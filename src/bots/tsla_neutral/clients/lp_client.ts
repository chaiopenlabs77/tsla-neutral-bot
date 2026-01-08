/**
 * Raydium CLMM LP Client - Full SDK Integration
 *
 * Production-ready client for Raydium Concentrated Liquidity pools.
 * Uses @raydium-io/raydium-sdk-v2 for pool operations.
 *
 * @see https://github.com/raydium-io/raydium-sdk-V2-demo
 * @see https://docs.raydium.io
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
import { LPPosition } from '../types';
import { loggers } from '../observability/logger';
import { lpValueGauge, txSubmittedCounter } from '../observability/metrics';

const log = loggers.lp;

// Dynamic imports to handle SDK version conflicts
let Raydium: any = null;
let BN: any = null;

// CLMM Pool info interface
interface ClmmPoolInfo {
    id: PublicKey;
    mintA: PublicKey;
    mintB: PublicKey;
    tickSpacing: number;
    sqrtPriceX64: bigint;
    currentTickIndex: number;
    liquidity: bigint;
}

/**
 * Raydium CLMM LP Client
 *
 * Provides full integration with Raydium SDK v2 for:
 * - Opening concentrated liquidity positions
 * - Closing positions and collecting fees
 * - Monitoring position range status
 */
export class LPClient {
    private connection: Connection;
    private wallet: Keypair | null = null;
    private raydium: any = null;
    private poolAddress: PublicKey;
    private poolInfo: ClmmPoolInfo | null = null;
    private isInitialized = false;

    constructor(connection: Connection) {
        this.connection = connection;
        this.poolAddress = config.RAYDIUM_POOL_ADDRESS;
    }

