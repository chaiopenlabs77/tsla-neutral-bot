# TSLA Delta-Neutral Bot

## Quick Reference

```bash
npm test                       # Run tests
npx tsc --noEmit               # Type-check without emitting
npm run dev                    # Run in dry-run mode
npm start                      # Run production
```

## Deployment (spirit-worker VM)

```bash
# SSH into VM
gcloud compute ssh spirit-worker --zone=us-central1-a

# Deploy latest code
gcloud compute ssh spirit-worker --zone=us-central1-a \
  --command="cd ~/tsla-hedge && git pull && npx tsc && pm2 restart tsla-neutral"

# View logs
gcloud compute ssh spirit-worker --zone=us-central1-a \
  --command="pm2 logs tsla-neutral --lines 50"

# Export cycle data for analysis
gcloud compute ssh spirit-worker --zone=us-central1-a \
  --command="cd ~/tsla-hedge && node -e \"
    const db = require('better-sqlite3')('./data/cycles.db');
    const rows = db.prepare('SELECT * FROM cycles ORDER BY timestamp').all();
    require('fs').writeFileSync('/tmp/cycles_data.json', JSON.stringify(rows));
    console.log(rows.length + ' rows exported');
  \""
gcloud compute scp spirit-worker:/tmp/cycles_data.json /tmp/ --zone=us-central1-a
```

## Project Structure

```
src/bots/tsla_neutral/
├── config.ts                    # All strategy parameters (from .env)
├── types.ts                     # LPPosition, HedgePosition, CycleMetrics, etc.
├── state_machine.ts             # Bot state transitions
├── clients/
│   ├── lp_client.ts             # Raydium CLMM LP operations
│   ├── flash_trade_client.ts    # Flash Trade perp operations
│   ├── jupiter_client.ts        # Jupiter swap + SOL top-up
│   └── rpc_manager.ts           # Multi-RPC connection management
├── strategy/
│   ├── orchestrator.ts          # Main loop: fetch positions → evaluate → rebalance → record
│   └── risk_manager.ts          # evaluateRebalance() decision logic
├── infra/
│   └── data_collector.ts        # SQLite cycles.db recording (auto-migrating schema)
├── observability/
│   ├── logger.ts                # Structured JSON logging
│   ├── metrics.ts               # Prometheus-style gauges/counters
│   └── alerter.ts               # Telegram/webhook alerts
├── utils/
│   └── shutdown.ts              # Graceful shutdown handling
└── watchdog/                    # Health monitoring
```

## Strategy Overview

- **Long leg**: Concentrated LP on Raydium CLMM (TSLAx/USDC pool)
- **Short leg**: Perpetual short on Flash Trade (TSLAr/USDC)
- **Goal**: Delta-neutral yield from LP fees + funding income

### Impermanent Loss (IL) in Delta-Hedged CLMM
- IL is the **primary cost** of the delta-neutral strategy — directional moves cancel, IL remains
- For concentrated LP at center P₀ with range width w, hedged with short:
  - **In range** (r = P₁/P₀ between 1-w and 1+w): `il = -(2√r - r - 1) / w` as fraction of LP value
  - **Out of range**: IL frozen at edge + tracking error `|r - r_edge| / 2` from unhedged exposure
- IL is **realized at each reposition** (LP close locks it in)
- Both fees AND IL scale with concentration factor — narrower range amplifies both equally
- Tighter range = more repositions × smaller IL each, wider = fewer × larger IL each
- ±1% range: ~0.25% of LP value per reposition (at edge move)
- ±2% range: ~0.50% of LP value per reposition (at edge move)
- **The hedge does NOT eliminate IL** — it only cancels directional risk. IL is the gamma cost.

## Critical Rules

### Funding Rate is INCOME, Not Cost
- On Flash Trade TSLA perps, **longs pay shorts** (funding rate is positive)
- Our short position **receives** funding — this is a major income source
- Never model funding as a cost — it's income that adds to LP fee yield
- `estFundingCostUsd` in the DB is a legacy name; the value represents income for shorts

### Pool APR is Pool-Wide, NOT Position-Specific
- Raydium API `pool_apr` = total fees / total TVL across ALL liquidity providers
- Our **concentrated** position (e.g., ±2%) earns MORE per dollar than the pool average
- Concentration multiplier = effective_avg_LP_range / our_range
- From liquidity distribution analysis: ±2% holds ~12.7% of total liquidity
- Estimated multiplier: 2-8x depending on liquidity distribution
- **Never use raw pool APR for position P&L** — must apply concentration multiplier

