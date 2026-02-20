#!/usr/bin/env npx tsx
/**
 * One-shot LP reposition: closes old LP (±5.4%) and reopens at config RANGE_WIDTH_PERCENT (±1%).
 * Run with: npx tsx scripts/reposition_now.ts
 *
 * IMPORTANT: Stop the bot first! pm2 stop tsla-neutral
 */

import dotenv from 'dotenv';
dotenv.config();

import { Keypair, Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../src/bots/tsla_neutral/config';
import { getRpcManager } from '../src/bots/tsla_neutral/clients/rpc_manager';
import { LPClient } from '../src/bots/tsla_neutral/clients/lp_client';
import { JupiterClient } from '../src/bots/tsla_neutral/clients/jupiter_client';
import { PythClient } from '../src/bots/tsla_neutral/clients/pyth_client';
import { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

async function main() {
    console.log('=== ONE-SHOT LP REPOSITION ===');
    console.log(`Target range: ±${(config.RANGE_WIDTH_PERCENT * 100).toFixed(1)}%`);
    console.log();

    // Initialize wallet
    const privateKey = process.env.WALLET_PRIVATE_KEY;
    if (!privateKey) throw new Error('WALLET_PRIVATE_KEY not set');
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

    // Initialize clients
    const connection = getRpcManager().getConnection();

    const lpClient = new LPClient(connection);
    await lpClient.initialize(wallet);
    console.log('LP client initialized');

    const jupiterClient = new JupiterClient(connection);
    await jupiterClient.initialize(wallet);
    console.log('Jupiter client initialized');

    const pythClient = new PythClient();

    // Get current price from Pyth
    const priceData = await pythClient.getTSLAPrice();
    if (!priceData || !priceData.price) throw new Error('Pyth price unavailable — too late after market close?');
    const currentPrice = priceData.price;
    const priceAge = Date.now() - (priceData.publishTime * 1000);
    console.log(`\nTSLA price: $${currentPrice.toFixed(2)} (age: ${(priceAge / 1000).toFixed(0)}s)`);

    if (priceAge > 600_000) {
        console.log('WARNING: Price is >10 min old. Pyth is stale. Aborting.');
        process.exit(1);
    }
    if (priceAge > 120_000) {
        console.log('NOTE: Price is >2 min old — likely just after market close. Proceeding with closing price.');
    }

    // Fetch current LP positions
    const positions = await lpClient.fetchPositions();
    if (positions.length === 0) {
        console.log('No LP positions found. Nothing to reposition.');
        process.exit(0);
    }

    for (const pos of positions) {
        const lowerPrice = Math.pow(1.0001, pos.tickLower) * 100;
        const upperPrice = Math.pow(1.0001, pos.tickUpper) * 100;
        console.log(`\nCurrent LP: ticks ${pos.tickLower}–${pos.tickUpper} ($${lowerPrice.toFixed(2)}–$${upperPrice.toFixed(2)})`);
        console.log(`  Range width: ±${((upperPrice - lowerPrice) / (upperPrice + lowerPrice) * 100).toFixed(1)}%`);
    }

    // Compute new range
    const rangePercent = config.RANGE_WIDTH_PERCENT;
    const newLow = currentPrice * (1 - rangePercent);
    const newHigh = currentPrice * (1 + rangePercent);
    console.log(`\nNew range: $${newLow.toFixed(2)}–$${newHigh.toFixed(2)} (±${(rangePercent * 100).toFixed(1)}%)`);

    // Step 1: Close all existing LP positions
    console.log('\n--- CLOSING OLD LP ---');
    for (const pos of positions) {
        console.log(`Closing position ${pos.mint.toBase58()}...`);
        const closeResult = await lpClient.closePosition(pos.mint);
        if (!closeResult) {
            console.error('FAILED to close LP position! Aborting.');
            process.exit(1);
        }
        console.log(`  Closed. TX: ${closeResult.txSignature}`);
    }

    // Wait for state to settle
    console.log('Waiting 3s for state to settle...');
    await new Promise(r => setTimeout(r, 3000));

    // Ensure SOL balance
    await jupiterClient.ensureSolBalance();

    // Step 2: Check token balances
    let tslaxBalance = 0n;
    try {
        const tslaxAta = await getAssociatedTokenAddress(
            config.TSLAX_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID
        );
        const info = await connection.getTokenAccountBalance(tslaxAta);
        tslaxBalance = BigInt(info.value.amount);
    } catch { tslaxBalance = 0n; }

    let usdcBalance = 0n;
    try {
        const usdcAta = await getAssociatedTokenAddress(config.USDC_MINT, wallet.publicKey);
        const info = await connection.getTokenAccountBalance(usdcAta);
        usdcBalance = BigInt(info.value.amount);
    } catch { usdcBalance = 0n; }

    const tslaxValueUsd = (Number(tslaxBalance) / 1e8) * currentPrice;
    const usdcValueUsd = Number(usdcBalance) / 1e6;
    const totalLpValue = tslaxValueUsd + usdcValueUsd;

    console.log(`\nBalances after close:`);
    console.log(`  TSLAx: ${(Number(tslaxBalance) / 1e8).toFixed(8)} ($${tslaxValueUsd.toFixed(2)})`);
    console.log(`  USDC:  ${usdcValueUsd.toFixed(2)}`);
    console.log(`  Total: $${totalLpValue.toFixed(2)}`);

    // Step 3: Swap to target ratio
    const { tokenARatio } = lpClient.calculateTokenRatio(rangePercent);
    const targetTslaxUsd = totalLpValue * tokenARatio;
    const tslaxDeltaUsd = targetTslaxUsd - tslaxValueUsd;

    console.log(`\nTarget TSLAx ratio: ${(tokenARatio * 100).toFixed(1)}%`);
    console.log(`Need to swap: $${tslaxDeltaUsd.toFixed(2)} (${tslaxDeltaUsd > 0 ? 'buy TSLAx' : 'sell TSLAx'})`);

    if (tslaxDeltaUsd > 1) {
        const swapMicro = BigInt(Math.floor(tslaxDeltaUsd * 1.02 * 1e6));
        console.log(`Swapping $${(Number(swapMicro) / 1e6).toFixed(2)} USDC → TSLAx...`);
        const swapResult = await jupiterClient.swapUsdcToTslax(swapMicro);
        if (!swapResult) {
            console.error('Swap USDC→TSLAx FAILED! Aborting.');
            process.exit(1);
        }
        tslaxBalance += BigInt(swapResult.tslaxAmount);
        console.log(`  Swapped. Slippage: ${swapResult.slippageBps?.toFixed(1) ?? 'N/A'} bps`);
    } else if (tslaxDeltaUsd < -1) {
        const excessTslax = BigInt(Math.floor((-tslaxDeltaUsd / currentPrice) * 1e8));
        console.log(`Swapping ${(Number(excessTslax) / 1e8).toFixed(6)} TSLAx → USDC...`);
        const swapResult = await jupiterClient.swapTslaxToUsdc(excessTslax);
        if (!swapResult) {
            console.warn('Swap TSLAx→USDC failed — will open LP with current balances');
        } else {
            console.log(`  Swapped. Slippage: ${swapResult.slippageBps?.toFixed(1) ?? 'N/A'} bps`);
        }
    } else {
        console.log('Balances already close to target ratio — no swap needed.');
    }

    // Re-read balances after swap
    await new Promise(r => setTimeout(r, 2000));
    try {
        const tslaxAta = await getAssociatedTokenAddress(
            config.TSLAX_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID
        );
        const info = await connection.getTokenAccountBalance(tslaxAta);
        tslaxBalance = BigInt(info.value.amount);
    } catch {}
    try {
        const usdcAta = await getAssociatedTokenAddress(config.USDC_MINT, wallet.publicKey);
        const info = await connection.getTokenAccountBalance(usdcAta);
        usdcBalance = BigInt(info.value.amount);
    } catch {}

    console.log(`\nFinal balances before LP open:`);
    console.log(`  TSLAx: ${(Number(tslaxBalance) / 1e8).toFixed(8)} ($${((Number(tslaxBalance) / 1e8) * currentPrice).toFixed(2)})`);
    console.log(`  USDC:  ${(Number(usdcBalance) / 1e6).toFixed(2)}`);

    // Step 4: Open new LP at current price with ±1% range
    console.log(`\n--- OPENING NEW LP at ±${(rangePercent * 100).toFixed(1)}% ---`);
    const openResult = await lpClient.openPosition(
        tslaxBalance,
        usdcBalance,
        rangePercent,
    );

    if (!openResult) {
        console.error('FAILED to open new LP position!');
        console.log('Tokens are in wallet — restart bot and it will bootstrap.');
        process.exit(1);
    }

    console.log(`\n=== REPOSITION COMPLETE ===`);
    console.log(`TX: ${openResult.txSignature}`);
    console.log(`New range: $${newLow.toFixed(2)}–$${newHigh.toFixed(2)} (±${(rangePercent * 100).toFixed(1)}%)`);
    console.log(`\nRestart bot: pm2 restart tsla-neutral`);

    process.exit(0);
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
