import { config } from '../config';
import { BotState, StateMachineState, CycleMetrics } from '../types';
import {
    loadState,
    transitionState,
    recordSuccess,
    recordFailure,
    canOperate,
} from '../state_machine';
import { getRpcManager } from '../clients/rpc_manager';
import { evaluateRebalance } from './risk_manager';
import { loggers, logMetricsSnapshot } from '../observability/logger';
import { rebalanceCounter } from '../observability/metrics';
import { alerts } from '../observability/alerter';
import { isShutdownInProgress, onShutdown } from '../utils/shutdown';
import { sleep, Backoff } from '../utils/backoff';
import { getMonotonicTime } from '../utils/clock';
import { LPClient } from '../clients/lp_client';
import { FlashTradeClient } from '../clients/flash_trade_client';
import { PythClient } from '../clients/pyth_client';
import { Keypair, Connection } from '@solana/web3.js';
import bs58 from 'bs58';

const log = loggers.orchestrator;

export class Orchestrator {
    private state: StateMachineState | null = null;
    private isRunning = false;
    private backoff = new Backoff();
    private cycleCount = 0;

    // Protocol clients
    private lpClient: LPClient | null = null;
    private flashTradeClient: FlashTradeClient | null = null;
    private pythClient: PythClient;
    private wallet: Keypair | null = null;

    constructor() {
        this.pythClient = new PythClient();
    }

    /**
     * Initialize the orchestrator.
     */
    async initialize(): Promise<void> {
        log.info({ event: 'initializing' });

        // Load state from Redis
        this.state = await loadState();

        // Start RPC health checks
        getRpcManager().startHealthChecks();

        // Initialize wallet
        const privateKey = process.env.WALLET_PRIVATE_KEY;
        if (privateKey) {
            try {
                this.wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
                log.info({ event: 'wallet_loaded', publicKey: this.wallet.publicKey.toBase58() });

                // Initialize protocol clients
                const connection = getRpcManager().getConnection();

                // Initialize LP Client (Raydium)
                this.lpClient = new LPClient(connection);
                await this.lpClient.initialize(this.wallet);
                log.info({ event: 'lp_client_initialized' });

                // Initialize Flash Trade Client (TSLAr = Tesla equity perp)
                this.flashTradeClient = new FlashTradeClient(connection, 'TSLAr');
                await this.flashTradeClient.initialize(this.wallet);
                log.info({ event: 'flash_trade_client_initialized' });
            } catch (error) {
                log.warn({
                    event: 'client_init_warning',
                    error: error instanceof Error ? error.message : String(error),
                    msg: 'Running in monitoring-only mode'
                });
            }
        } else {
            log.warn({ event: 'no_wallet', msg: 'WALLET_PRIVATE_KEY not set, monitoring-only mode' });
        }

        // Register shutdown handler
        onShutdown(async () => {
            log.info({ event: 'shutdown_handler_triggered' });
            await this.stop();
        });

        log.info({ event: 'initialized', state: this.state!.currentState });
    }

    /**
     * Start the main loop.
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            log.warn({ event: 'already_running' });
            return;
        }

        this.isRunning = true;
        alerts.botStarted();
        log.info({ event: 'starting_main_loop', interval: config.LOOP_INTERVAL_MS });

        while (this.isRunning && !isShutdownInProgress()) {
            const cycleStart = getMonotonicTime();
            this.cycleCount++;

            try {
                await this.runCycle();
                this.backoff.reset();
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                log.error({ event: 'cycle_error', cycle: this.cycleCount, error: errorMessage });

                if (this.state) {
                    this.state = await recordFailure(this.state, errorMessage);
                }

                // Apply backoff
                await this.backoff.wait();
            }

            // Wait for next cycle
            const cycleDuration = getMonotonicTime() - cycleStart;
            const sleepTime = Math.max(0, config.LOOP_INTERVAL_MS - cycleDuration);

            if (sleepTime > 0 && this.isRunning) {
                await sleep(sleepTime);
            }
        }

        log.info({ event: 'main_loop_exited' });
    }

    /**
     * Stop the orchestrator.
     */
    async stop(): Promise<void> {
        if (!this.isRunning) return;

        log.info({ event: 'stopping' });
        this.isRunning = false;

        // Transition to shutdown state
        if (this.state && canOperate(this.state)) {
            this.state = await transitionState(this.state, BotState.SHUTTING_DOWN);
        }

        // Stop RPC health checks
        getRpcManager().stopHealthChecks();

        alerts.botStopped('graceful_shutdown');
        log.info({ event: 'stopped' });
    }