### Decimal Conventions (CRITICAL — Get These Wrong and Values Are Off by 10^6)
| Token/Field | Decimals | Example |
|---|---|---|
| TSLAx (tokenA) | 8 | `tokenAAmount / 1e8` = actual TSLAx |
| USDC (tokenB) | 6 | `tokenBAmount / 1e6` = actual USDC |
| Flash Trade sizeUsd | 6 | `sizeUsd / 1e6` = actual USD |
| Flash Trade tokenAmount | 9 | `sizeAmount / 1e9` = actual tokens |
| Flash Trade price | exponent -5 | `price / 1e5` = actual price |
| Flash Trade unsettledFeesUsd | 6 | `unsettledFeesUsd / 1e6` = actual USD |
| Flash Trade cumulativeLockFeeSnapshot | 9 | `cumulativeLockFeeSnapshot / 1e9` |
| Raydium tokenFeesOwedA | 8 | Same as tokenA (TSLAx) decimals |
| Raydium tokenFeesOwedB | 6 | Same as tokenB (USDC) decimals |
| SOL | 9 (lamports) | `balance / 1e9` = actual SOL |

### Market Hours and LP Hours
- **LP earns fees 24/7** on-chain (pool never sleeps)
- **Hedge operations** (Flash Trade) only during market hours (~9:30 AM - 4 PM ET, weekdays)
- Flash Trade extended: 24/5 availability (Mon-Fri including pre/post market)
- **LP repositioning** can happen anytime (on-chain only, no Flash Trade needed)
- **Auto-bootstrap** only triggers during market hours (needs hedge leg)
- **After-hours power saving**: When US stock market is closed, cycles skip all network calls and loop interval slows from 10s to 60s. Pyth TSLA feed only publishes during NYSE hours, so after-hours cycles would always fail the staleness check anyway. This saves ~360 wasted RPC calls/hour.

### Rebalance Parameters (Optimized Feb 2026)
- `DELTA_DRIFT_THRESHOLD_PERCENT=0.50` — 50% drift before rebalance (was 5%, way too aggressive)
- `MIN_REBALANCE_INTERVAL_MS=1800000` — 30 min cooldown between rebalances
- **No out-of-range timer** — LP repositioning triggers immediately when out of range (was 60 min, removed)
- Price stability check (`isPriceStable()`) is the only guard before repositioning — requires 3 observations + low velocity
- `RANGE_WIDTH_PERCENT=0.02` — ±2% concentrated range
- **Rebalancing is the biggest cost** — at 5% drift + 5min cooldown = $700+ slippage; at 50% drift + 30min = $8

### Raydium SDK Position Fields
- `PositionInfoLayout.fields`: bump, nftMint, poolId, tickLower, tickUpper, liquidity, feeGrowthInsideLastX64A, feeGrowthInsideLastX64B, **tokenFeesOwedA**, **tokenFeesOwedB**, rewardInfos
- `tokenFeesOwedA/B` = uncollected fees in the position (not yet harvested)
- SDK call: `raydium.clmm.getOwnerPositionInfo({ programId })` returns array of positions with these fields

### Flash Trade SDK Position Fields
- `position.account` fields: owner, delegate, market, openTime, updateTime, entryPrice, sizeAmount, sizeUsd, lockedAmount, lockedUsd, collateralAmount, collateralUsd, **unsettledValueUsd**, **unsettledFeesUsd**, **cumulativeLockFeeSnapshot**, referencePrice
- `unsettledFeesUsd` = accumulated funding fees (income for shorts)
- `cumulativeLockFeeSnapshot` = running total lock fee
- SDK call: `perpClient.program.account.position.all([{ memcmp: { offset: 8, bytes: wallet } }])`

## Cycle Data Schema (cycles.db)

The `data_collector.ts` records every 10s cycle to SQLite. Schema auto-migrates on startup.

