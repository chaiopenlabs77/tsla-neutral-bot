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
                    log.warn({
                        event: 'rebalance_skipped',
                        reason: 'insufficient_collateral',
                        required: requiredCollateral.toFixed(2),
                        available: availableUsdc.toFixed(2),
                    });
                    alertWarning('REBALANCE_BLOCKED', `Insufficient USDC: need $${requiredCollateral.toFixed(2)}, have $${availableUsdc.toFixed(2)}`);
                    return false;
                }
            } catch (error) {
                log.warn({ event: 'rebalance_balance_check_failed', error: String(error) });
                // Continue anyway - Flash Trade will fail if insufficient
            }
        }

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
            // TSLAx has 8 decimals, USDC has 6 decimals
            // USDC side should match TSLAx value for balanced LP
            const usdcAmountMicro = BigInt(Math.floor(actualTslaxValueUsd * 1_000_000));

            log.info({
                event: 'bootstrap_opening_lp',
                tslaxAmount: tslaxAmount.toString(),
                usdcAmount: usdcAmountMicro.toString(),
                rangePercent,
            });

            const lpResult = await this.lpClient.openPosition(
                tslaxAmount,
                usdcAmountMicro,
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
