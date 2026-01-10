/**
 * Unwind All Positions Script
 * 
 * Closes all LP positions and Flash Trade short positions.
 * Use at EOD or for manual cleanup.
 * 
 * Features:
 * - Slippage protection on TSLAx→USDC swap
 * - Reports profit/loss before swap
 * - Dry run mode for safety
 * 
 * Usage:
 *   npx ts-node scripts/unwind-all.ts          # Live execution
 *   npx ts-node scripts/unwind-all.ts --dry-run # Dry run
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { config } from '../src/bots/tsla_neutral/config';
import { LPClient } from '../src/bots/tsla_neutral/clients/lp_client';
import { FlashTradeClient } from '../src/bots/tsla_neutral/clients/flash_trade_client';
import { JupiterClient } from '../src/bots/tsla_neutral/clients/jupiter_client';
import { PythClient } from '../src/bots/tsla_neutral/clients/pyth_client';
import bs58 from 'bs58';

// Parse wallet from env
function loadWallet(): Keypair {
    const keyString = process.env.WALLET_PRIVATE_KEY || '';

    if (keyString.startsWith('[')) {
        // JSON array format
        const keyArray = JSON.parse(keyString);
        return Keypair.fromSecretKey(Uint8Array.from(keyArray));
    } else {
        // Base58 format
        return Keypair.fromSecretKey(bs58.decode(keyString));
    }
}

// Max slippage allowed on EOD swap (1%)
const MAX_SWAP_SLIPPAGE_PERCENT = config.EOD_SWAP_MAX_SLIPPAGE_PERCENT;

async function main() {
    const isDryRun = process.argv.includes('--dry-run');

    console.log('='.repeat(60));
    console.log('TSLA Neutral Bot - Unwind All Positions');
    console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'}`);
    console.log('='.repeat(60));

    // Set DRY_RUN in config
    if (isDryRun) {
        (config as any).DRY_RUN = true;
    }

    const connection = new Connection(config.RPC_ENDPOINTS[0], 'confirmed');
    const wallet = loadWallet();
    console.log(`\nWallet: ${wallet.publicKey.toBase58()}`);

    // Initialize clients
    console.log('\n--- Initializing Clients ---');

    const lpClient = new LPClient(connection);
    await lpClient.initialize(wallet);
    console.log('✓ LP Client initialized');

    const flashTradeClient = new FlashTradeClient(connection, 'TSLAr');
    await flashTradeClient.initialize(wallet);
    console.log('✓ Flash Trade Client initialized');

    const jupiterClient = new JupiterClient(connection);
    await jupiterClient.initialize(wallet);
    console.log('✓ Jupiter Client initialized');

    const pythClient = new PythClient();
    console.log('✓ Pyth Client initialized');

    // Get current TSLA price for fallback
    const priceData = await pythClient.getTSLAPrice();
    const tslaPrice = priceData?.price ?? 0;
    console.log(`\nCurrent TSLA Price: $${tslaPrice.toFixed(2)}`);

    if (tslaPrice === 0) {
        console.log('⚠ Could not fetch TSLA price - operations may fail');
    }

    // Step 1: Close Flash Trade positions
    console.log('\n--- Step 1: Close Flash Trade Positions ---');
    const hedgePositions = await flashTradeClient.fetchPositions();

    if (hedgePositions.length === 0) {
        console.log('No Flash Trade positions to close');
    } else {
        for (const pos of hedgePositions) {
            console.log(`Closing ${pos.side} position: $${pos.size.toFixed(2)} @ ${pos.entryPrice.toFixed(2)}`);
            const result = await flashTradeClient.closePosition(config.MAX_SLIPPAGE_BPS, tslaPrice);
            if (result) {
                console.log(`✓ Closed: ${result.txSignature}`);
            } else {
                console.log('✗ Failed to close position');
            }
        }
    }

    // Step 2: Close LP positions
    console.log('\n--- Step 2: Close LP Positions ---');
    const lpPositions = await lpClient.fetchPositions();

    if (lpPositions.length === 0) {
        console.log('No LP positions to close');
    } else {
        for (const pos of lpPositions) {
            console.log(`Closing LP position: ${pos.mint.toBase58()}`);
            console.log(`  TokenA: ${pos.tokenAAmount}, TokenB: ${pos.tokenBAmount}, Range: [${pos.lowerTick}, ${pos.upperTick}]`);

            const result = await lpClient.closePosition(pos.mint);
            if (result) {
                console.log(`✓ Closed: ${result.txSignature}`);
            } else {
                console.log('✗ Failed to close LP position');
            }
        }
    }

    // Step 3: Check TSLAx balance and optionally swap to USDC
    console.log('\n--- Step 3: Check TSLAx Balance ---');

    // Get TSLAx balance by fetching the token account
    const tslaxAccounts = await connection.getTokenAccountsByOwner(wallet.publicKey, {
        mint: config.TSLAX_MINT,
    });

    let tslaxBalance = 0n;
    if (tslaxAccounts.value.length > 0) {
        const accountInfo = await connection.getTokenAccountBalance(tslaxAccounts.value[0].pubkey);
        tslaxBalance = BigInt(accountInfo.value.amount);
    }

    const tslaxDecimal = Number(tslaxBalance) / 1e8; // TSLAx has 8 decimals
    const tslaxValueUsd = tslaxDecimal * tslaPrice;

    console.log(`TSLAx balance: ${tslaxDecimal.toFixed(6)} (~$${tslaxValueUsd.toFixed(2)})`);

    if (tslaxDecimal < 0.0001) {
        console.log('No significant TSLAx balance to swap');
    } else {
        // Get quote to check slippage
        try {
            const quote = await jupiterClient.getQuote(
                config.TSLAX_MINT.toBase58(),
                config.USDC_MINT.toBase58(),
                tslaxBalance,
                config.MAX_SLIPPAGE_BPS
            );

            const expectedUsd = Number(quote.outAmount) / 1e6; // USDC is 6 decimals
            const slippagePct = ((tslaxValueUsd - expectedUsd) / tslaxValueUsd) * 100;

            console.log(`Quote: ${expectedUsd.toFixed(2)} USDC (slippage: ${slippagePct.toFixed(2)}%)`);

            // Only swap if slippage is acceptable
            if (slippagePct > MAX_SWAP_SLIPPAGE_PERCENT) {
                console.log(`⚠ Slippage ${slippagePct.toFixed(2)}% > ${MAX_SWAP_SLIPPAGE_PERCENT}%, skipping swap`);
                console.log('  TSLAx will be kept for tomorrow\'s position');
            } else {
                if (!isDryRun) {
                    const swapResult = await jupiterClient.swap(quote);
                    if (swapResult) {
                        console.log(`✓ Swapped: ${swapResult.txSignature}`);
                    } else {
                        console.log('✗ Swap failed');
                    }
                } else {
                    console.log('[DRY RUN] Would execute swap');
                }
            }
        } catch (error) {
            console.log(`Swap quote failed: ${error}`);
        }
    }

    // Step 4: Report final balances
    console.log('\n--- Final Balances ---');
    const solBalance = await connection.getBalance(wallet.publicKey);

    // Get USDC balance  
    const usdcAccounts = await connection.getTokenAccountsByOwner(wallet.publicKey, {
        mint: config.USDC_MINT,
    });
    let usdcBalance = 0;
    if (usdcAccounts.value.length > 0) {
        const accountInfo = await connection.getTokenAccountBalance(usdcAccounts.value[0].pubkey);
        usdcBalance = Number(accountInfo.value.amount) / 1e6;
    }

    // Get final TSLAx balance
    let finalTslax = 0;
    if (tslaxAccounts.value.length > 0) {
        const accountInfo = await connection.getTokenAccountBalance(tslaxAccounts.value[0].pubkey);
        finalTslax = Number(accountInfo.value.amount) / 1e8;
    }

    console.log(`SOL: ${(solBalance / 1e9).toFixed(4)}`);
    console.log(`USDC: $${usdcBalance.toFixed(2)}`);
    console.log(`TSLAx: ${finalTslax.toFixed(6)} (~$${(finalTslax * tslaPrice).toFixed(2)})`);
    console.log(`Total Value: $${(usdcBalance + finalTslax * tslaPrice).toFixed(2)}`);

    console.log('\n' + '='.repeat(60));
    console.log('Unwind complete!');
    console.log('='.repeat(60));
}

main().catch(console.error);