| Column | Type | Description |
|---|---|---|
| timestamp | INTEGER | Epoch ms |
| tsla_price | REAL | Current TSLA price from Pyth |
| lp_delta | REAL | LP position USD exposure |
| hedge_delta | REAL | Hedge position USD exposure (negative for shorts) |
| net_delta | REAL | lp_delta + hedge_delta (should be ~0) |
| is_lp_in_range | INTEGER | 1 if LP position is within tick range |
| pool_apr | REAL | Raydium pool-wide APR (NOT position-specific) |
| pool_tvl | REAL | Pool total value locked |
| rebalance_triggered | INTEGER | 1 if rebalance was attempted |
| rebalance_reason | TEXT | drift / out_of_range_too_long / null |
| rebalance_size_usd | REAL | USD size of rebalance trade |
| gas_cost_usd | REAL | Actual SOL spent × $200 estimate |
| est_funding_cost_usd | REAL | Estimated per-cycle funding (legacy name — is income for shorts) |
| rebalance_slippage_cost_usd | REAL | Slippage on rebalance trades |
| reposition_event | INTEGER | 1 if LP was repositioned |
| lp_fees_usd | REAL | **CUMULATIVE** uncollected LP fees in USD (since last reposition) |
| lp_value_usd | REAL | Total LP position value in USD |
| hedge_funding_usd | REAL | **CUMULATIVE** funding income since position open (shorts earn this) |
| hedge_cum_lock_fee | REAL | Flash Trade cumulativeLockFeeSnapshot (raw on-chain value) |
| hedge_funding_delta_usd | REAL | Per-cycle funding increment (use `SUM()` for daily totals) |
| lp_fees_delta_usd | REAL | Per-cycle LP fee increment (use `SUM()` for daily totals) |
| reposition_il_usd | REAL | IL realized at this reposition event (0 on non-reposition cycles) |
| cumulative_il_usd | REAL | Running total of IL since strategy start |
| swap_slippage_bps | REAL | Realized slippage on reposition swap (0 on non-swap cycles) |
| swap_expected_usd | REAL | Expected swap output in USD (from Jupiter quote) |
| swap_actual_usd | REAL | Actual swap output in USD (from on-chain balance diff) |

### Data Analysis Gotchas
- **First 5 days (pre-Jan 26)** have 0% APR — tracking wasn't deployed yet, filter these out
- **Observations only during market hours** (~18% of calendar time) — LP earns 24/7 on-chain
- **Off-hours fee estimation**: Use ~3% APR as conservative off-hours estimate
- **Time gaps**: Median gap is 10s, but weekends create 65+ hour gaps
- When analyzing: handle gaps >30s specially (split into on-hours actual APR + off-hours estimated APR)
- **`hedge_funding_usd` and `lp_fees_usd` are CUMULATIVE** — they grow monotonically. The same ~$0.39 appears every cycle because it's total-since-open. Use `*_delta_usd` columns for per-cycle increments.
- **Daily funding**: `SELECT SUM(hedge_funding_delta_usd) FROM cycles WHERE timestamp > <start_of_day>`
- **Daily LP fees**: `SELECT SUM(lp_fees_delta_usd) FROM cycles WHERE timestamp > <start_of_day>`
- **First cycle after restart** has delta=0 (no previous value to diff against) — this is correct, not missing data

## Recovery Flows

The orchestrator has three recovery mechanisms, tried in order of severity:

1. **`repositionLP()`** — Close LP → reopen at current price. Used when LP drifts out of range. Price stability check prevents repositioning during volatile moves.
2. **`recoverStuckPosition()`** — Close LP → swap TSLAx to USDC → consolidate → re-bootstrap. Used when LP is out of range AND no hedge exists.
3. **`fullPositionReset()`** — Close hedge (frees USDC collateral) → chain into `recoverStuckPosition()`. Used when LP is out of range AND hedge exists but can't be adjusted.

Bootstrap allocates ALL USDC to LP first, then re-reads wallet balance and uses remainder for hedge collateral. This avoids underallocating LP to reserve collateral that may not be needed.

## Lessons Learned (Mistakes to Avoid)

### 1. CLMM tick calculation MUST use raw pool price, NOT decimal-adjusted price (ROOT CAUSE: 25 days 0% APY)
The `calculateRangeTicks()` function used `getCurrentPrice()` which returns the decimal-adjusted price ($410 for TSLA). But CLMM ticks encode RAW pool prices derived from `sqrtPriceX64`. For the TSLAx(8 dec)/USDC(6 dec) pool, raw price ≈ 4.1 (not 410). Using $410 produced tick ~60169 when the pool tick was ~14112. **The LP was always placed 46,000 ticks away from the pool — permanently out of range for 25 days.**

