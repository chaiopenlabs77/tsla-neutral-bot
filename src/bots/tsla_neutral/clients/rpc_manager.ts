import {
    Connection,
    Commitment,
    PublicKey,
    AccountInfo,
    GetMultipleAccountsConfig,
} from '@solana/web3.js';
import { config } from '../config';
import { RpcHealth } from '../types';
import { loggers } from '../observability/logger';
import { rpcHealthGauge, rpcLatencyHistogram } from '../observability/metrics';
import { alerts } from '../observability/alerter';

const log = loggers.rpc;

interface RpcEndpoint {
    url: string;
    connection: Connection;
    health: RpcHealth;
}

class RpcManager {
    private endpoints: RpcEndpoint[] = [];
    private currentIndex = 0;
    private healthCheckInterval: NodeJS.Timeout | null = null;

    constructor() {
        this.endpoints = config.RPC_ENDPOINTS.map((url) => ({
            url,
            connection: new Connection(url, {
                commitment: 'confirmed' as Commitment,
                confirmTransactionInitialTimeout: 60000,
            }),
            health: {
                endpoint: url,
                latencyMs: 0,
                lastBlockhash: '',
                lastBlockHeight: 0,
                lastChecked: 0,
                isHealthy: true,
                consecutiveFailures: 0,
            },
        }));

        if (this.endpoints.length === 0) {
            throw new Error('No RPC endpoints configured');
        }
    }

    /**
     * Get the current healthy connection.
     */
    getConnection(): Connection {
        const healthy = this.endpoints.find((e) => e.health.isHealthy);
        if (healthy) {
            return healthy.connection;
        }

        // Fallback to first endpoint if none healthy
        log.warn({ event: 'no_healthy_rpc', msg: 'No healthy RPC endpoints, using fallback' });
        return this.endpoints[0].connection;
    }

    /**
     * Get all connections for multi-RPC verification.
     */
    getAllConnections(): Connection[] {
        return this.endpoints.map((e) => e.connection);
    }

    /**
     * Get multiple accounts with batching.
     */
    async getMultipleAccounts(
        publicKeys: PublicKey[],
        configOrCommitment?: GetMultipleAccountsConfig | Commitment
    ): Promise<(AccountInfo<Buffer> | null)[]> {
        const connection = this.getConnection();
        const start = Date.now();

        try {
            const result = await connection.getMultipleAccountsInfo(publicKeys, configOrCommitment);
            rpcLatencyHistogram.observe({ method: 'getMultipleAccounts' }, (Date.now() - start) / 1000);
            return result;
        } catch (error) {
            this.handleRpcError(this.endpoints[this.currentIndex], error);
            throw error;
        }
    }

    /**
     * Start health check loop.
     */
    startHealthChecks(): void {
        if (this.healthCheckInterval) return;

        this.healthCheckInterval = setInterval(() => {
            this.checkAllEndpoints();
        }, config.RPC_HEALTH_CHECK_INTERVAL_MS);

        // Initial check
        this.checkAllEndpoints();
        log.info({ event: 'health_checks_started' });
    }

    /**
     * Stop health check loop.
     */
    stopHealthChecks(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    /**
     * Check health of all endpoints.
     */
    private async checkAllEndpoints(): Promise<void> {
        await Promise.all(this.endpoints.map((e) => this.checkEndpoint(e)));
    }

    /**
     * Check health of a single endpoint.
     */
    private async checkEndpoint(endpoint: RpcEndpoint): Promise<void> {
        const start = Date.now();

        try {
            const { blockhash, lastValidBlockHeight } = await endpoint.connection.getLatestBlockhash();
            const latency = Date.now() - start;

            endpoint.health = {
                endpoint: endpoint.url,
                latencyMs: latency,
                lastBlockhash: blockhash,
                lastBlockHeight: lastValidBlockHeight,
                lastChecked: Date.now(),
                isHealthy: true,
                consecutiveFailures: 0,
            };

            rpcHealthGauge.set({ endpoint: endpoint.url }, 1);
            rpcLatencyHistogram.observe({ method: 'getLatestBlockhash' }, latency / 1000);
        } catch (error) {
            this.handleRpcError(endpoint, error);
        }
    }

    /**
     * Handle RPC error and update health status.
     */
    private handleRpcError(endpoint: RpcEndpoint, error: unknown): void {
        endpoint.health.consecutiveFailures++;
        endpoint.health.lastChecked = Date.now();

        if (endpoint.health.consecutiveFailures >= 3) {
            endpoint.health.isHealthy = false;
            rpcHealthGauge.set({ endpoint: endpoint.url }, 0);
            alerts.rpcUnhealthy(endpoint.url);
        }

        log.warn({
            event: 'rpc_error',
            endpoint: endpoint.url,
            failures: endpoint.health.consecutiveFailures,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    /**
     * Get current health status of all endpoints.
     */
    getHealthStatus(): RpcHealth[] {
        return this.endpoints.map((e) => e.health);
    }
}

// Singleton instance
let rpcManager: RpcManager | null = null;

export function getRpcManager(): RpcManager {
    if (!rpcManager) {
        rpcManager = new RpcManager();
    }
    return rpcManager;
}

export function getConnection(): Connection {
    return getRpcManager().getConnection();
}
