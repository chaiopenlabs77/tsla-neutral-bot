#!/usr/bin/env npx ts-node
/**
 * OPTIMAL HEDGE REBALANCE THRESHOLD FINDER
 *
 * Uses ACTUAL recorded data from cycles.db:
 * - Real TSLA prices from pool
 * - Real pool APR at each observation (10s intervals during market hours)
 * - Accounts for overnight/weekend gaps with conservative off-hours APR estimate
 *
 * Filters out pre-Jan-26 data (APR tracking wasn't deployed yet).
 */

import * as fs from 'fs';

const POSITION_SIZE = 14000; // $14k position (production target)

// Real costs on Solana
const HEDGE_REBALANCE_GAS_SOL = 0.001;
const SOL_PRICE = 200;
const HEDGE_REBALANCE_GAS_USD = HEDGE_REBALANCE_GAS_SOL * SOL_PRICE; // $0.20
const HEDGE_SLIPPAGE_BPS = 10;
const LP_REPOSITION_GAS_USD = 0.01 * SOL_PRICE; // $2 for LP repo (multiple txs)
const LP_REPOSITION_SLIPPAGE_BPS = 30;
const LP_SWAP_PORTION = 0.15;
const DAILY_FUNDING_RATE = 0.0003; // 3bps/day funding INCOME on short hedge

// Bootstrap cost (one-time on position open)
const BOOTSTRAP_COST = POSITION_SIZE * 0.5 * (30 / 10000); // ~$21

// Off-hours APR: LP earns fees 24/7 on-chain. We only observe during market hours.
// Weekend data (Feb 15) shows 0.6% APR. Overnight likely 2-5%.
// Conservative estimate for unobserved periods:
const OFF_HOURS_APR = 3.0; // 3% APR during unobserved gaps (conservative)

interface CycleRecord {
    ts: number;     // epoch ms
    price: number;  // TSLA price
    apr: number;    // pool APR (annualized %, e.g., 39.08 = 39.08%)
}

function loadCyclesData(): CycleRecord[] {
    const raw = fs.readFileSync('/tmp/cycles_data.json', 'utf-8');
    const data: { ts: number; price: number; apr: number }[] = JSON.parse(raw);

    // Filter: only use records after APR tracking went live (Jan 26, 2026)
    // and where price > 0
    const firstAprRecord = data.find(d => d.apr > 0);
    if (!firstAprRecord) throw new Error('No APR data found');

    const startTs = firstAprRecord.ts;
    const filtered = data.filter(d => d.ts >= startTs && d.price > 0);
    console.log(`  Filtered to ${filtered.length} records (from ${new Date(startTs).toISOString().split('T')[0]})`);
    console.log(`  Dropped ${data.length - filtered.length} records (pre-APR-tracking or invalid price)`);

    return filtered;
}

function calculateLpDelta(price: number, rangeCenter: number, rangeWidth: number, positionValue: number): number {
    const rangeLow = rangeCenter * (1 - rangeWidth);
    const rangeHigh = rangeCenter * (1 + rangeWidth);
    if (price <= rangeLow) return positionValue;
    if (price >= rangeHigh) return 0;
    return positionValue * (rangeHigh - price) / (rangeHigh - rangeLow);
}

interface SimResult {
    driftThreshold: number;
    cooldownMin: number;
    rangeWidth: number;
    waitMin: number;
    hedgeRebalances: number;
    lpRepositions: number;
    grossFeesUsd: number;
    offHoursFeesUsd: number;
    hedgeRebalanceCostUsd: number;
    lpRepoCostUsd: number;
    fundingIncomeUsd: number;
    totalCostsUsd: number;
    netPnlUsd: number;
    netApy: number;
    avgUnhedgedExposureUsd: number;
    maxUnhedgedExposureUsd: number;
    timeInRangePct: number;
    totalDays: number;
}

