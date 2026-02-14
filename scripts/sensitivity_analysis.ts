#!/usr/bin/env npx ts-node
/**
 * SENSITIVITY ANALYSIS
 * 
 * What pool APY or funding rate would we need to hit 25% net APY?
 */

const POSITION_SIZE = 14000;
const DAYS = 60;

// Costs that don't change
const LP_REPOSITION_GAS = 0.01;
const LP_REPOSITION_SWAP_PORTION = 0.15;
const LP_SLIPPAGE_BPS = 30;
const BOOTSTRAP_COST = POSITION_SIZE * 0.5 * (LP_SLIPPAGE_BPS / 10000); // $21

function calculateNetApr(
    poolApr: number,
    dailyFundingRate: number,
    lpRepositions: number,
    hedgeRebalances: number,
    timeInRange: number
): number {
    const effectiveApr = poolApr * timeInRange;
    const grossFees = POSITION_SIZE * effectiveApr * (DAYS / 365);

    const lpRepoCost = lpRepositions * ((LP_REPOSITION_SWAP_PORTION * POSITION_SIZE * (LP_SLIPPAGE_BPS / 10000)) + LP_REPOSITION_GAS);
    const hedgeCost = hedgeRebalances * ((POSITION_SIZE * 0.5 * 0.05 * (LP_SLIPPAGE_BPS / 10000)) + 0.005);
    const fundingCost = (POSITION_SIZE / 2) * dailyFundingRate * DAYS;

    const netPnl = grossFees - lpRepoCost - hedgeCost - fundingCost - BOOTSTRAP_COST;
    // Use compound annualization (APY), not linear (APR)
    return Math.pow(1 + netPnl / POSITION_SIZE, 365 / DAYS) - 1;
}

console.log('════════════════════════════════════════════════════════════════════════════════');
console.log('SENSITIVITY ANALYSIS: What Parameters Achieve 25% APY?');
console.log('════════════════════════════════════════════════════════════════════════════════\n');

// Scenario 1: Current parameters
console.log('CURRENT PARAMETERS (±15% range, 0 repos):');
const currentNetApr = calculateNetApr(0.29, 0.0003, 0, 16, 1.0);
console.log(`  Pool APY: 29%, Funding: 3bps/day`);
console.log(`  Net APY: ${(currentNetApr * 100).toFixed(1)}%`);
console.log(`  Gap to 25%: ${((0.25 - currentNetApr) * 100).toFixed(1)}% shortfall\n`);

// Scenario 2: What pool APY is needed?
console.log('SCENARIO A: What pool APY is needed? (assuming 3bps/day funding, 0 repos)');
for (const poolApr of [0.29, 0.35, 0.40, 0.45, 0.50]) {
    const netApy = calculateNetApr(poolApr, 0.0003, 0, 16, 1.0);
    const marker = netApy >= 0.25 ? '✓' : '✗';
    console.log(`  ${marker} Pool APY ${(poolApr * 100).toFixed(0)}% → Net APY ${(netApy * 100).toFixed(1)}%`);
}

// Scenario 3: What if no funding cost?
console.log('\nSCENARIO B: What if funding rate was 0? (e.g., spot short instead of perp)');
for (const poolApr of [0.29, 0.35, 0.40]) {
    const netApy = calculateNetApr(poolApr, 0, 0, 16, 1.0);
    const marker = netApy >= 0.25 ? '✓' : '✗';
    console.log(`  ${marker} Pool APY ${(poolApr * 100).toFixed(0)}%, Funding 0 → Net APY ${(netApy * 100).toFixed(1)}%`);
}

// Scenario 4: What funding rate can we tolerate at 29% pool APY?
console.log('\nSCENARIO C: What funding rate can we tolerate at 29% pool APY?');
for (const fundingBps of [0, 0.0001, 0.0002, 0.0003, 0.0004]) {
    const netApy = calculateNetApr(0.29, fundingBps, 0, 16, 1.0);
    const marker = netApy >= 0.25 ? '✓' : '✗';
    const annualFundingPct = fundingBps * 365 * 100; // Annual rate on hedge notional
    console.log(`  ${marker} ${(fundingBps * 100 * 100).toFixed(1)} bps/day (${annualFundingPct.toFixed(1)}% annual on hedge) → Net APY ${(netApy * 100).toFixed(1)}%`);
}

// Scenario 5: Allow some repositions
console.log('\nSCENARIO D: With tighter ranges (some repositioning)');
const scenarios = [
    { range: '±15%', repos: 0, timeInRange: 1.0 },
    { range: '±10%', repos: 4, timeInRange: 0.999 },
    { range: '±5%', repos: 16, timeInRange: 0.997 },
    { range: '±3%', repos: 38, timeInRange: 0.992 },
    { range: '±2%', repos: 74, timeInRange: 0.984 },
];

for (const s of scenarios) {
    const netApy = calculateNetApr(0.29, 0.0003, s.repos, 16, s.timeInRange);
    const marker = netApy >= 0.25 ? '✓' : '✗';
    console.log(`  ${marker} ${s.range} (${s.repos} repos, ${(s.timeInRange * 100).toFixed(1)}% in range) → Net APY ${(netApy * 100).toFixed(1)}%`);
}

console.log('\n════════════════════════════════════════════════════════════════════════════════');
console.log('CONCLUSIONS');
console.log('════════════════════════════════════════════════════════════════════════════════\n');

const requiredPoolApr = 0.35;
const netAt35 = calculateNetApr(0.35, 0.0003, 0, 16, 1.0);
console.log(`1. To hit 25% net APY with current funding (3bps/day):`);
console.log(`   Need pool APY of ~${(requiredPoolApr * 100).toFixed(0)}% (currently 29%)`);
console.log('');

const netAtZeroFunding = calculateNetApr(0.29, 0, 0, 16, 1.0);
console.log(`2. With current 29% pool APY and zero funding cost:`);
console.log(`   Net APY would be ${(netAtZeroFunding * 100).toFixed(1)}%`);
console.log('');

console.log(`3. Current strategy max (29% pool, 3bps funding, wide range):`);
console.log(`   Net APY: ${(currentNetApr * 100).toFixed(1)}% - ~3% SHORT of target`);
console.log('');

console.log('OPTIONS TO HIT 25% TARGET:');
console.log('  a) Find a pool with higher APY (35%+)');
console.log('  b) Use a hedge with lower/no funding cost (spot short, options)');
console.log('  c) Accept ~22% APY as the realistic ceiling for this strategy');
console.log('  d) Wait for higher volume periods in the pool (variable APY)');
