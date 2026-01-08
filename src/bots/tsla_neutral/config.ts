import { PublicKey } from '@solana/web3.js';
import 'dotenv/config';

// ============================================================================
// Environment Validation
// ============================================================================
function requireEnv(key: string): string {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

function optionalEnv(key: string, defaultValue: string): string {
    return process.env[key] ?? defaultValue;
}

function optionalEnvNumber(key: string, defaultValue: number): number {
    const value = process.env[key];
    return value ? parseFloat(value) : defaultValue;
}

function optionalEnvBool(key: string, defaultValue: boolean): boolean {
    const value = process.env[key];
    if (!value) return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
}

// ============================================================================
// Configuration Object
// ============================================================================
export const config = {
    // ──────────────────────────────────────────────────────────────────────────
    // Mode
    // ──────────────────────────────────────────────────────────────────────────
    DRY_RUN: optionalEnvBool('DRY_RUN', true),
    TRADING_HOURS_ONLY: optionalEnvBool('TRADING_HOURS_ONLY', false),

    // ──────────────────────────────────────────────────────────────────────────
    // RPC Endpoints (Multi-RPC with failover)
    // ──────────────────────────────────────────────────────────────────────────
    RPC_ENDPOINTS: [
        optionalEnv('RPC_ENDPOINT_1', 'https://api.mainnet-beta.solana.com'),
        optionalEnv('RPC_ENDPOINT_2', ''),
        optionalEnv('RPC_ENDPOINT_3', ''),
    ].filter(Boolean),
    RPC_HEALTH_CHECK_INTERVAL_MS: optionalEnvNumber('RPC_HEALTH_CHECK_INTERVAL_MS', 5000),

    // ──────────────────────────────────────────────────────────────────────────
    // Wallet
    // ──────────────────────────────────────────────────────────────────────────
    WALLET_PRIVATE_KEY: requireEnv('WALLET_PRIVATE_KEY'),

    // ──────────────────────────────────────────────────────────────────────────
    // Redis
    // ──────────────────────────────────────────────────────────────────────────
    REDIS_URL: optionalEnv('REDIS_URL', 'redis://localhost:6379'),
    DISTRIBUTED_LOCK_TTL_MS: optionalEnvNumber('DISTRIBUTED_LOCK_TTL_MS', 30000),
    DISTRIBUTED_LOCK_RENEWAL_MS: optionalEnvNumber('DISTRIBUTED_LOCK_RENEWAL_MS', 10000),

    // ──────────────────────────────────────────────────────────────────────────
    // Pool & Token Addresses (Raydium CLMM)
    // ──────────────────────────────────────────────────────────────────────────
    TSLAX_MINT: new PublicKey(optionalEnv('TSLAX_MINT', 'TSLAxMGPCpLeQahyN6NnfpF4SMJa4cLSLdKEVjPJmAP')),
    USDC_MINT: new PublicKey(optionalEnv('USDC_MINT', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')),
    RAYDIUM_POOL_ADDRESS: new PublicKey(optionalEnv('RAYDIUM_POOL_ADDRESS', '11111111111111111111111111111111')), // Placeholder

    // ──────────────────────────────────────────────────────────────────────────
    // Flash Trade
    // ──────────────────────────────────────────────────────────────────────────
    FLASH_TRADE_PROGRAM_ID: new PublicKey(optionalEnv('FLASH_TRADE_PROGRAM_ID', '11111111111111111111111111111111')),
    FLASH_TRADE_TSLA_MARKET: optionalEnv('FLASH_TRADE_TSLA_MARKET', 'TSLA-USD'),

    // ──────────────────────────────────────────────────────────────────────────
    // Pyth
    // ──────────────────────────────────────────────────────────────────────────
    PYTH_HERMES_ENDPOINT: optionalEnv('PYTH_HERMES_ENDPOINT', 'https://hermes.pyth.network'),
    PYTH_TSLA_PRICE_FEED_ID: optionalEnv('PYTH_TSLA_PRICE_FEED_ID', ''),

    // ──────────────────────────────────────────────────────────────────────────
    // Jito
    // ──────────────────────────────────────────────────────────────────────────
    JITO_BLOCK_ENGINE_URL: optionalEnv('JITO_BLOCK_ENGINE_URL', 'https://mainnet.block-engine.jito.wtf'),
    JITO_TIP_LAMPORTS: optionalEnvNumber('JITO_TIP_LAMPORTS', 10000), // 0.00001 SOL default
    MAX_PRIORITY_FEE_LAMPORTS: optionalEnvNumber('MAX_PRIORITY_FEE_LAMPORTS', 10000000), // 0.01 SOL cap

    // ──────────────────────────────────────────────────────────────────────────
    // Strategy Parameters
    // ──────────────────────────────────────────────────────────────────────────
    RANGE_WIDTH_PERCENT: optionalEnvNumber('RANGE_WIDTH_PERCENT', 0.05), // ±5% default
    DELTA_DRIFT_THRESHOLD_PERCENT: optionalEnvNumber('DELTA_DRIFT_THRESHOLD_PERCENT', 0.05), // 5% drift
    MAX_SLIPPAGE_BPS: optionalEnvNumber('MAX_SLIPPAGE_BPS', 50), // 0.5%
    ORACLE_DIVERGENCE_THRESHOLD_PERCENT: optionalEnvNumber('ORACLE_DIVERGENCE_THRESHOLD_PERCENT', 0.005), // 0.5%
    PYTH_CONFIDENCE_THRESHOLD_PERCENT: optionalEnvNumber('PYTH_CONFIDENCE_THRESHOLD_PERCENT', 0.01), // 1%
    MAX_OUT_OF_RANGE_DURATION_MS: optionalEnvNumber('MAX_OUT_OF_RANGE_DURATION_MS', 3600000), // 1 hour
    MAX_GAS_COST_PER_REBALANCE_SOL: optionalEnvNumber('MAX_GAS_COST_PER_REBALANCE_SOL', 0.05),

    // ──────────────────────────────────────────────────────────────────────────
    // Risk Management
    // ──────────────────────────────────────────────────────────────────────────
    MIN_SOL_RESERVE: optionalEnvNumber('MIN_SOL_RESERVE', 0.1),
    LIQUIDATION_WARNING_PERCENT: optionalEnvNumber('LIQUIDATION_WARNING_PERCENT', 0.10), // Alert if within 10%
    FUNDING_RATE_SPIKE_THRESHOLD: optionalEnvNumber('FUNDING_RATE_SPIKE_THRESHOLD', 0.001), // 0.1% per hour

    // ──────────────────────────────────────────────────────────────────────────
    // Timing
    // ──────────────────────────────────────────────────────────────────────────
    LOOP_INTERVAL_MS: optionalEnvNumber('LOOP_INTERVAL_MS', 10000), // 10 seconds
    RECONCILIATION_INTERVAL_MS: optionalEnvNumber('RECONCILIATION_INTERVAL_MS', 300000), // 5 minutes
    QUIET_HOURS_START_UTC: optionalEnv('QUIET_HOURS_START_UTC', '14:30'), // 9:30 AM ET = 14:30 UTC
    QUIET_HOURS_END_UTC: optionalEnv('QUIET_HOURS_END_UTC', '15:15'), // 10:15 AM ET = 15:15 UTC

    // ──────────────────────────────────────────────────────────────────────────
    // Backoff
    // ──────────────────────────────────────────────────────────────────────────
    BACKOFF_INITIAL_MS: optionalEnvNumber('BACKOFF_INITIAL_MS', 1000),
    BACKOFF_MAX_MS: optionalEnvNumber('BACKOFF_MAX_MS', 60000),
    BACKOFF_MULTIPLIER: optionalEnvNumber('BACKOFF_MULTIPLIER', 2),

    // ──────────────────────────────────────────────────────────────────────────
    // Observability
    // ──────────────────────────────────────────────────────────────────────────
    PROMETHEUS_PORT: optionalEnvNumber('PROMETHEUS_PORT', 9090),
    LOG_LEVEL: optionalEnv('LOG_LEVEL', 'info'),
    TELEGRAM_BOT_TOKEN: optionalEnv('TELEGRAM_BOT_TOKEN', ''),
    TELEGRAM_CHAT_ID: optionalEnv('TELEGRAM_CHAT_ID', ''),
    ALERT_RATE_LIMIT_MS: optionalEnvNumber('ALERT_RATE_LIMIT_MS', 300000), // 5 min per alert type

    // ──────────────────────────────────────────────────────────────────────────
    // Postgres (for profit tracking)
    // ──────────────────────────────────────────────────────────────────────────
    POSTGRES_URL: optionalEnv('POSTGRES_URL', ''),

    // ──────────────────────────────────────────────────────────────────────────
    // Memory Monitoring
    // ──────────────────────────────────────────────────────────────────────────
    HEAP_SNAPSHOT_INTERVAL_MS: optionalEnvNumber('HEAP_SNAPSHOT_INTERVAL_MS', 21600000), // 6 hours
    HEAP_GROWTH_ALERT_PERCENT: optionalEnvNumber('HEAP_GROWTH_ALERT_PERCENT', 50),
} as const;

export type Config = typeof config;