function simulate(
    records: CycleRecord[],
    rangeWidth: number,
    driftThreshold: number,
    cooldownMs: number,
    positionSize: number,
    outOfRangeWaitMs: number = 3600000,
    rangeScaleFactor: number = 1.0,
): SimResult {
    let rangeCenter = records[0].price;
    let hedgeDelta = -positionSize * 0.5;
    let lastRebalanceTime = 0;
    let outOfRangeSince: number | null = null;

    let totalGrossFees = 0;
    let offHoursFees = 0;
    let totalHedgeRebalances = 0;
    let totalLpRepos = 0;
    let totalHedgeCost = 0;
    let totalLpRepoCost = 0;
    let totalPeriodsInRange = 0;
    let totalPeriods = 0;
    let totalUnhedgedExposure = 0;
    let maxUnhedgedExposure = 0;
    let totalHedgeNotionalSum = 0;

    for (let i = 0; i < records.length; i++) {
        const { ts: time, price, apr } = records[i];

        // Calculate actual elapsed time since last observation
        const elapsedMs = i === 0 ? 10000 : (time - records[i - 1].ts);
        const elapsedS = elapsedMs / 1000;

        const rangeLow = rangeCenter * (1 - rangeWidth);
        const rangeHigh = rangeCenter * (1 + rangeWidth);
        const isInRange = price >= rangeLow && price <= rangeHigh;

        const lpDelta = calculateLpDelta(price, rangeCenter, rangeWidth, positionSize);
        const netDelta = lpDelta + hedgeDelta;
        const unhedgedExposure = Math.abs(netDelta);
        totalUnhedgedExposure += unhedgedExposure;
        maxUnhedgedExposure = Math.max(maxUnhedgedExposure, unhedgedExposure);
        totalHedgeNotionalSum += Math.abs(hedgeDelta);
        totalPeriods++;

        if (isInRange) {
            if (elapsedS <= 30) {
                // Normal observation: use actual APR over actual interval
                const fee = positionSize * (apr / 100) * (elapsedS / (365 * 86400)) * rangeScaleFactor;
                totalGrossFees += fee;
            } else {
                // Gap (overnight/weekend): LP still earns fees on-chain
                // Current 10s at actual APR + remaining gap at off-hours rate
                const onFee = positionSize * (apr / 100) * (10 / (365 * 86400)) * rangeScaleFactor;
                const offFee = positionSize * (OFF_HOURS_APR / 100) * ((elapsedS - 10) / (365 * 86400)) * rangeScaleFactor;
                totalGrossFees += onFee;
                offHoursFees += offFee;
                totalGrossFees += offFee;
            }
            totalPeriodsInRange++;
            outOfRangeSince = null;
        } else {
            // Out of range — no fees earned
            if (outOfRangeSince === null) {
                outOfRangeSince = time;
            }
            const outOfRangeDuration = time - outOfRangeSince;
            if (outOfRangeDuration >= outOfRangeWaitMs) {
                totalLpRepos++;
                const repoCost = (LP_SWAP_PORTION * positionSize * (LP_REPOSITION_SLIPPAGE_BPS / 10000)) + LP_REPOSITION_GAS_USD;
                totalLpRepoCost += repoCost;
                rangeCenter = price;
                outOfRangeSince = null;
            }
        }

        // Hedge rebalance check
        const driftPct = Math.abs(netDelta) / Math.max(Math.abs(lpDelta), 1);
        const cooldownElapsed = (time - lastRebalanceTime) >= cooldownMs;

        if (driftPct >= driftThreshold && cooldownElapsed && lpDelta > 0) {
            const adjustSize = Math.abs(netDelta);
            const slippageCost = adjustSize * (HEDGE_SLIPPAGE_BPS / 10000);
            totalHedgeCost += slippageCost + HEDGE_REBALANCE_GAS_USD;
            totalHedgeRebalances++;
            hedgeDelta = -lpDelta;
            lastRebalanceTime = time;
        }
    }

    // Duration: calendar days between first and last record
    const totalMs = records[records.length - 1].ts - records[0].ts;
    const totalDays = totalMs / (1000 * 86400);

    // Funding INCOME: shorts receive funding 24/5 (weekdays)
    const avgHedgeNotional = totalHedgeNotionalSum / records.length;
    const totalFundingIncome = avgHedgeNotional * DAILY_FUNDING_RATE * totalDays;

    const totalCosts = totalHedgeCost + totalLpRepoCost + BOOTSTRAP_COST;
    const grossTotal = totalGrossFees;
    const netPnl = grossTotal + totalFundingIncome - totalCosts;
    const netApy = Math.pow(1 + netPnl / positionSize, 365 / totalDays) - 1;

    return {
        driftThreshold,
        cooldownMin: cooldownMs / 60000,
        rangeWidth,
        waitMin: outOfRangeWaitMs / 60000,
        hedgeRebalances: totalHedgeRebalances,
        lpRepositions: totalLpRepos,
        grossFeesUsd: grossTotal,
        offHoursFeesUsd: offHoursFees,
        hedgeRebalanceCostUsd: totalHedgeCost,
        lpRepoCostUsd: totalLpRepoCost,
        fundingIncomeUsd: totalFundingIncome,
        totalCostsUsd: totalCosts,
        netPnlUsd: netPnl,
        netApy,
        avgUnhedgedExposureUsd: totalUnhedgedExposure / totalPeriods,
        maxUnhedgedExposureUsd: maxUnhedgedExposure,
        timeInRangePct: totalPeriodsInRange / totalPeriods,
        totalDays,
    };
}

