#!/usr/bin/env npx tsx
import dotenv from 'dotenv';
dotenv.config();

import { Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../src/bots/tsla_neutral/config';
import { getRpcManager } from '../src/bots/tsla_neutral/clients/rpc_manager';
import bs58 from 'bs58';

async function main() {
    const conn = getRpcManager().getConnection();
    const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY!));
    console.log('Wallet:', wallet.publicKey.toBase58());

    const sol = await conn.getBalance(wallet.publicKey);
    console.log('SOL:', (sol / 1e9).toFixed(4), `($${(sol / 1e9 * 200).toFixed(2)})`);

    // TSLAx (Token2022, 8 decimals)
    try {
        const tslaxAta = await getAssociatedTokenAddress(config.TSLAX_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
        const tslaxInfo = await conn.getTokenAccountBalance(tslaxAta);
        const tslaxUsd = Number(tslaxInfo.value.amount) / 1e8 * 411.9;
        console.log(`TSLAx: ${tslaxInfo.value.uiAmountString} ($${tslaxUsd.toFixed(2)})`);
    } catch { console.log('TSLAx: 0'); }

    // USDC (6 decimals)
    try {
        const usdcAta = await getAssociatedTokenAddress(config.USDC_MINT, wallet.publicKey);
        const usdcInfo = await conn.getTokenAccountBalance(usdcAta);
        console.log(`USDC: ${usdcInfo.value.uiAmountString}`);
    } catch { console.log('USDC: 0'); }

    // Check for any LP positions (NFT mints from Raydium)
    const { LPClient } = await import('../src/bots/tsla_neutral/clients/lp_client');
    const lpClient = new LPClient(conn);
    await lpClient.initialize(wallet);
    const positions = await lpClient.fetchPositions();
    console.log(`\nLP positions: ${positions.length}`);
    for (const pos of positions) {
        console.log(`  Ticks: ${pos.tickLower}–${pos.tickUpper}, Mint: ${pos.mint.toBase58()}`);
    }

    // Check hedge
    const { FlashTradeClient } = await import('../src/bots/tsla_neutral/clients/flash_trade_client');
    const ftClient = new FlashTradeClient(conn, 'TSLAr');
    await ftClient.initialize(wallet);
    const hedgePositions = await ftClient.fetchPositions();
    console.log(`\nHedge positions: ${hedgePositions.length}`);
    for (const pos of hedgePositions) {
        console.log(`  Side: ${pos.side}, Size: $${pos.sizeUsd.toFixed(2)}, Collateral: $${pos.collateralUsd.toFixed(2)}, Entry: $${pos.entryPrice.toFixed(2)}`);
    }
}

main().catch(console.error).finally(() => process.exit(0));
