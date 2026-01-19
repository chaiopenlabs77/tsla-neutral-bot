/**
 * Swap USDC to SOL for rent/fees
 * 
 * Usage: npx ts-node scripts/fund-sol.ts [amount-usd]
 * Default: $5 USDC → ~0.025 SOL
 */

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { JupiterClient, TOKEN_MINTS } from '../src/bots/tsla_neutral/clients/jupiter_client';
import { config } from '../src/bots/tsla_neutral/config';

const USDC_DECIMALS = 6;

async function main() {
    const amountUsd = parseFloat(process.argv[2] || '5');
    const amountMicro = BigInt(Math.floor(amountUsd * 10 ** USDC_DECIMALS));

    console.log('=== USDC → SOL Swap ===');
    console.log(`Amount: $${amountUsd} USDC`);

    // Load wallet
    const privateKey = process.env.WALLET_PRIVATE_KEY;
    if (!privateKey) {
        throw new Error('WALLET_PRIVATE_KEY not set');
    }
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

    // Connect
    const connection = new Connection(config.RPC_ENDPOINTS[0], 'confirmed');

    // Check balances before
    const solBefore = await connection.getBalance(wallet.publicKey);
    const usdcMint = new PublicKey(TOKEN_MINTS.USDC);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    });
    let usdcBefore = 0;
    for (const acc of tokenAccounts.value) {
        if (acc.account.data.parsed.info.mint === TOKEN_MINTS.USDC) {
            usdcBefore = acc.account.data.parsed.info.tokenAmount.uiAmount;
        }
    }

    console.log(`\nBefore:`);
    console.log(`  SOL:  ${(solBefore / LAMPORTS_PER_SOL).toFixed(4)}`);
    console.log(`  USDC: $${usdcBefore.toFixed(2)}`);

    // Initialize Jupiter
    const jupiter = new JupiterClient(connection);
    await jupiter.initialize(wallet);

    // Get quote first
    console.log(`\nGetting quote for ${amountUsd} USDC → SOL...`);
    const quote = await jupiter.getQuote(TOKEN_MINTS.USDC, TOKEN_MINTS.SOL, amountMicro, 100); // 1% slippage
    const expectedSol = Number(quote.outAmount) / LAMPORTS_PER_SOL;
    console.log(`Expected output: ${expectedSol.toFixed(4)} SOL`);
    console.log(`Price impact: ${quote.priceImpactPct}%`);

    // Confirm
    console.log('\nExecuting swap...');
    const result = await jupiter.swap(quote);

    if (result) {
        console.log(`\n✅ Swap successful!`);
        console.log(`TX: https://solscan.io/tx/${result.txSignature}`);

        // Check balances after
        await new Promise(r => setTimeout(r, 2000)); // Wait for confirmation
        const solAfter = await connection.getBalance(wallet.publicKey);
        console.log(`\nAfter:`);
        console.log(`  SOL:  ${(solAfter / LAMPORTS_PER_SOL).toFixed(4)} (+${((solAfter - solBefore) / LAMPORTS_PER_SOL).toFixed(4)})`);
    } else {
        console.log('❌ Swap failed');
        process.exit(1);
    }
}

main().catch(console.error);
