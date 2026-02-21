#!/usr/bin/env npx tsx
/**
 * CORRECTED Strategy Backtest — Uses actual observed parameters
 *
 * Key corrections vs backtest_real_apr.ts:
 * 1. Funding is INCOME (shorts earn), not cost
 * 2. Uses live-observed pool APR (16-28%), not stale Raydium UI data
 * 3. Concentration multiplier from actual liquidity distribution
 * 4. Gas cost per reposition from actual Solana tx fees
 * 5. Tests multiple capital levels
 */

interface PricePoint { timestamp: number; close: number; }

// ============================================================================
// Fetch TSLA prices from Yahoo Finance (5-min candles, max 60 days)
// ============================================================================
async function fetchTSLAPrices5m(): Promise<PricePoint[]> {
    console.log('Fetching TSLA 5-min candles from Yahoo Finance (60 days)...');
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/TSLA?interval=5m&range=60d';
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await response.json() as any;
    const result = json.chart?.result?.[0];
    if (!result) throw new Error('No data from Yahoo Finance');

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const points: PricePoint[] = [];
    for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] > 0) {
            points.push({ timestamp: timestamps[i] * 1000, close: closes[i] });
        }
    }
    console.log(`  Loaded ${points.length} candles (${(points.length / 78).toFixed(0)} trading days)`);
    return points;
}

async function fetchTSLAPricesDaily(): Promise<PricePoint[]> {
    console.log('Fetching TSLA daily candles from Yahoo Finance (1 year)...');
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/TSLA?interval=1d&range=1y';
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await response.json() as any;
    const result = json.chart?.result?.[0];
    if (!result) throw new Error('No data from Yahoo Finance');

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const points: PricePoint[] = [];
    for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] > 0) {
            points.push({ timestamp: timestamps[i] * 1000, close: closes[i] });
        }
    }
    console.log(`  Loaded ${points.length} daily candles`);
    return points;
}

// ============================================================================
// Strategy parameters (from actual live observations Feb 2026)
// ============================================================================
interface StrategyConfig {
    rangePercent: number;          // ±X% LP range (0.02 = ±2%)
    capitalUsd: number;            // Total capital deployed
    leverage: number;              // Hedge leverage (2x = 50% LP, 50% hedge collateral)
    poolAprBase: number;           // Base pool-wide APR (observed: 0.16-0.28)
    concentrationMultiplier: number; // How much more our concentrated position earns vs pool avg
    fundingRateDaily: number;      // Daily funding rate INCOME on short (observed: ~0.06%)
    repoSlippageBps: number;       // Slippage per reposition (bps on swapped portion)
    swapPortion: number;           // Fraction swapped on reposition (~15% for ratio delta)
    gasPerRepoUsd: number;         // Gas cost per reposition in USD
    repoDelayCandles: number;      // Candles to wait before repositioning (cooldown)
}

const DEFAULT_CONFIG: StrategyConfig = {
    rangePercent: 0.02,            // ±2% (current deployed)
    capitalUsd: 10_000,            // Test at $10K
    leverage: 2,
    poolAprBase: 0.20,             // 20% pool-wide APR (conservative mid of 16-28%)
    concentrationMultiplier: 3,    // Conservative: ±2% concentrated LP earns ~3x pool avg
    fundingRateDaily: 0.0006,      // 0.06%/day funding INCOME (from live: $0.0144/day on $2.34 = 0.6%)
    repoSlippageBps: 40,           // 40 bps on the swapped portion (measured via Jupiter quotes Feb 2026)
    swapPortion: 0.15,             // Only swap ~15% (ratio delta)
    gasPerRepoUsd: 0.20,           // ~$0.20 per Solana tx
    repoDelayCandles: 3,           // Wait 3 candles (~15min at 5m) before repositioning
};

// ============================================================================
// Simulation
// ============================================================================
interface SimResult {
    label: string;
    totalDays: number;
    capitalUsd: number;
    timeInRange: number;
    repositions: number;
    grossFeesUsd: number;
    fundingIncomeUsd: number;
    repoSlippageUsd: number;
    gasUsd: number;
    bootstrapCostUsd: number;
    netPnlUsd: number;
    periodReturn: number;
    simpleApy: number;
    maxDrawdownPct: number;
    reposPerDay: number;
}

