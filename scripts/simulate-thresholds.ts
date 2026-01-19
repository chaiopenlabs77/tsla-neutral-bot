#!/usr/bin/env npx ts-node
/**
 * Analyze collected cycle data
 * 
 * Simulates what would happen at different rebalance thresholds
 * using the real data collected by the bot.
 * 
 * Usage:
 *   npm run analyze
 */

import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(__dirname, '..', 'data', 'cycles.db');
const THRESHOLDS = [0.01, 0.02, 0.05]; // 1%, 2%, 5%
const GAS_COST_PER_REBALANCE = 0.10; // $0.10
const SLIPPAGE_BPS = 50; // 0.5%

interface CycleRow {
    id: number;
    timestamp: number;
    tsla_price: number;
    lp_delta: number;
    hedge_delta: number;
    net_delta: number;
    is_lp_in_range: number;
    pool_apr: number;
    rebalance_triggered: number;
    rebalance_reason: string;
    rebalance_size_usd: number;
    gas_cost_usd: number;
}

function simulateThreshold(cycles: CycleRow[], threshold: number): {
    rebalances: number;
    totalGas: number;
    totalSlippage: number;
} {
    if (cycles.length < 2) return { rebalances: 0, totalGas: 0, totalSlippage: 0 };

    let rebalances = 0;
    let lastRebalancePrice = cycles[0].tsla_price;
    let totalSlippage = 0;

    for (const cycle of cycles) {
        if (cycle.tsla_price === 0) continue;

        const drift = Math.abs(cycle.tsla_price - lastRebalancePrice) / lastRebalancePrice;

        if (drift >= threshold) {
            rebalances++;
            // Estimate slippage based on position size
            const positionSize = Math.abs(cycle.lp_delta) * cycle.tsla_price;
            totalSlippage += positionSize * (SLIPPAGE_BPS / 10000);
            lastRebalancePrice = cycle.tsla_price;
        }
    }

    return {
        rebalances,
        totalGas: rebalances * GAS_COST_PER_REBALANCE,
        totalSlippage,
    };
}

function main(): void {
    console.log('TSLA-USDC Delta Neutral - Data Analysis\n');

    let db: Database.Database;
    try {
        db = new Database(DB_PATH, { readonly: true });
    } catch (error) {
        console.log(`No data file found at ${DB_PATH}`);
        console.log('Run the bot first to collect data.');
        return;
    }

    // Get all cycles
    const cycles = db.prepare('SELECT * FROM cycles ORDER BY timestamp').all() as CycleRow[];

    if (cycles.length === 0) {
        console.log('No cycle data collected yet. Run the bot to collect data.');
        db.close();
        return;
    }

    // Get summary stats
    const stats = db.prepare(`
        SELECT 
            COUNT(*) as total,
            MIN(tsla_price) as min_price,
            MAX(tsla_price) as max_price,
            AVG(tsla_price) as avg_price,
            SUM(CASE WHEN rebalance_triggered = 1 THEN 1 ELSE 0 END) as actual_rebalances,
            SUM(gas_cost_usd) as total_gas
        FROM cycles
        WHERE tsla_price > 0
    `).get() as any;

    const firstTs = cycles[0]?.timestamp || 0;
    const lastTs = cycles[cycles.length - 1]?.timestamp || 0;
    const durationHours = (lastTs - firstTs) / (1000 * 60 * 60);

    console.log('═'.repeat(60));
    console.log('DATA SUMMARY');
    console.log('═'.repeat(60));
    console.log(`Cycles recorded: ${stats.total}`);
    console.log(`Duration: ${durationHours.toFixed(1)} hours`);
    console.log(`Price range: $${stats.min_price?.toFixed(2)} - $${stats.max_price?.toFixed(2)}`);
    console.log(`Actual rebalances (5%): ${stats.actual_rebalances}`);
    console.log(`Actual gas spent: $${(stats.total_gas || 0).toFixed(2)}`);

    // Simulate thresholds
    console.log('\n' + '═'.repeat(60));
    console.log('THRESHOLD COMPARISON');
    console.log('═'.repeat(60));
    console.log('\n┌───────────┬────────────┬──────────┬─────────────┐');
    console.log('│ Threshold │ Rebalances │ Gas ($)  │ Slippage ($)│');
    console.log('├───────────┼────────────┼──────────┼─────────────┤');

    for (const threshold of THRESHOLDS) {
        const result = simulateThreshold(cycles, threshold);
        const thresholdStr = `${(threshold * 100).toFixed(0)}%`.padStart(5);
        const marker = threshold === 0.05 ? ' *' : '  ';
        console.log(`│ ${thresholdStr}${marker}  │ ${result.rebalances.toString().padStart(6)}     │ ${result.totalGas.toFixed(2).padStart(6)}   │ ${result.totalSlippage.toFixed(2).padStart(9)}   │`);
    }

    console.log('└───────────┴────────────┴──────────┴─────────────┘');
    console.log('\n* = Current threshold');

    db.close();
}

main();
