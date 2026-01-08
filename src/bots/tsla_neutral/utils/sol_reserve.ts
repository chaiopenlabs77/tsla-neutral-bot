import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { config } from '../config';

/**
 * Check if wallet has sufficient SOL for operations.
 */
export async function checkSolReserve(
    connection: Connection,
    wallet: PublicKey
): Promise<{ hasSufficient: boolean; balance: number; required: number }> {
    const balance = await connection.getBalance(wallet);
    const balanceSol = balance / LAMPORTS_PER_SOL;
    const required = config.MIN_SOL_RESERVE;

    return {
        hasSufficient: balanceSol >= required,
        balance: balanceSol,
        required,
    };
}

/**
 * Abort if SOL reserve is insufficient.
 */
export async function requireSolReserve(
    connection: Connection,
    wallet: PublicKey,
    operationName: string
): Promise<void> {
    const { hasSufficient, balance, required } = await checkSolReserve(connection, wallet);

    if (!hasSufficient) {
        throw new Error(
            `[SOL Reserve] Insufficient SOL for ${operationName}. ` +
            `Have: ${balance.toFixed(4)} SOL, Need: ${required} SOL`
        );
    }
}

/**
 * Estimate if a transaction would be too expensive.
 */
export function isGasCostAcceptable(estimatedCostLamports: number): boolean {
    const maxCostLamports = config.MAX_GAS_COST_PER_REBALANCE_SOL * LAMPORTS_PER_SOL;
    return estimatedCostLamports <= maxCostLamports;
}