function simulate(prices: PricePoint[], cfg: StrategyConfig, label: string, candlesPerDay: number): SimResult {
    const totalDays = prices.length / candlesPerDay;

    // Split capital: LP + hedge collateral
    const lpCapital = cfg.capitalUsd * (cfg.leverage / (cfg.leverage + 1));  // 2/3 for 2x leverage
    const hedgeCollateral = cfg.capitalUsd - lpCapital;
    const hedgeNotional = hedgeCollateral * cfg.leverage; // Short notional = collateral × leverage

    // Position APR (concentrated)
    const positionApr = cfg.poolAprBase * cfg.concentrationMultiplier;

    let position = cfg.capitalUsd;
    const bootstrapCost = lpCapital * 0.5 * (cfg.repoSlippageBps / 10000);
    position -= bootstrapCost;

    let rangeCenter = prices[0].close;
    let outOfRangeCount = 0;

    let periodsInRange = 0;
    let repositions = 0;
    let totalGrossFees = 0;
    let totalFundingIncome = 0;
    let totalRepoSlippage = 0;
    let totalGas = 0;
    let peakValue = position;
    let maxDrawdown = 0;

    for (let i = 0; i < prices.length; i++) {
        const price = prices[i].close;
        const rangeLow = rangeCenter * (1 - cfg.rangePercent);
        const rangeHigh = rangeCenter * (1 + cfg.rangePercent);
        const inRange = price >= rangeLow && price <= rangeHigh;

        if (inRange) {
            periodsInRange++;
            outOfRangeCount = 0;

            // Earn LP fees (pro-rated per candle)
            const candleFees = position * (positionApr / 365 / candlesPerDay);
            totalGrossFees += candleFees;
            position += candleFees;

            // Earn funding income on short (pro-rated per candle)
            const candleFunding = hedgeNotional * (cfg.fundingRateDaily / candlesPerDay);
            totalFundingIncome += candleFunding;
            position += candleFunding;
        } else {
            outOfRangeCount++;

            // Still earn funding on short even when LP is out of range
            const candleFunding = hedgeNotional * (cfg.fundingRateDaily / candlesPerDay);
            totalFundingIncome += candleFunding;
            position += candleFunding;

            if (outOfRangeCount >= cfg.repoDelayCandles) {
                // Reposition
                const repoSlippage = cfg.swapPortion * position * (cfg.repoSlippageBps / 10000);
                totalRepoSlippage += repoSlippage;
                totalGas += cfg.gasPerRepoUsd;
                position -= repoSlippage;
                position -= cfg.gasPerRepoUsd;

                rangeCenter = price;
                outOfRangeCount = 0;
                repositions++;
            }
        }

        // Track drawdown
        if (position > peakValue) peakValue = position;
        const dd = (peakValue - position) / peakValue;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const timeInRange = periodsInRange / prices.length;
    const netPnl = position - cfg.capitalUsd;
    const periodReturn = cfg.capitalUsd > 0 ? netPnl / cfg.capitalUsd : 0;
    const simpleApy = totalDays > 0 ? periodReturn * (365 / totalDays) : 0;

    return {
        label,
        totalDays,
        capitalUsd: cfg.capitalUsd,
        timeInRange,
        repositions,
        grossFeesUsd: totalGrossFees,
        fundingIncomeUsd: totalFundingIncome,
        repoSlippageUsd: totalRepoSlippage,
        gasUsd: totalGas,
        bootstrapCostUsd: bootstrapCost,
        netPnlUsd: netPnl,
        periodReturn,
        simpleApy,
        maxDrawdownPct: maxDrawdown,
        reposPerDay: repositions / totalDays,
    };
}

function printResult(r: SimResult) {
    const marker = r.simpleApy >= 0.25 ? '★' : r.simpleApy >= 0.10 ? '◆' : r.simpleApy >= 0 ? '○' : '✗';
    console.log(`${marker} ${r.label.padEnd(28)} | ${(r.timeInRange * 100).toFixed(1).padStart(5)}% in range | ${r.repositions.toString().padStart(4)} repos (${r.reposPerDay.toFixed(1)}/day) | Fees: $${r.grossFeesUsd.toFixed(0).padStart(6)} | Funding: $${r.fundingIncomeUsd.toFixed(0).padStart(5)} | Costs: $${(r.repoSlippageUsd + r.gasUsd + r.bootstrapCostUsd).toFixed(0).padStart(5)} | Net: $${r.netPnlUsd.toFixed(0).padStart(6)} | APY: ${(r.simpleApy * 100).toFixed(1).padStart(6)}% | MaxDD: ${(r.maxDrawdownPct * 100).toFixed(2)}%`);
}

// ============================================================================
// Main
// ============================================================================
async function main() {
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log('TSLA Delta-Neutral Strategy Backtest (Corrected)');
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log();
    console.log('Key corrections vs old backtest:');
    console.log('  1. Funding is INCOME (shorts earn on Flash Trade), not cost');
    console.log('  2. Pool APR = 20% base (observed 16-28%), not stale 8.38%');
    console.log('  3. Concentration multiplier = 3x for ±2% range');
    console.log('  4. Gas = $0.20/repo (actual Solana fees)');
    console.log();

    // Fetch both 5m (60 day) and daily (1 year) data
    const [prices5m, pricesDaily] = await Promise.all([
        fetchTSLAPrices5m(),
        fetchTSLAPricesDaily(),
    ]);

    const tsla5m = prices5m.filter(p => p.close > 0);
    const tslaDaily = pricesDaily.filter(p => p.close > 0);

    const minPrice = Math.min(...tslaDaily.map(p => p.close));
    const maxPrice = Math.max(...tslaDaily.map(p => p.close));
    console.log(`\nTSLA price range: $${minPrice.toFixed(0)} — $${maxPrice.toFixed(0)} (${((maxPrice - minPrice) / minPrice * 100).toFixed(0)}% swing)\n`);

    // ── SECTION 1: Range Width Sweep (5-min data, 60 days) ──────────────────
    console.log('═══ SECTION 1: Range Width Sweep (60-day, 5-min candles, $10K capital) ═══');
    console.log();

    const ranges = [0.005, 0.01, 0.015, 0.02, 0.03, 0.05, 0.075, 0.10];
    for (const rng of ranges) {
        const cfg = {
            ...DEFAULT_CONFIG,
            rangePercent: rng,
            concentrationMultiplier: Math.min(0.10 / rng, 8), // Cap at 8x
        };
        const result = simulate(tsla5m, cfg, `±${(rng * 100).toFixed(1)}% range`, 78);
        printResult(result);
    }

    // ── SECTION 2: Capital Level Sweep (5-min, ±2% range) ───────────────────
    console.log();
    console.log('═══ SECTION 2: Capital Level Sweep (60-day, ±2% range) ═══');
    console.log();

    const capitals = [100, 1000, 5000, 10000, 50000, 100000];
    for (const cap of capitals) {
        const cfg = { ...DEFAULT_CONFIG, capitalUsd: cap };
        const result = simulate(tsla5m, cfg, `$${cap.toLocaleString()} capital`, 78);
        printResult(result);
    }

    // ── SECTION 3: Pool APR Sensitivity (5-min, ±2% range, $10K) ────────────
    console.log();
    console.log('═══ SECTION 3: Pool APR Sensitivity (what if APR changes?) ═══');
    console.log();

    const aprs = [0.05, 0.10, 0.16, 0.20, 0.28, 0.40];
    for (const apr of aprs) {
        const cfg = { ...DEFAULT_CONFIG, poolAprBase: apr };
        const result = simulate(tsla5m, cfg, `${(apr * 100).toFixed(0)}% pool APR`, 78);
        printResult(result);
    }

    // ── SECTION 4: Funding Rate Sensitivity ─────────────────────────────────
    console.log();
    console.log('═══ SECTION 4: Funding Rate Sensitivity (income from short) ═══');
    console.log();

    const fundingRates = [0, 0.0002, 0.0006, 0.001, 0.002];
    for (const fr of fundingRates) {
        const cfg = { ...DEFAULT_CONFIG, fundingRateDaily: fr };
        const label = fr === 0 ? 'No funding' : `${(fr * 100).toFixed(2)}%/day funding`;
        const result = simulate(tsla5m, cfg, label, 78);
        printResult(result);
    }

    // ── SECTION 5: 1-Year Daily Backtest (conservative, daily granularity) ──
    console.log();
    console.log('═══ SECTION 5: 1-Year Backtest (daily candles, lower granularity) ═══');
    console.log('Note: Daily candles undercount out-of-range events (intraday moves missed)');
    console.log();

    const yearRanges = [0.02, 0.03, 0.05, 0.10];
    for (const rng of yearRanges) {
        const cfg = {
            ...DEFAULT_CONFIG,
            rangePercent: rng,
            concentrationMultiplier: Math.min(0.10 / rng, 8),
            repoDelayCandles: 1, // Daily: 1 candle = 1 day
        };
        const result = simulate(tslaDaily, cfg, `±${(rng * 100).toFixed(0)}% (1yr daily)`, 1);
        printResult(result);
    }

    // ── Summary ─────────────────────────────────────────────────────────────
    console.log();
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log('SUMMARY');
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log();
    console.log('★ = 25%+ APY | ◆ = 10%+ APY | ○ = Profitable | ✗ = Loss');
    console.log();
    console.log('Key findings:');

    // Run the "current config" scenario
    const current = simulate(tsla5m, DEFAULT_CONFIG, 'Current config', 78);
    console.log(`  Current config (±2%, $10K, 20% pool APR): ${(current.simpleApy * 100).toFixed(1)}% APY, $${current.netPnlUsd.toFixed(0)} P&L over ${current.totalDays.toFixed(0)} days`);
    console.log(`  Income breakdown: $${current.grossFeesUsd.toFixed(0)} LP fees + $${current.fundingIncomeUsd.toFixed(0)} funding = $${(current.grossFeesUsd + current.fundingIncomeUsd).toFixed(0)} gross`);
    console.log(`  Cost breakdown: $${current.repoSlippageUsd.toFixed(0)} slippage + $${current.gasUsd.toFixed(0)} gas + $${current.bootstrapCostUsd.toFixed(0)} bootstrap = $${(current.repoSlippageUsd + current.gasUsd + current.bootstrapCostUsd).toFixed(0)} total costs`);
    console.log(`  ${current.repositions} repositions (${current.reposPerDay.toFixed(1)}/day), ${(current.timeInRange * 100).toFixed(1)}% time in range`);
    console.log(`  Max drawdown: ${(current.maxDrawdownPct * 100).toFixed(2)}%`);
}

main().catch(console.error);
