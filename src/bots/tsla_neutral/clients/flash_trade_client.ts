/**
 * Flash Trade Perp Client - Full SDK Integration
 *
 * Production-ready client for Flash Trade perpetual futures on Solana.
 * Uses flash-sdk PerpetualsClient for position management.
 *
 * @see https://github.com/flash-trade/flash-sdk
 * @see https://docs.flash.trade
 */

import {
    Connection,
    PublicKey,
    Keypair,
    VersionedTransaction,
    TransactionMessage,
    TransactionInstruction,
    Signer,
} from '@solana/web3.js';
import { config } from '../config';
import { HedgePosition } from '../types';
import { loggers } from '../observability/logger';
import { hedgeValueGauge, liquidationDistanceGauge, txSubmittedCounter } from '../observability/metrics';
import { alerts } from '../observability/alerter';

const log = loggers.hedge;

// Flash Trade mainnet program IDs (from flash-sdk PoolConfig.json)
const FLASH_PROGRAM_ID = new PublicKey('FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn');
const COMPOSABILITY_PROGRAM_ID = new PublicKey('FSWAPViR8ny5K96hezav8jynVubP2dJ2L7SbKzds2hwm');
const FB_NFT_REWARD_PROGRAM_ID = new PublicKey('FBRWDXSLysNbFQk64MQJcpkXP8e4fjezsGabV8jV7d7o');
const REWARD_DISTRIBUTION_PROGRAM_ID = new PublicKey('FARNT7LL119pmy9vSkN9q1ApZESPaKHuuX5Acz1oBoME');

// Market configuration
const COLLATERAL_SYMBOL = 'USDC';

// Dynamic imports to handle SDK version conflicts
let PerpetualsClient: any = null;
let PoolConfig: any = null;
let BN: any = null;

/**
 * Flash Trade Perpetuals Client
 *
 * Provides full integration with Flash Trade SDK for:
 * - Opening short positions to hedge LP exposure
 * - Closing positions when reducing hedge
 * - Querying position state and metrics
 */
export class FlashTradeClient {
    private connection: Connection;
    private wallet: Keypair | null = null;
    private perpClient: any = null;
    private poolConfig: any = null;
    private isInitialized = false;
    private targetSymbol: string;

    constructor(connection: Connection, targetSymbol: string = 'TSLA') {
        this.connection = connection;
        this.targetSymbol = targetSymbol;
    }

