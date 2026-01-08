import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { createServer } from 'http';
import { config } from '../config';

// Create a custom registry
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (memory, CPU, etc.)
collectDefaultMetrics({ register: metricsRegistry });

// ============================================================================
// Counters (monotonically increasing)
// ============================================================================

export const txSubmittedCounter = new Counter({
    name: 'tsla_bot_tx_submitted_total',
    help: 'Total transactions submitted',
    labelNames: ['type', 'status'] as const, // type: lp|hedge|bundle, status: success|failure
    registers: [metricsRegistry],
});

export const rebalanceCounter = new Counter({
    name: 'tsla_bot_rebalances_total',
    help: 'Total rebalance operations',
    labelNames: ['reason', 'status'] as const, // reason: drift|out_of_range|forced
    registers: [metricsRegistry],
});

export const alertCounter = new Counter({
    name: 'tsla_bot_alerts_total',
    help: 'Total alerts sent',
    labelNames: ['severity', 'type'] as const,
    registers: [metricsRegistry],
});

// ============================================================================
// Gauges (point-in-time values)
// ============================================================================

export const deltaGauge = new Gauge({
    name: 'tsla_bot_delta',
    help: 'Current net delta exposure',
    registers: [metricsRegistry],
});

export const lpValueGauge = new Gauge({
    name: 'tsla_bot_lp_value_usd',
    help: 'Current LP position value in USD',
    registers: [metricsRegistry],
});

export const hedgeValueGauge = new Gauge({
    name: 'tsla_bot_hedge_value_usd',
    help: 'Current hedge position value in USD',
    registers: [metricsRegistry],
});

export const pnlGauge = new Gauge({
    name: 'tsla_bot_pnl_usd',
    help: 'Unrealized PnL in USD',
    registers: [metricsRegistry],
});

export const solBalanceGauge = new Gauge({
    name: 'tsla_bot_sol_balance',
    help: 'Wallet SOL balance',
    registers: [metricsRegistry],
});

export const rpcHealthGauge = new Gauge({
    name: 'tsla_bot_rpc_healthy',
    help: 'RPC endpoint health (1=healthy, 0=unhealthy)',
    labelNames: ['endpoint'] as const,
    registers: [metricsRegistry],
});

export const stateGauge = new Gauge({
    name: 'tsla_bot_state',
    help: 'Current bot state (encoded as integer)',
    registers: [metricsRegistry],
});

export const oracleDivergenceGauge = new Gauge({
    name: 'tsla_bot_oracle_divergence_percent',
    help: 'Price divergence between pool and Pyth oracle',
    registers: [metricsRegistry],
});

export const liquidationDistanceGauge = new Gauge({
    name: 'tsla_bot_liquidation_distance_percent',
    help: 'Distance to liquidation price as percentage',
    registers: [metricsRegistry],
});

// ============================================================================
// Histograms (distributions)
// ============================================================================

export const txLatencyHistogram = new Histogram({
    name: 'tsla_bot_tx_latency_seconds',
    help: 'Transaction confirmation latency',
    labelNames: ['type'] as const,
    buckets: [0.5, 1, 2, 5, 10, 30, 60],
    registers: [metricsRegistry],
});

export const rpcLatencyHistogram = new Histogram({
    name: 'tsla_bot_rpc_latency_seconds',
    help: 'RPC call latency',
    labelNames: ['method'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [metricsRegistry],
});

export const slippageHistogram = new Histogram({
    name: 'tsla_bot_slippage_bps',
    help: 'Actual slippage in basis points',
    labelNames: ['operation'] as const,
    buckets: [5, 10, 25, 50, 100, 200],
    registers: [metricsRegistry],
});

// ============================================================================
// Metrics Server
// ============================================================================

let metricsServer: ReturnType<typeof createServer> | null = null;

export function startMetricsServer(): void {
    if (metricsServer) return;

    metricsServer = createServer(async (req, res) => {
        if (req.url === '/metrics') {
            res.setHeader('Content-Type', metricsRegistry.contentType);
            res.end(await metricsRegistry.metrics());
        } else if (req.url === '/health') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ status: 'ok' }));
        } else {
            res.statusCode = 404;
            res.end('Not found');
        }
    });

    metricsServer.listen(config.PROMETHEUS_PORT, () => {
        console.log(`[Metrics] Server listening on port ${config.PROMETHEUS_PORT}`);
    });
}

export function stopMetricsServer(): Promise<void> {
    return new Promise((resolve) => {
        if (metricsServer) {
            metricsServer.close(() => resolve());
            metricsServer = null;
        } else {
            resolve();
        }
    });
}
