/**
 * Test Jupiter Swap - 0.01 SOL → USDC
 * Reads wallet from .env
 */

import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import * as dotenv from 'dotenv';

dotenv.config();

const key = process.env.WALLET_PRIVATE_KEY;
if (!key) {
    console.error('WALLET_PRIVATE_KEY not set in .env');
    process.exit(1);
}

const wallet = Keypair.fromSecretKey(bs58.decode(key));
const conn = new Connection(process.env.RPC_ENDPOINT_1 || 'https://api.mainnet-beta.solana.com');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function testSwap() {
    console.log('Wallet:', wallet.publicKey.toBase58());

    // Check balance
    const sol = await conn.getBalance(wallet.publicKey);
    console.log('SOL Balance:', sol / 1e9);

    if (sol < 10_000_000) {
        console.log('Not enough SOL for swap test (need ~0.01 SOL)');
        return;
    }

    const amount = 5_000_000; // 0.005 SOL

    console.log('\nGetting quote for 0.005 SOL → USDC...');
    const quoteUrl = `https://public.jupiterapi.com/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${amount}&slippageBps=50`;
    const quoteRes = await fetch(quoteUrl);
    const quote: any = await quoteRes.json();

    if (quote.error) {
        console.error('Quote error:', quote.error);
        return;
    }

    console.log('Quote received:');
    console.log('  In: 0.01 SOL');
    console.log('  Out:', (Number(quote.outAmount) / 1e6).toFixed(4), 'USDC');
    console.log('  Price impact:', quote.priceImpactPct);

    console.log('\nExecuting swap...');
    const swapRes = await fetch('https://public.jupiterapi.com/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
        }),
    });

    const swapData: any = await swapRes.json();

    if (swapData.error) {
        console.error('Swap error:', swapData.error);
        return;
    }

    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
    tx.sign([wallet]);

    const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    console.log('TX submitted:', sig);
    console.log('Explorer: https://solscan.io/tx/' + sig);

    console.log('Waiting for confirmation...');
    await conn.confirmTransaction(sig, 'confirmed');
    console.log('✅ Swap confirmed!');

    // Check new balances
    const newSol = await conn.getBalance(wallet.publicKey);
    console.log('\nNew SOL Balance:', newSol / 1e9);

    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, {
        mint: new PublicKey(USDC_MINT)
    });
    if (tokenAccounts.value.length > 0) {
        const usdc = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
        console.log('USDC Balance:', usdc);
    }
}

testSwap().catch(console.error);