**Fix**: Compute ticks from `sqrtPriceX64` directly:
```typescript
const sqrtPrice = Number(poolInfo.sqrtPriceX64) / Math.pow(2, 64);
const rawPrice = sqrtPrice * sqrtPrice;
const lowerTick = Math.floor(Math.log(rawPrice * (1 - rangePercent)) / Math.log(1.0001) / tickSpacing) * tickSpacing;
```

**Rule**: Never use `getCurrentPrice()` for tick math. Always derive from `sqrtPriceX64`. The decimal adjustment (×100 for 8-6 decimal difference) is for human-readable prices only.

### 2. `getSignatureStatus` lies — use `confirmTransaction` for on-chain verification
`getSignatureStatus` can return `{value: null}` before the transaction is confirmed. Our code checked `if (!status.value?.err)` which passed for null (no error = no status = "success"). Every LP open was failing on-chain with error 6021 (PriceSlippageCheck) but the bot thought they succeeded.

**Fix**: Use `confirmTransaction` which blocks until the transaction is finalized:
```typescript
const latestBlockhash = await connection.getLatestBlockhash();
const confirmation = await connection.confirmTransaction({
    signature: txId,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
}, 'confirmed');
if (confirmation.value.err) throw new Error('TX failed on-chain');
```

**Rule**: ALWAYS use `confirmTransaction` after submitting any on-chain transaction. Never trust `getSignatureStatus` for success verification.

### 3. Raydium CLMM PriceSlippageCheck (error 6021) — SDK simulation ≠ on-chain success
The Raydium SDK simulates transactions locally and returns estimated token amounts. But between simulation and on-chain execution, the price can move. If `otherAmountMax` is too tight, the on-chain check fails with error 6021: `PriceSlippageCheck`.

**Fix**: Add 5% slippage buffer to `otherAmountMax`:
```typescript
const otherAmountMaxBN = new BN(amountB.toString()).muln(105).divn(100);
```

**Rule**: Always add slippage buffers to on-chain token amount parameters. SDK simulation amounts are estimates, not guarantees.

### 4. Flash Trade TSLAr oracle returns 0 — always pass Pyth fallback price
The Flash Trade oracle for TSLAr consistently returns price 0. All Flash Trade operations (openShort, closePosition, increasePosition) fail silently or with `oracle_price_zero` when no fallback is provided.

**Fix**: Pass `currentPrice` (from Pyth) as fallback to EVERY Flash Trade call:
```typescript
await flashTradeClient.openShortPosition(size, collateral, slippage, currentPrice);
await flashTradeClient.closePosition(slippage, currentPrice);
```

**Rule**: Never call Flash Trade without a Pyth fallback price. The native oracle may return 0 at any time.

### 5. Bootstrap guard — set `hasBootstrapped` after LP, not after LP+hedge
When `hasBootstrapped` was only set after both LP AND hedge succeeded, a hedge failure caused the bootstrap to re-trigger every cycle (10s). Each cycle opened a NEW orphaned LP position. Within minutes, the wallet had multiple duplicate LPs draining capital.

**Fix**: Set `hasBootstrapped = true` immediately after LP opens successfully, before attempting the hedge. If the hedge fails, the next cycle will detect LP-exists-but-no-hedge and try only the hedge.

### 6. Don't reserve collateral before LP opens — allocate sequentially
Original flow: Split USDC 50/50 between LP and hedge collateral. Problem: LP might need more or less than 50%, and pre-reserving hedge collateral means LP is underfunded.

