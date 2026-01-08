/**
 * Flash Trade Perp Client
 *
 * Handles interactions with Flash Trade perpetual futures on Solana.
 * Uses the official flash-sdk for position management.
 *
 * NOTE: Flash Trade SDK returns instructions that must be assembled into
 * transactions. For production, you'll need to:
 * 1. Set up the Anchor provider with your wallet
 * 2. Build versioned transactions from the instructions
 * 3. Sign and submit via Jito bundles
 *
 * @see https://github.com/flash-trade/flash-sdk
 */

import { Connection, PublicKey, Keypair, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { config } from '../config';
import { HedgePosition } from '../types';
import { loggers } from '../observability/logger';
import { hedgeValueGauge, liquidationDistanceGauge } from '../observability/metrics';
import { alerts } from '../observability/alerter';

const log = loggers.hedge;

// Flash Trade program IDs (mainnet)
const FLASH_PROGRAM_ID = new PublicKey('PERP9EeXeGnyEqGhfphDnT7NjiEN14LoGHFnGkBdbbL3');

// Pool configuration
const TSLA_POOL_NAME = 'TSLA';
const COLLATERAL_SYMBOL = 'USDC';

// Market info interface
interface FlashTradeMarket {
    marketId: string;
    baseAsset: string;
    maxLeverage: number;
    minPositionSize: number;
    positionIncrement: number;
    fundingInterval: number;
    nextFundingTime: number;
}

/**
 * Flash Trade Perpetuals Client
 *
 * Provides methods to interact with Flash Trade for hedging TSLA exposure.
 * In production, this would use the flash-sdk PerpetualsClient to build
 * instructions and submit via Jito bundles.
 */
export class FlashTradeClient {
    private connection: Connection;
    private wallet: Keypair | null = null;
    private marketInfo: FlashTradeMarket | null = null;
    private isInitialized = false;

    constructor(connection: Connection) {
        this.connection = connection;
    }

    /**
     * Initialize the client with a wallet.
     *
     * Production implementation:
     * ```typescript
     * import { PerpetualsClient, PoolConfig } from 'flash-sdk';
     * import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
     *
     * const provider = new AnchorProvider(connection, new Wallet(wallet), {});
     * this.perpClient = new PerpetualsClient(provider, FLASH_PROGRAM_ID, ...);
     * this.poolConfig = PoolConfig.fromIdsByName('TSLA', 'mainnet-beta');
     * await this.perpClient.loadAddressLookupTable(this.poolConfig);
     * ```
     */
    async initialize(wallet: Keypair): Promise<void> {
        if (this.isInitialized) return;

        log.info({ event: 'initializing_flash_trade_client' });
        this.wallet = wallet;

        // Fetch market info
        await this.fetchMarketInfo();

        this.isInitialized = true;
        log.info({
            event: 'flash_trade_client_initialized',
            pool: TSLA_POOL_NAME,
            programId: FLASH_PROGRAM_ID.toBase58(),
        });
    }

    /**
     * Fetch market parameters.
     */
    async fetchMarketInfo(): Promise<FlashTradeMarket> {
        log.info({ event: 'fetching_market_info', market: TSLA_POOL_NAME });

        // In production, use:
        // const pool = await this.perpClient.getPool(TSLA_POOL_NAME);
        // const custody = await this.perpClient.getCustody(pool, COLLATERAL_SYMBOL);

        this.marketInfo = {
            marketId: TSLA_POOL_NAME,
            baseAsset: 'TSLA',
            maxLeverage: 10,
            minPositionSize: 0.001,
            positionIncrement: 0.001,
            fundingInterval: 3600,
            nextFundingTime: Math.floor(Date.now() / 1000) + 1800,
        };

        return this.marketInfo;
    }

    /**
     * Fetch user's open positions.
     *
     * Production implementation:
     * ```typescript
     * const positions = await this.perpClient.program.account.position.all([
     *   { memcmp: { offset: 8, bytes: walletAddress.toBase58() } }
     * ]);
     * ```
     */
    async fetchPositions(walletAddress: PublicKey): Promise<HedgePosition[]> {
        log.info({ event: 'fetching_hedge_positions', wallet: walletAddress.toBase58() });

        // In production, this would query the Flash Trade program
        // Placeholder returns empty for dry run
        const positions: HedgePosition[] = [];

        log.info({ event: 'hedge_positions_fetched', count: positions.length });
        return positions;
    }

    /**
     * Open a short position on TSLA.
     *
     * Production implementation:
     * ```typescript
     * const { instructions, additionalSigners } = await this.perpClient.openPosition(
     *   TSLA_POOL_NAME, COLLATERAL_SYMBOL, priceWithSlippage,
     *   collateralBN, sizeBN, { short: {} }, poolConfig, { none: {} }
     * );
     * // Build versioned TX from instructions
     * // Submit via Jito bundle
     * ```
     */
    async openShortPosition(
        sizeUsd: number,
        collateralUsd: number,
        maxSlippageBps: number = config.MAX_SLIPPAGE_BPS
    ): Promise<{ txSignature: string } | null> {
        this.ensureInitialized();

        log.info({
            event: 'opening_short_position',
            sizeUsd,
            collateralUsd,
            maxSlippageBps,
        });

        if (config.DRY_RUN) {
            log.info({
                event: 'dry_run_open_short',
                msg: `Would open SHORT: $${sizeUsd} TSLA with $${collateralUsd} collateral`,
            });
            return { txSignature: 'dry-run-signature' };
        }

        // Production: Build and submit TX
        throw new Error('Live trading requires Flash Trade SDK integration. See code comments.');
    }

    /**
     * Close an existing position.
     */
    async closePosition(positionId: string): Promise<{ txSignature: string } | null> {
        this.ensureInitialized();

        log.info({ event: 'closing_position', positionId });

        if (config.DRY_RUN) {
            log.info({
                event: 'dry_run_close_position',
                msg: `Would close position: ${positionId}`,
            });
            return { txSignature: 'dry-run-signature' };
        }

        throw new Error('Live trading requires Flash Trade SDK integration. See code comments.');
    }

    /**
     * Adjust position size.
     */
    async adjustPositionSize(
        positionId: string,
        sizeDeltaUsd: number
    ): Promise<{ txSignature: string } | null> {
        this.ensureInitialized();

        log.info({ event: 'adjusting_position', positionId, sizeDeltaUsd });

        if (config.DRY_RUN) {
            log.info({
                event: 'dry_run_adjust_position',
                msg: `Would adjust position ${positionId} by $${sizeDeltaUsd}`,
            });
            return { txSignature: 'dry-run-signature' };
        }

        throw new Error('Live trading requires Flash Trade SDK integration.');
    }

    private ensureInitialized(): void {
        if (!this.isInitialized) {
            throw new Error('FlashTradeClient not initialized. Call initialize() first.');
        }
    }

    /**
     * Calculate position delta (exposure).
     */
    calculatePositionDelta(position: HedgePosition): number {
        const notionalValue = position.size * position.entryPrice;
        return position.side === 'SHORT' ? -notionalValue : notionalValue;
    }

    /**
     * Check liquidation risk.
     */
    checkLiquidationRisk(
        position: HedgePosition,
        currentPrice: number
    ): { isAtRisk: boolean; distancePercent: number } {
        let distancePercent: number;

        if (position.side === 'SHORT') {
            distancePercent = (position.liquidationPrice - currentPrice) / currentPrice;
        } else {
            distancePercent = (currentPrice - position.liquidationPrice) / currentPrice;
        }

        const isAtRisk = distancePercent <= config.LIQUIDATION_WARNING_PERCENT;
        liquidationDistanceGauge.set(distancePercent * 100);

        if (isAtRisk) {
            log.warn({
                event: 'liquidation_warning',
                positionId: position.positionId,
                currentPrice,
                liquidationPrice: position.liquidationPrice,
                distancePercent,
            });
            alerts.liquidationWarning(distancePercent, position.liquidationPrice, currentPrice);
        }

        return { isAtRisk, distancePercent };
    }

    /**
     * Get time until next funding settlement.
     */
    getTimeUntilFunding(): number {
        if (!this.marketInfo) return 0;
        const now = Math.floor(Date.now() / 1000);
        return Math.max(0, this.marketInfo.nextFundingTime - now) * 1000;
    }

    /**
     * Check if we should avoid trading near funding time.
     */
    isNearFundingTime(bufferMs: number = 300000): boolean {
        return this.getTimeUntilFunding() < bufferMs;
    }

    /**
     * Get current funding rate.
     */
    async getCurrentFundingRate(): Promise<number> {
        // In production, fetch from pool data
        return 0.0001;
    }

    /**
     * Update metrics.
     */
    updateMetrics(totalValueUsd: number): void {
        hedgeValueGauge.set(totalValueUsd);
    }
}
