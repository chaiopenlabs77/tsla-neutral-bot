#!/usr/bin/env npx tsx
/**
 * Force open LP position with current wallet balances at ±1% range.
 * Uses pool sqrtPriceX64 for ticks (no Pyth needed).
 */

import dotenv from 'dotenv';
dotenv.config();

import { Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from '../src/bots/tsla_neutral/config';
import { getRpcManager } from '../src/bots/tsla_neutral/clients/rpc_manager';
import { LPClient } from '../src/bots/tsla_neutral/clients/lp_client';

async function main() {
    console.log('=== FORCE OPEN LP ===');
    console.log(`Range: ±${(config.RANGE_WIDTH_PERCENT * 100).toFixed(1)}%\n`);

    const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY!));
    const connection = getRpcManager().getConnection();

    const lpClient = new LPClient(connection);
    await lpClient.initialize(wallet);

    // Check balances
    let tslaxBalance = 0n;
    try {
        const tslaxAta = await getAssociatedTokenAddress(config.TSLAX_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const info = await connection.getTokenAccountBalance(tslaxAta);
        tslaxBalance = BigInt(info.value.amount);
    } catch { tslaxBalance = 0n; }

    let usdcBalance = 0n;
    try {
        const usdcAta = await getAssociatedTokenAddress(config.USDC_MINT, wallet.publicKey);
        const info = await connection.getTokenAccountBalance(usdcAta);
        usdcBalance = BigInt(info.value.amount);
    } catch { usdcBalance = 0n; }

    console.log(`TSLAx: ${(Number(tslaxBalance) / 1e8).toFixed(8)}`);
    console.log(`USDC:  ${(Number(usdcBalance) / 1e6).toFixed(2)}`);

    if (tslaxBalance === 0n && usdcBalance === 0n) {
        console.log('No tokens to open LP with.');
        process.exit(1);
    }

    console.log(`\nOpening LP...`);
    const result = await lpClient.openPosition(tslaxBalance, usdcBalance, config.RANGE_WIDTH_PERCENT);

    if (!result) {
        console.error('FAILED to open LP!');
        process.exit(1);
    }

    console.log(`\n=== LP OPENED ===`);
    console.log(`TX: ${result.txSignature}`);
    console.log(`NFT: ${result.nftMint}`);
    process.exit(0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
