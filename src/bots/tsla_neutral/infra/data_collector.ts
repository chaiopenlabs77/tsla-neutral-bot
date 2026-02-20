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
    // Phase 3: Cost tracking fields (nullable for backward compatibility)
    estFundingCostUsd?: number;
    rebalanceSlippageCostUsd?: number;
    repositionEvent?: boolean;
    // Phase 4: Actual tracking fields (CUMULATIVE since position open / last reposition)
    lpFeesUsd?: number;           // Cumulative uncollected LP fees in USD (since last reposition)
    lpValueUsd?: number;          // Total LP position value (tokenA * price + tokenB) in USD
    hedgeFundingUsd?: number;     // Cumulative funding income since position open (shorts earn this)
    hedgeCumLockFee?: number;     // Flash Trade cumulativeLockFeeSnapshot
    // Phase 5: Per-cycle deltas (for daily/hourly aggregation)
    hedgeFundingDeltaUsd?: number;  // Per-cycle funding increment
    lpFeesDeltaUsd?: number;        // Per-cycle LP fee increment
    // Phase 6: Impermanent loss tracking
    repositionIlUsd?: number;      // IL realized at this reposition event (0 on non-reposition cycles)
    cumulativeIlUsd?: number;      // Running total of IL since strategy start
    // Phase 6 (continued): Swap slippage tracking
    swapSlippageBps?: number;      // Realized slippage on reposition swap (0 on non-swap cycles)
    swapExpectedUsd?: number;      // Expected swap output in USD
    swapActualUsd?: number;        // Actual swap output in USD
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

            // Migration: add cost tracking columns if they don't exist
            const columns = this.db.pragma('table_info(cycles)') as { name: string }[];
            const colNames = new Set(columns.map(c => c.name));
            if (!colNames.has('est_funding_cost_usd')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN est_funding_cost_usd REAL DEFAULT 0');
            }
            if (!colNames.has('rebalance_slippage_cost_usd')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN rebalance_slippage_cost_usd REAL DEFAULT 0');
            }
            if (!colNames.has('reposition_event')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN reposition_event INTEGER DEFAULT 0');
            }
            if (!colNames.has('lp_fees_usd')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN lp_fees_usd REAL DEFAULT 0');
            }
            if (!colNames.has('lp_value_usd')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN lp_value_usd REAL DEFAULT 0');
            }
            if (!colNames.has('hedge_funding_usd')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN hedge_funding_usd REAL DEFAULT 0');
            }
            if (!colNames.has('hedge_cum_lock_fee')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN hedge_cum_lock_fee REAL DEFAULT 0');
            }
            if (!colNames.has('hedge_funding_delta_usd')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN hedge_funding_delta_usd REAL DEFAULT 0');
            }
            if (!colNames.has('lp_fees_delta_usd')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN lp_fees_delta_usd REAL DEFAULT 0');
            }
            if (!colNames.has('reposition_il_usd')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN reposition_il_usd REAL DEFAULT 0');
            }
            if (!colNames.has('cumulative_il_usd')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN cumulative_il_usd REAL DEFAULT 0');
            }
            if (!colNames.has('swap_slippage_bps')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN swap_slippage_bps REAL DEFAULT 0');
            }
            if (!colNames.has('swap_expected_usd')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN swap_expected_usd REAL DEFAULT 0');
            }
            if (!colNames.has('swap_actual_usd')) {
                this.db.exec('ALTER TABLE cycles ADD COLUMN swap_actual_usd REAL DEFAULT 0');
            }

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
                    rebalance_reason, rebalance_size_usd, gas_cost_usd,
                    est_funding_cost_usd, rebalance_slippage_cost_usd, reposition_event,
                    lp_fees_usd, lp_value_usd, hedge_funding_usd, hedge_cum_lock_fee,
                    hedge_funding_delta_usd, lp_fees_delta_usd,
                    reposition_il_usd, cumulative_il_usd,
                    swap_slippage_bps, swap_expected_usd, swap_actual_usd
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                data.gasCostUsd,
                data.estFundingCostUsd || 0,
                data.rebalanceSlippageCostUsd || 0,
                data.repositionEvent ? 1 : 0,
                data.lpFeesUsd || 0,
                data.lpValueUsd || 0,
                data.hedgeFundingUsd || 0,
                data.hedgeCumLockFee || 0,
                data.hedgeFundingDeltaUsd || 0,
                data.lpFeesDeltaUsd || 0,
                data.repositionIlUsd || 0,
                data.cumulativeIlUsd || 0,
                data.swapSlippageBps || 0,
                data.swapExpectedUsd || 0,
                data.swapActualUsd || 0
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
