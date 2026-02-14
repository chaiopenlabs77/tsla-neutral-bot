#!/usr/bin/env npx ts-node
/**
 * OPTIMAL RANGE BACKTEST — Uses real data collected from VM (Jan 19 – Feb 13, 2026)
 *
 * Data source: cycles.db from spirit-worker GCE VM
 *   - 6600+ minute-level samples of TSLA price + pool APR + pool TVL
 *   - Real Raydium CLMM APR observations (not UI screenshots)
 *
 * Simulates different LP range widths to find the optimal rebalancing %
 * that maximizes net APY after all costs (reposition slippage, gas, funding).
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Load real data from VM export
// ============================================================================
interface CycleRow {
    timestamp: number;
    tslaPrice: number;
    poolApr: number;
    poolTvl: number;
}

function loadData(): CycleRow[] {
    const csvPath = '/tmp/vm_cycles.csv';
    if (!fs.existsSync(csvPath)) {
        console.error('ERROR: /tmp/vm_cycles.csv not found. Export from VM first.');
        process.exit(1);
    }
    const lines = fs.readFileSync(csvPath, 'utf-8').split('\n').filter(Boolean);
    const rows: CycleRow[] = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        const tslaPrice = parseFloat(cols[1]);
        const poolApr = parseFloat(cols[5]);
        const poolTvl = parseFloat(cols[6]);
        if (tslaPrice > 0) {
            rows.push({
                timestamp: parseInt(cols[0]),
                tslaPrice,
                poolApr: isNaN(poolApr) ? 0 : poolApr,
                poolTvl: isNaN(poolTvl) ? 0 : poolTvl,
            });
        }
    }
    return rows;
}

// ============================================================================
// Constants from real environment
// ============================================================================
const INITIAL_POSITION_USD = 14000;
const LP_SLIPPAGE_BPS = 30;                 // 0.3% slippage per swap
const LP_REPOSITION_SWAP_PORTION = 0.50;    // Must swap ~50% of position to rebalance token ratio
const LP_REPOSITION_GAS_USD = 0.50;         // SOL gas per reposition (~$0.50 at $135/SOL)
const DAILY_FUNDING_RATE = 0.0003;          // 3 bps/day on hedge notional
const BOOTSTRAP_SLIPPAGE_COST = INITIAL_POSITION_USD * 0.5 * (LP_SLIPPAGE_BPS / 10000);

// ============================================================================
// Simulation
// ============================================================================
interface SimResult {
    rangePercent: number;
    medianApr: number;
    timeInRange: number;
    repositions: number;
    grossFeesUsd: number;
    reposCostUsd: number;
    fundingCostUsd: number;
    gasCostUsd: number;
    bootstrapCostUsd: number;
    netPnlUsd: number;
    netApy: number;
}

function simulate(data: CycleRow[], rangePercent: number): SimResult {
    const totalMs = data[data.length - 1].timestamp - data[0].timestamp;
    const totalDays = totalMs / (1000 * 60 * 60 * 24);

    // Compute median pool APR from real observations (non-zero only)
    const nonZeroAprs = data.filter(d => d.poolApr > 0).map(d => d.poolApr / 100); // Convert % to decimal
    nonZeroAprs.sort((a, b) => a - b);
    const medianApr = nonZeroAprs.length > 0
        ? nonZeroAprs[Math.floor(nonZeroAprs.length / 2)]
        : 0;

    // Concentration scaling: In CLMM, fee income per $ scales as 1/rangeWidth.
    // The Raydium UI confirms this:
    //   ±5% = 5.04%, ±10% = 2.45%, ±20% = 1.2%  →  APR * rangeWidth ≈ constant (0.245)
    //
    // The API pool APR is the aggregate across ALL LPs' concentration profiles.
    // We estimate the pool's "effective average range" from the UI calibration data:
    //   UI ±10% → 2.45% APR, so k = APR * range = 0.00245 * 0.10 = 0.000245
    //   For pool APR P: effective_pool_range = k / P
    //
    // For our position at ±R: position_apr = pool_apr * (effective_pool_range / R)
    //   which simplifies to: position_apr = k / R  (the pool APR cancels out)
    //
    // But k was measured at a specific time. Volume has changed since then.
    // Scale k by current vs reference volume: k_now = k_ref * (current_pool_apr / ref_pool_apr)
    //   where ref_pool_apr = 2.45% (the ±10% UI data implies this was the pool's state)
    //
    // Final: position_apr(±R) = pool_apr * REFERENCE_RANGE / R
    // where REFERENCE_RANGE is the "effective average LP range" of the pool.
    // From UI: at ±10% you get exactly the pool APR → REFERENCE_RANGE ≈ 0.10
    const REFERENCE_RANGE = 0.10;
    const concentrationFactor = REFERENCE_RANGE / rangePercent;

    let position = INITIAL_POSITION_USD;
    position -= BOOTSTRAP_SLIPPAGE_COST;

    let rangeCenter = data[0].tslaPrice;
    let periodsInRange = 0;
    let repositions = 0;
    let totalGrossFees = 0;
    let totalReposCost = 0;
    let totalFundingCost = 0;
    let totalGasCost = 0;

    // Group by day for daily compounding
    const dayMs = 1000 * 60 * 60 * 24;
    const startDay = Math.floor(data[0].timestamp / dayMs);
    const endDay = Math.floor(data[data.length - 1].timestamp / dayMs);

    for (let day = startDay; day <= endDay; day++) {
        const dayStart = day * dayMs;
        const dayEnd = (day + 1) * dayMs;

        // Get data points for this day
        const dayData = data.filter(d => d.timestamp >= dayStart && d.timestamp < dayEnd);
        if (dayData.length === 0) continue;

        let dayPeriodsInRange = 0;
        let dayRepos = 0;
        let dayAprSum = 0;
        let dayAprCount = 0;

        for (const point of dayData) {
            const rangeLow = rangeCenter * (1 - rangePercent);
            const rangeHigh = rangeCenter * (1 + rangePercent);

            if (point.tslaPrice >= rangeLow && point.tslaPrice <= rangeHigh) {
                dayPeriodsInRange++;
                if (point.poolApr > 0) {
                    dayAprSum += point.poolApr / 100;
                    dayAprCount++;
                }
            } else {
                // Reposition: recenter range on current price
                dayRepos++;
                rangeCenter = point.tslaPrice;
            }
        }

        periodsInRange += dayPeriodsInRange;
        repositions += dayRepos;

        const timeInRangeToday = dayPeriodsInRange / dayData.length;

        // Use day's average observed APR if available, else median
        // Then scale by concentration factor for our specific range
        const dayAvgApr = dayAprCount > 0 ? dayAprSum / dayAprCount : medianApr;
        const positionApr = dayAvgApr * concentrationFactor;

        // Daily fee income (only when in range)
        const dailyFeeRate = positionApr / 365;
        const dailyFees = position * dailyFeeRate * timeInRangeToday;

        // Reposition cost: swap portion of position + slippage + gas per repo
        const repoSwapCost = dayRepos * (LP_REPOSITION_SWAP_PORTION * position * (LP_SLIPPAGE_BPS / 10000));
        const repoGasCost = dayRepos * LP_REPOSITION_GAS_USD;

        // Funding cost on hedge (half the position, every day)
        const fundingCost = (position / 2) * DAILY_FUNDING_RATE;

        const netDay = dailyFees - repoSwapCost - repoGasCost - fundingCost;

        totalGrossFees += dailyFees;
        totalReposCost += repoSwapCost;
        totalGasCost += repoGasCost;
        totalFundingCost += fundingCost;

        // Compound
        position += netDay;
    }

    const totalPeriods = data.length;
    const timeInRange = periodsInRange / totalPeriods;
    const netPnl = position - INITIAL_POSITION_USD;
    const growthRatio = position / INITIAL_POSITION_USD;
    const netApy = Math.pow(growthRatio, 365 / totalDays) - 1;

    return {
        rangePercent,
        medianApr: medianApr * 100,
        timeInRange,
        repositions,
        grossFeesUsd: totalGrossFees,
        reposCostUsd: totalReposCost,
        fundingCostUsd: totalFundingCost,
        gasCostUsd: totalGasCost,
        bootstrapCostUsd: BOOTSTRAP_SLIPPAGE_COST,
        netPnlUsd: netPnl,
        netApy,
    };
}

// ============================================================================
// Main
// ============================================================================
function main() {
    const data = loadData();

    const totalMs = data[data.length - 1].timestamp - data[0].timestamp;
    const totalDays = (totalMs / (1000 * 60 * 60 * 24)).toFixed(1);
    const prices = data.map(d => d.tslaPrice).filter(p => p > 0);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const priceRange = ((maxPrice - minPrice) / avgPrice * 100).toFixed(1);

    const nonZeroAprs = data.filter(d => d.poolApr > 0).map(d => d.poolApr);
    nonZeroAprs.sort((a, b) => a - b);
    const p25Apr = nonZeroAprs[Math.floor(nonZeroAprs.length * 0.25)];
    const p50Apr = nonZeroAprs[Math.floor(nonZeroAprs.length * 0.50)];
    const p75Apr = nonZeroAprs[Math.floor(nonZeroAprs.length * 0.75)];
    const avgApr = nonZeroAprs.reduce((a, b) => a + b, 0) / nonZeroAprs.length;

    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log('OPTIMAL RANGE BACKTEST — Real VM Data (Jan 19 – Feb 13, 2026)');
    console.log('════════════════════════════════════════════════════════════════════════════════\n');

    console.log(`Data: ${data.length} samples over ${totalDays} days`);
    console.log(`TSLA Price: $${minPrice.toFixed(2)} – $${maxPrice.toFixed(2)} (avg $${avgPrice.toFixed(2)}, ${priceRange}% range)`);
    console.log(`Pool APR observed: P25=${p25Apr?.toFixed(1)}% | Median=${p50Apr?.toFixed(1)}% | P75=${p75Apr?.toFixed(1)}% | Mean=${avgApr?.toFixed(1)}%`);
    console.log(`Position: $${INITIAL_POSITION_USD} | Funding: ${DAILY_FUNDING_RATE * 100 * 100} bps/day | Slippage: ${LP_SLIPPAGE_BPS} bps\n`);

    const ranges = [0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.05, 0.075, 0.10, 0.15, 0.20];

    console.log('┌─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐');
    console.log('│ Range   │ In-Rng  │ Repos   │ Gross$  │ Repo$   │ Fund$   │ Gas$    │ Net P&L │ Net APY │');
    console.log('├─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┤');

    let bestResult: SimResult | null = null;

    for (const range of ranges) {
        const r = simulate(data, range);

        if (!bestResult || r.netApy > bestResult.netApy) {
            bestResult = r;
        }

        const marker = r.netApy >= 0.25 ? '★' :
                        r.netApy >= 0.10 ? '◆' :
                        r.netApy >= 0    ? '○' : '✗';

        console.log(
            `│${marker}±${(range * 100).toFixed(2).padStart(5)}% │` +
            ` ${(r.timeInRange * 100).toFixed(1).padStart(5)}%  │` +
            ` ${r.repositions.toString().padStart(5)}   │` +
            ` $${r.grossFeesUsd.toFixed(0).padStart(5)}  │` +
            ` $${r.reposCostUsd.toFixed(0).padStart(5)}  │` +
            ` $${r.fundingCostUsd.toFixed(0).padStart(5)}  │` +
            ` $${r.gasCostUsd.toFixed(0).padStart(5)}  │` +
            ` $${r.netPnlUsd.toFixed(0).padStart(5)}  │` +
            ` ${(r.netApy * 100).toFixed(1).padStart(6)}% │`
        );
    }

    console.log('└─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘');
    console.log('★ = 25%+ APY | ◆ = 10%+ APY | ○ = Profitable | ✗ = Loss\n');

    if (bestResult) {
        console.log('════════════════════════════════════════════════════════════════════════════════');
        console.log('OPTIMAL RANGE');
        console.log('════════════════════════════════════════════════════════════════════════════════\n');
        console.log(`  Best range:     ±${(bestResult.rangePercent * 100).toFixed(2)}%`);
        console.log(`  Net APY:        ${(bestResult.netApy * 100).toFixed(1)}%`);
        console.log(`  Time in range:  ${(bestResult.timeInRange * 100).toFixed(1)}%`);
        console.log(`  Repositions:    ${bestResult.repositions} (over ${totalDays} days)`);
        console.log(`  Gross fees:     $${bestResult.grossFeesUsd.toFixed(2)}`);
        console.log(`  Repo cost:      $${bestResult.reposCostUsd.toFixed(2)} (slippage)`);
        console.log(`  Gas cost:       $${bestResult.gasCostUsd.toFixed(2)}`);
        console.log(`  Funding cost:   $${bestResult.fundingCostUsd.toFixed(2)}`);
        console.log(`  Bootstrap cost: $${bestResult.bootstrapCostUsd.toFixed(2)}`);
        console.log(`  Net P&L:        $${bestResult.netPnlUsd.toFixed(2)}\n`);

        const breakEvenApr = (bestResult.reposCostUsd + bestResult.fundingCostUsd + bestResult.gasCostUsd + bestResult.bootstrapCostUsd) /
            (INITIAL_POSITION_USD * parseFloat(totalDays) / 365 * bestResult.timeInRange);
        console.log(`  Break-even pool APR: ${(breakEvenApr * 100).toFixed(1)}% (need this APR just to cover costs)`);
    }
}

main();
