/**
 * Data Collector - Records every cycle's metrics to SQLite
 * 
 * Collects: prices, deltas, APR, rebalance events for later analysis.
 */

import Database from 'better-sqlite3';
import { loggers } from '../observability/logger';
import path from 'path';
import fs from 'fs';

const log = loggers.orchestrator;

// ============================================================================
// Types
// ============================================================================

export interface CycleData {
    timestamp: number;
    tslaPrice: number;
    lpDelta: number;
    hedgeDelta: number;
    netDelta: number;
    isLpInRange: boolean;
    poolApr: number;  // Current APR from Raydium
    poolTvl: number;
    rebalanceTriggered: boolean;
    rebalanceReason: string | null;
    rebalanceSizeUsd: number;
    gasCostUsd: number;
}

// ============================================================================
// Data Collector
// ============================================================================

export class DataCollector {
    private db: Database.Database | null = null;
    private dbPath: string;

    constructor(dataDir: string = './data') {
        // Ensure data directory exists
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        this.dbPath = path.join(dataDir, 'cycles.db');
    }

    /**
     * Initialize database and create tables
     */
    async initialize(): Promise<void> {
        try {
            this.db = new Database(this.dbPath);

            // Create cycles table
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS cycles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp INTEGER NOT NULL,
                    tsla_price REAL NOT NULL,
                    lp_delta REAL NOT NULL,
                    hedge_delta REAL NOT NULL,
                    net_delta REAL NOT NULL,
                    is_lp_in_range INTEGER NOT NULL,
                    pool_apr REAL,
                    pool_tvl REAL,
                    rebalance_triggered INTEGER NOT NULL,
                    rebalance_reason TEXT,
                    rebalance_size_usd REAL,
                    gas_cost_usd REAL,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );
                
                CREATE INDEX IF NOT EXISTS idx_cycles_timestamp ON cycles(timestamp);
                CREATE INDEX IF NOT EXISTS idx_cycles_rebalance ON cycles(rebalance_triggered);
            `);

            log.info({ event: 'data_collector_initialized', dbPath: this.dbPath });
        } catch (error) {
            log.error({
                event: 'data_collector_init_error',
                error: error instanceof Error ? error.message : String(error)
            });
            // Non-fatal - bot can run without data collection
        }
    }

    /**
     * Record a cycle's data
     */
    recordCycle(data: CycleData): void {
        if (!this.db) return;

        try {
            const stmt = this.db.prepare(`
                INSERT INTO cycles (
                    timestamp, tsla_price, lp_delta, hedge_delta, net_delta,
                    is_lp_in_range, pool_apr, pool_tvl, rebalance_triggered,
                    rebalance_reason, rebalance_size_usd, gas_cost_usd
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            stmt.run(
                data.timestamp,
                data.tslaPrice,
                data.lpDelta,
                data.hedgeDelta,
                data.netDelta,
                data.isLpInRange ? 1 : 0,
                data.poolApr,
                data.poolTvl,
                data.rebalanceTriggered ? 1 : 0,
                data.rebalanceReason,
                data.rebalanceSizeUsd,
                data.gasCostUsd
            );

            log.debug({ event: 'cycle_recorded', timestamp: data.timestamp });
        } catch (error) {
            log.warn({
                event: 'cycle_record_error',
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /**
     * Get cycle count
     */
    getCycleCount(): number {
        if (!this.db) return 0;
        const row = this.db.prepare('SELECT COUNT(*) as count FROM cycles').get() as { count: number };
        return row?.count || 0;
    }

    /**
     * Get rebalance count
     */
    getRebalanceCount(): number {
        if (!this.db) return 0;
        const row = this.db.prepare('SELECT COUNT(*) as count FROM cycles WHERE rebalance_triggered = 1').get() as { count: number };
        return row?.count || 0;
    }

    /**
     * Get summary stats
     */
    getSummary(): {
        totalCycles: number;
        rebalances: number;
        avgPrice: number;
        totalGasCost: number;
    } {
        if (!this.db) return { totalCycles: 0, rebalances: 0, avgPrice: 0, totalGasCost: 0 };

        const row = this.db.prepare(`
            SELECT 
                COUNT(*) as total_cycles,
                SUM(CASE WHEN rebalance_triggered = 1 THEN 1 ELSE 0 END) as rebalances,
                AVG(tsla_price) as avg_price,
                SUM(gas_cost_usd) as total_gas
            FROM cycles
        `).get() as { total_cycles: number; rebalances: number; avg_price: number; total_gas: number };

        return {
            totalCycles: row?.total_cycles || 0,
            rebalances: row?.rebalances || 0,
            avgPrice: row?.avg_price || 0,
            totalGasCost: row?.total_gas || 0,
        };
    }

    /**
     * Close database connection
     */
    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

// Singleton instance
let instance: DataCollector | null = null;

export function getDataCollector(): DataCollector {
    if (!instance) {
        instance = new DataCollector();
    }
    return instance;
}