**Fix**: Pass ALL available USDC to LP open. After LP opens, re-read wallet balance — whatever USDC remains (the LP didn't consume) becomes hedge collateral. This naturally adapts to the actual token ratio the pool requires.

### 7. `estimateWithdrawalComposition` must apply decimal adjustment to tick-derived prices
Ticks encode raw pool prices (e.g., 4.1), but withdrawal composition math needs human-readable prices to compute USD values. When computing LP position value from tick ranges:
```typescript
const lowerPrice = Math.pow(1.0001, position.lowerTick) * 100; // ×100 for 8-6 decimal diff
const upperPrice = Math.pow(1.0001, position.upperTick) * 100;
```

### 8. Transaction failures are silent without proper confirmation
On Solana, submitting a transaction returns a signature immediately — this does NOT mean the transaction succeeded. The transaction can fail during execution (insufficient funds, slippage check, invalid arguments) and `sendTransaction` will still return a valid signature. You MUST confirm the transaction and check for errors.

### 9. Don't use timers when simpler guards exist
The 60-min out-of-range timer was intended to prevent thrashing but just delayed recovery. The `isPriceStable()` check (3 observations + low velocity) is a better guard — it prevents repositioning during volatile moves while allowing immediate recovery once price stabilizes. Removing the timer eliminated a class of "stuck bot" failures.

### 10. Full reset is necessary when capital is fragmented
When the bot has an undersized hedge AND out-of-range LP, it can't increase the hedge (no free USDC for collateral) and can't reposition LP (hedge size doesn't match). The only way out is to close BOTH positions, consolidate all capital, and re-bootstrap from scratch. This is the `fullPositionReset()` pattern: close hedge → close LP → swap excess TSLAx → re-bootstrap.

### 11. RPC failures must skip the cycle, never assume empty positions
If `fetchPositions()` throws (RPC timeout, network error), the bot was continuing with `lpPositions = []` — which triggers bootstrap, creating duplicate positions. Fix: catch the error and `return` (skip the cycle). Distinguish "fetch failed" (`null`) from "no positions exist" (`[]`).

### 12. Always calculate and check liquidation price
The bot was running for weeks with `liquidationPrice: 0` hardcoded. The `checkLiquidationRisk()` function existed but was never called. A 20%+ TSLA move would liquidate the hedge with zero warning. Fix: Calculate from `entryPrice * (1 + collateral/size)` for shorts, and call `checkLiquidationRisk()` every cycle.

### 13. Validate Pyth price freshness before using
If the Pyth feed goes stale (market disruption, feed outage), the bot operates on minutes-old prices for all decisions — rebalancing, bootstrap sizing, recovery. Fix: Check `Date.now() - pythPublishTime > 60s` and skip the cycle if stale. Configured via `PYTH_MAX_STALENESS_MS`.

### 14. Add circuit breakers to recovery loops
Recovery/fullReset had no max retry limit. A persistent failure (Flash Trade down, RPC down) caused infinite recovery attempts, each burning gas. Fix: Track `recoveryAttempts`, enter ERROR_RECOVERY after `MAX_RECOVERY_ATTEMPTS` (default 3), reset on success.

### 15. Never hardcode asset prices — always fetch dynamically
SOL price was hardcoded at `$200` for collateral swap calculations. If SOL dropped to $100, the bot would swap 2x the necessary amount. Fix: Use `jupiterClient.getPrice(SOL, USDC)` with $200 fallback.

### 16. Don't burn RPC calls when data will always be stale
The bot was making ~360 wasted RPC calls/hour after market close (Pyth fetch + SOL balance check every 10s), only to immediately bail on the Pyth staleness check. Fix: Early return from `runCycle()` when `!isUSMarketOpen()`, and slow the loop interval to 60s. During NYSE hours (9:30 AM - 4 PM ET) the full 10s cadence resumes.

### 17. Distinguish cumulative vs per-cycle values in cycle data
`hedge_funding_usd` and `lp_fees_usd` are **cumulative since position open** (or last reposition for LP fees). Recording $0.39 cumulative on every 10s cycle makes it look like $0.39/cycle = $3,369/day on a $2.34 short (144,000% APY — obviously wrong). The actual daily growth was $0.000056. Fix: Added `hedge_funding_delta_usd` and `lp_fees_delta_usd` columns that track the per-cycle increment. Use `SUM(delta)` for daily totals. The cumulative columns are still useful — they're monotonically increasing and robust against rounding errors.

### 18. Impermanent loss is the dominant cost in delta-neutral CLMM — always model it
The backtest originally showed ±1% at 495% APY and ±2% at 151% APY — but these numbers excluded impermanent loss entirely. With IL: ±1% drops to 44% APY, ±2% drops to -3.4% APY (a loss!). IL consumed 69% of ±1% gross fees and 99% of ±2% gross fees. For a delta-hedged LP, directional price moves cancel (that's the hedge), but IL remains as the residual gamma cost. When out of range, tracking error from unmatched hedge exposure adds to IL. Formula: `il_fraction = -(2√r - r - 1) / w` where r = price_ratio, w = range_width. When out of range, add `|r - r_edge|/2`. At ±1%, average IL per reposition was $26 (0.38% of LP value), not the theoretical $17 at edge — because price often moves beyond the edge before repositioning completes. Always model IL before making range width decisions.

### 19. Always stress-test with zero/negative funding and 2x slippage
The backtest's headline 44% APY at ±1% assumes 6bps/day funding income and 30bps slippage. But funding rates can flip negative in bear markets (shorts pay instead of earn), and slippage doubles during high-vol events. Stress scenarios: zero funding = 28.3% APY (still profitable!); negative funding (-3bps/day) = 21.1% APY; double slippage (60bps) = 0.6% APY (barely break-even); full stress (0 fund + 60bps + $1 gas) = -12.9% APY (loss). Key finding: ±1% is profitable even with zero funding — fee income alone covers IL. The biggest risk is slippage, not funding. ±0.5% survives full stress at 103% APY. Real-time IL tracking via `reposition_il_usd` and `cumulative_il_usd` in cycles.db computes actual IL vs fee income per day.

### 20. Jupiter swap `outAmount` is an estimate — always measure actual token received
The convenience methods (`swapUsdcToTslax`, etc.) returned `quote.outAmount` as the output amount, but this is the pre-execution estimate from the route planner. The actual on-chain amount differs due to price movement between quote and execution, MEV/sandwich attacks, and route execution variance. Fix: Query output token ATA balance before and after `confirmTransaction`, compute `actualOutput = postBalance - preBalance`. This also means downstream code using the swap result (like `tslaxBalance += BigInt(swapResult.tslaxAmount)` in repositionLP) now uses real amounts instead of estimates. Track `swap_slippage_bps` in cycles.db to monitor if slippage exceeds the 30bps assumption used in the backtest. For TSLAx output (8 decimals), convert to USD via `amount / 1e8 * currentPrice`. For USDC output (6 decimals), convert via `amount / 1e6`. Token-2022 (TSLAx) requires `TOKEN_2022_PROGRAM_ID` for ATA resolution.

## Working Protocol

- **Plan first, execute after approval** — propose approach before making changes
- **Evidence over claims** — show logs/output, don't just say "it works"
- **Use actual data** — never use estimates/medians when real per-observation data is available
- **Verify decimals** — wrong decimal scaling silently produces garbage values
- **Test compile before deploy** — `npx tsc --noEmit` must pass
- **Deploy command**: `git pull && npx tsc && pm2 restart tsla-neutral` on spirit-worker
- **Always confirm on-chain** — never trust `sendTransaction` return value alone; use `confirmTransaction`
- **Check tick math against pool state** — log expected ticks AND current pool tick, verify they're in the same range

## Environment Variables

Secrets live in `.env` on the VM (never commit). Key vars:
- `SOLANA_RPC_URL` — Helius/Triton RPC endpoint
- `WALLET_PRIVATE_KEY` — Bot wallet (base58)
- `RANGE_WIDTH_PERCENT` — LP range width (0.01 = ±1%, deployed Feb 2026)
- `DELTA_DRIFT_THRESHOLD_PERCENT` — Drift before rebalance (0.50 = 50%)
- `MIN_REBALANCE_INTERVAL_MS` — Cooldown between rebalances (1800000 = 30min)
- `AUTO_BOOTSTRAP` — Auto-create positions on startup (true/false)
- `DRY_RUN` — Simulate without real trades (true/false)
- `LOOP_INTERVAL_MS` — Cycle interval (10000 = 10s)
- `FUNDING_RATE_SPIKE_THRESHOLD` — Hourly funding rate for alerts (0.001 = 0.1%/hr)
- `GAS_TOP_UP_THRESHOLD_SOL` — Min SOL before auto top-up (default: 0.015)
- `MAX_RECOVERY_ATTEMPTS` — Circuit breaker after N failed recoveries (default: 3)
- `PYTH_MAX_STALENESS_MS` — Reject Pyth prices older than this (default: 60000 = 60s)
- `MIN_REBALANCE_SIZE_USD` — Minimum USD size for hedge adjustment (default: 1)
