#!/usr/bin/env npx tsx
/**
 * Query Raydium CLMM Tick-Level Liquidity Distribution
 *
 * Connects to the TSLAx/USDC pool and computes the actual concentration
 * multiplier for different LP range widths. This replaces the backtest's
 * naive `referenceRange / rangePercent` formula with real on-chain data.
 *
 * Run on VM where .env has RPC_ENDPOINT_1 and RAYDIUM_POOL_ADDRESS:
 *   npx tsx scripts/query_liquidity_distribution.ts
 */

import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

const RPC_URL = process.env.RPC_ENDPOINT_1 || 'https://api.mainnet-beta.solana.com';
const POOL_ADDRESS = process.env.RAYDIUM_POOL_ADDRESS;

if (!POOL_ADDRESS || POOL_ADDRESS === '11111111111111111111111111111111') {
    console.error('ERROR: Set RAYDIUM_POOL_ADDRESS in .env');
    process.exit(1);
}

// Range widths to analyze
const RANGE_PERCENTS = [0.005, 0.01, 0.015, 0.02, 0.03, 0.05, 0.075, 0.10, 0.15, 0.20];

async function main() {
    console.log('Connecting to Raydium CLMM...');
    console.log(`  RPC: ${RPC_URL.substring(0, 40)}...`);
    console.log(`  Pool: ${POOL_ADDRESS}`);
    console.log();

    const connection = new Connection(RPC_URL, { commitment: 'confirmed' });

    // Initialize Raydium SDK (read-only, no wallet needed for queries)
    const { Raydium } = await import('@raydium-io/raydium-sdk-v2');
    const dummyWallet = Keypair.generate(); // SDK requires owner but we only read

    const raydium = await Raydium.load({
        connection,
        cluster: 'mainnet',
        owner: dummyWallet,
        disableLoadToken: true,
    });

    // Fetch pool data with tick arrays
    console.log('Fetching pool data and tick arrays...');
    const poolData = await raydium.clmm.getPoolInfoFromRpc(POOL_ADDRESS);

    const computeInfo = poolData.computePoolInfo;
    const currentTick = computeInfo.tickCurrent;
    const sqrtPriceX64 = computeInfo.sqrtPriceX64;
    const currentLiquidity = BigInt(computeInfo.liquidity.toString());
    const tickSpacing = poolData.poolInfo?.config?.tickSpacing || 1;

    // Compute human-readable price
    const sqrtPrice = Number(sqrtPriceX64.toString()) / Math.pow(2, 64);
    const rawPrice = sqrtPrice * sqrtPrice;
    const humanPrice = rawPrice * 100; // TSLAx(8 dec) / USDC(6 dec) = ×100

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`LIQUIDITY DISTRIBUTION — TSLAx/USDC Raydium CLMM`);
    console.log(`════════════════════════════════════════════════════════════════`);
    console.log(`Pool:          ${POOL_ADDRESS}`);
    console.log(`Current tick:  ${currentTick}`);
    console.log(`Current price: $${humanPrice.toFixed(2)} (raw: ${rawPrice.toFixed(6)})`);
    console.log(`Active liq:    ${currentLiquidity.toString()}`);
    console.log(`Tick spacing:  ${tickSpacing}`);

    // Build tick map: tick index → liquidityNet (signed)
    // In CLMM, liquidity is constant between ticks. At each initialized tick,
    // liquidity changes by liquidityNet. To find total liquidity in a range,
    // we walk from the lowest tick upward, accumulating liquidity.
    const tickData = poolData.tickData[POOL_ADDRESS];
    if (!tickData) {
        console.error('ERROR: No tick data returned. Pool may not exist or RPC issue.');
        process.exit(1);
    }

    interface TickInfo {
        tick: number;
        liquidityNet: bigint;
        liquidityGross: bigint;
    }

    const allTicks: TickInfo[] = [];
    for (const ta of Object.values(tickData) as any[]) {
        if (!ta.ticks) continue;
        for (const t of ta.ticks) {
            if (t && t.tick !== undefined && t.liquidityGross) {
                const grossBN = BigInt(t.liquidityGross.toString());
                if (grossBN > 0n) {
                    allTicks.push({
                        tick: t.tick,
                        liquidityNet: BigInt(t.liquidityNet.toString()),
                        liquidityGross: grossBN,
                    });
                }
            }
        }
    }

    allTicks.sort((a, b) => a.tick - b.tick);
    console.log(`Init ticks:    ${allTicks.length}`);

    if (allTicks.length === 0) {
        console.error('ERROR: No initialized ticks found. Pool may have no liquidity.');
        process.exit(1);
    }

    const minTick = allTicks[0].tick;
    const maxTick = allTicks[allTicks.length - 1].tick;
    console.log(`Tick range:    [${minTick}, ${maxTick}]`);
    console.log();

    // For CLMM: liquidity in a range = the liquidity that is active when
    // the price is anywhere in that range. This equals the cumulative
    // liquidityNet from the lowest tick up to the range boundaries.
    //
    // However, for concentration analysis, we care about a different question:
    // "What fraction of fees does a position in [tickLow, tickHigh] earn?"
    //
    // Fee share = (our liquidity) / (liquidity active at current tick within our range)
    // Concentration multiplier = (pool-wide APR) × (total active liquidity / our active liquidity fraction)
    //
    // Actually, the simplest correct metric:
    // - Pool APR is fees / TVL averaged over all positions
    // - A position at ±X% only earns fees when price is in its range
    // - When price IS in range, its fee share = (its liquidity) / (total liquidity at that tick)
    //
    // For positions of equal USD size but different widths:
    // - Narrower position concentrates more liquidity per tick → higher share when in range
    // - But narrower position is out of range more often
    //
    // The multiplier vs pool average is approximately:
    //   multiplier ≈ (full_range_width / position_range_width) × (time_in_range / 1.0)
    //
    // Since ALL positions (regardless of width) contribute to pool APR,
    // the real question is: how does the liquidity distribute?
    //
    // Let's compute: for each range width, what fraction of TOTAL pool liquidity
    // has tick ranges that overlap with ±X% around current price?
    // This tells us how much competition we face.

    // Method: Walk through all ticks and compute cumulative liquidity profile
    // Build a profile of "total liquidity active at each tick"
    // Start from the lowest tick and accumulate liquidityNet

    // First, compute total liquidity at the current tick (should match currentLiquidity)
    let runningLiquidity = 0n;
    const liquidityAtTick: Map<number, bigint> = new Map();

    // Walk from lowest tick upward
    for (const t of allTicks) {
        runningLiquidity += t.liquidityNet;
        liquidityAtTick.set(t.tick, runningLiquidity);
    }

    // Verify against pool's reported active liquidity
    // Find the liquidity just at/below the current tick
    let liquidityAtCurrent = 0n;
    for (const t of allTicks) {
        if (t.tick > currentTick) break;
        liquidityAtCurrent += t.liquidityNet;
    }

    console.log(`Verification: computed liq at current tick = ${liquidityAtCurrent.toString()}`);
    console.log(`              pool reports active liq       = ${currentLiquidity.toString()}`);
    const match = liquidityAtCurrent === currentLiquidity;
    console.log(`              match: ${match ? 'YES ✓' : 'NO ✗ (may affect accuracy)'}`);
    console.log();

    // For concentration analysis:
    // When price is at current tick, ALL liquidity that spans this tick earns fees.
    // A position spanning [tickLow, tickHigh] has its liquidity active at every tick in that range.
    // The "concentration multiplier" for a ±X% position of $1 of capital:
    //
    // For the same capital, a narrower range deposits MORE liquidity per tick.
    // If our ±2% position has L liquidity, and total active liquidity is L_total,
    // we earn L/L_total of all fees while in range.
    //
    // A ±1% position with the same capital has ~2× the liquidity (since it's half the range),
    // so it earns (2L)/L_total = 2× the fee rate when in range.
    //
    // BUT this only works if the OTHER positions don't also narrow.
    // The current tick's active liquidity L_total already includes all overlapping positions.
    //
    // The correct formula:
    // concentration_multiplier(±X%) = (full_price_range / (2*X%)) × (time_in_range)
    //
    // Where full_price_range represents the "effective average" range of all liquidity providers.
    // We can compute this from the tick data!

    // Compute the "effective average range" of the pool
    // = sum over all positions of (position_liquidity × position_range_width) / sum of position_liquidity
    // But we don't have individual positions — we have tick-level aggregates.
    //
    // Alternative: compute the liquidity-weighted average tick span.
    // For each tick that has liquidityGross > 0, it represents a boundary of some position(s).
    // The total liquidity at the current tick divided by the number of ticks that contain it
    // gives a sense of concentration.
    //
    // SIMPLEST CORRECT APPROACH:
    // Compute what fraction of fees accrues to a ±X% range when price moves ±Y%.
    // Model: assume price does a random walk visiting each tick with equal probability
    // (not perfect but reasonable for analysis).
    //
    // When at tick T, fee share of a position spanning [T-a, T+a] = its_liquidity / total_liq_at_T
    // For same capital in different widths:
    //   liquidity_per_tick(±X%) ∝ capital / (2 * X%)
    //   fee_share(±X%) = liquidity_per_tick(±X%) / total_liq_at_T ∝ 1/(2*X%) / total_liq_at_T
    //
    // The concentration multiplier vs pool average:
    //   multiplier(±X%) = fee_share(±X%) / fee_share(pool_average)
    //
    // Where pool_average fee_share is what a $1 position would earn if spread across
    // the entire active liquidity range.

    // Let's compute the EFFECTIVE RANGE of the pool.
    // The effective range is the liquidity-weighted average tick span of all positions.
    // We can estimate it by looking at how quickly liquidity drops off from the center.

    // Compute liquidity profile around current tick
    console.log('─── LIQUIDITY PROFILE AROUND CURRENT TICK ───');
    console.log();

    // For each range width, compute:
    // 1. The tick bounds
    // 2. The average liquidity in that range (mean of active liquidity at each tick)
    // 3. The ratio: avg_liq_in_range / avg_liq_at_center

    // First compute average liquidity at center (±1 tick spacing)
    const centerTicks = allTicks.filter(t =>
        t.tick >= currentTick - tickSpacing && t.tick <= currentTick + tickSpacing
    );

    // The "active liquidity" at the current tick is what matters
    const activeLiqAtCenter = currentLiquidity;

    console.log('Range       │ Lower Tick │ Upper Tick │ Avg Active Liq    │ vs Center │ Concentration');
    console.log('────────────┼────────────┼────────────┼───────────────────┼───────────┼──────────────');

    const results: { range: number; multiplier: number }[] = [];

    for (const rangePct of RANGE_PERCENTS) {
        // Compute tick bounds for ±X% around current price
        const lowerPrice = rawPrice * (1 - rangePct);
        const upperPrice = rawPrice * (1 + rangePct);
        const lowerTick = Math.floor(Math.log(lowerPrice) / Math.log(1.0001) / tickSpacing) * tickSpacing;
        const upperTick = Math.ceil(Math.log(upperPrice) / Math.log(1.0001) / tickSpacing) * tickSpacing;

        // Walk through the range and compute average active liquidity
        // The active liquidity between two consecutive initialized ticks is constant
        // We need to sum liquidity × tick_span for each segment in our range

        let totalLiqTicks = 0n; // sum of (liquidity × ticks_in_segment)
        let totalTicks = 0;

        // Find all ticks that might affect our range
        // Start with liquidity at the tick just below our lowerTick
        let segmentLiq = 0n;
        for (const t of allTicks) {
            if (t.tick > lowerTick) break;
            segmentLiq += t.liquidityNet;
        }

        // Now walk through ticks in our range
        let prevTick = lowerTick;
        for (const t of allTicks) {
            if (t.tick <= lowerTick) continue;
            if (t.tick > upperTick) break;

            // Segment from prevTick to t.tick has segmentLiq
            const span = t.tick - prevTick;
            if (span > 0 && segmentLiq > 0n) {
                totalLiqTicks += segmentLiq * BigInt(span);
                totalTicks += span;
            }

            segmentLiq += t.liquidityNet;
            prevTick = t.tick;
        }

        // Last segment from prevTick to upperTick
        const lastSpan = upperTick - prevTick;
        if (lastSpan > 0 && segmentLiq > 0n) {
            totalLiqTicks += segmentLiq * BigInt(lastSpan);
            totalTicks += lastSpan;
        }

        const rangeSpan = upperTick - lowerTick;
        const avgLiqInRange = totalTicks > 0 ? totalLiqTicks / BigInt(totalTicks) : 0n;

        // Concentration multiplier:
        // A position spanning ±X% vs the "average" LP position.
        // If the pool has uniform liquidity across all ticks, then a ±X% position
        // earns (total_range / our_range) × pool APR.
        // But liquidity is NOT uniform — it concentrates near the center.
        //
        // The ratio avgLiqInRange / activeLiqAtCenter tells us:
        // If ratio = 1.0: liquidity is uniform (positions are wide, our narrow position captures more)
        // If ratio < 1.0: liquidity drops off (other LPs are even narrower, we're competing)
        //
        // Real concentration multiplier:
        // When we place $1 at ±X%, we get liquidity_per_tick = $1 / (2*X% * price)
        // Our fee share at tick T = our_liq / total_liq_at_T
        // Pool APR is earned by ALL liquidity across ALL ticks (weighted by time at each tick)
        //
        // For a simple model: if pool has L_total active at center, and our position
        // contributes L_our, we earn L_our/L_total share of fees while in range.
        //
        // L_our for ±X% with $C capital = C / (2 * X% * sqrt(price_upper * price_lower))
        // (from CLMM math — narrower range = more liquidity per dollar)
        //
        // Compared to a position at ±Y%, same capital:
        // L_our(±X%) / L_our(±Y%) ≈ Y/X (for small ranges)
        //
        // So ±1% has ~2× the liquidity density of ±2% for same capital.
        // Fee rate when in range: 2× higher.
        // BUT: total fees also depend on time in range (handled by backtest).
        //
        // The "competitor effect": if average pool liquidity at center tick is high
        // but drops off quickly, narrow positions face MORE competition near center.
        // Effective multiplier = (narrowing benefit) × (1 / competition_increase)

        // Simplest useful metric: what is the actual liquidity that a ±X% position
        // would be competing against (averaged over the range)?
        // competition_ratio = avgLiqInRange / activeLiqAtCenter

        const ratio = activeLiqAtCenter > 0n
            ? Number(avgLiqInRange * 10000n / activeLiqAtCenter) / 10000
            : 0;

        // The concentration multiplier vs a "full range" position:
        // If pool effective range = some R, and we're at ±X%, multiplier = R/(2*X%)
        // But we can compute it more directly:
        // multiplier = (1 / rangePct) × (avgLiqAtCenter / avgLiqInRange) × baseFactor
        // where baseFactor normalizes so that the widest range gives multiplier ≈ 1
        //
        // Actually, the most useful output is just the RAW DATA:
        // - Average liquidity in range
        // - Ratio vs center
        // Let the backtest use this to compute the right multiplier.

        // For the backtest, the formula should be:
        // position_apr(±X%) = pool_apr × (activeLiqAtCenter / avgLiqInRange) × (1 / (rangePct * 2))
        // normalized so that at the widest range we test, it approaches pool_apr

        // But the simplest form for the backtest:
        // concentrationMultiplier(±X%) = (widest_range / this_range) × (avgLiq_widest / avgLiq_this)
        // This accounts for both the narrowing benefit AND the competition effect.

        const rangeLabel = `±${(rangePct * 100).toFixed(1)}%`.padEnd(10);
        const lowerStr = lowerTick.toString().padStart(9);
        const upperStr = upperTick.toString().padStart(9);
        const avgLiqStr = avgLiqInRange.toString().padStart(17);
        const ratioStr = ratio.toFixed(4).padStart(8);

        // Store for multiplier computation after loop
        results.push({ range: rangePct, multiplier: 0 }); // placeholder

        console.log(`${rangeLabel} │ ${lowerStr} │ ${upperStr} │ ${avgLiqStr} │ ${ratioStr}x │ (computed below)`);
    }

    // Compute concentration multipliers relative to widest range (±20%)
    // multiplier(±X%) = (widest / X) × (avgLiq_widest / avgLiq_X)
    // This gives: wider range = lower multiplier, but adjusted for competition
    console.log();
    console.log('─── CONCENTRATION MULTIPLIERS (for backtest) ───');
    console.log();

    // Re-compute with the actual numbers to get clean multipliers
    // Use ±10% as the reference (close to "full range" for most pools)
    const REF_RANGE = 0.10;

    // Get average liquidity for each range
    const rangeLiqMap = new Map<number, bigint>();
    for (const rangePct of [...RANGE_PERCENTS]) {
        const lowerPrice = rawPrice * (1 - rangePct);
        const upperPrice = rawPrice * (1 + rangePct);
        const lowerTick = Math.floor(Math.log(lowerPrice) / Math.log(1.0001) / tickSpacing) * tickSpacing;
        const upperTick = Math.ceil(Math.log(upperPrice) / Math.log(1.0001) / tickSpacing) * tickSpacing;

        let segLiq = 0n;
        for (const t of allTicks) {
            if (t.tick > lowerTick) break;
            segLiq += t.liquidityNet;
        }

        let totalLT = 0n;
        let totalT = 0;
        let prevT = lowerTick;
        for (const t of allTicks) {
            if (t.tick <= lowerTick) continue;
            if (t.tick > upperTick) break;
            const span = t.tick - prevT;
            if (span > 0 && segLiq > 0n) {
                totalLT += segLiq * BigInt(span);
                totalT += span;
            }
            segLiq += t.liquidityNet;
            prevT = t.tick;
        }
        const lastSpan = upperTick - prevT;
        if (lastSpan > 0 && segLiq > 0n) {
            totalLT += segLiq * BigInt(lastSpan);
            totalT += lastSpan;
        }

        rangeLiqMap.set(rangePct, totalT > 0 ? totalLT / BigInt(totalT) : 0n);
    }

    const refLiq = rangeLiqMap.get(REF_RANGE) || 1n;

    console.log('Range       │ Avg Liquidity   │ vs ±10%   │ Naive Mult │ Real Mult │ Explanation');
    console.log('────────────┼─────────────────┼───────────┼────────────┼───────────┼────────────');

    const multiplierTable: { range: number; mult: number }[] = [];

    for (const rangePct of RANGE_PERCENTS) {
        const avgLiq = rangeLiqMap.get(rangePct) || 0n;

        // Naive multiplier: just range ratio (what old backtest does)
        const naiveMult = REF_RANGE / rangePct;

        // Real multiplier: range ratio adjusted for liquidity concentration
        // When we narrow from ±10% to ±X%, we get (10/X) times more liquidity per tick.
        // But the competing liquidity at ±X% is avgLiq(±X%) vs avgLiq(±10%).
        // Net multiplier = naiveMult × (refLiq / avgLiq_X)
        // = (REF/X) × (avgLiq_ref / avgLiq_X)
        //
        // If avgLiq(±1%) = avgLiq(±10%), real = naive (uniform distribution)
        // If avgLiq(±1%) > avgLiq(±10%), real < naive (competition concentrates near center)
        // If avgLiq(±1%) < avgLiq(±10%), real > naive (we're the only ones near center)
        const liqRatio = refLiq > 0n ? Number(avgLiq * 10000n / refLiq) / 10000 : 1;
        const realMult = naiveMult / liqRatio;

        multiplierTable.push({ range: rangePct, mult: realMult });

        const rangeLabel = `±${(rangePct * 100).toFixed(1)}%`.padEnd(10);
        const liqStr = avgLiq.toString().padStart(15);
        const liqRatioStr = liqRatio.toFixed(4).padStart(8);
        const naiveStr = naiveMult.toFixed(1).padStart(9);
        const realStr = realMult.toFixed(2).padStart(8);

        let explanation = '';
        if (liqRatio > 1.05) explanation = `↑ more competition in this range`;
        else if (liqRatio < 0.95) explanation = `↓ less competition (liquidity drops off)`;
        else explanation = `≈ uniform liquidity`;

        console.log(`${rangeLabel} │ ${liqStr} │ ${liqRatioStr}x │ ${naiveStr}x │ ${realStr}x │ ${explanation}`);
    }

    // Output for copy-paste into backtest
    console.log();
    console.log('─── COPY-PASTE FOR BACKTEST ───');
    console.log();
    console.log('// Real concentration multipliers from on-chain data');
    console.log('// Generated by scripts/query_liquidity_distribution.ts');
    console.log('const REAL_CONCENTRATION: Record<number, number> = {');
    for (const { range, mult } of multiplierTable) {
        console.log(`    ${range}: ${mult.toFixed(2)},  // ±${(range * 100).toFixed(1)}%`);
    }
    console.log('};');
    console.log();
    console.log('function getRealConcentration(rangePercent: number): number {');
    console.log('    // Lookup exact match or interpolate');
    console.log('    if (REAL_CONCENTRATION[rangePercent]) return REAL_CONCENTRATION[rangePercent];');
    console.log('    const ranges = Object.keys(REAL_CONCENTRATION).map(Number).sort((a,b) => a-b);');
    console.log('    for (let i = 0; i < ranges.length - 1; i++) {');
    console.log('        if (rangePercent >= ranges[i] && rangePercent <= ranges[i+1]) {');
    console.log('            const t = (rangePercent - ranges[i]) / (ranges[i+1] - ranges[i]);');
    console.log('            return REAL_CONCENTRATION[ranges[i]] * (1-t) + REAL_CONCENTRATION[ranges[i+1]] * t;');
    console.log('        }');
    console.log('    }');
    console.log('    return 1.0;');
    console.log('}');

    // Summary
    console.log();
    console.log('════════════════════════════════════════════════════════════════');
    console.log('SUMMARY');
    console.log('════════════════════════════════════════════════════════════════');
    console.log();

    const mult1 = multiplierTable.find(m => m.range === 0.01)?.mult || 0;
    const mult2 = multiplierTable.find(m => m.range === 0.02)?.mult || 0;
    const mult05 = multiplierTable.find(m => m.range === 0.005)?.mult || 0;

    console.log(`±1% real multiplier: ${mult1.toFixed(2)}x (naive was 10.0x)`);
    console.log(`±2% real multiplier: ${mult2.toFixed(2)}x (naive was 5.0x)`);
    console.log(`±0.5% real multiplier: ${mult05.toFixed(2)}x (naive was 20.0x)`);
    console.log();
    console.log(`±1% / ±2% advantage: ${(mult1 / mult2).toFixed(2)}x (naive was 2.0x)`);
    console.log();

    if (mult1 / mult2 > 1.5) {
        console.log('→ ±1% has SIGNIFICANT advantage over ±2% even with real liquidity distribution');
    } else if (mult1 / mult2 > 1.1) {
        console.log('→ ±1% has MODEST advantage over ±2% — time-in-range differences may dominate');
    } else {
        console.log('→ ±1% has NEGLIGIBLE advantage over ±2% — stick with ±2% for reliability');
    }
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
