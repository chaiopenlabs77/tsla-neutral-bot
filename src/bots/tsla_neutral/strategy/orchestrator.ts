import { config } from '../config';
import { BotState, StateMachineState, CycleMetrics, HedgePosition, LPPosition } from '../types';
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
import { getDataCollector, DataCollector } from '../infra/data_collector';
import { Keypair, Connection, PublicKey } from '@solana/web3.js';
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
    private dataCollector: DataCollector;

    // (EOD unwind removed — LP + hedge stay open 24/7)

    // Pool APR cache (refresh every 5 minutes)
    private cachedPoolApr = 0;
    private cachedPoolTvl = 0;
    private lastAprFetch = 0;

    // Price history for stabilization check (rolling buffer)
    private priceHistory: { ts: number; price: number }[] = [];

    constructor() {
        this.pythClient = new PythClient();
        this.dataCollector = getDataCollector();
    }

    /**
     * Check if Flash Trade hedge operations are available.
     * Flash Trade TSLAr is 24/5 — open all day on weekdays, closed weekends + US bank holidays.
     * (Holiday detection not implemented — failed trades are retried gracefully.)
     */
    private isWithinTradingHours(): boolean {
        const now = new Date();
        const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

        // Flash Trade is closed on weekends
        const dayOfWeek = et.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            return false;
        }

        // Open 24 hours on weekdays (Flash Trade is 24/5)
        return true;
    }

    /**
     * Check if it's time to open positions (at market open time).
     */
    /**
     * Get current ET time string for logging.
     */
    private getCurrentET(): string {
        const now = new Date();
        return now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true });
    }

    /**
     * Fetch pool APR from Raydium API (caches for 5 minutes).
     */
    private async fetchPoolApr(): Promise<void> {
        const RAYDIUM_API = 'https://api-v3.raydium.io';
        const POOL_ID = config.RAYDIUM_POOL_ADDRESS.toBase58();

        try {
            const response = await fetch(`${RAYDIUM_API}/pools/info/ids?ids=${POOL_ID}`);
            const json = await response.json() as { success: boolean; data: any[] };

            if (json.success && json.data?.[0]) {
                const pool = json.data[0];
                this.cachedPoolApr = pool.day?.feeApr || pool.week?.feeApr || 0;
                this.cachedPoolTvl = pool.tvl || 0;
                this.lastAprFetch = Date.now();

                log.debug({
                    event: 'pool_apr_fetched',
                    apr: this.cachedPoolApr,
                    tvl: this.cachedPoolTvl,
                });
            }
        } catch (error) {
            log.warn({
                event: 'pool_apr_fetch_error',
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Initialize the orchestrator.
     */
    async initialize(): Promise<void> {
        log.info({ event: 'initializing' });

        // Load state from Redis
        this.state = await loadState();

        // Initialize data collector
        await this.dataCollector.initialize();

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

        log.debug({ event: 'cycle_start', cycle: this.cycleCount, et: this.getCurrentET() });

        // ===== MARKET HOURS CHECK =====
        // LP runs 24/7; only hedge operations (open/rebalance) are gated on market hours.
        // Both LP and hedge stay open continuously — no daily EOD unwind.
        const withinHours = this.isWithinTradingHours();

        // In DRY_RUN mode, just log what we would do
        if (config.DRY_RUN) {
            await this.runDryRunCycle();
            return;
        }

        // ===== LIVE MODE: Fetch real on-chain data =====

        // 0. Proactively ensure SOL balance for gas (tops up early so swaps never fail)
        if (this.jupiterClient) {
            await this.jupiterClient.ensureSolBalance();
        }

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

        // Track price history for stabilization checks (keep last 2 minutes)
        if (tslaPrice > 0) {
            const now = Date.now();
            this.priceHistory.push({ ts: now, price: tslaPrice });
            const cutoff = now - 120_000; // 2 minutes
            while (this.priceHistory.length > 0 && this.priceHistory[0].ts < cutoff) {
                this.priceHistory.shift();
            }
        }

        // 2. Fetch LP positions and calculate delta
        let lpDelta = 0;
        let isLpInRange = true;
        let lpPositionCount = 0;
        let lpPositions: LPPosition[] = [];
        if (this.lpClient) {
            try {
                lpPositions = await this.lpClient.fetchPositions();
                lpPositionCount = lpPositions.length;
                for (const pos of lpPositions) {
                    lpDelta += this.lpClient.calculatePositionDelta(pos, tslaPrice || 400);
                    isLpInRange = isLpInRange && this.lpClient.isPositionInRange(pos.lowerTick, pos.upperTick);
                }
                log.debug({ event: 'lp_positions_fetched', count: lpPositions.length, totalDelta: lpDelta });

                // Track out-of-range duration for LP repositioning
                if (lpPositionCount > 0) {
                    if (!isLpInRange && !this.state!.outOfRangeSince) {
                        this.state = await transitionState(this.state!, this.state!.currentState, {
                            outOfRangeSince: Date.now(),
                        });
                        log.info({ event: 'lp_out_of_range_started', price: tslaPrice });
                    } else if (isLpInRange && this.state!.outOfRangeSince) {
                        this.state = await transitionState(this.state!, this.state!.currentState, {
                            outOfRangeSince: null,
                        });
                        log.info({ event: 'lp_back_in_range', price: tslaPrice });
                    }
                }

                // Bootstrap: Create initial LP + hedge if none exists
                // Requires market hours since hedge (Flash Trade) can't open on weekends
                if (lpPositionCount === 0 && config.AUTO_BOOTSTRAP && !this.hasBootstrapped) {
                    if (!withinHours) {
                        log.debug({ event: 'bootstrap_deferred', reason: 'outside_market_hours', et: this.getCurrentET() });
                    } else {
                        log.info({ event: 'bootstrap_check', noPositions: true, autoBootstrap: true });
                        await this.bootstrapPosition(tslaPrice);
                        return; // Wait for next cycle to process the new position
                    }
                }
            } catch (error) {
                log.warn({ event: 'lp_fetch_error', error: error instanceof Error ? error.message : String(error) });
            }
        }

        // 3. Fetch hedge positions and calculate delta
        let hedgeDelta = 0;
        let hedgePositions: HedgePosition[] = [];
        if (this.flashTradeClient) {
            try {
                hedgePositions = await this.flashTradeClient.fetchPositions();
                for (const pos of hedgePositions) {
                    hedgeDelta += this.flashTradeClient.calculatePositionDelta(pos);
                }
                log.debug({ event: 'hedge_positions_fetched', count: hedgePositions.length, totalDelta: hedgeDelta });
            } catch (error) {
                log.warn({ event: 'hedge_fetch_error', error: error instanceof Error ? error.message : String(error) });
            }
        }

        // 4. Snapshot SOL balance before rebalance (to measure real gas cost)
        let solBalanceBefore = 0;
        try {
            const connection = getRpcManager().getConnection();
            solBalanceBefore = await connection.getBalance(this.wallet!.publicKey);
        } catch { /* non-critical */ }

        // Evaluate rebalance decision
        const estimatedGasCost = 0.001; // ~0.001 SOL estimate for risk manager check
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
            // Cooldown: skip if we rebalanced too recently
            const timeSinceLastRebalance = Date.now() - (this.state!.lastRebalanceTime || 0);
            if (timeSinceLastRebalance < config.MIN_REBALANCE_INTERVAL_MS) {
                log.info({
                    event: 'rebalance_cooldown',
                    msSinceLastRebalance: timeSinceLastRebalance,
                    cooldownMs: config.MIN_REBALANCE_INTERVAL_MS,
                });
            } else {
                log.info({
                    event: 'rebalance_triggered',
                    reason: decision.reason,
                    currentDelta: decision.currentDelta,
                    sizeToAdjust: decision.sizeToAdjust,
                });

                rebalanceCounter.inc({ reason: decision.reason, status: 'pending' });

                let success: boolean;

                if (decision.reason === 'out_of_range_too_long') {
                    // LP is out of range — reposition anytime (LP runs 24/7)
                    if (!this.isPriceStable()) {
                        log.info({ event: 'reposition_deferred', reason: 'price_unstable' });
                        success = false; // Don't count as failure — just wait
                    } else {
                        success = await this.repositionLP(tslaPrice);
                    }
                } else if (!withinHours) {
                    // Hedge rebalance only during market hours (Flash Trade restriction)
                    log.debug({ event: 'hedge_rebalance_deferred', reason: 'outside_market_hours', et: this.getCurrentET() });
                    success = false;
                } else {
                    // Normal delta drift — adjust hedge (market hours only)
                    success = await this.executeRebalance(decision.sizeToAdjust, tslaPrice, hedgePositions);
                }

                if (success) {
                    rebalanceCounter.inc({ reason: decision.reason, status: 'success' });
                    this.state = await transitionState(this.state!, this.state!.currentState, {
                        lastRebalanceTime: Date.now(),
                    });
                } else {
                    rebalanceCounter.inc({ reason: decision.reason, status: 'failure' });
                }
            }
        }

        // 7. Record cycle data for analysis
        // Fetch pool APR if stale (every 5 minutes)
        if (Date.now() - this.lastAprFetch > 300_000) {
            await this.fetchPoolApr();
        }

        // Estimated daily funding cost (hedge notional × daily rate)
        const hedgeNotional = Math.abs(hedgeDelta);
        const estDailyFundingUsd = hedgeNotional * config.FUNDING_RATE_SPIKE_THRESHOLD;
        if (estDailyFundingUsd > 0 && this.cachedPoolApr > 0) {
            // Warn if funding cost exceeds 50% of gross fee income
            const grossDailyFees = (hedgeNotional * (this.cachedPoolApr / 100)) / 365;
            if (estDailyFundingUsd > grossDailyFees * 0.5) {
                log.warn({
                    event: 'funding_cost_high',
                    estDailyFundingUsd: estDailyFundingUsd.toFixed(2),
                    grossDailyFees: grossDailyFees.toFixed(2),
                    ratio: (estDailyFundingUsd / grossDailyFees).toFixed(2),
                });
            }
        }

        // Measure actual gas cost (SOL difference × rough price)
        let actualGasCostUsd = 0;
        try {
            const connection = getRpcManager().getConnection();
            const solBalanceAfter = await connection.getBalance(this.wallet!.publicKey);
            const solSpent = (solBalanceBefore - solBalanceAfter) / 1e9; // lamports → SOL
            if (solSpent > 0 && solSpent < 0.1) { // Sanity: ignore if >0.1 SOL (likely a swap, not gas)
                actualGasCostUsd = solSpent * 200; // ~$200/SOL rough estimate
            }
        } catch { /* non-critical */ }

        // Compute LP fees and value from position data
        let lpFeesUsd = 0;
        let lpValueUsd = 0;
        if (lpPositions.length > 0) {
            for (const pos of lpPositions) {
                // LP fees: tokenFeesOwedA (TSLAx, 8 decimals) * price + tokenFeesOwedB (USDC, 6 decimals)
                const feesA = Number(pos.tokenFeesOwedA) / 1e8;
                const feesB = Number(pos.tokenFeesOwedB) / 1e6;
                lpFeesUsd += feesA * tslaPrice + feesB;

                // LP value: tokenA (TSLAx) * price + tokenB (USDC)
                const tokenA = Number(pos.tokenAAmount) / 1e8;
                const tokenB = Number(pos.tokenBAmount) / 1e6;
                lpValueUsd += tokenA * tslaPrice + tokenB;
            }
        }

        // Compute hedge funding fields
        let hedgeFundingUsd = 0;
        let hedgeCumLockFee = 0;
        if (hedgePositions.length > 0) {
            for (const pos of hedgePositions) {
                hedgeFundingUsd += pos.unsettledFeesUsd;
                hedgeCumLockFee += pos.cumulativeLockFeeSnapshot;
            }
        }

        this.dataCollector.recordCycle({
            timestamp: Date.now(),
            tslaPrice,
            lpDelta,
            hedgeDelta,
            netDelta: decision.currentDelta,
            isLpInRange,
            poolApr: this.cachedPoolApr,
            poolTvl: this.cachedPoolTvl,
            rebalanceTriggered: decision.shouldRebalance && !decision.blocked,
            rebalanceReason: decision.reason,
            rebalanceSizeUsd: decision.sizeToAdjust,
            gasCostUsd: actualGasCostUsd,
            estFundingCostUsd: estDailyFundingUsd / (86400 / (config.LOOP_INTERVAL_MS / 1000)), // Per-cycle funding
            repositionEvent: decision.reason === 'out_of_range_too_long' && decision.shouldRebalance,
            lpFeesUsd,
            lpValueUsd,
            hedgeFundingUsd,
            hedgeCumLockFee,
        });

        this.state = await recordSuccess(this.state);
    }

    /**
     * Execute a rebalance trade.
     * @param sizeToAdjust - Positive = need more short, negative = need less short
     * @param currentPrice - Current TSLA price for calculations
     * @param existingPositions - Current hedge positions (to determine if we should increase vs open)
     */
    private async executeRebalance(
        sizeToAdjust: number,
        currentPrice: number,
        existingPositions: HedgePosition[] = []
    ): Promise<boolean> {
        if (!this.flashTradeClient || !this.wallet) {
            log.error({ event: 'rebalance_failed', error: 'Flash Trade client not initialized' });
            return false;
        }

        // Ensure we have enough SOL for transaction fees before attempting any swaps
        if (this.jupiterClient) {
            const hasSol = await this.jupiterClient.ensureSolBalance();
            if (!hasSol) {
                log.warn({ event: 'rebalance_blocked', reason: 'insufficient_sol_for_fees' });
                alertWarning('REBALANCE_BLOCKED', 'Could not ensure SOL balance for transaction fees');
                return false;
            }
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

        // For opening new shorts, check if we have enough USDC for collateral
        if (sizeToAdjust > 0) {
            const requiredCollateral = cappedSize / config.DEFAULT_LEVERAGE;
            const connection = getRpcManager().getConnection();
            try {
                const { getAssociatedTokenAddress } = await import('@solana/spl-token');
                const usdcAta = await getAssociatedTokenAddress(config.USDC_MINT, this.wallet.publicKey);
                const accountInfo = await connection.getTokenAccountBalance(usdcAta);
                const availableUsdc = Number(accountInfo.value.amount) / 1_000_000;

                if (availableUsdc < requiredCollateral) {
                    const shortfall = requiredCollateral - availableUsdc;
                    const swapAmount = shortfall + 1; // Add $1 buffer

                    log.info({
                        event: 'auto_collateral_swap',
                        shortfall: shortfall.toFixed(2),
                        swapAmount: swapAmount.toFixed(2),
                    });

                    // Try to swap SOL to USDC via Jupiter
                    if (this.jupiterClient) {
                        try {
                            // Convert USD to SOL amount (rough estimate: $200/SOL)
                            const solPrice = 200; // TODO: fetch from Pyth
                            const solNeeded = swapAmount / solPrice;
                            const lamports = BigInt(Math.ceil(solNeeded * 1e9));

                            const swapResult = await this.jupiterClient.swapSolToUsdc(lamports);
                            if (swapResult) {
                                log.info({
                                    event: 'collateral_swap_success',
                                    tx: swapResult.txSignature,
                                    usdcReceived: swapResult.usdcAmount,
                                });
                                alertInfo('COLLATERAL_TOPPED_UP', `Swapped SOL for $${(Number(swapResult.usdcAmount) / 1e6).toFixed(2)} USDC`);
                            } else {
                                log.warn({ event: 'collateral_swap_failed' });
                                alertWarning('REBALANCE_BLOCKED', `Could not swap for USDC collateral`);
                                return false;
                            }
                        } catch (swapError) {
                            log.warn({ event: 'collateral_swap_error', error: String(swapError) });
                            alertWarning('REBALANCE_BLOCKED', `Insufficient USDC: need $${requiredCollateral.toFixed(2)}, have $${availableUsdc.toFixed(2)}`);
                            return false;
                        }
                    } else {
                        log.warn({
                            event: 'rebalance_skipped',
                            reason: 'insufficient_collateral',
                            required: requiredCollateral.toFixed(2),
                            available: availableUsdc.toFixed(2),
                        });
                        alertWarning('REBALANCE_BLOCKED', `Insufficient USDC: need $${requiredCollateral.toFixed(2)}, have $${availableUsdc.toFixed(2)}`);
                        return false;
                    }
                }
            } catch (error) {
                log.warn({ event: 'rebalance_balance_check_failed', error: String(error) });
                // Continue anyway - Flash Trade will fail if insufficient
            }
        }

        try {
            if (sizeToAdjust > 0) {
                // Need MORE hedge -> open/increase short position
                const existingShort = existingPositions.find(p => p.side === 'SHORT');

                if (existingShort) {
                    // Existing position - use increaseSize
                    log.info({
                        event: 'increasing_short',
                        existingPositionId: existingShort.positionId,
                        additionalSizeUsd: cappedSize,
                    });

                    const result = await this.flashTradeClient.increaseShortPosition(
                        existingShort.positionId,
                        cappedSize,
                        config.MAX_SLIPPAGE_BPS,
                        currentPrice
                    );

                    if (result) {
                        log.info({
                            event: 'short_increased',
                            txSignature: result.txSignature,
                            additionalSizeUsd: cappedSize,
                        });
                        alertInfo('REBALANCE_EXECUTED', `Increased short by $${cappedSize.toFixed(2)} (tx: ${result.txSignature.slice(0, 8)}...)`);
                        return true;
                    } else {
                        log.error({ event: 'short_increase_failed', sizeUsd: cappedSize });
                        alertWarning('REBALANCE_FAILED', `Failed to increase short: $${cappedSize}`);
                        return false;
                    }
                } else {
                    // No existing position - open new one
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
                        config.MAX_SLIPPAGE_BPS,
                        currentPrice // Pass the TSLA price from Pyth
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
     * Reposition LP: close current out-of-range position and re-open at current price.
     * Does NOT touch the hedge — the next cycle's delta drift check will adjust it.
     */
    /**
     * Check if price has stabilized (low velocity over last 30s).
     * Returns true if we have enough data and price change is < 0.5%.
     */
    private isPriceStable(): boolean {
        if (this.priceHistory.length < 3) return false; // Need at least 3 observations

        const now = Date.now();
        const recent = this.priceHistory.filter(p => p.ts > now - 30_000);
        if (recent.length < 2) return false;

        const first = recent[0].price;
        const last = recent[recent.length - 1].price;
        const changePct = Math.abs(last - first) / first;

        return changePct < 0.005; // < 0.5% move in last 30s
    }

    private async repositionLP(currentPrice: number): Promise<boolean> {
        if (!this.lpClient || !this.jupiterClient) {
            log.error({ event: 'reposition_failed', error: 'Clients not initialized' });
            return false;
        }

        try {
            // Step 1: Get current LP positions
            const positions = await this.lpClient.fetchPositions();
            if (positions.length === 0) {
                log.warn({ event: 'reposition_skipped', reason: 'no_lp_positions' });
                return false;
            }

            log.info({
                event: 'reposition_starting',
                positionCount: positions.length,
                currentPrice,
                newRange: `±${(config.RANGE_WIDTH_PERCENT * 100).toFixed(1)}%`,
            });

            // Step 2: Close all existing LP positions (collects fees automatically)
            for (const pos of positions) {
                const closeResult = await this.lpClient.closePosition(pos.mint);
                if (!closeResult) {
                    log.error({ event: 'reposition_close_failed', mint: pos.mint.toBase58() });
                    alertWarning('REPOSITION_FAILED', 'Failed to close old LP position');
                    return false;
                }
                log.info({ event: 'reposition_closed_old', tx: closeResult.txSignature });
            }

            // Step 3: Wait for state to settle
            await sleep(2000);

            // Step 4: Check token balances and re-open LP at current price
            const connection = getRpcManager().getConnection();
            const { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');

            // Get TSLAx balance (Token2022, 8 decimals)
            let tslaxBalance = 0n;
            try {
                const tslaxAta = await getAssociatedTokenAddress(
                    config.TSLAX_MINT, this.wallet!.publicKey, false, TOKEN_2022_PROGRAM_ID
                );
                const info = await connection.getTokenAccountBalance(tslaxAta);
                tslaxBalance = BigInt(info.value.amount);
            } catch { tslaxBalance = 0n; }

            // Get USDC balance (6 decimals)
            let usdcBalance = 0n;
            try {
                const usdcAta = await getAssociatedTokenAddress(config.USDC_MINT, this.wallet!.publicKey);
                const info = await connection.getTokenAccountBalance(usdcAta);
                usdcBalance = BigInt(info.value.amount);
            } catch { usdcBalance = 0n; }

            const tslaxValueUsd = (Number(tslaxBalance) / 1e8) * currentPrice;
            const usdcValueUsd = Number(usdcBalance) / 1e6;

            log.info({
                event: 'reposition_balances',
                tslaxBalance: tslaxBalance.toString(),
                tslaxValueUsd: tslaxValueUsd.toFixed(2),
                usdcValueUsd: usdcValueUsd.toFixed(2),
            });

            // Step 5: Calculate target token ratio for new range
            const { tokenARatio } = this.lpClient.calculateTokenRatio(config.RANGE_WIDTH_PERCENT);
            const totalLpValue = tslaxValueUsd + usdcValueUsd;

            // Reserve hedge collateral (don't LP with all capital)
            const hedgeCollateral = totalLpValue / (config.DEFAULT_LEVERAGE + 1) / config.DEFAULT_LEVERAGE;
            const lpCapital = totalLpValue - hedgeCollateral;
            const targetTslaxUsd = lpCapital * tokenARatio;

            // Swap delta if needed (only swap the difference, not 50% of position)
            const tslaxDeltaUsd = targetTslaxUsd - tslaxValueUsd;

            if (tslaxDeltaUsd > 1) {
                // Need more TSLAx
                const swapMicro = BigInt(Math.floor(tslaxDeltaUsd * 1.02 * 1e6)); // 2% buffer
                const swapResult = await this.jupiterClient.swapUsdcToTslax(swapMicro);
                if (!swapResult) {
                    log.error({ event: 'reposition_swap_failed', direction: 'usdc_to_tslax' });
                    alertWarning('REPOSITION_FAILED', 'Failed to swap USDC→TSLAx for reposition');
                    return false;
                }
                tslaxBalance += BigInt(swapResult.tslaxAmount);
            } else if (tslaxDeltaUsd < -1) {
                // Have excess TSLAx — swap some back
                const excessTslax = BigInt(Math.floor((-tslaxDeltaUsd / currentPrice) * 1e8));
                const swapResult = await this.jupiterClient.swapTslaxToUsdc(excessTslax);
                if (!swapResult) {
                    log.warn({ event: 'reposition_swap_failed', direction: 'tslax_to_usdc' });
                    // Non-fatal: just open with current balance
                }
            }

            // Re-read USDC balance after any swaps
            try {
                const usdcAta = await getAssociatedTokenAddress(config.USDC_MINT, this.wallet!.publicKey);
                const info = await connection.getTokenAccountBalance(usdcAta);
                usdcBalance = BigInt(info.value.amount);
            } catch { /* use previous */ }

            // Step 6: Open new LP at current price
            const lpResult = await this.lpClient.openPosition(
                tslaxBalance,
                usdcBalance,
                config.RANGE_WIDTH_PERCENT
            );

            if (!lpResult) {
                log.error({ event: 'reposition_open_failed' });
                alertWarning('REPOSITION_FAILED', 'Failed to open new LP position');
                return false;
            }

            // Reset out-of-range tracking
            this.state = await transitionState(this.state!, this.state!.currentState, {
                outOfRangeSince: null,
            });

            alertInfo('LP_REPOSITIONED', `Repositioned LP at $${currentPrice.toFixed(2)} ±${(config.RANGE_WIDTH_PERCENT * 100).toFixed(1)}%`);
            log.info({
                event: 'reposition_complete',
                newLpTx: lpResult.txSignature,
                price: currentPrice,
                range: config.RANGE_WIDTH_PERCENT,
            });

            return true;
        } catch (error) {
            log.error({
                event: 'reposition_error',
                error: error instanceof Error ? error.message : String(error),
            });
            alerts.txFailure('reposition', error instanceof Error ? error.message : String(error));
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
        if (!this.lpClient || !this.jupiterClient || !this.flashTradeClient || !this.wallet) {
            log.error({ event: 'bootstrap_failed', error: 'Clients not initialized' });
            return false;
        }

        const rangePercent = config.BOOTSTRAP_LP_RANGE_PERCENT;
        const leverage = config.DEFAULT_LEVERAGE;

        // Fetch actual USDC balance from wallet
        const connection = getRpcManager().getConnection();
        const usdcMint = config.USDC_MINT;

        let usdcBalanceMicro: bigint;
        try {
            const { getAssociatedTokenAddress } = await import('@solana/spl-token');
            const usdcAta = await getAssociatedTokenAddress(usdcMint, this.wallet.publicKey);
            const accountInfo = await connection.getTokenAccountBalance(usdcAta);
            usdcBalanceMicro = BigInt(accountInfo.value.amount);
        } catch (error) {
            log.error({ event: 'bootstrap_failed', error: 'Could not fetch USDC balance' });
            return false;
        }

        const totalCapitalUsd = Number(usdcBalanceMicro) / 1_000_000; // Convert from micro to USD

        // Minimum viable amount check
        const minRequired = 1; // At least $1 needed for meaningful position
        if (totalCapitalUsd < minRequired) {
            log.warn({
                event: 'bootstrap_skipped',
                reason: 'insufficient_usdc',
                available: totalCapitalUsd.toFixed(2),
                required: minRequired,
            });
            return false;
        }

        // Calculate capital allocation using ratio-aware LP math:
        // First, determine what % of LP value should be TSLAx vs USDC based on tick range
        const { tokenARatio, tokenBRatio } = this.lpClient.calculateTokenRatio(rangePercent);

        // LP value = total capital minus hedge collateral
        // Hedge collateral = LP value / leverage
        // So: LP value = totalCapital / (1 + 1/leverage)
        const lpValueUsd = totalCapitalUsd / (1 + 1 / leverage);
        const hedgeCollateralUsd = lpValueUsd / leverage;

        // Now split LP value according to actual ratio
        const targetTslaxUsd = lpValueUsd * tokenARatio;
        const targetUsdcForLp = lpValueUsd * tokenBRatio;

        // Add slippage buffer (2%) - swap slightly more to ensure we have enough
        const slippageBuffer = 1.02;
        const swapAmountUsd = targetTslaxUsd * slippageBuffer;

        log.info({
            event: 'bootstrap_starting',
            walletUsdcBalance: totalCapitalUsd.toFixed(2),
            lpValueUsd: lpValueUsd.toFixed(2),
            hedgeCollateralUsd: hedgeCollateralUsd.toFixed(2),
            tokenARatio: tokenARatio.toFixed(4),
            tokenBRatio: tokenBRatio.toFixed(4),
            targetTslaxUsd: targetTslaxUsd.toFixed(2),
            targetUsdcForLp: targetUsdcForLp.toFixed(2),
            swapAmountUsd: swapAmountUsd.toFixed(2),
            slippageBuffer,
            leverage,
            currentPrice,
            rangePercent,
        });

        try {
            // Step 0: Ensure we have enough SOL for rent/fees
            const hasSol = await this.jupiterClient.ensureSolBalance();
            if (!hasSol) {
                log.error({ event: 'bootstrap_failed', reason: 'insufficient_sol_for_rent' });
                alertWarning('BOOTSTRAP_FAILED', 'Could not ensure SOL balance for rent');
                return false;
            }

            // Step 1: Check existing TSLAx balance
            const { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');

            let existingTslax: bigint = 0n;
            try {
                // TSLAx is Token2022
                const tslaxAta = await getAssociatedTokenAddress(
                    config.TSLAX_MINT,
                    this.wallet.publicKey,
                    false,
                    TOKEN_2022_PROGRAM_ID
                );
                const tslaxInfo = await connection.getTokenAccountBalance(tslaxAta);
                existingTslax = BigInt(tslaxInfo.value.amount);
            } catch {
                existingTslax = 0n; // No TSLAx account exists
            }

            // TSLAx has 8 decimals - calculate existing value in USD
            const existingTslaxUsd = (Number(existingTslax) / 1e8) * currentPrice;

            // Delta = how much more TSLAx we need (targetTslaxUsd already includes slippage buffer)
            const deltaUsd = swapAmountUsd - existingTslaxUsd;

            log.info({
                event: 'bootstrap_capital_check',
                existingTslaxRaw: existingTslax.toString(),
                existingTslaxUsd: existingTslaxUsd.toFixed(2),
                targetTslaxUsd: swapAmountUsd.toFixed(2),
                deltaUsd: deltaUsd.toFixed(2),
            });

            let tslaxAmount: bigint;

            if (deltaUsd > 0.50) {
                // Need more TSLAx - swap only the delta needed
                const swapAmountMicro = BigInt(Math.floor(deltaUsd * 1_000_000));
                log.info({
                    event: 'bootstrap_swapping_delta',
                    amountUsd: deltaUsd.toFixed(2),
                    msg: 'Swapping only the additional amount needed'
                });

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

                // Total TSLAx = existing + newly swapped
                tslaxAmount = existingTslax + BigInt(swapResult.tslaxAmount);
            } else if (deltaUsd < -0.50) {
                // Have excess TSLAx - could swap some back, but for now just use what we have
                log.info({
                    event: 'bootstrap_excess_tslax',
                    excessUsd: (-deltaUsd).toFixed(2),
                    msg: 'Using existing TSLAx without additional swap'
                });
                tslaxAmount = existingTslax;
            } else {
                // Close enough - use existing without swap
                log.info({
                    event: 'bootstrap_using_existing',
                    msg: 'Existing TSLAx matches target, no swap needed'
                });
                tslaxAmount = existingTslax;
            }

            // Recalculate USDC needed for LP based on actual TSLAx we have
            // LP should be balanced, so USDC side should match TSLAx value
            const actualTslaxValueUsd = (Number(tslaxAmount) / 1e8) * currentPrice;

            // Step 2: Open LP position
            // Pass all available USDC as max - SDK will calculate exact amount needed
            // based on TSLAx amount and tick range
            const availableUsdcMicro = usdcBalanceMicro - BigInt(Math.floor(hedgeCollateralUsd * 1_000_000));

            log.info({
                event: 'bootstrap_opening_lp',
                tslaxAmount: tslaxAmount.toString(),
                availableUsdcForLp: availableUsdcMicro.toString(),
                actualTslaxValueUsd: actualTslaxValueUsd.toFixed(2),
                rangePercent,
            });

            const lpResult = await this.lpClient.openPosition(
                tslaxAmount,
                availableUsdcMicro, // Pass max available, SDK calculates exact
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
            // Hedge size should match ACTUAL TSLAx value
            const hedgeSize = actualTslaxValueUsd;
            const collateral = Math.min(hedgeCollateralUsd, hedgeSize / config.DEFAULT_LEVERAGE);

            log.info({
                event: 'bootstrap_opening_hedge',
                actualTslaxValueUsd: actualTslaxValueUsd.toFixed(2),
                hedgeSizeUsd: hedgeSize.toFixed(2),
                collateralUsd: collateral.toFixed(2),
            });

            const hedgeResult = await this.flashTradeClient.openShortPosition(
                hedgeSize,
                collateral,
                config.MAX_SLIPPAGE_BPS
            );

            if (!hedgeResult) {
                log.error({ event: 'bootstrap_hedge_failed' });
                alertWarning('BOOTSTRAP_FAILED', 'Failed to open hedge position');
                // LP is already open - next cycle will detect imbalance
                return false;
            }

            log.info({
                event: 'bootstrap_hedge_opened',
                txSignature: hedgeResult.txSignature,
            });

            // Mark bootstrap as complete
            this.hasBootstrapped = true;

            alertInfo('BOOTSTRAP_COMPLETE', `Initial position created: $${totalCapitalUsd.toFixed(2)} deployed`);
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
    }/**
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
