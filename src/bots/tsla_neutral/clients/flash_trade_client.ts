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

// Flash Trade mainnet program IDs
const FLASH_PROGRAM_ID = new PublicKey('PERP9EeXeGnyEqGhfphDnT7NjiEN14LoGHFnGkBdbbL3');
const COMPOSABILITY_PROGRAM_ID = new PublicKey('CmpM3yUdXvuKAd5pxdPNsqkhJNBaNsWB9h4eGLuUgvA6');
const FB_NFT_REWARD_PROGRAM_ID = new PublicKey('FBNFTo1GRB8qpSMVpYEy4qSpmPqjyu2jLBskCZzNrKsP');
const REWARD_DISTRIBUTION_PROGRAM_ID = new PublicKey('RWD4ay7urPzjDqmGPJp5YLqfosXqE6PFLbmcvZWyLpB');

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
            this.poolConfig = PoolConfig.fromIdsByName(this.targetSymbol, 'mainnet-beta');

            if (!this.poolConfig) {
                throw new Error(`Pool config not found for ${this.targetSymbol}`);
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
            const flashSdk = await import('flash-sdk');
            const custody = this.poolConfig.custodies.find(
                (c: any) => c.symbol === this.targetSymbol
            );

            if (!custody) {
                throw new Error(`Custody not found for ${this.targetSymbol}`);
            }

            const custodyAccount = await this.perpClient.program.account.custody.fetch(
                custody.custodyAccount
            );

            // Extract price from oracle data
            const price =
                Number(custodyAccount.oracle?.price || 0) /
                Math.pow(10, Math.abs(custodyAccount.oracle?.exponent || 0));

            return price;
        } catch (error) {
            log.error({ event: 'get_price_error', error: String(error) });
            throw error;
        }
    }

    /**
     * Open a short position to hedge LP exposure.
     */
    async openShortPosition(
        sizeUsd: number,
        collateralUsd: number,
        maxSlippageBps: number = config.MAX_SLIPPAGE_BPS
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
            // Get current price with slippage
            const currentPrice = await this.getCurrentPrice();
            const priceWithSlippage = currentPrice * (1 - maxSlippageBps / 10000);

            const priceObj = {
                price: new BN(Math.floor(priceWithSlippage * 1e6)),
                exponent: -6,
            };

            // Convert amounts to BN with proper decimals
            const sizeBN = new BN(Math.floor(sizeUsd * 1e6));
            const collateralBN = new BN(Math.floor(collateralUsd * 1e6));

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

            const hedgePositions: HedgePosition[] = positions.map((pos: any) => {
                const data = pos.account;
                const side = data.side?.long ? 'LONG' : 'SHORT';

                return {
                    positionId: pos.publicKey.toBase58(),
                    market: this.targetSymbol,
                    side,
                    size: Number(data.sizeAmount || 0) / 1e9,
                    entryPrice:
                        Number(data.entryPrice?.price || 0) /
                        Math.pow(10, Math.abs(data.entryPrice?.exponent || 0)),
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
