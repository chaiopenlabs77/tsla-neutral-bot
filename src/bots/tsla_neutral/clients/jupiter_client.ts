/**
 * Jupiter Swap Client
 *
 * Aggregator client for token swaps on Solana via Jupiter V6 API.
 * Provides best route discovery across all Solana DEXs.
 *
 * @see https://station.jup.ag/docs/apis/swap-api
 */

import {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import { config } from '../config';
import { loggers } from '../observability/logger';
import { txSubmittedCounter } from '../observability/metrics';

const log = loggers.lp; // Reuse LP logger for swaps

// Jupiter API endpoints
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';

// Common token mints
export const TOKEN_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  TSLAX: config.TSLAX_MINT.toBase58(),
};

// Quote response from Jupiter
interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
}

// Swap response from Jupiter
interface JupiterSwapResponse {
  swapTransaction: string; // Base64 encoded versioned transaction
  lastValidBlockHeight: number;
}

/**
 * Jupiter Swap Client
 *
 * Provides token swap functionality via Jupiter aggregator.
 */
export class JupiterClient {
  private connection: Connection;
  private wallet: Keypair | null = null;
  private isInitialized = false;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Initialize with wallet.
   */
  async initialize(wallet: Keypair): Promise<void> {
    if (this.isInitialized) return;
    this.wallet = wallet;
    this.isInitialized = true;
    log.info({ event: 'jupiter_client_initialized' });
  }

  private ensureInitialized(): void {
    if (!this.isInitialized || !this.wallet) {
      throw new Error('JupiterClient not initialized. Call initialize() first.');
    }
  }

  /**
   * Get a swap quote from Jupiter.
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: bigint,
    slippageBps: number = config.MAX_SLIPPAGE_BPS
  ): Promise<JupiterQuote> {
    log.info({
      event: 'getting_jupiter_quote',
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps,
    });

    const url = new URL(JUPITER_QUOTE_API);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount.toString());
    url.searchParams.set('slippageBps', slippageBps.toString());
    url.searchParams.set('onlyDirectRoutes', 'false');
    url.searchParams.set('asLegacyTransaction', 'false');

    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jupiter quote failed: ${error}`);
    }

    const quote = (await response.json()) as JupiterQuote;

    log.info({
      event: 'jupiter_quote_received',
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      priceImpact: quote.priceImpactPct,
      routes: quote.routePlan.length,
    });

    return quote;
  }

  /**
   * Execute a swap using a quote.
   */
  async swap(quote: JupiterQuote): Promise<{ txSignature: string } | null> {
    this.ensureInitialized();

    log.info({
      event: 'executing_jupiter_swap',
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
    });

    if (config.DRY_RUN) {
      log.info({
        event: 'dry_run_swap',
        msg: `Would swap ${quote.inAmount} ${quote.inputMint} → ${quote.outAmount} ${quote.outputMint}`,
      });
      txSubmittedCounter.inc({ type: 'swap', status: 'dry_run' });
      return { txSignature: 'dry-run-signature' };
    }

    try {
      // Get serialized swap transaction
      const swapResponse = await fetch(JUPITER_SWAP_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.wallet!.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: config.JITO_TIP_LAMPORTS,
        }),
      });

      if (!swapResponse.ok) {
        const error = await swapResponse.text();
        throw new Error(`Jupiter swap failed: ${error}`);
      }

      const { swapTransaction, lastValidBlockHeight } =
        (await swapResponse.json()) as JupiterSwapResponse;

      // Deserialize the transaction
      const txBuffer = Buffer.from(swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuffer);

      // Sign the transaction
      tx.sign([this.wallet!]);

      // Send and confirm
      const signature = await this.connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3,
      });

      await this.connection.confirmTransaction({
        signature,
        blockhash: tx.message.recentBlockhash,
        lastValidBlockHeight,
      });

      log.info({ event: 'jupiter_swap_success', txSignature: signature });
      txSubmittedCounter.inc({ type: 'swap', status: 'success' });

      return { txSignature: signature };
    } catch (error) {
      log.error({
        event: 'jupiter_swap_error',
        error: error instanceof Error ? error.message : String(error),
      });
      txSubmittedCounter.inc({ type: 'swap', status: 'failure' });
      return null;
    }
  }

  /**
   * Convenience method: Swap SOL to USDC.
   */
  async swapSolToUsdc(
    solAmount: bigint,
    slippageBps?: number
  ): Promise<{ txSignature: string; usdcAmount: string } | null> {
    const quote = await this.getQuote(TOKEN_MINTS.SOL, TOKEN_MINTS.USDC, solAmount, slippageBps);
    const result = await this.swap(quote);
    if (result) {
      return { ...result, usdcAmount: quote.outAmount };
    }
    return null;
  }

  /**
   * Convenience method: Swap USDC to SOL.
   */
  async swapUsdcToSol(
    usdcAmount: bigint,
    slippageBps?: number
  ): Promise<{ txSignature: string; solAmount: string } | null> {
    const quote = await this.getQuote(TOKEN_MINTS.USDC, TOKEN_MINTS.SOL, usdcAmount, slippageBps);
    const result = await this.swap(quote);
    if (result) {
      return { ...result, solAmount: quote.outAmount };
    }
    return null;
  }

  /**
   * Convenience method: Swap USDC to TSLAx.
   */
  async swapUsdcToTslax(
    usdcAmount: bigint,
    slippageBps?: number
  ): Promise<{ txSignature: string; tslaxAmount: string } | null> {
    const quote = await this.getQuote(TOKEN_MINTS.USDC, TOKEN_MINTS.TSLAX, usdcAmount, slippageBps);
    const result = await this.swap(quote);
    if (result) {
      return { ...result, tslaxAmount: quote.outAmount };
    }
    return null;
  }

  /**
   * Convenience method: Swap TSLAx to USDC.
   */
  async swapTslaxToUsdc(
    tslaxAmount: bigint,
    slippageBps?: number
  ): Promise<{ txSignature: string; usdcAmount: string } | null> {
    const quote = await this.getQuote(TOKEN_MINTS.TSLAX, TOKEN_MINTS.USDC, tslaxAmount, slippageBps);
    const result = await this.swap(quote);
    if (result) {
      return { ...result, usdcAmount: quote.outAmount };
    }
    return null;
  }

  /**
   * Get price estimate (output amount for 1 unit of input).
   */
  async getPrice(inputMint: string, outputMint: string): Promise<number> {
    // Get quote for 1 unit (adjusted for decimals)
    const decimals = inputMint === TOKEN_MINTS.USDC ? 6 : 9;
    const amount = BigInt(10 ** decimals);

    const quote = await this.getQuote(inputMint, outputMint, amount);
    const outDecimals = outputMint === TOKEN_MINTS.USDC ? 6 : 9;

    return Number(quote.outAmount) / 10 ** outDecimals;
  }
}