function main(): void {
    console.log('Loading actual cycles.db data...');
    const records = loadCyclesData();
    const totalMs = records[records.length - 1].ts - records[0].ts;
    const totalDays = totalMs / (1000 * 86400);

    // APR stats (non-zero only since 0 = no data)
    const aprs = records.map(r => r.apr).filter(a => a > 0);
    const sortedAprs = [...aprs].sort((a, b) => a - b);
    const medianApr = sortedAprs[Math.floor(sortedAprs.length / 2)];
    const avgApr = aprs.reduce((a, b) => a + b, 0) / aprs.length;

    // Count market-hours observation time vs calendar time
    let marketHoursS = 0;
    for (let i = 1; i < records.length; i++) {
        const gap = (records[i].ts - records[i - 1].ts) / 1000;
        if (gap <= 30) marketHoursS += gap;
    }
    const marketHoursDays = marketHoursS / 86400;

    console.log(`\nData: ${records.length} observations over ${totalDays.toFixed(1)} calendar days`);
    console.log(`Market-hours observation time: ${marketHoursDays.toFixed(1)} days (${(marketHoursDays/totalDays*100).toFixed(0)}% of calendar time)`);
    console.log(`Price range: $${Math.min(...records.map(r => r.price)).toFixed(2)} - $${Math.max(...records.map(r => r.price)).toFixed(2)}`);
    console.log(`APR (market hours): median=${medianApr.toFixed(1)}%, avg=${avgApr.toFixed(1)}%, P10=${sortedAprs[Math.floor(sortedAprs.length * 0.1)].toFixed(1)}%, P90=${sortedAprs[Math.floor(sortedAprs.length * 0.9)].toFixed(1)}%`);
    console.log(`Off-hours APR assumption: ${OFF_HOURS_APR}% (conservative; weekend data shows 0.6%)`);
    console.log(`Position size: $${POSITION_SIZE.toLocaleString()}`);
    console.log(`Funding: ${DAILY_FUNDING_RATE * 100 * 100} bps/day INCOME (shorts get paid)\n`);

    const RANGE_WIDTH = 0.02;

    // ═══════════════════════════════════════════════════════════════════
    // SWEEP 1: Drift threshold
    // ═══════════════════════════════════════════════════════════════════
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log('SWEEP 1: Delta Drift Threshold (cooldown=5min, OOR wait=60min, range=±2%)');
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log('┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
    console.log('│ Drift %  │ Hedge    │ Hedge $  │ LP Repo  │ Gross $  │ Fund Inc │ Net P&L  │ Net APY  │');
    console.log('│ Thresh   │ Rebals   │ Cost     │ Count    │ Fees     │ (short)  │          │          │');
    console.log('├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');

    const driftThresholds = [0.01, 0.02, 0.03, 0.05, 0.075, 0.10, 0.15, 0.20, 0.25, 0.30, 0.50, 1.0];
    const cooldown5min = 5 * 60 * 1000;
    let bestResult: SimResult | null = null;

    for (const drift of driftThresholds) {
        const r = simulate(records, RANGE_WIDTH, drift, cooldown5min, POSITION_SIZE);
        if (!bestResult || r.netPnlUsd > bestResult.netPnlUsd) bestResult = r;
        const marker = r.netApy >= 0.10 ? '★' : r.netApy >= 0 ? '○' : '✗';
        console.log(
            `│${marker} ${(drift * 100).toFixed(1).padStart(5)}%  │ ${r.hedgeRebalances.toString().padStart(6)}   │ $${r.hedgeRebalanceCostUsd.toFixed(0).padStart(5)}   │ ${r.lpRepositions.toString().padStart(5)}    │ $${r.grossFeesUsd.toFixed(0).padStart(5)}   │ $${r.fundingIncomeUsd.toFixed(0).padStart(5)}   │ $${r.netPnlUsd.toFixed(0).padStart(5)}   │ ${(r.netApy * 100).toFixed(1).padStart(6)}%  │`
        );
    }
    console.log('└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');

    // ═══════════════════════════════════════════════════════════════════
    // SWEEP 2: Cooldown
    // ═══════════════════════════════════════════════════════════════════
    const bestDrift = bestResult!.driftThreshold;
    console.log(`\n════════════════════════════════════════════════════════════════════════════════`);
    console.log(`SWEEP 2: Cooldown Period (drift=${(bestDrift * 100).toFixed(1)}%, OOR wait=60min, range=±2%)`);
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log('┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
    console.log('│ Cooldown │ Hedge    │ Hedge $  │ Avg Unhd │ Max Unhd │ Total $  │ Net P&L  │ Net APY  │');
    console.log('│ (min)    │ Rebals   │ Cost     │ Exposure │ Exposure │ Costs    │          │          │');
    console.log('├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');

    const cooldowns = [1, 2, 5, 10, 15, 30, 60, 120, 240];
    let bestCooldownResult: SimResult | null = null;

    for (const cdMin of cooldowns) {
        const r = simulate(records, RANGE_WIDTH, bestDrift, cdMin * 60 * 1000, POSITION_SIZE);
        if (!bestCooldownResult || r.netPnlUsd > bestCooldownResult.netPnlUsd) bestCooldownResult = r;
        const marker = r.netApy >= 0.10 ? '★' : r.netApy >= 0 ? '○' : '✗';
        console.log(
            `│${marker} ${cdMin.toString().padStart(5)} min │ ${r.hedgeRebalances.toString().padStart(6)}   │ $${r.hedgeRebalanceCostUsd.toFixed(0).padStart(5)}   │ $${r.avgUnhedgedExposureUsd.toFixed(0).padStart(5)}   │ $${r.maxUnhedgedExposureUsd.toFixed(0).padStart(5)}   │ $${r.totalCostsUsd.toFixed(0).padStart(5)}   │ $${r.netPnlUsd.toFixed(0).padStart(5)}   │ ${(r.netApy * 100).toFixed(1).padStart(6)}%  │`
        );
    }
    console.log('└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');

    // ═══════════════════════════════════════════════════════════════════
    // SWEEP 3: Out-of-range wait time
    // ═══════════════════════════════════════════════════════════════════
    const bestCooldown = bestCooldownResult!.cooldownMin;
    console.log(`\n════════════════════════════════════════════════════════════════════════════════`);
    console.log(`SWEEP 3: Out-of-Range Wait Time (drift=${(bestDrift * 100).toFixed(0)}%, cooldown=${bestCooldown}min, range=±2%)`);
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log('┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
    console.log('│ OOR Wait │ LP Repos │ LP Repo  │ In Range │ Gross $  │ Total $  │ Net P&L  │ Net APY  │');
    console.log('│          │          │ Cost     │ %        │ Fees     │ Costs    │          │          │');
    console.log('├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');

    const waitTimes = [0, 2, 5, 10, 15, 30, 60, 120, 240, 480];
    let bestWaitResult: SimResult | null = null;

    for (const waitMin of waitTimes) {
        const r = simulate(records, RANGE_WIDTH, bestDrift, bestCooldown * 60000, POSITION_SIZE, waitMin * 60 * 1000);
        if (!bestWaitResult || r.netPnlUsd > bestWaitResult.netPnlUsd) bestWaitResult = r;
        const marker = r.netApy >= 0.10 ? '★' : r.netApy >= 0 ? '○' : '✗';
        const label = waitMin === 0 ? '  0 (imm)' : `${waitMin.toString().padStart(5)} min`;
        console.log(
            `│${marker} ${label} │ ${r.lpRepositions.toString().padStart(6)}   │ $${r.lpRepoCostUsd.toFixed(0).padStart(5)}   │ ${(r.timeInRangePct * 100).toFixed(1).padStart(5)}%   │ $${r.grossFeesUsd.toFixed(0).padStart(5)}   │ $${r.totalCostsUsd.toFixed(0).padStart(5)}   │ $${r.netPnlUsd.toFixed(0).padStart(5)}   │ ${(r.netApy * 100).toFixed(1).padStart(6)}%  │`
        );
    }
    console.log('└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');

    // ═══════════════════════════════════════════════════════════════════
    // SWEEP 4: Range widths (with concentration scaling)
    // ═══════════════════════════════════════════════════════════════════
    const bestWait = bestWaitResult!.waitMin;
    console.log(`\n════════════════════════════════════════════════════════════════════════════════`);
    console.log(`SWEEP 4: Range Width (each with full param optimization)`);
    console.log(`NOTE: APR scaled by concentration factor (base=±2%). ±2% row uses raw data.`);
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log('┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
    console.log('│ Range    │ Scale    │ In Range │ LP Repos │ Hedge    │ Gross $  │ Net P&L  │ Net APY  │');
    console.log('│          │ Factor   │ %        │          │ Rebals   │ Fees     │          │          │');
    console.log('├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');

    const BASE_RANGE = 0.02;
    const rangeWidths = [0.01, 0.015, 0.02, 0.03, 0.05, 0.075, 0.10, 0.15];
    let overallBest: SimResult | null = null;

    for (const rw of rangeWidths) {
        const scaleFactor = BASE_RANGE / rw;
        let bestForRange: SimResult | null = null;

        for (const drift of [0.05, 0.10, 0.15, 0.20, 0.30, 0.50, 1.0]) {
            for (const cd of [5, 15, 30, 60, 120]) {
                for (const wait of [0, 5, 15, 30, 60, 120, 240]) {
                    const r = simulate(records, rw, drift, cd * 60 * 1000, POSITION_SIZE, wait * 60 * 1000, scaleFactor);
                    if (!bestForRange || r.netPnlUsd > bestForRange.netPnlUsd) {
                        bestForRange = r;
                    }
                }
            }
        }

        const r = bestForRange!;
        if (!overallBest || r.netPnlUsd > overallBest.netPnlUsd) overallBest = r;
        const marker = r.netApy >= 0.10 ? '★' : r.netApy >= 0 ? '○' : '✗';
        console.log(
            `│${marker}±${(rw * 100).toFixed(1).padStart(4)}%  │ ${scaleFactor.toFixed(2).padStart(5)}x  │ ${(r.timeInRangePct * 100).toFixed(1).padStart(5)}%   │ ${r.lpRepositions.toString().padStart(5)}    │ ${r.hedgeRebalances.toString().padStart(5)}    │ $${r.grossFeesUsd.toFixed(0).padStart(5)}   │ $${r.netPnlUsd.toFixed(0).padStart(5)}   │ ${(r.netApy * 100).toFixed(1).padStart(6)}%  │`
        );
        console.log(`│         │ drift=${(r.driftThreshold * 100).toFixed(0)}% cd=${r.cooldownMin}m wait=${r.waitMin}m`);
    }
    console.log('└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');

    // ═══════════════════════════════════════════════════════════════════
    // DETAILED BREAKDOWN
    // ═══════════════════════════════════════════════════════════════════
    const best = overallBest!;
    console.log('\n════════════════════════════════════════════════════════════════════════════════');
    console.log('RECOMMENDATION');
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log(`\nOptimal config for $${POSITION_SIZE.toLocaleString()} position over ${best.totalDays.toFixed(1)} days:`);
    console.log(`  RANGE_WIDTH_PERCENT = ${best.rangeWidth} (±${(best.rangeWidth * 100).toFixed(1)}%)`);
    console.log(`  DELTA_DRIFT_THRESHOLD_PERCENT = ${best.driftThreshold} (${(best.driftThreshold * 100).toFixed(0)}%)`);
    console.log(`  MIN_REBALANCE_INTERVAL_MS = ${best.cooldownMin * 60 * 1000} (${best.cooldownMin} min)`);
    console.log(`  MAX_OUT_OF_RANGE_DURATION_MS = ${best.waitMin * 60 * 1000} (${best.waitMin} min)`);
    console.log(`\n  P&L breakdown (${best.totalDays.toFixed(0)}-day backtest):`);
    console.log(`    Gross LP fees:     $${best.grossFeesUsd.toFixed(2)} (of which $${best.offHoursFeesUsd.toFixed(2)} off-hours estimate)`);
    console.log(`    Funding income:   +$${best.fundingIncomeUsd.toFixed(2)} (shorts get paid)`);
    console.log(`    LP repo cost:     -$${best.lpRepoCostUsd.toFixed(2)} (${best.lpRepositions} repos)`);
    console.log(`    Hedge rebal cost: -$${best.hedgeRebalanceCostUsd.toFixed(2)} (${best.hedgeRebalances} rebals)`);
    console.log(`    Bootstrap cost:   -$${BOOTSTRAP_COST.toFixed(2)}`);
    console.log(`    ─────────────────────────────`);
    console.log(`    Net P&L:           $${best.netPnlUsd.toFixed(2)}`);
    console.log(`    Net APY:           ${(best.netApy * 100).toFixed(1)}%`);
    console.log(`    Time in range:     ${(best.timeInRangePct * 100).toFixed(1)}%`);
    console.log(`    Hedge rebals/day:  ${(best.hedgeRebalances / best.totalDays).toFixed(1)}`);
    console.log(`    LP repos/day:      ${(best.lpRepositions / best.totalDays).toFixed(2)}`);
    console.log(`    Avg unhedged:      $${best.avgUnhedgedExposureUsd.toFixed(0)} (${(best.avgUnhedgedExposureUsd / POSITION_SIZE * 100).toFixed(1)}% of position)`);
    console.log(`    Max unhedged:      $${best.maxUnhedgedExposureUsd.toFixed(0)} (${(best.maxUnhedgedExposureUsd / POSITION_SIZE * 100).toFixed(1)}% of position)`);

    // Also show best for ±2% specifically (unscaled data, most reliable)
    console.log(`\n────────────────────────────────────────────────────────────────────────────────`);
    console.log('BEST FOR ±2% (unscaled data — most reliable):');
    let best2pct: SimResult | null = null;
    for (const drift of [0.05, 0.10, 0.15, 0.20, 0.30, 0.50, 1.0]) {
        for (const cd of [5, 15, 30, 60, 120]) {
            for (const wait of [0, 5, 15, 30, 60, 120, 240]) {
                const r = simulate(records, 0.02, drift, cd * 60 * 1000, POSITION_SIZE, wait * 60 * 1000, 1.0);
                if (!best2pct || r.netPnlUsd > best2pct.netPnlUsd) best2pct = r;
            }
        }
    }
    const b = best2pct!;
    console.log(`  drift=${(b.driftThreshold * 100).toFixed(0)}%, cooldown=${b.cooldownMin}min, OOR wait=${b.waitMin}min`);
    console.log(`  Gross fees: $${b.grossFeesUsd.toFixed(2)} | Funding: +$${b.fundingIncomeUsd.toFixed(2)} | Costs: -$${b.totalCostsUsd.toFixed(2)}`);
    console.log(`  Net P&L: $${b.netPnlUsd.toFixed(2)} | Net APY: ${(b.netApy * 100).toFixed(1)}%`);
    console.log(`  In range: ${(b.timeInRangePct * 100).toFixed(1)}% | Hedge rebals: ${b.hedgeRebalances} | LP repos: ${b.lpRepositions}`);

    // ═══════════════════════════════════════════════════════════════════
    // ENV vars
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n# Copy to .env:');
    console.log(`RANGE_WIDTH_PERCENT=${best.rangeWidth}`);
    console.log(`DELTA_DRIFT_THRESHOLD_PERCENT=${best.driftThreshold}`);
    console.log(`MIN_REBALANCE_INTERVAL_MS=${best.cooldownMin * 60 * 1000}`);
    console.log(`MAX_OUT_OF_RANGE_DURATION_MS=${best.waitMin * 60 * 1000}`);
}

main();
