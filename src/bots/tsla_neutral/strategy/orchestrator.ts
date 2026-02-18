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
import { evaluateRebalance, checkLiquidationRisk } from './risk_manager';
import { loggers, logMetricsSnapshot } from '../observability/logger';
import { rebalanceCounter } from '../observability/metrics';
import { alerts, alertInfo, alertWarning } from '../observability/alerter';
import { isShutdownInProgress, onShutdown } from '../utils/shutdown';
import { sleep, Backoff } from '../utils/backoff';
import { getMonotonicTime, isUSMarketOpen } from '../utils/clock';
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
    private recoveryAttempts = 0;
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

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
            const response = await fetch(`${RAYDIUM_API}/pools/info/ids?ids=${POOL_ID}`, { signal: controller.signal });
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
        } finally {
            clearTimeout(timeout);
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

            // Wait for next cycle — slow down to 60s when market is closed (saves RPC quota)
            const cycleDuration = getMonotonicTime() - cycleStart;
            const interval = isUSMarketOpen() ? config.LOOP_INTERVAL_MS : 60_000;
            const sleepTime = Math.max(0, interval - cycleDuration);

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

        // Skip expensive network calls when US stock market is closed
        // (Pyth TSLA feed only publishes during NYSE hours — will always be stale otherwise)
        if (!isUSMarketOpen()) {
            log.debug({ event: 'market_closed_skip', et: this.getCurrentET() });
            return;
        }

        // 0. Proactively ensure SOL balance for gas (tops up early so swaps never fail)
        if (this.jupiterClient) {
            await this.jupiterClient.ensureSolBalance();
        }

        // 1. Fetch TSLA price from Pyth (with staleness check)
        let tslaPrice = 0;
        try {
            const priceData = await this.pythClient.getTSLAPrice();
            if (priceData) {
                const ageMs = Date.now() - (priceData.publishTime * 1000);
                if (ageMs > config.PYTH_MAX_STALENESS_MS) {
                    log.warn({ event: 'pyth_price_stale', ageMs, price: priceData.price, maxAge: config.PYTH_MAX_STALENESS_MS });
                    return; // Skip cycle — stale price is dangerous for position decisions
                }
                tslaPrice = priceData.price;
                log.debug({ event: 'pyth_price_fetched', price: tslaPrice, confidence: priceData.confidence, ageMs });
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
        // CRITICAL: If fetch fails, skip cycle — never assume empty positions (causes duplicates)
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
                log.error({ event: 'lp_fetch_critical', error: error instanceof Error ? error.message : String(error) });
                return; // Skip cycle — RPC failure must NOT assume empty positions
            }
        }

        // 3. Fetch hedge positions and calculate delta
        // CRITICAL: If fetch fails, skip cycle — never assume empty positions (causes duplicates)
        let hedgeDelta = 0;
        let hedgePositions: HedgePosition[] = [];
        if (this.flashTradeClient) {
            try {
                hedgePositions = await this.flashTradeClient.fetchPositions();
                for (const pos of hedgePositions) {
                    hedgeDelta += this.flashTradeClient.calculatePositionDelta(pos);
                }
                log.debug({ event: 'hedge_positions_fetched', count: hedgePositions.length, totalDelta: hedgeDelta });

                // Check liquidation risk on all hedge positions
                for (const pos of hedgePositions) {
                    if (pos.liquidationPrice > 0 && tslaPrice > 0) {
                        const { isAtRisk, distancePercent } = checkLiquidationRisk(tslaPrice, pos.liquidationPrice, pos.side as 'SHORT' | 'LONG');
                        if (isAtRisk) {
                            alertWarning('LIQUIDATION_RISK', `${pos.side} liq $${pos.liquidationPrice.toFixed(2)} (${(distancePercent * 100).toFixed(1)}% away), price $${tslaPrice.toFixed(2)}`);
                        }
                    }
                }
            } catch (error) {
                log.error({ event: 'hedge_fetch_critical', error: error instanceof Error ? error.message : String(error) });
                return; // Skip cycle — RPC failure must NOT assume empty positions
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

                        if (success) {
                            // After successful reposition, open hedge in the same cycle
                            // (don't wait for next cycle's delta_drift)
                            if (hedgePositions.length === 0 && withinHours) {
                                const newLpPositions = await this.lpClient!.fetchPositions();
                                let newLpDelta = 0;
                                for (const pos of newLpPositions) {
                                    newLpDelta += this.lpClient!.calculatePositionDelta(pos, tslaPrice);
                                }
                                if (newLpDelta > config.MIN_REBALANCE_SIZE_USD) {
                                    log.info({ event: 'post_reposition_hedging', lpDelta: newLpDelta });
                                    await this.executeRebalance(newLpDelta, tslaPrice, []);
                                }
                            }
                        } else if (hedgePositions.length > 0 && withinHours) {
                            // Reposition failed with existing hedge — capital is stuck.
                            // Full reset: close hedge (frees collateral) → close LP → consolidate → re-bootstrap
                            log.info({ event: 'full_reset_triggered', reason: 'reposition_failed_with_hedge' });
                            success = await this.fullPositionReset(tslaPrice, lpPositions);
                        }
                    }
                } else if (!withinHours) {
                    // Hedge rebalance only during market hours (Flash Trade restriction)
                    log.debug({ event: 'hedge_rebalance_deferred', reason: 'outside_market_hours', et: this.getCurrentET() });
                    success = false;
                } else {
                    // Normal delta drift — adjust hedge (market hours only)
                    success = await this.executeRebalance(decision.sizeToAdjust, tslaPrice, hedgePositions);

                    // RECOVERY: If rebalance failed and LP is stranded out of range,
                    // close everything, consolidate capital, and re-bootstrap from scratch
                    if (!success && !isLpInRange) {
                        if (hedgePositions.length === 0) {
                            log.info({ event: 'recovery_triggered', reason: 'cannot_hedge_stranded_lp' });
                            success = await this.recoverStuckPosition(tslaPrice, lpPositions);
                        } else {
                            // Has hedge but can't increase it (no liquid capital) — full reset
                            log.info({ event: 'full_reset_triggered', reason: 'stuck_with_undersized_hedge' });
                            success = await this.fullPositionReset(tslaPrice, lpPositions);
                        }
                    }
                }

                if (success) {
                    rebalanceCounter.inc({ reason: decision.reason, status: 'success' });
                    this.recoveryAttempts = 0; // Reset circuit breaker on success
                    this.state = await transitionState(this.state!, this.state!.currentState, {
                        lastRebalanceTime: Date.now(),
                    });
                } else {
                    rebalanceCounter.inc({ reason: decision.reason, status: 'failure' });

                    // Circuit breaker: if recovery/fullReset keeps failing, stop trying
                    if (decision.reason === 'out_of_range_too_long' || !isLpInRange) {
                        this.recoveryAttempts++;
                        if (this.recoveryAttempts >= config.MAX_RECOVERY_ATTEMPTS) {
                            log.error({
                                event: 'recovery_circuit_breaker',
                                attempts: this.recoveryAttempts,
                                msg: 'Max recovery attempts reached, pausing operations',
                            });
                            alertWarning('CIRCUIT_BREAKER', `Recovery failed ${this.recoveryAttempts} times consecutively — manual intervention needed`);
                            this.state = await transitionState(this.state!, BotState.ERROR_RECOVERY, {
                                consecutiveFailures: this.recoveryAttempts,
                            });
                        }
                    }
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
                            // Get real SOL price from Jupiter
                            let solPrice = 200; // fallback
                            try {
                                solPrice = await this.jupiterClient.getPrice(TOKEN_MINTS.SOL, TOKEN_MINTS.USDC);
                            } catch { /* use fallback */ }
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

                    // Pass proportional collateral for the size increase
                    const additionalCollateral = cappedSize / config.DEFAULT_LEVERAGE;
                    const result = await this.flashTradeClient.increaseShortPosition(
                        existingShort.positionId,
                        cappedSize,
                        config.MAX_SLIPPAGE_BPS,
                        currentPrice,
                        additionalCollateral
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
                const result = await this.flashTradeClient.closePosition(config.MAX_SLIPPAGE_BPS, currentPrice);

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

            // Step 3: Wait for state to settle, reclaim rent SOL
            await sleep(2000);
            if (this.jupiterClient) {
                await this.jupiterClient.ensureSolBalance();
            }

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
            // Use ALL wallet funds — hedge already has its own collateral, no need to reserve
            const { tokenARatio } = this.lpClient.calculateTokenRatio(config.RANGE_WIDTH_PERCENT);
            const totalLpValue = tslaxValueUsd + usdcValueUsd;
            const targetTslaxUsd = totalLpValue * tokenARatio;

            log.info({
                event: 'reposition_compounding',
                totalLpValue: totalLpValue.toFixed(2),
                tslaxHeld: (Number(tslaxBalance) / 1e8).toFixed(8),
                usdcHeld: usdcValueUsd.toFixed(2),
                targetTslaxRatio: tokenARatio.toFixed(4),
            });

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
     * Full position reset: close ALL positions (hedge + LP), consolidate capital, re-bootstrap.
     * Triggered when bot is stuck: has hedge but can't increase it (no liquid capital),
     * LP is out of range, and executeRebalance keeps failing.
     */
    private async fullPositionReset(currentPrice: number, lpPositions: LPPosition[]): Promise<boolean> {
        if (!this.flashTradeClient || !this.lpClient || !this.jupiterClient || !this.wallet) {
            log.error({ event: 'full_reset_failed', error: 'Clients not initialized' });
            return false;
        }

        log.info({
            event: 'full_reset_starting',
            reason: 'stuck_with_hedge_and_oor_lp',
            lpPositionCount: lpPositions.length,
            currentPrice,
        });

        try {
            // Step 1: Close ALL hedge positions (frees USDC collateral back to wallet)
            const hedgeResult = await this.flashTradeClient.closePosition(config.MAX_SLIPPAGE_BPS, currentPrice);
            if (!hedgeResult) {
                log.error({ event: 'full_reset_close_hedge_failed' });
                alertWarning('FULL_RESET_FAILED', 'Could not close hedge position');
                return false;
            }
            log.info({ event: 'full_reset_hedge_closed', tx: hedgeResult.txSignature });

            await sleep(2000);

            // Step 2: Now that hedge is closed, use existing recovery flow
            // (closes LP → consolidates tokens → re-bootstraps)
            const recoveryResult = await this.recoverStuckPosition(currentPrice, lpPositions);

            if (recoveryResult) {
                alertInfo('FULL_RESET_COMPLETE', `Full position reset at $${currentPrice.toFixed(2)}`);
            }

            return recoveryResult;
        } catch (error) {
            log.error({
                event: 'full_reset_error',
                error: error instanceof Error ? error.message : String(error),
            });
            alerts.txFailure('full_reset', error instanceof Error ? error.message : String(error));
            return false;
        }
    }

    /**
     * Recovery: Close stranded out-of-range LP, swap TSLAx → USDC, and re-bootstrap.
     * Triggered when LP is out of range, no hedge exists, and we can't open a hedge
     * because there's insufficient liquid capital (USDC/SOL).
     */
    private async recoverStuckPosition(currentPrice: number, lpPositions: LPPosition[]): Promise<boolean> {
        if (!this.lpClient || !this.jupiterClient || !this.wallet) {
            log.error({ event: 'recovery_failed', error: 'Clients not initialized' });
            return false;
        }

        log.info({
            event: 'recovery_starting',
            reason: 'out_of_range_no_hedge_insufficient_capital',
            lpPositionCount: lpPositions.length,
            currentPrice,
        });

        try {
            // Step 1: Close all LP positions to free capital
            for (const pos of lpPositions) {
                const closeResult = await this.lpClient.closePosition(pos.mint);
                if (!closeResult) {
                    log.error({ event: 'recovery_close_lp_failed', mint: pos.mint.toBase58() });
                    alertWarning('RECOVERY_FAILED', 'Failed to close stranded LP position');
                    return false;
                }
                log.info({ event: 'recovery_lp_closed', tx: closeResult.txSignature });
            }

            await sleep(2000);

            // After closing LP, we recover rent SOL — ensure balance is topped up
            if (this.jupiterClient) {
                await this.jupiterClient.ensureSolBalance();
            }

            // Step 2: Swap TSLAx → USDC as needed for hedge collateral + LP USDC side
            const { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
            const connection = getRpcManager().getConnection();

            let tslaxBalance = 0n;
            try {
                const tslaxAta = await getAssociatedTokenAddress(
                    config.TSLAX_MINT, this.wallet.publicKey, false, TOKEN_2022_PROGRAM_ID
                );
                const info = await connection.getTokenAccountBalance(tslaxAta);
                tslaxBalance = BigInt(info.value.amount);
            } catch { tslaxBalance = 0n; }

            // Check how much USDC we already have
            let usdcBalance = 0;
            try {
                const usdcAta = await getAssociatedTokenAddress(config.USDC_MINT, this.wallet.publicKey);
                const info = await connection.getTokenAccountBalance(usdcAta);
                usdcBalance = Number(info.value.amount) / 1e6;
            } catch { usdcBalance = 0; }

            // Calculate how much USDC we need for bootstrap:
            // bootstrapPosition will need USDC for hedge collateral + LP USDC side
            // LP uses tokenBRatio of capital as USDC, hedge uses 1/leverage of LP value
            const tslaxValueUsd = (Number(tslaxBalance) / 1e8) * currentPrice;
            const totalCapital = tslaxValueUsd + usdcBalance;
            const { tokenBRatio } = this.lpClient.calculateTokenRatio(config.RANGE_WIDTH_PERCENT);
            const lpValue = totalCapital / (1 + 1 / config.DEFAULT_LEVERAGE);
            const hedgeCollateral = lpValue / config.DEFAULT_LEVERAGE;
            const usdcNeeded = lpValue * tokenBRatio + hedgeCollateral;
            const usdcShortfall = usdcNeeded - usdcBalance;

            if (tslaxBalance > 0n && usdcShortfall > 0.50) {
                // Only swap enough TSLAx to cover the USDC shortfall (not all of it)
                const tslaxToSwap = Math.min(
                    Number(tslaxBalance),
                    Math.ceil((usdcShortfall * 1.05 / currentPrice) * 1e8) // 5% buffer
                );
                const swapAmount = BigInt(tslaxToSwap);

                log.info({
                    event: 'recovery_swapping_tslax',
                    tslaxBalance: tslaxBalance.toString(),
                    tslaxToSwap: swapAmount.toString(),
                    usdcShortfall: usdcShortfall.toFixed(2),
                    estimatedUsd: ((tslaxToSwap / 1e8) * currentPrice).toFixed(2),
                });

                const swapResult = await this.jupiterClient.swapTslaxToUsdc(swapAmount);
                if (swapResult) {
                    log.info({
                        event: 'recovery_tslax_swapped',
                        tx: swapResult.txSignature,
                        usdcReceived: swapResult.usdcAmount,
                    });
                } else {
                    log.warn({ event: 'recovery_tslax_swap_failed' });
                    // Non-fatal: bootstrap will work with whatever capital is available
                }
            }

            await sleep(2000);

            // Step 3: Re-bootstrap (LP + hedge) with recovered capital
            // bootstrapPosition handles TSLAx/USDC ratio internally
            this.hasBootstrapped = false; // Allow bootstrap to run
            const success = await this.bootstrapPosition(currentPrice);

            if (success) {
                alertInfo('POSITION_RECOVERED', `Recovered stuck position at $${currentPrice.toFixed(2)}`);
                log.info({ event: 'recovery_complete', price: currentPrice });
            } else {
                log.warn({ event: 'recovery_bootstrap_failed' });
            }

            return success;
        } catch (error) {
            log.error({
                event: 'recovery_error',
                error: error instanceof Error ? error.message : String(error),
            });
            alerts.txFailure('recovery', error instanceof Error ? error.message : String(error));
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
            // Pass ALL USDC as max — SDK uses only what's needed for the tick range.
            // Remaining USDC after LP open is used for hedge collateral.
            log.info({
                event: 'bootstrap_opening_lp',
                tslaxAmount: tslaxAmount.toString(),
                availableUsdcForLp: usdcBalanceMicro.toString(),
                actualTslaxValueUsd: actualTslaxValueUsd.toFixed(2),
                rangePercent,
            });

            const lpResult = await this.lpClient.openPosition(
                tslaxAmount,
                usdcBalanceMicro, // All USDC as max, SDK calculates exact needed
                rangePercent
            );

            if (!lpResult) {
                log.error({ event: 'bootstrap_lp_failed' });
                alertWarning('BOOTSTRAP_FAILED', 'Failed to open LP position');
                return false;
            }

            // Mark bootstrap as complete AFTER LP opens — prevents duplicate LP creation
            // even if hedge fails. Delta drift will catch the missing hedge next cycle.
            this.hasBootstrapped = true;

            log.info({
                event: 'bootstrap_lp_opened',
                txSignature: lpResult.txSignature,
            });

            // Step 3: Open matching hedge using remaining USDC as collateral
            // Re-read USDC balance — LP consumed some, remainder is for hedge
            let remainingUsdc = 0;
            try {
                const { getAssociatedTokenAddress: getAta } = await import('@solana/spl-token');
                const usdcAta = await getAta(config.USDC_MINT, this.wallet.publicKey);
                const info = await connection.getTokenAccountBalance(usdcAta);
                remainingUsdc = Number(info.value.amount) / 1e6;
            } catch { remainingUsdc = 0; }

            const hedgeSize = actualTslaxValueUsd;
            const collateral = Math.min(remainingUsdc * 0.95, hedgeSize / config.DEFAULT_LEVERAGE); // Leave 5% buffer

            log.info({
                event: 'bootstrap_opening_hedge',
                actualTslaxValueUsd: actualTslaxValueUsd.toFixed(2),
                hedgeSizeUsd: hedgeSize.toFixed(2),
                collateralUsd: collateral.toFixed(2),
                remainingUsdc: remainingUsdc.toFixed(2),
            });

            if (collateral < 0.50) {
                log.warn({ event: 'bootstrap_hedge_skipped', reason: 'insufficient_collateral', remaining: remainingUsdc.toFixed(2) });
                alertWarning('BOOTSTRAP_PARTIAL', 'LP opened but not enough USDC for hedge');
                return false;
            }

            const hedgeResult = await this.flashTradeClient.openShortPosition(
                hedgeSize,
                collateral,
                config.MAX_SLIPPAGE_BPS,
                currentPrice
            );

            if (!hedgeResult) {
                log.error({ event: 'bootstrap_hedge_failed' });
                alertWarning('BOOTSTRAP_PARTIAL', 'LP opened but hedge failed — delta drift will retry');
                // LP is already open - next cycle will detect imbalance
                return false;
            }

            log.info({
                event: 'bootstrap_hedge_opened',
                txSignature: hedgeResult.txSignature,
            });

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