    /**
     * Initialize the client with wallet and load SDK.
     */
    async initialize(wallet: Keypair): Promise<void> {
        if (this.isInitialized) return;

        log.info({ event: 'initializing_flash_trade_client', target: this.targetSymbol });
        this.wallet = wallet;

        try {
            // Dynamically import flash-sdk to avoid version conflicts
            const flashSdk = await import('flash-sdk');
            const anchor = await import('@coral-xyz/anchor');

            PerpetualsClient = flashSdk.PerpetualsClient;
            PoolConfig = flashSdk.PoolConfig;
            BN = anchor.BN;

            // Create Anchor wallet adapter
            const anchorWallet = {
                publicKey: wallet.publicKey,
                signTransaction: async (tx: any) => {
                    tx.sign([wallet]);
                    return tx;
                },
                signAllTransactions: async (txs: any[]) => {
                    txs.forEach((tx) => tx.sign([wallet]));
                    return txs;
                },
            };

            // Create provider using flash-sdk's bundled Anchor
            const provider = new anchor.AnchorProvider(
                this.connection as any, // Cast to avoid version mismatch
                anchorWallet as any,
                { commitment: 'confirmed', preflightCommitment: 'confirmed' }
            );

            // Initialize PerpetualsClient
            this.perpClient = new PerpetualsClient(
                provider,
                FLASH_PROGRAM_ID,
                COMPOSABILITY_PROGRAM_ID,
                FB_NFT_REWARD_PROGRAM_ID,
                REWARD_DISTRIBUTION_PROGRAM_ID,
                {
                    prioritizationFee: config.JITO_TIP_LAMPORTS,
                }
            );

            // Load pool configuration
            // TSLAr is in the 'Remora.1' pool - we need to load by pool name, not market symbol
            // Then verify our target market exists in that pool
            const poolName = 'Remora.1'; // Pool containing equity perps like TSLAr
            this.poolConfig = PoolConfig.fromIdsByName(poolName, 'mainnet-beta');

            if (!this.poolConfig) {
                throw new Error(`Pool config not found for ${poolName}`);
            }

            // Verify the target market exists in this pool
            const targetMarket = this.poolConfig.markets?.find(
                (m: any) => m.targetCustody?.symbol === this.targetSymbol
            );
            if (!targetMarket) {
                // Log available markets for debugging
                const availableMarkets = this.poolConfig.markets?.map((m: any) => m.targetCustody?.symbol) || [];
                log.warn({
                    event: 'target_market_not_found',
                    target: this.targetSymbol,
                    availableMarkets,
                    poolName,
                });
            } else {
                log.info({ event: 'target_market_found', target: this.targetSymbol, poolName });
            }

            // Pre-load address lookup tables
            await this.perpClient.loadAddressLookupTable(this.poolConfig);

            this.isInitialized = true;
            log.info({
                event: 'flash_trade_client_initialized',
                target: this.targetSymbol,
                pool: this.poolConfig.poolAddress?.toBase58(),
            });
        } catch (error) {
            log.error({
                event: 'flash_trade_init_error',
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    private ensureInitialized(): void {
        if (!this.isInitialized || !this.perpClient || !this.poolConfig) {
            throw new Error('FlashTradeClient not initialized. Call initialize() first.');
        }
    }

    /**
     * Get current oracle price for the target asset.
     */
    async getCurrentPrice(): Promise<number> {
        this.ensureInitialized();

        try {
            const custody = this.poolConfig.custodies.find(
                (c: any) => c.symbol === this.targetSymbol
            );

            if (!custody) {
                throw new Error(`Custody not found for ${this.targetSymbol}`);
            }

            const custodyAccount = await this.perpClient.program.account.custody.fetch(
                custody.custodyAccount
            );

            // Debug: log oracle structure
            log.debug({
                event: 'custody_oracle_debug',
                hasOracle: !!custodyAccount.oracle,
                oracleKeys: custodyAccount.oracle ? Object.keys(custodyAccount.oracle) : [],
                rawOracle: JSON.stringify(custodyAccount.oracle, (k, v) =>
                    typeof v === 'bigint' ? v.toString() : v),
            });

            // Extract price from oracle data - try different field names
            let price = 0;
            if (custodyAccount.oracle) {
                const oracle: any = custodyAccount.oracle;
                // Try various possible field names
                const rawPrice = oracle.price ?? oracle.oraclePrice ?? oracle.lastPrice ?? 0;
                const exponent = oracle.exponent ?? oracle.oracleExponent ?? oracle.exp ?? -8;

                price = Number(rawPrice) / Math.pow(10, Math.abs(Number(exponent)));

                log.debug({
                    event: 'price_extracted',
                    rawPrice: String(rawPrice),
                    exponent: Number(exponent),
                    computedPrice: price,
                });
            }

            // If still 0, use a fallback from Pyth or the pool config
            if (price === 0) {
                log.warn({ event: 'oracle_price_zero', fallback: 'using_pyth_or_pool' });
                // TODO: Fetch from Pyth as fallback
            }

            return price;
        } catch (error) {
            log.error({ event: 'get_price_error', error: String(error) });
            throw error;
        }
    }

    /**
     * Open a short position to hedge LP exposure.
     * @param fallbackPrice - Price to use if oracle price is unavailable (from Pyth)
     */
    async openShortPosition(
        sizeUsd: number,
        collateralUsd: number,
        maxSlippageBps: number = config.MAX_SLIPPAGE_BPS,
        fallbackPrice?: number
    ): Promise<{ txSignature: string; instructions: TransactionInstruction[] } | null> {
        this.ensureInitialized();

        log.info({
            event: 'opening_short_position',
            target: this.targetSymbol,
            sizeUsd,
            collateralUsd,
            maxSlippageBps,
        });

        if (config.DRY_RUN) {
            log.info({
                event: 'dry_run_open_short',
                msg: `Would open SHORT: $${sizeUsd} ${this.targetSymbol} with $${collateralUsd} collateral`,
            });
            txSubmittedCounter.inc({ type: 'open_short', status: 'dry_run' });
            return { txSignature: 'dry-run-signature', instructions: [] };
        }

        try {
            // Get current price with slippage - use fallback if oracle returns 0
            let currentPrice = await this.getCurrentPrice();
            if (currentPrice === 0 && fallbackPrice) {
                log.info({ event: 'using_fallback_price', fallbackPrice });
                currentPrice = fallbackPrice;
            }
            if (currentPrice === 0) {
                throw new Error('Cannot open position: price is 0 and no fallback provided');
            }
            const priceWithSlippage = currentPrice * (1 - maxSlippageBps / 10000);

            const priceObj = {
                price: new BN(Math.floor(priceWithSlippage * 1e5)), // 1e5 for exponent -5
                exponent: -5, // Flash Trade uses -5 exponent
            };

            // Convert amounts to BN with proper decimals
            const sizeBN = new BN(Math.floor(sizeUsd * 1e6));
            const collateralBN = new BN(Math.floor(collateralUsd * 1e6));

            log.info({
                event: 'open_position_params',
                targetSymbol: this.targetSymbol,
                collateralSymbol: COLLATERAL_SYMBOL,
                price: priceObj.price.toString(),
                exponent: priceObj.exponent,
                collateral: collateralBN.toString(),
                size: sizeBN.toString(),
                side: 'short',
                poolAddress: this.poolConfig?.poolAddress?.toBase58(),
            });

            // Build open position instruction
            const { instructions, additionalSigners } = await this.perpClient.openPosition(
                this.targetSymbol,
                COLLATERAL_SYMBOL,
                priceObj,
                collateralBN,
                sizeBN,
                { short: {} }, // Side
                this.poolConfig,
                { none: {} } // Privilege
            );

            // Build and send transaction
            const txSignature = await this.buildAndSendTransaction(instructions, additionalSigners);

            log.info({ event: 'short_position_opened', txSignature });
            txSubmittedCounter.inc({ type: 'open_short', status: 'success' });

            return { txSignature, instructions };
        } catch (error) {
            log.error({
                event: 'open_short_error',
                error: error instanceof Error ? error.message : String(error),
            });
            txSubmittedCounter.inc({ type: 'open_short', status: 'failure' });
            return null;
        }
    }

    /**
     * Close an existing short position.
     */
    async closePosition(
        maxSlippageBps: number = config.MAX_SLIPPAGE_BPS
    ): Promise<{ txSignature: string } | null> {
        this.ensureInitialized();

        log.info({ event: 'closing_position', target: this.targetSymbol });

        if (config.DRY_RUN) {
            log.info({
                event: 'dry_run_close_position',
                msg: `Would close ${this.targetSymbol} short position`,
            });
            txSubmittedCounter.inc({ type: 'close_position', status: 'dry_run' });
            return { txSignature: 'dry-run-signature' };
        }

        try {
            const currentPrice = await this.getCurrentPrice();
            const priceWithSlippage = currentPrice * (1 + maxSlippageBps / 10000);

            const priceObj = {
                price: new BN(Math.floor(priceWithSlippage * 1e6)),
                exponent: -6,
            };

            const { instructions, additionalSigners } = await this.perpClient.closePosition(
                this.targetSymbol,
                COLLATERAL_SYMBOL,
                priceObj,
                { short: {} },
                this.poolConfig,
                { none: {} }
            );

            const txSignature = await this.buildAndSendTransaction(instructions, additionalSigners);

            log.info({ event: 'position_closed', txSignature });
            txSubmittedCounter.inc({ type: 'close_position', status: 'success' });

            return { txSignature };
        } catch (error) {
            log.error({
                event: 'close_position_error',
                error: error instanceof Error ? error.message : String(error),
            });
            txSubmittedCounter.inc({ type: 'close_position', status: 'failure' });
            return null;
        }
    }

    /**
     * Fetch user's open positions.
     */
    async fetchPositions(): Promise<HedgePosition[]> {
        this.ensureInitialized();

        if (!this.wallet) return [];

        log.info({ event: 'fetching_positions', wallet: this.wallet.publicKey.toBase58() });

        try {
            const positions = await this.perpClient.program.account.position.all([
                {
                    memcmp: {
                        offset: 8,
                        bytes: this.wallet.publicKey.toBase58(),
                    },
                },
            ]);

            // Debug: log raw position data
            if (positions.length > 0) {
                const rawData = positions[0].account;
                log.info({
                    event: 'raw_flash_position_debug',
                    keys: Object.keys(rawData),
                    sizeAmount: rawData.sizeAmount?.toString(),
                    sizeUsd: rawData.sizeUsd?.toString(), // This is what Flash Trade UI shows
                    collateralAmount: rawData.collateralAmount?.toString(),
                    collateralUsd: rawData.collateralUsd?.toString(),
                    entryPrice: JSON.stringify(rawData.entryPrice, (k, v) =>
                        typeof v === 'bigint' ? v.toString() : v),
                    side: JSON.stringify(rawData.side),
                });
            }

            const hedgePositions: HedgePosition[] = positions.map((pos: any) => {
                const data = pos.account;
                const side = data.side?.long ? 'LONG' : 'SHORT';

                // Use sizeUsd which is what Flash Trade UI displays
                const rawSizeUsd = Number(data.sizeUsd || data.sizeAmount || 0);
                const rawEntryPrice = Number(data.entryPrice?.price || 0);
                const entryPriceExponent = data.entryPrice?.exponent || 0;

                // sizeUsd is in 6 decimals (USDC standard)
                const size = rawSizeUsd / 1e6;
                const entryPrice = rawEntryPrice / Math.pow(10, Math.abs(entryPriceExponent));

                log.info({
                    event: 'parsed_flash_position',
                    rawSizeAmount: data.sizeAmount?.toString(),
                    rawSizeUsd: rawSizeUsd.toString(),
                    size,
                    rawEntryPrice: rawEntryPrice.toString(),
                    entryPriceExponent,
                    entryPrice,
                    side,
                    computedDelta: side === 'SHORT' ? -size : size,
                });

                return {
                    positionId: pos.publicKey.toBase58(),
                    market: this.targetSymbol,
                    side,
                    size,
                    entryPrice,
                    leverage: 1,
                    liquidationPrice: 0, // Calculate from metrics
                    unrealizedPnl: 0,
                    marginUsed: Number(data.collateralAmount || 0) / 1e6,
                };
            });

            log.info({ event: 'positions_fetched', count: hedgePositions.length });
            return hedgePositions;
        } catch (error) {
            log.error({ event: 'fetch_positions_error', error: String(error) });
            return [];
        }
    }

    /**
     * Build and send a versioned transaction.
     */
    private async buildAndSendTransaction(
        instructions: TransactionInstruction[],
        additionalSigners: Signer[] = []
    ): Promise<string> {
        if (!this.wallet) throw new Error('Wallet not initialized');

        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();

        const messageV0 = new TransactionMessage({
            payerKey: this.wallet.publicKey,
            recentBlockhash: blockhash,
            instructions,
        }).compileToV0Message(this.perpClient.addressLookupTables);

        const tx = new VersionedTransaction(messageV0);
        tx.sign([this.wallet, ...additionalSigners]);

        const signature = await this.connection.sendTransaction(tx, {
            skipPreflight: false,
            maxRetries: 3,
        });

        await this.connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight,
        });

        return signature;
    }

    /**
     * Calculate position delta (exposure in USD).
     * Size from Flash Trade is already the USD notional value.
     */
    calculatePositionDelta(position: HedgePosition): number {
        // Size is already in USD from Flash Trade (sizeAmount / 1e6)
        // SHORT = negative delta, LONG = positive delta
        return position.side === 'SHORT' ? -position.size : position.size;
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

        const isAtRisk = Math.abs(distancePercent) <= config.LIQUIDATION_WARNING_PERCENT;
        liquidationDistanceGauge.set(Math.abs(distancePercent) * 100);

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
     * Update metrics.
     */
    updateMetrics(totalValueUsd: number): void {
        hedgeValueGauge.set(totalValueUsd);
    }
}
