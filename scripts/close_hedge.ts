#!/usr/bin/env npx tsx
/**
 * One-shot: Close the Flash Trade hedge position.
 * Run with: npx tsx scripts/close_hedge.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../src/bots/tsla_neutral/config';
import { getRpcManager } from '../src/bots/tsla_neutral/clients/rpc_manager';
import { FlashTradeClient } from '../src/bots/tsla_neutral/clients/flash_trade_client';
import { PythClient } from '../src/bots/tsla_neutral/clients/pyth_client';

async function main() {
    console.log('=== CLOSE HEDGE POSITION ===\n');

    const privateKey = process.env.WALLET_PRIVATE_KEY;
    if (!privateKey) throw new Error('WALLET_PRIVATE_KEY not set');
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

    const connection = getRpcManager().getConnection();

    const ftClient = new FlashTradeClient(connection, 'TSLAr');
    await ftClient.initialize(wallet);
    console.log('Flash Trade client initialized');

    // Get current price for slippage calc
    const pythClient = new PythClient();
    const priceData = await pythClient.getTSLAPrice();
    const currentPrice = priceData?.price ?? 411.9; // Fallback to last known
    console.log(`TSLA price: $${currentPrice.toFixed(2)} (${priceData ? 'live' : 'fallback'})`);

    // Fetch hedge positions
    const positions = await ftClient.fetchPositions();
    console.log(`\nHedge positions: ${positions.length}`);

    if (positions.length === 0) {
        console.log('No hedge positions to close.');
        process.exit(0);
    }

    for (const pos of positions) {
        console.log(`  Side: ${pos.side}, Size: $${pos.sizeUsd.toFixed(2)}, Entry: $${pos.entryPrice.toFixed(2)}, Collateral: $${pos.collateralUsd.toFixed(2)}`);
    }

    console.log('\nClosing hedge...');
    const result = await ftClient.closePosition(config.MAX_SLIPPAGE_BPS, currentPrice);
    if (!result) {
        console.error('FAILED to close hedge!');
        process.exit(1);
    }

    console.log(`\n=== HEDGE CLOSED ===`);
    console.log(`TX: ${result.txSignature}`);
    console.log('Collateral returned to wallet. Ready for clean bootstrap on Monday.');

    process.exit(0);
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
