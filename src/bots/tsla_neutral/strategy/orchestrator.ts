import { config } from '../config';
import { BotState, StateMachineState, CycleMetrics, HedgePosition } from '../types';
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

    // EOD tracking
    private eodUnwindCompleted = false;
    private lastTradingDay = '';

    constructor() {
        this.pythClient = new PythClient();
        this.dataCollector = getDataCollector();
    }

    /**
     * Check if current time is within trading hours (9:15 AM - 3:45 PM ET).
     */
    private isWithinTradingHours(): boolean {
        const now = new Date();
        // Convert to ET (handle DST automatically)
        const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const hour = et.getHours();
        const minute = et.getMinutes();
        const currentMinutes = hour * 60 + minute;

        const openMinutes = config.MARKET_OPEN_HOUR_ET * 60 + config.MARKET_OPEN_MINUTE_ET;
        const closeMinutes = config.MARKET_CLOSE_HOUR_ET * 60 + config.MARKET_CLOSE_MINUTE_ET;

        // Check if weekend
        const dayOfWeek = et.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            return false;
        }

        return currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
    }

    /**
     * Check if it's time to open positions (at market open time).
     */
    private shouldOpenPosition(): boolean {
        const now = new Date();
        const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const hour = et.getHours();
        const minute = et.getMinutes();

        // Check if it's market open time (within first 5 minutes of trading window)
        const openHour = config.MARKET_OPEN_HOUR_ET;
        const openMinute = config.MARKET_OPEN_MINUTE_ET;

        return hour === openHour && minute >= openMinute && minute <= openMinute + 5;
    }

    /**
     * Check if it's time to unwind (at market close time).
     */
    private shouldUnwind(): boolean {
        const now = new Date();
        const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const today = et.toISOString().split('T')[0];

        // Reset flag for new day
        if (this.lastTradingDay !== today) {
            this.lastTradingDay = today;
            this.eodUnwindCompleted = false;
        }

        // Already unwound today
        if (this.eodUnwindCompleted) {
            return false;
        }

        const hour = et.getHours();
        const minute = et.getMinutes();

        // Check if it's within 5 minutes of close time (3:45-3:50 PM)
        const closeHour = config.MARKET_CLOSE_HOUR_ET;
        const closeMinute = config.MARKET_CLOSE_MINUTE_ET;

        return hour === closeHour && minute >= closeMinute && minute <= closeMinute + 5;
    }

    /**
     * Get current ET time string for logging.
     */
    private getCurrentET(): string {
        const now = new Date();
        return now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true });
    }

    /**
     * Perform End-of-Day unwind: close all positions and swap TSLAx to USDC.
     */
    private async performEodUnwind(): Promise<void> {
        log.info({ event: 'eod_unwind_starting', et: this.getCurrentET() });

        // Get current price for slippage calculations
        let currentPrice = 0;
        try {
            const priceData = await this.pythClient.getTSLAPrice();
            if (priceData) {
                currentPrice = priceData.price;
            }
        } catch (error) {
            log.warn({ event: 'pyth_price_error_eod', error: String(error) });
        }

        // 1. Close Flash Trade hedge positions
        if (this.flashTradeClient) {
            try {
                log.info({ event: 'eod_closing_flash_trade' });
                const result = await this.flashTradeClient.closePosition(config.MAX_SLIPPAGE_BPS, currentPrice || undefined);
                if (result) {
                    log.info({ event: 'flash_trade_closed', tx: result.txSignature });
                }
            } catch (error) {
                log.error({ event: 'flash_trade_close_error', error: String(error) });
            }
        }

        // 2. Close LP positions
        if (this.lpClient) {
            try {
                log.info({ event: 'eod_closing_lp_positions' });
                const positions = await this.lpClient.fetchPositions();
                for (const pos of positions) {
                    // LPPosition.mint is the NFT mint for the position
                    const result = await this.lpClient.closePosition(pos.mint);
                    if (result) {
                        log.info({ event: 'lp_position_closed', tx: result.txSignature });
                    }
                }
            } catch (error) {
                log.error({ event: 'lp_close_error', error: String(error) });
            }
        }

        // 3. Swap any remaining TSLAx to USDC
        if (this.jupiterClient && this.wallet) {
            try {
                // Get TSLAx balance via SPL token balance check
                const tslaxMint = new PublicKey(TOKEN_MINTS.TSLAX);
                const tokenAccounts = await this.jupiterClient['connection'].getTokenAccountsByOwner(
                    this.wallet.publicKey,
                    { mint: tslaxMint }
                );

                let tslaxBalance = 0n;
                if (tokenAccounts.value.length > 0) {
                    const accountInfo = tokenAccounts.value[0];
                    const data = accountInfo.account.data;
                    // SPL token amount is at offset 64, 8 bytes
                    tslaxBalance = data.readBigUInt64LE(64);
                }

                if (tslaxBalance > 1000n) { // Only swap if significant (> 0.001 TSLAx)
                    log.info({ event: 'eod_swapping_tslax', balance: Number(tslaxBalance) / 1e6 });
                    const result = await this.jupiterClient.swapTslaxToUsdc(
                        tslaxBalance,
                        config.EOD_SWAP_MAX_SLIPPAGE_PERCENT * 100 // Convert to bps
                    );
                    if (result) {
                        log.info({ event: 'tslax_swapped', tx: result.txSignature });
                    }
                }
            } catch (error) {
                log.error({ event: 'tslax_swap_error', error: String(error) });
            }
        }

        // Reset bootstrap flag for next day
        this.hasBootstrapped = false;

        log.info({ event: 'eod_unwind_complete' });
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
        const withinHours = this.isWithinTradingHours();

        // Check if it's time for EOD unwind
        if (this.shouldUnwind()) {
            log.info({ event: 'eod_unwind_triggered', et: this.getCurrentET() });
            await this.performEodUnwind();
            this.eodUnwindCompleted = true;
            return;
        }

        // Outside trading hours - just monitor
        if (!withinHours) {
            log.debug({ event: 'outside_trading_hours', et: this.getCurrentET(), nextOpen: `${config.MARKET_OPEN_HOUR_ET}:${config.MARKET_OPEN_MINUTE_ET}` });
            return;
        }

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
            const success = await this.executeRebalance(decision.sizeToAdjust, tslaPrice, hedgePositions);

            if (success) {
                rebalanceCounter.inc({ reason: decision.reason, status: 'success' });
            } else {
                rebalanceCounter.inc({ reason: decision.reason, status: 'failure' });
            }
        }

        // 7. Record cycle data for analysis
        this.dataCollector.recordCycle({
            timestamp: Date.now(),
            tslaPrice,
            lpDelta,
            hedgeDelta,
            netDelta: decision.currentDelta,
            isLpInRange,
            poolApr: 0, // TODO: Fetch from Raydium API periodically
            poolTvl: 0,
            rebalanceTriggered: decision.shouldRebalance && !decision.blocked,
            rebalanceReason: decision.reason,
            rebalanceSizeUsd: decision.sizeToAdjust,
            gasCostUsd: estimatedGasCost * 200, // Rough SOL to USD
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
        const minRequired = 5; // At least $5 needed for meaningful position
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