    /**
     * Run a single cycle.
     */
    private async runCycle(): Promise<void> {
        if (!this.state || !canOperate(this.state)) {
            log.debug({ event: 'skip_cycle', reason: 'cannot_operate' });
            return;
        }

        log.debug({ event: 'cycle_start', cycle: this.cycleCount });

        // In DRY_RUN mode, just log what we would do
        if (config.DRY_RUN) {
            await this.runDryRunCycle();
            return;
        }

        // ===== LIVE MODE: Fetch real on-chain data =====

        // 1. Fetch TSLA price from Pyth
        let tslaPrice = 0;
        try {
            const priceData = await this.pythClient.getTSLAPrice();
            if (priceData) {
                tslaPrice = priceData.price;
                log.debug({ event: 'pyth_price_fetched', price: tslaPrice, confidence: priceData.confidence });
            }
        } catch (error) {
            log.warn({ event: 'pyth_fetch_error', error: error instanceof Error ? error.message : String(error) });
        }

        // 2. Fetch LP positions and calculate delta
        let lpDelta = 0;
        let isLpInRange = true;
        if (this.lpClient) {
            try {
                const lpPositions = await this.lpClient.fetchPositions();
                for (const pos of lpPositions) {
                    lpDelta += this.lpClient.calculatePositionDelta(pos, tslaPrice || 400);
                    isLpInRange = isLpInRange && this.lpClient.isPositionInRange(pos.lowerTick, pos.upperTick);
                }
                log.debug({ event: 'lp_positions_fetched', count: lpPositions.length, totalDelta: lpDelta });
            } catch (error) {
                log.warn({ event: 'lp_fetch_error', error: error instanceof Error ? error.message : String(error) });
            }
        }

        // 3. Fetch hedge positions and calculate delta
        let hedgeDelta = 0;
        if (this.flashTradeClient) {
            try {
                const hedgePositions = await this.flashTradeClient.fetchPositions();
                for (const pos of hedgePositions) {
                    hedgeDelta += this.flashTradeClient.calculatePositionDelta(pos);
                }
                log.debug({ event: 'hedge_positions_fetched', count: hedgePositions.length, totalDelta: hedgeDelta });
            } catch (error) {
                log.warn({ event: 'hedge_fetch_error', error: error instanceof Error ? error.message : String(error) });
            }
        }

        // 4. Evaluate rebalance decision
        const estimatedGasCost = 0.001; // ~0.001 SOL for tx
        const decision = evaluateRebalance(
            this.state,
            lpDelta,
            hedgeDelta,
            estimatedGasCost,
            isLpInRange
        );

        // 5. Log metrics (same format as dry-run for consistency)
        logMetricsSnapshot({
            cycle: this.cycleCount,
            dryRun: false,
            lpDelta,
            hedgeDelta,
            netDelta: decision.currentDelta,
            tslaPrice,
            isLpInRange,
            shouldRebalance: decision.shouldRebalance,
            reason: decision.reason,
        });

        // 6. Handle rebalance decision
        if (decision.shouldRebalance && !decision.blocked) {
            log.info({
                event: 'rebalance_triggered',
                reason: decision.reason,
                currentDelta: decision.currentDelta,
                sizeToAdjust: decision.sizeToAdjust,
            });

            rebalanceCounter.inc({ reason: decision.reason, status: 'pending' });

            // TODO: Execute actual rebalance trades
            // For now, just log what we would do
            log.info({
                event: 'would_execute_rebalance',
                action: decision.sizeToAdjust > 0 ? 'increase_short' : 'decrease_short',
                sizeUsd: Math.abs(decision.sizeToAdjust)
            });
        }

        this.state = await recordSuccess(this.state);
    }

    /**
     * Run a dry-run cycle (no actual trades).
     */
    private async runDryRunCycle(): Promise<void> {
        // Simulate fetching data
        const mockLpDelta = 1000; // $1000 long exposure
        const mockHedgeDelta = -950; // $950 short exposure
        const mockGasCost = 0.001; // 0.001 SOL

        const decision = evaluateRebalance(
            this.state!,
            mockLpDelta,
            mockHedgeDelta,
            mockGasCost,
            true
        );

        const metrics: Partial<CycleMetrics> = {
            cycleId: `cycle-${this.cycleCount}`,
            timestamp: Date.now(),
            deltaBeforeRebalance: decision.currentDelta,
        };

        logMetricsSnapshot({
            cycle: this.cycleCount,
            dryRun: true,
            lpDelta: mockLpDelta,
            hedgeDelta: mockHedgeDelta,
            netDelta: decision.currentDelta,
            shouldRebalance: decision.shouldRebalance,
            reason: decision.reason,
        });

        if (decision.shouldRebalance && !decision.blocked) {
            log.info({
                event: 'dry_run_would_rebalance',
                reason: decision.reason,
                sizeToAdjust: decision.sizeToAdjust,
            });
        }

        log.debug({ event: 'cycle_complete', cycle: this.cycleCount });
    }

    /**
     * Get current state.
     */
    getState(): StateMachineState | null {
        return this.state;
    }

    /**
     * Get cycle count.
     */
    getCycleCount(): number {
        return this.cycleCount;
    }
}
