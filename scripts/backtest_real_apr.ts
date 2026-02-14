#!/usr/bin/env npx ts-node
/**
 * TSLAx-USDC Model Using REAL Raydium APR Data
 * 
 * From actual Raydium UI screenshots:
 * ±1% range = 8.38% APR
 * ±5% range = 5.04% APR  
 * ±10% range = 2.45% APR
 * ±20% range = 1.2% APR
 */

const INITIAL_POSITION = 14000;

// REAL APR data from Raydium UI (when in range)
function getRaydiumApr(rangeWidth: number): number {
    // Interpolate from actual data points
    const dataPoints: [number, number][] = [
        [0.01, 0.0838],   // ±1% = 8.38%
        [0.05, 0.0504],   // ±5% = 5.04%
        [0.10, 0.0245],   // ±10% = 2.45%
        [0.20, 0.012],    // ±20% = 1.2%
    ];

    // Find closest points and interpolate
    for (let i = 0; i < dataPoints.length - 1; i++) {
        if (rangeWidth >= dataPoints[i][0] && rangeWidth <= dataPoints[i + 1][0]) {
            const [x1, y1] = dataPoints[i];
            const [x2, y2] = dataPoints[i + 1];
            const t = (rangeWidth - x1) / (x2 - x1);
            return y1 + t * (y2 - y1);
        }
    }

    // Extrapolate for tighter ranges
    if (rangeWidth < 0.01) {
        // Assume linear relationship continues
        return 0.0838 + (0.01 - rangeWidth) * (0.0838 - 0.0504) / (0.05 - 0.01);
    }

    return dataPoints[dataPoints.length - 1][1]; // Return widest if beyond
}

// Costs
const LP_REPOSITION_SWAP_PORTION = 0.15;
const LP_SLIPPAGE_BPS = 30;
const LP_REPOSITION_GAS = 0.01;
const DAILY_FUNDING_RATE = 0.0003; // 3bps/day

interface PricePoint { close: number; }

async function fetchTSLAPrices(): Promise<PricePoint[]> {
    console.log('Fetching TSLA prices from Yahoo Finance...');
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/TSLA?interval=5m&range=60d`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await response.json() as any;
    const quotes = json.chart?.result?.[0]?.indicators?.quote?.[0] || {};
    return (quotes.close || []).filter((c: number) => c > 0).map((c: number) => ({ close: c }));
}

async function main(): Promise<void> {
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log('TSLAx-USDC Model with REAL Raydium APR Data');
    console.log('════════════════════════════════════════════════════════════════════════════════\n');

    console.log('REAL APR from Raydium UI:');
    console.log('  ±1% range = 8.38% APR');
    console.log('  ±5% range = 5.04% APR');
    console.log('  ±10% range = 2.45% APR');
    console.log('  ±20% range = 1.2% APR\n');

    const prices = await fetchTSLAPrices();
    const PERIODS_PER_DAY = 78;
    const totalDays = Math.floor(prices.length / PERIODS_PER_DAY);

    console.log(`TSLA Data: ${prices.length} candles (${totalDays} days)\n`);

    const ranges = [0.005, 0.0075, 0.01, 0.02, 0.03, 0.05, 0.10, 0.20];

    console.log('RESULTS (with daily compounding):');
    console.log('┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
    console.log('│ LP Range │ Raydium  │ Time In  │ LP Repos │ Gross    │ Total    │ Net      │ Net APY  │');
    console.log('│          │ APR      │ Range    │          │ Fees     │ Costs    │ P&L      │          │');
    console.log('├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');

    for (const rangeWidth of ranges) {
        const raydiumApr = getRaydiumApr(rangeWidth);
        const dailyFeeRate = raydiumApr / 365;

        // Simulate with compounding
        let position = INITIAL_POSITION;
        let rangeCenter = prices[0].close;

        // Bootstrap cost
        position -= INITIAL_POSITION * 0.5 * (LP_SLIPPAGE_BPS / 10000);

        let totalGrossFees = 0;
        let totalLpRepos = 0;
        let totalPeriodsInRange = 0;

        for (let day = 0; day < totalDays; day++) {
            const dayStart = day * PERIODS_PER_DAY;
            const dayEnd = Math.min((day + 1) * PERIODS_PER_DAY, prices.length);

            let periodsInRange = 0;
            let dayLpRepos = 0;

            for (let i = dayStart; i < dayEnd; i++) {
                const price = prices[i].close;
                const rangeLow = rangeCenter * (1 - rangeWidth);
                const rangeHigh = rangeCenter * (1 + rangeWidth);

                if (price >= rangeLow && price <= rangeHigh) {
                    periodsInRange++;
                } else {
                    dayLpRepos++;
                    rangeCenter = price;
                }
            }

            totalPeriodsInRange += periodsInRange;
            totalLpRepos += dayLpRepos;

            const periodsInDay = dayEnd - dayStart;
            const timeInRange = periodsInRange / periodsInDay;

            // Daily fees (only earn when in range)
            const dailyFees = position * dailyFeeRate * timeInRange;

            // Costs
            const lpRepoCostPer = (LP_REPOSITION_SWAP_PORTION * position * (LP_SLIPPAGE_BPS / 10000)) + LP_REPOSITION_GAS;
            const lpRepoCost = dayLpRepos * lpRepoCostPer;
            const fundingCost = (position / 2) * DAILY_FUNDING_RATE;

            const netDay = dailyFees - lpRepoCost - fundingCost;

            // Compound
            position += netDay;
            totalGrossFees += dailyFees;
        }

        const timeInRangeOverall = totalPeriodsInRange / (totalDays * PERIODS_PER_DAY);
        // Bootstrap cost already subtracted from position on line 94, don't double-count
        const totalCosts = INITIAL_POSITION - position + totalGrossFees;
        const netPnl = position - INITIAL_POSITION;
        const growthRatio = position / INITIAL_POSITION;
        const netApy = Math.pow(growthRatio, 365 / totalDays) - 1;

        const marker = netApy >= 0.25 ? '★' : netApy >= 0.10 ? '◆' : netApy >= 0 ? '○' : '✗';
        console.log(`│${marker}±${(rangeWidth * 100).toFixed(2).padStart(4)}% │ ${(raydiumApr * 100).toFixed(2).padStart(5)}%  │ ${(timeInRangeOverall * 100).toFixed(1).padStart(5)}%   │ ${totalLpRepos.toString().padStart(5)}    │ $${totalGrossFees.toFixed(0).padStart(5)}   │ $${Math.abs(totalCosts).toFixed(0).padStart(5)}   │ $${netPnl.toFixed(0).padStart(5)}   │ ${(netApy * 100).toFixed(1).padStart(6)}%  │`);
    }

    console.log('└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');
    console.log('\n★ = 25%+ APY | ◆ = 10%+ APY | ○ = Profitable | ✗ = Loss\n');

    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log('KEY INSIGHT');
    console.log('════════════════════════════════════════════════════════════════════════════════\n');
    console.log('With REAL Raydium APR data (8.38% max for ±1%), achieving 25% APY is NOT possible');
    console.log('for this pool. The best case is likely single-digit APY after all costs.');
}

main().catch(console.error);
