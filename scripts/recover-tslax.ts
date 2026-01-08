/**
 * Recovery Script: Swap all TSLAx back to USDC
 * 
 * Use this when bootstrap partially failed and you need to recover funds.
 * 
 * Usage: npx ts-node scripts/recover-tslax.ts
 */

import { Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { JupiterClient } from '../src/bots/tsla_neutral/clients/jupiter_client';
import { config } from '../src/bots/tsla_neutral/config';
import { getRpcManager } from '../src/bots/tsla_neutral/clients/rpc_manager';
import bs58 from 'bs58';

async function main() {
    console.log('=== TSLAx Recovery Script ===\n');

    // Load wallet - handle both base58 and JSON array formats
    const privateKeyEnv = process.env.WALLET_PRIVATE_KEY || '';
    if (!privateKeyEnv) {
        console.error('Error: WALLET_PRIVATE_KEY not set');
        process.exit(1);
    }

    let wallet: Keypair;
    try {
        // Try JSON array first
        const privateKeyBytes = JSON.parse(privateKeyEnv) as number[];
        wallet = Keypair.fromSecretKey(Uint8Array.from(privateKeyBytes));
    } catch {
        // Assume base58
        wallet = Keypair.fromSecretKey(bs58.decode(privateKeyEnv));
    }
    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

    // Get connection
    const connection = getRpcManager().getConnection();

    // Check TSLAx balance
    const tslaxMint = config.TSLAX_MINT;
    let tslaxBalance: bigint;

    try {
        // TSLAx is a Token2022 token, need to use TOKEN_2022_PROGRAM_ID
        const tslaxAta = await getAssociatedTokenAddress(
            tslaxMint,
            wallet.publicKey,
            false, // allowOwnerOffCurve
            TOKEN_2022_PROGRAM_ID
        );
        const tslaxInfo = await connection.getTokenAccountBalance(tslaxAta);
        tslaxBalance = BigInt(tslaxInfo.value.amount);

        // TSLAx has 8 decimals
        const tslaxUiAmount = Number(tslaxBalance) / 1e8;
        console.log(`TSLAx Balance: ${tslaxBalance.toString()} raw (${tslaxUiAmount.toFixed(6)} tokens)`);

        if (tslaxBalance === 0n) {
            console.log('\nNo TSLAx to recover.');
            process.exit(0);
        }
    } catch (error) {
        console.log('No TSLAx token account found - nothing to recover.');
        process.exit(0);
    }

    // Check USDC balance before
    const usdcMint = config.USDC_MINT;
    const usdcAta = await getAssociatedTokenAddress(usdcMint, wallet.publicKey);
    const usdcBefore = await connection.getTokenAccountBalance(usdcAta);
    console.log(`USDC Before: ${(Number(usdcBefore.value.amount) / 1e6).toFixed(2)} USDC`);

    // Initialize Jupiter client
    const jupiterClient = new JupiterClient(connection);
    await jupiterClient.initialize(wallet);

    // Dry run check
    if (process.env.DRY_RUN === 'true') {
        console.log('\n[DRY RUN] Would swap TSLAx back to USDC');
        console.log('Set DRY_RUN=false to execute');
        process.exit(0);
    }

    // Execute swap
    console.log('\nSwapping TSLAx → USDC...');
    const swapResult = await jupiterClient.swapTslaxToUsdc(tslaxBalance);

    if (!swapResult) {
        console.error('Swap failed!');
        process.exit(1);
    }

    console.log(`\n✅ Swap successful!`);
    console.log(`TX: ${swapResult.txSignature}`);
    console.log(`USDC received: ${(Number(swapResult.usdcAmount) / 1e6).toFixed(2)} USDC`);

    // Check final USDC balance
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for confirmation
    const usdcAfter = await connection.getTokenAccountBalance(usdcAta);
    console.log(`\nUSDC After: ${(Number(usdcAfter.value.amount) / 1e6).toFixed(2)} USDC`);

    const gained = (Number(usdcAfter.value.amount) - Number(usdcBefore.value.amount)) / 1e6;
    console.log(`Net gained: +${gained.toFixed(2)} USDC`);
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
