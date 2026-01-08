/**
 * Standalone Flash Trade Test Script
 * 
 * Tests opening a short position on Flash Trade for debugging purposes.
 */

import { Connection, Keypair } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import bs58 from 'bs58';

dotenv.config();

async function main() {
    console.log('=== Flash Trade Test Script ===\n');

    // Load wallet
    const privateKeyStr = process.env.WALLET_PRIVATE_KEY;
    if (!privateKeyStr) {
        throw new Error('WALLET_PRIVATE_KEY not set');
    }

    let wallet: Keypair;
    try {
        // Try JSON array first
        const secretKey = JSON.parse(privateKeyStr);
        wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));
    } catch {
        // Try base58
        const secretKey = bs58.decode(privateKeyStr);
        wallet = Keypair.fromSecretKey(secretKey);
    }
    console.log('Wallet:', wallet.publicKey.toBase58());

    // Load Flash SDK
    const flashSdk = await import('flash-sdk');
    const { PerpetualsClient, PoolConfig } = flashSdk;
    const anchor = await import('@coral-xyz/anchor');
    const BN = anchor.BN;

    // Create connection
    const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');

    // Create Anchor provider
    const anchorWallet = {
        publicKey: wallet.publicKey,
        signTransaction: async (tx: any) => {
            tx.sign([wallet]);
            return tx;
        },
        signAllTransactions: async (txs: any[]) => {
            txs.forEach((tx) => tx.sign([wallet]));
            return txs;
        },
    };

    const provider = new anchor.AnchorProvider(
        connection as any,
        anchorWallet as any,
        { commitment: 'confirmed', preflightCommitment: 'confirmed' }
    );

    // Program IDs
    const FLASH_PROGRAM_ID = 'FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn';
    const COMPOSABILITY_PROGRAM_ID = 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2verN';
    const FB_NFT_REWARD_PROGRAM_ID = '5GKiTjH7hfL1VCZSgk1CDcJJ9AsuT9nuZ4fwt7yXAf4M';
    const REWARD_DISTRIBUTION_PROGRAM_ID = 'BPBgY2NZSEFYTgfbXZcwtLwVnFuBGx5vxJWkTYxxp3JD';

    // Initialize PerpetualsClient
    const perpClient = new PerpetualsClient(
        provider,
        FLASH_PROGRAM_ID,
        COMPOSABILITY_PROGRAM_ID,
        FB_NFT_REWARD_PROGRAM_ID,
        REWARD_DISTRIBUTION_PROGRAM_ID,
        { prioritizationFee: 10000 }
    );

    // Load pool config
    const poolConfig = PoolConfig.fromIdsByName('Remora.1', 'mainnet-beta');
    console.log('Pool:', poolConfig.poolAddress?.toBase58());
    console.log('Pool Name:', poolConfig.poolName);

    // List available tokens
    console.log('\nAvailable tokens:', poolConfig.tokens?.map((t: any) => t?.symbol));

    // Check if TSLAr token exists
    const tslaxToken = poolConfig.getTokenFromSymbol('TSLAr');
    const usdcToken = poolConfig.getTokenFromSymbol('USDC');
    console.log('\nTSLAr token:', tslaxToken?.symbol, tslaxToken?.decimals);
    console.log('USDC token:', usdcToken?.symbol, usdcToken?.decimals);

    // Load address lookup tables
    console.log('\nLoading address lookup tables...');
    await perpClient.loadAddressLookupTable(poolConfig);

    // Test parameters
    const targetSymbol = 'TSLAr';
    const collateralSymbol = 'USDC';
    const sizeUsd = 5.0; // $5 position
    const collateralUsd = 2.5; // $2.5 collateral (2x leverage)
    const slippageBps = 100; // 1% slippage

    // Get current price (mock for now)
    const currentPrice = 435.0; // From screenshot
    const priceWithSlippage = currentPrice * (1 - slippageBps / 10000);

    const priceObj = {
        price: new BN(Math.floor(priceWithSlippage * 1e5)),  // 1e5 for exponent -5
        exponent: -5,  // Flash Trade uses -5
    };

    // Convert amounts
    const sizeBN = new BN(Math.floor(sizeUsd * 1e6));
    const collateralBN = new BN(Math.floor(collateralUsd * 1e6));

    console.log('\n=== Position Parameters ===');
    console.log('Target:', targetSymbol);
    console.log('Collateral:', collateralSymbol);
    console.log('Price with slippage:', priceWithSlippage, 'USD');
    console.log('Price BN:', priceObj.price.toString(), '(exponent:', priceObj.exponent, ')');
    console.log('Size:', sizeUsd, 'USD => BN:', sizeBN.toString());
    console.log('Collateral:', collateralUsd, 'USD => BN:', collateralBN.toString());
    console.log('Side: SHORT ({ short: {} })');
    console.log('Privilege: NONE ({ none: {} })');

    // Check dry run mode
    const dryRun = process.env.DRY_RUN === 'true';
    if (dryRun) {
        console.log('\n=== DRY RUN MODE - Not executing ===');
        return;
    }

    console.log('\n=== Attempting to open position ===');
    try {
        const { instructions, additionalSigners } = await perpClient.openPosition(
            targetSymbol,
            collateralSymbol,
            priceObj,
            collateralBN,
            sizeBN,
            { short: {} },
            poolConfig,
            { none: {} }
        );

        console.log('Instructions generated:', instructions.length);
        console.log('Additional signers:', additionalSigners.length);

        // Build and send transaction
        const { blockhash } = await connection.getLatestBlockhash();
        const messageV0 = new (await import('@solana/web3.js')).TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions,
        }).compileToV0Message();

        const transaction = new (await import('@solana/web3.js')).VersionedTransaction(messageV0);
        transaction.sign([wallet, ...additionalSigners]);

        console.log('\nSimulating transaction...');
        const simulation = await connection.simulateTransaction(transaction);

        if (simulation.value.err) {
            console.error('Simulation failed:', JSON.stringify(simulation.value.err, null, 2));
            console.error('Logs:', simulation.value.logs);
        } else {
            console.log('Simulation succeeded!');
            console.log('Logs:', simulation.value.logs?.slice(0, 10));
        }

    } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
        if (error instanceof Error && error.stack) {
            console.error('Stack:', error.stack.split('\n').slice(0, 5).join('\n'));
        }
    }
}

main().catch(console.error);
