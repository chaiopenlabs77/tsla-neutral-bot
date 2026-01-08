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
import { alerts, alertInfo, alertWarning } from '../observability/alerter';
import { isShutdownInProgress, onShutdown } from '../utils/shutdown';
import { sleep, Backoff } from '../utils/backoff';
import { getMonotonicTime } from '../utils/clock';
import { LPClient } from '../clients/lp_client';
import { FlashTradeClient } from '../clients/flash_trade_client';
import { PythClient } from '../clients/pyth_client';
import { JupiterClient, TOKEN_MINTS } from '../clients/jupiter_client';
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
    private jupiterClient: JupiterClient | null = null;
    private pythClient: PythClient;
    private wallet: Keypair | null = null;
    private hasBootstrapped = false;

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

                // Initialize Jupiter Client (for swaps)
                this.jupiterClient = new JupiterClient(connection);
                await this.jupiterClient.initialize(this.wallet);
                log.info({ event: 'jupiter_client_initialized' });
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
        let lpPositionCount = 0;
        if (this.lpClient) {
            try {
                const lpPositions = await this.lpClient.fetchPositions();
                lpPositionCount = lpPositions.length;
                for (const pos of lpPositions) {
                    lpDelta += this.lpClient.calculatePositionDelta(pos, tslaPrice || 400);
                    isLpInRange = isLpInRange && this.lpClient.isPositionInRange(pos.lowerTick, pos.upperTick);
                }
                log.debug({ event: 'lp_positions_fetched', count: lpPositions.length, totalDelta: lpDelta });

                // Bootstrap: Create initial LP position if none exists
                if (lpPositionCount === 0 && config.AUTO_BOOTSTRAP && !this.hasBootstrapped) {
                    log.info({ event: 'bootstrap_check', noPositions: true, autoBootstrap: true });
                    await this.bootstrapPosition(tslaPrice);
                    return; // Wait for next cycle to process the new position
                }
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

            // Execute the rebalance
            const success = await this.executeRebalance(decision.sizeToAdjust, tslaPrice);

            if (success) {
                rebalanceCounter.inc({ reason: decision.reason, status: 'success' });
            } else {
                rebalanceCounter.inc({ reason: decision.reason, status: 'failure' });
            }
        }

        this.state = await recordSuccess(this.state);
    }

    /**
     * Execute a rebalance trade.
     * @param sizeToAdjust - Positive = need more short, negative = need less short
     * @param currentPrice - Current TSLA price for calculations
     */
    private async executeRebalance(sizeToAdjust: number, currentPrice: number): Promise<boolean> {
        if (!this.flashTradeClient) {
            log.error({ event: 'rebalance_failed', error: 'Flash Trade client not initialized' });
            return false;
        }

        const absSize = Math.abs(sizeToAdjust);

        // Skip tiny adjustments
        if (absSize < config.MIN_REBALANCE_SIZE_USD) {
            log.info({
                event: 'rebalance_skipped',
                reason: 'below_min_size',
                size: absSize,
                minSize: config.MIN_REBALANCE_SIZE_USD
            });
            return true; // Not a failure, just skipped
        }

        // Cap position size
        const cappedSize = Math.min(absSize, config.MAX_POSITION_SIZE_USD);

        try {
            if (sizeToAdjust > 0) {
                // Need MORE hedge -> open/increase short position
                log.info({
                    event: 'opening_short',
                    sizeUsd: cappedSize,
                    leverage: config.DEFAULT_LEVERAGE,
                });

                // Calculate collateral: size / leverage
                const collateralUsd = Math.max(
                    cappedSize / config.DEFAULT_LEVERAGE,
                    config.MIN_COLLATERAL_USD
                );

                const result = await this.flashTradeClient.openShortPosition(
                    cappedSize,
                    collateralUsd,
                    config.MAX_SLIPPAGE_BPS
                );

                if (result) {
                    log.info({
                        event: 'short_opened',
                        txSignature: result.txSignature,
                        sizeUsd: cappedSize,
                        collateralUsd,
                    });
                    alertInfo('REBALANCE_EXECUTED', `Opened short: $${cappedSize} (tx: ${result.txSignature.slice(0, 8)}...)`);
                    return true;
                } else {
                    log.error({ event: 'short_open_failed', sizeUsd: cappedSize });
                    alertWarning('REBALANCE_FAILED', `Failed to open short: $${cappedSize}`);
                    return false;
                }
            } else {
                // Need LESS hedge -> close/reduce short position
                log.info({
                    event: 'closing_short',
                    sizeUsd: cappedSize,
                });

                // For now, close the entire position
                // TODO: Support partial closes when SDK supports it
                const result = await this.flashTradeClient.closePosition(config.MAX_SLIPPAGE_BPS);

                if (result) {
                    log.info({
                        event: 'short_closed',
                        txSignature: result.txSignature,
                    });
                    alertInfo('REBALANCE_EXECUTED', `Closed short (tx: ${result.txSignature.slice(0, 8)}...)`);
                    return true;
                } else {
                    log.error({ event: 'short_close_failed' });
                    alertWarning('REBALANCE_FAILED', 'Failed to close short position');
                    return false;
                }
            }
        } catch (error) {
            log.error({
                event: 'rebalance_execution_error',
                error: error instanceof Error ? error.message : String(error),
                sizeToAdjust,
            });
            alerts.txFailure('rebalance', error instanceof Error ? error.message : String(error));
            return false;
        }
    }

    /**
     * Bootstrap initial position from scratch.
     * 1. Swap half of USDC to TSLAx
     * 2. Open concentrated LP position
     * 3. Open matching hedge on Flash Trade
     */
    private async bootstrapPosition(currentPrice: number): Promise<boolean> {
        if (!this.lpClient || !this.jupiterClient || !this.flashTradeClient) {
            log.error({ event: 'bootstrap_failed', error: 'Clients not initialized' });
            return false;
        }

        const totalCapitalUsd = config.BOOTSTRAP_AMOUNT_USD;
        const rangePercent = config.BOOTSTRAP_LP_RANGE_PERCENT;
        const leverage = config.DEFAULT_LEVERAGE;

        // Calculate capital allocation:
        // - LP needs: $L/2 for TSLAx swap + $L/2 for USDC side = $L total
        // - Hedge needs: $L/leverage for collateral (e.g., 2x leverage = 50%)
        // - Total: $L * (1 + 1/leverage)
        // - So: LP value = totalCapital / (1 + 1/leverage)
        const lpValueUsd = totalCapitalUsd / (1 + 1 / leverage);
        const hedgeCollateralUsd = lpValueUsd / leverage;
        const swapAmountUsd = lpValueUsd / 2; // Half goes to TSLAx
        const lpUsdcSideUsd = lpValueUsd / 2; // Half stays as USDC for LP

        log.info({
            event: 'bootstrap_starting',
            totalCapitalUsd,
            lpValueUsd: lpValueUsd.toFixed(2),
            hedgeCollateralUsd: hedgeCollateralUsd.toFixed(2),
            swapAmountUsd: swapAmountUsd.toFixed(2),
            leverage,
            currentPrice,
            rangePercent,
        });

        try {
            // Step 1: Swap portion of USDC to TSLAx for LP
            const swapAmountMicro = BigInt(Math.floor(swapAmountUsd * 1_000_000)); // USDC has 6 decimals

            log.info({ event: 'bootstrap_swapping', amountUsd: swapAmountUsd.toFixed(2) });

            const swapResult = await this.jupiterClient.swapUsdcToTslax(swapAmountMicro);
            if (!swapResult) {
                log.error({ event: 'bootstrap_swap_failed' });
                alertWarning('BOOTSTRAP_FAILED', 'Failed to swap USDC to TSLAx');
                return false;
            }

            log.info({
                event: 'bootstrap_swap_complete',
                txSignature: swapResult.txSignature,
                tslaxReceived: swapResult.tslaxAmount,
            });

            // Step 2: Open LP position
            // TSLAx has 9 decimals, USDC has 6 decimals
            // We received tslaxAmount from the swap, and we'll use remaining USDC
            const tslaxAmount = BigInt(swapResult.tslaxAmount);
            const usdcAmount = swapAmountMicro; // Same amount of USDC for the other side

            log.info({
                event: 'bootstrap_opening_lp',
                tslaxAmount: tslaxAmount.toString(),
                usdcAmount: usdcAmount.toString(),
                rangePercent,
            });

            const lpResult = await this.lpClient.openPosition(
                tslaxAmount,
                usdcAmount,
                rangePercent
            );

            if (!lpResult) {
                log.error({ event: 'bootstrap_lp_failed' });
                alertWarning('BOOTSTRAP_FAILED', 'Failed to open LP position');
                return false;
            }

            log.info({
                event: 'bootstrap_lp_opened',
                txSignature: lpResult.txSignature,
            });

            // Step 3: Open matching hedge
            // Hedge size = LP value (to be delta neutral)
            // Collateral already calculated based on leverage
            const hedgeSize = lpValueUsd;
            const collateral = hedgeCollateralUsd;

            log.info({
                event: 'bootstrap_opening_hedge',
                hedgeSizeUsd: hedgeSize,
                collateralUsd: collateral,
            });

            const hedgeResult = await this.flashTradeClient.openShortPosition(
                hedgeSize,
                collateral,
                config.MAX_SLIPPAGE_BPS
            );

            if (!hedgeResult) {
                log.error({ event: 'bootstrap_hedge_failed' });
                alertWarning('BOOTSTRAP_FAILED', 'Failed to open hedge position');
                // Note: LP is already open, but we failed to hedge. 
                // This is a partial success - the next cycle will detect the imbalance
                return false;
            }

            log.info({
                event: 'bootstrap_hedge_opened',
                txSignature: hedgeResult.txSignature,
            });

            // Mark bootstrap as complete
            this.hasBootstrapped = true;

            alertInfo('BOOTSTRAP_COMPLETE', `Initial position created: $${totalCapitalUsd} deployed`);
            log.info({
                event: 'bootstrap_complete',
                totalCapitalUsd,
                lpValueUsd,
                hedgeSize,
                hedgeCollateralUsd,
            });

            return true;
        } catch (error) {
            log.error({
                event: 'bootstrap_error',
                error: error instanceof Error ? error.message : String(error),
            });
            alerts.txFailure('bootstrap', error instanceof Error ? error.message : String(error));
            return false;
        }
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