    /**
     * Initialize the client with wallet and load SDK.
     */
    async initialize(wallet: Keypair): Promise<void> {
        if (this.isInitialized) return;

        log.info({ event: 'initializing_lp_client', pool: this.poolAddress.toBase58() });
        this.wallet = wallet;

        try {
            // Dynamically import Raydium SDK
            const raydiumSdk = await import('@raydium-io/raydium-sdk-v2');
            Raydium = raydiumSdk.Raydium;

            const anchor = await import('@coral-xyz/anchor');
            BN = anchor.BN;

            // Initialize Raydium SDK
            this.raydium = await Raydium.load({
                connection: this.connection,
                cluster: 'mainnet',
                owner: wallet,
                disableLoadToken: true, // Speed up init
            });

            // Fetch pool info
            await this.fetchPoolInfo();

            this.isInitialized = true;
            log.info({
                event: 'lp_client_initialized',
                pool: this.poolAddress.toBase58(),
            });
        } catch (error) {
            log.error({
                event: 'lp_client_init_error',
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    private ensureInitialized(): void {
        if (!this.isInitialized || !this.raydium) {
            throw new Error('LPClient not initialized. Call initialize() first.');
        }
    }

    /**
     * Fetch current pool info from chain.
     */
    async fetchPoolInfo(): Promise<ClmmPoolInfo> {
        // Note: This can be called during initialization, so we check raydium directly
        if (!this.raydium) {
            throw new Error('Raydium SDK not loaded');
        }

        log.info({ event: 'fetching_pool_info', pool: this.poolAddress.toBase58() });

        try {
            // Fetch pool data from Raydium API
            const poolData = await this.raydium.clmm.getPoolInfoFromRpc(this.poolAddress.toBase58());

            // Log the actual structure for debugging
            log.info({
                event: 'pool_data_received',
                keys: Object.keys(poolData || {}),
                hasPoolData: !!poolData,
            });

            // Debug: Log raw pool properties to understand SDK response
            log.info({
                event: 'pool_data_debug',
                sqrtPriceX64: poolData?.sqrtPriceX64?.toString(),
                tickCurrent: poolData?.tickCurrent,
                liquidity: poolData?.liquidity?.toString(),
                tickSpacing: poolData?.config?.tickSpacing,
            });

            if (!poolData) {
                throw new Error('Pool not found or RPC returned empty response');
            }

            // SDK v2 returns { poolInfo, poolKeys, computePoolInfo, tickData }
            // Extract the actual pool info from the nested structure
            const pi = poolData.poolInfo || poolData;
            const computeInfo = poolData.computePoolInfo;

            log.info({
                event: 'pool_data_structure',
                hasPoolInfo: !!poolData.poolInfo,
                hasComputePoolInfo: !!computeInfo,
                computePoolInfoKeys: Object.keys(computeInfo || {}),
            });

            // Get mint info
            const mintA = pi.mintA?.address || pi.mintA?.programId ? pi.mintA : null;
            const mintB = pi.mintB?.address || pi.mintB?.programId ? pi.mintB : null;

            // Get pool state - prefer computePoolInfo for current values
            const tickSpacing = pi.config?.tickSpacing || pi.tickSpacing || 1;
            const sqrtPriceX64 = computeInfo?.sqrtPriceX64 || pi.sqrtPriceX64 || '0';
            const tickCurrent = computeInfo?.tickCurrent ?? pi.tickCurrent ?? 0;
            const liquidity = computeInfo?.liquidity || pi.liquidity || '0';

            log.info({
                event: 'parsed_pool_values',
                sqrtPriceX64: sqrtPriceX64.toString(),
                tickCurrent,
                liquidity: liquidity.toString(),
                tickSpacing,
            });

            this.poolInfo = {
                id: this.poolAddress,
                mintA: mintA?.address ? new PublicKey(mintA.address) : new PublicKey(config.TSLAX_MINT),
                mintB: mintB?.address ? new PublicKey(mintB.address) : new PublicKey(config.USDC_MINT),
                tickSpacing,
                sqrtPriceX64: BigInt(sqrtPriceX64.toString()),
                currentTickIndex: tickCurrent,
                liquidity: BigInt(liquidity.toString()),
            };

            log.info({
                event: 'pool_info_fetched',
                currentTick: this.poolInfo.currentTickIndex,
                liquidity: this.poolInfo.liquidity.toString(),
            });

            return this.poolInfo;
        } catch (error) {
            log.error({ event: 'fetch_pool_error', error: String(error) });
            throw error;
        }
    }

    /**
     * Get current pool price from sqrtPriceX64.
     */
    getCurrentPrice(): number {
        if (!this.poolInfo) {
            throw new Error('Pool info not loaded. Call fetchPoolInfo first.');
        }

        // sqrtPriceX64 to price: price = (sqrtPriceX64 / 2^64)^2
        const sqrtPrice = Number(this.poolInfo.sqrtPriceX64) / Math.pow(2, 64);
        return sqrtPrice * sqrtPrice;
    }

    /**
     * Calculate tick indices for a range around current price.
     */
    calculateRangeTicks(rangePercent: number = config.RANGE_WIDTH_PERCENT): {
        lowerTick: number;
        upperTick: number;
    } {
        if (!this.poolInfo) {
            throw new Error('Pool info not loaded');
        }

        const currentPrice = this.getCurrentPrice();
        const tickSpacing = this.poolInfo.tickSpacing;

        // Calculate price bounds
        const lowerPrice = currentPrice * (1 - rangePercent);
        const upperPrice = currentPrice * (1 + rangePercent);

        // Convert prices to ticks: tick = log(price) / log(1.0001)
        const lowerTick =
            Math.floor(Math.log(lowerPrice) / Math.log(1.0001) / tickSpacing) * tickSpacing;
        const upperTick =
            Math.ceil(Math.log(upperPrice) / Math.log(1.0001) / tickSpacing) * tickSpacing;

        log.info({
            event: 'calculated_range',
            currentPrice,
            lowerPrice,
            upperPrice,
            lowerTick,
            upperTick,
            rangePercent,
        });

        return { lowerTick, upperTick };
    }

    /**
     * Check if current price is within a position's range.
     */
    isPositionInRange(lowerTick: number, upperTick: number): boolean {
        if (!this.poolInfo) {
            throw new Error('Pool info not loaded');
        }

        const currentTick = this.poolInfo.currentTickIndex;
        return currentTick >= lowerTick && currentTick <= upperTick;
    }

    /**
     * Calculate the token ratio needed for an LP position in a given range.
     * 
     * For CLMM, the ratio depends on where current price sits within the range.
     * Returns the fraction of value that should be in tokenA (TSLAx).
     * 
     * @param rangePercent - Range width as a decimal (e.g., 0.05 for ±5%)
     * @returns tokenARatio - Fraction of LP value that should be tokenA (0 to 1)
     */
    calculateTokenRatio(rangePercent: number = config.RANGE_WIDTH_PERCENT): {
        tokenARatio: number;
        tokenBRatio: number;
        lowerTick: number;
        upperTick: number;
    } {
        if (!this.poolInfo) {
            throw new Error('Pool info not loaded');
        }

        const { lowerTick, upperTick } = this.calculateRangeTicks(rangePercent);

        // Convert ticks to sqrt prices
        // sqrtPrice = 1.0001^(tick/2)
        const sqrtPriceLower = Math.pow(1.0001, lowerTick / 2);
        const sqrtPriceUpper = Math.pow(1.0001, upperTick / 2);
        const sqrtPriceCurrent = Number(this.poolInfo.sqrtPriceX64) / Math.pow(2, 64);

        // CLMM liquidity math for in-range position:
        // amount0 (tokenA) = L * (1/sqrtP - 1/sqrtPu)
        // amount1 (tokenB) = L * (sqrtP - sqrtPl)
        // 
        // For value ratio, we need:
        // valueA = amount0 * price = L * (1/sqrtP - 1/sqrtPu) * P = L * (sqrtP - P/sqrtPu)
        // valueB = amount1 = L * (sqrtP - sqrtPl)
        //
        // Simplified for ratio calculation (L cancels out):
        const p = sqrtPriceCurrent * sqrtPriceCurrent; // current price

        // Handle edge cases
        if (sqrtPriceCurrent <= sqrtPriceLower) {
            // Price below range: 100% tokenA
            return { tokenARatio: 1, tokenBRatio: 0, lowerTick, upperTick };
        }
        if (sqrtPriceCurrent >= sqrtPriceUpper) {
            // Price above range: 100% tokenB
            return { tokenARatio: 0, tokenBRatio: 1, lowerTick, upperTick };
        }

        // In range: calculate actual ratio
        // amount0 proportional to: (sqrtPu - sqrtP) / (sqrtP * sqrtPu)
        // amount1 proportional to: (sqrtP - sqrtPl)
        const amount0Factor = (sqrtPriceUpper - sqrtPriceCurrent) / (sqrtPriceCurrent * sqrtPriceUpper);
        const amount1Factor = sqrtPriceCurrent - sqrtPriceLower;

        // Value in tokenB terms (amount0 * price + amount1)
        const valueAInB = amount0Factor * p;
        const valueB = amount1Factor;
        const totalValue = valueAInB + valueB;

        const tokenARatio = valueAInB / totalValue;
        const tokenBRatio = valueB / totalValue;

        log.info({
            event: 'calculated_token_ratio',
            tokenARatio: tokenARatio.toFixed(4),
            tokenBRatio: tokenBRatio.toFixed(4),
            sqrtPriceCurrent: sqrtPriceCurrent.toFixed(6),
            sqrtPriceLower: sqrtPriceLower.toFixed(6),
            sqrtPriceUpper: sqrtPriceUpper.toFixed(6),
        });

        return { tokenARatio, tokenBRatio, lowerTick, upperTick };
    }

    /**
     * Fetch user's LP positions.
     */
    async fetchPositions(): Promise<LPPosition[]> {
        this.ensureInitialized();

        if (!this.wallet) return [];

        log.info({ event: 'fetching_lp_positions', wallet: this.wallet.publicKey.toBase58() });

        try {
            const positions = await this.raydium.clmm.getOwnerPositionInfo({
                programId: this.raydium.clmm.programId,
            });

            const lpPositions: LPPosition[] = positions.map((pos: any) => ({
                mint: new PublicKey(pos.nftMint),
                poolAddress: this.poolAddress,
                lowerTick: pos.tickLower,
                upperTick: pos.tickUpper,
                liquidity: BigInt(pos.liquidity.toString()),
                tokenAAmount: BigInt(pos.amountA?.toString() || '0'),
                tokenBAmount: BigInt(pos.amountB?.toString() || '0'),
                inRange: this.isPositionInRange(pos.tickLower, pos.tickUpper),
                entryPrice: this.getCurrentPrice(),
            }));

            log.info({ event: 'lp_positions_fetched', count: lpPositions.length });
            return lpPositions;
        } catch (error) {
            log.error({ event: 'fetch_positions_error', error: String(error) });
            return [];
        }
    }

    /**
     * Open a new concentrated LP position.
     */
    async openPosition(
        amountA: bigint,
        amountB: bigint,
        rangePercent: number = config.RANGE_WIDTH_PERCENT
    ): Promise<{ txSignature: string; nftMint: string } | null> {
        this.ensureInitialized();

        const { lowerTick, upperTick } = this.calculateRangeTicks(rangePercent);

        log.info({
            event: 'opening_lp_position',
            amountA: amountA.toString(),
            amountB: amountB.toString(),
            lowerTick,
            upperTick,
        });

        if (config.DRY_RUN) {
            log.info({
                event: 'dry_run_open_position',
                msg: `Would open LP: ${amountA} tokenA, ${amountB} tokenB, ticks [${lowerTick}, ${upperTick}]`,
            });
            txSubmittedCounter.inc({ type: 'open_lp', status: 'dry_run' });
            return { txSignature: 'dry-run-signature', nftMint: 'dry-run-nft-mint' };
        }

        try {
            // Build open position transaction
            const { execute, extInfo } = await this.raydium.clmm.openPositionFromBase({
                poolInfo: await this.raydium.clmm.getPoolInfoFromRpc(this.poolAddress.toBase58()),
                ownerInfo: {
                    useSOLBalance: true,
                },
                tickLower: lowerTick,
                tickUpper: upperTick,
                base: 'MintA',
                baseAmount: new BN(amountA.toString()),
                otherAmountMax: new BN(amountB.toString()),
                txVersion: 'V0', // Use versioned transactions
            });

            // Execute the transaction
            const { txId } = await execute();

            log.info({
                event: 'lp_position_opened',
                txSignature: txId,
                nftMint: extInfo?.nftMint?.toBase58(),
            });
            txSubmittedCounter.inc({ type: 'open_lp', status: 'success' });

            return {
                txSignature: txId,
                nftMint: extInfo?.nftMint?.toBase58() || '',
            };
        } catch (error) {
            log.error({
                event: 'open_position_error',
                error: error instanceof Error ? error.message : String(error),
            });
            txSubmittedCounter.inc({ type: 'open_lp', status: 'failure' });
            return null;
        }
    }

    /**
     * Close an LP position and collect fees.
     */
    async closePosition(positionNftMint: PublicKey): Promise<{ txSignature: string } | null> {
        this.ensureInitialized();

        log.info({
            event: 'closing_lp_position',
            nftMint: positionNftMint.toBase58(),
        });

        if (config.DRY_RUN) {
            log.info({
                event: 'dry_run_close_position',
                msg: `Would close LP position: ${positionNftMint.toBase58()}`,
            });
            txSubmittedCounter.inc({ type: 'close_lp', status: 'dry_run' });
            return { txSignature: 'dry-run-signature' };
        }

        try {
            // Close position and collect fees
            const { execute } = await this.raydium.clmm.closePosition({
                poolInfo: await this.raydium.clmm.getPoolInfoFromRpc(this.poolAddress.toBase58()),
                ownerPosition: {
                    nftMint: positionNftMint,
                },
                txVersion: 'V0',
            });

            const { txId } = await execute();

            log.info({ event: 'lp_position_closed', txSignature: txId });
            txSubmittedCounter.inc({ type: 'close_lp', status: 'success' });

            return { txSignature: txId };
        } catch (error) {
            log.error({
                event: 'close_position_error',
                error: error instanceof Error ? error.message : String(error),
            });
            txSubmittedCounter.inc({ type: 'close_lp', status: 'failure' });
            return null;
        }
    }

    /**
     * Calculate LP position delta (exposure to token A).
     */
    calculatePositionDelta(position: LPPosition, currentPrice: number): number {
        const lowerPrice = Math.pow(1.0001, position.lowerTick);
        const upperPrice = Math.pow(1.0001, position.upperTick);

        let tokenAPercent: number;

        if (currentPrice <= lowerPrice) {
            tokenAPercent = 1.0;
        } else if (currentPrice >= upperPrice) {
            tokenAPercent = 0.0;
        } else {
            tokenAPercent = (upperPrice - currentPrice) / (upperPrice - lowerPrice);
        }

        const totalValue =
            Number(position.tokenAAmount) * currentPrice + Number(position.tokenBAmount);
        return totalValue * tokenAPercent;
    }

    /**
     * Estimate withdrawal composition.
     */
    estimateWithdrawalComposition(
        position: LPPosition,
        currentPrice: number
    ): { tokenAPercent: number; tokenBPercent: number } {
        const lowerPrice = Math.pow(1.0001, position.lowerTick);
        const upperPrice = Math.pow(1.0001, position.upperTick);

        if (currentPrice <= lowerPrice) {
            return { tokenAPercent: 1.0, tokenBPercent: 0.0 };
        } else if (currentPrice >= upperPrice) {
            return { tokenAPercent: 0.0, tokenBPercent: 1.0 };
        } else {
            const tokenAPercent = (upperPrice - currentPrice) / (upperPrice - lowerPrice);
            return { tokenAPercent, tokenBPercent: 1 - tokenAPercent };
        }
    }

    /**
     * Update metrics.
     */
    updateMetrics(totalValueUsd: number): void {
        lpValueGauge.set(totalValueUsd);
    }
}
