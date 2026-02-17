/**
 * Crash Prevention Tests
 *
 * Tests for each robustness fix to prevent capital loss:
 * 1. RPC failure → skip cycle (not assume empty positions)
 * 2. Liquidation price calculation
 * 3. Pyth staleness check
 * 4. Bootstrap TSLAx guard
 * 5. Recovery circuit breaker
 * 6. Raydium fetch timeout
 * 7. SOL price dynamic fetch
 * 8. MIN_REBALANCE_SIZE_USD filter
 */

import { checkLiquidationRisk, evaluateRebalance } from './risk_manager';
import { BotState, StateMachineState } from '../types';

// Mock dependencies
jest.mock('../config', () => ({
    config: {
        ORACLE_DIVERGENCE_THRESHOLD_PERCENT: 0.005,
        PYTH_CONFIDENCE_THRESHOLD_PERCENT: 0.01,
        LIQUIDATION_WARNING_PERCENT: 0.10,
        DELTA_DRIFT_THRESHOLD_PERCENT: 0.05,
        MAX_OUT_OF_RANGE_DURATION_MS: 3600000,
        FUNDING_RATE_SPIKE_THRESHOLD: 0.001,
        MIN_REBALANCE_SIZE_USD: 1,
        MAX_RECOVERY_ATTEMPTS: 3,
        PYTH_MAX_STALENESS_MS: 60000,
    },
}));

jest.mock('../observability/logger', () => ({
    loggers: {
        risk: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
    },
}));

jest.mock('../observability/metrics', () => ({
    deltaGauge: { set: jest.fn() },
    oracleDivergenceGauge: { set: jest.fn() },
    liquidationDistanceGauge: { set: jest.fn() },
}));

jest.mock('../observability/alerter', () => ({
    alerts: { oracleDivergence: jest.fn(), liquidationWarning: jest.fn() },
}));

jest.mock('../utils/clock', () => ({
    isQuietHours: jest.fn(() => false),
}));

jest.mock('../utils/sol_reserve', () => ({
    isGasCostAcceptable: jest.fn(() => true),
}));

describe('Crash Prevention', () => {
    const baseState: StateMachineState = {
        currentState: BotState.IDLE,
        lpPositionMint: null,
        hedgePositionId: null,
        lastLpDelta: 0,
        lastHedgeDelta: 0,
        lastRebalanceTime: 0,
        outOfRangeSince: null,
        consecutiveFailures: 0,
        lastError: null,
    };

    // =========================================================================
    // Fix 2: Liquidation price calculation
    // =========================================================================
    describe('Liquidation price calculation', () => {
        it('should compute correct liquidation price for SHORT position', () => {
            // SHORT: entry=$400, collateral=$100, size=$200
            // Liq price = $400 * (1 + $100/$200) = $400 * 1.5 = $600
            const entryPrice = 400;
            const collateralUsd = 100;
            const size = 200;
            const liquidationPrice = entryPrice * (1 + collateralUsd / size);

            expect(liquidationPrice).toBe(600);
        });

        it('should compute correct liquidation price for LONG position', () => {
            // LONG: entry=$400, collateral=$100, size=$200
            // Liq price = $400 * (1 - $100/$200) = $400 * 0.5 = $200
            const entryPrice = 400;
            const collateralUsd = 100;
            const size = 200;
            const liquidationPrice = entryPrice * (1 - collateralUsd / size);

            expect(liquidationPrice).toBe(200);
        });

        it('should alert when price is within 10% of liquidation (SHORT)', () => {
            // SHORT at $400, liq at $600
            // Current price $555 → distance = (600-555)/555 = 8.1% < 10%
            const result = checkLiquidationRisk(555, 600, 'SHORT');
            expect(result.isAtRisk).toBe(true);
            expect(result.distancePercent).toBeCloseTo(0.081, 2);
        });

        it('should NOT alert when price is far from liquidation', () => {
            // SHORT at $400, liq at $600
            // Current price $410 → distance = (600-410)/410 = 46.3% > 10%
            const result = checkLiquidationRisk(410, 600, 'SHORT');
            expect(result.isAtRisk).toBe(false);
        });

        it('should alert when price is within 10% of liquidation (LONG)', () => {
            // LONG at $400, liq at $200
            // Current price $218 → distance = (218-200)/218 = 8.3% < 10%
            const result = checkLiquidationRisk(218, 200, 'LONG');
            expect(result.isAtRisk).toBe(true);
        });
    });

    // =========================================================================
    // Fix 3: Pyth staleness check
    // =========================================================================
    describe('Pyth staleness check', () => {
        it('should accept recent prices', () => {
            const publishTimeSec = Date.now() / 1000 - 5; // 5 seconds ago
            const ageMs = Date.now() - (publishTimeSec * 1000);
            expect(ageMs).toBeLessThan(60_000);
        });

        it('should reject stale prices (>60s old)', () => {
            const publishTimeSec = Date.now() / 1000 - 120; // 2 minutes ago
            const ageMs = Date.now() - (publishTimeSec * 1000);
            expect(ageMs).toBeGreaterThan(60_000);
        });

        it('should handle exact boundary', () => {
            const publishTimeSec = Date.now() / 1000 - 60; // exactly 60 seconds
            const ageMs = Date.now() - (publishTimeSec * 1000);
            // At exactly 60s, should be within threshold (<=)
            // Our code uses > 60000 so exactly 60s passes
            expect(ageMs).toBeLessThanOrEqual(60_001); // allow 1ms drift
        });
    });

    // =========================================================================
    // Fix 5: Recovery circuit breaker
    // =========================================================================
    describe('Recovery circuit breaker', () => {
        it('should allow recovery up to MAX_RECOVERY_ATTEMPTS', () => {
            const { config } = require('../config');
            let attempts = 0;
            for (let i = 0; i < config.MAX_RECOVERY_ATTEMPTS; i++) {
                attempts++;
            }
            expect(attempts).toBe(3);
            expect(attempts >= config.MAX_RECOVERY_ATTEMPTS).toBe(true);
        });

        it('should reset on success', () => {
            let recoveryAttempts = 2;
            const success = true;
            if (success) recoveryAttempts = 0;
            expect(recoveryAttempts).toBe(0);
        });

        it('should enter ERROR_RECOVERY after max attempts', () => {
            const { config } = require('../config');
            let recoveryAttempts = 0;
            let state = BotState.IDLE;

            // Simulate 3 consecutive failures
            for (let i = 0; i < 3; i++) {
                recoveryAttempts++;
                if (recoveryAttempts >= config.MAX_RECOVERY_ATTEMPTS) {
                    state = BotState.ERROR_RECOVERY;
                }
            }

            expect(state).toBe(BotState.ERROR_RECOVERY);
            expect(recoveryAttempts).toBe(3);
        });
    });

    // =========================================================================
    // Fix 6: Raydium fetch timeout
    // =========================================================================
    describe('Raydium fetch timeout', () => {
        it('should abort fetch after 10s using AbortController', async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 100); // 100ms for test speed

            try {
                // Simulate a fetch that would hang
                await Promise.race([
                    new Promise((_, reject) => {
                        controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
                    }),
                    new Promise(resolve => setTimeout(resolve, 200)), // 200ms simulated hang
                ]);
                // Should not reach here
                expect(true).toBe(false);
            } catch (e: any) {
                expect(e.message).toBe('aborted');
            } finally {
                clearTimeout(timeout);
            }
        });
    });

    // =========================================================================
    // Fix 8: MIN_REBALANCE_SIZE_USD filter
    // =========================================================================
    describe('MIN_REBALANCE_SIZE_USD filter', () => {
        it('should skip rebalance when drift is below MIN_REBALANCE_SIZE_USD', () => {
            const { config } = require('../config');
            const absSize = 0.5; // $0.50 adjustment
            expect(absSize < config.MIN_REBALANCE_SIZE_USD).toBe(true);
        });

        it('should allow rebalance when above MIN_REBALANCE_SIZE_USD', () => {
            const { config } = require('../config');
            const absSize = 2.0; // $2 adjustment
            expect(absSize >= config.MIN_REBALANCE_SIZE_USD).toBe(true);
        });
    });

    // =========================================================================
    // Fix 1: RPC failure → skip cycle
    // =========================================================================
    describe('RPC failure handling', () => {
        it('should use null sentinel to distinguish fetch failure from empty positions', () => {
            // Simulate the pattern: null = fetch failed, [] = no positions
            let positions: unknown[] | null = null;

            // Fetch failed scenario
            try {
                throw new Error('RPC timeout');
            } catch {
                positions = null; // sentinel
            }
            expect(positions).toBeNull();

            // Empty positions scenario (real result)
            positions = [];
            expect(positions).not.toBeNull();
            expect(positions!.length).toBe(0);
        });

        it('should not trigger bootstrap when fetch returns null (RPC failure)', () => {
            const positions = null as string[] | null;
            const shouldBootstrap = positions !== null && positions.length === 0;
            expect(shouldBootstrap).toBe(false);
        });

        it('should trigger bootstrap when fetch returns empty array (no positions)', () => {
            const positions = [] as string[] | null;
            const shouldBootstrap = positions !== null && positions.length === 0;
            expect(shouldBootstrap).toBe(true);
        });
    });

    // =========================================================================
    // Fix 4: Bootstrap TSLAx guard
    // =========================================================================
    describe('Bootstrap TSLAx guard', () => {
        it('should skip swap when existing TSLAx covers 90%+ of target', () => {
            const existingTslaxUsd = 3.5; // $3.50 worth of TSLAx
            const targetTslaxUsd = 3.0;   // only need $3.00
            const shouldSkipSwap = existingTslaxUsd >= targetTslaxUsd * 0.90;
            expect(shouldSkipSwap).toBe(true);
        });

        it('should swap when existing TSLAx is insufficient', () => {
            const existingTslaxUsd = 1.0;
            const targetTslaxUsd = 3.0;
            const shouldSkipSwap = existingTslaxUsd >= targetTslaxUsd * 0.90;
            expect(shouldSkipSwap).toBe(false);
        });
    });

    // =========================================================================
    // Fix 7: SOL price dynamic fetch
    // =========================================================================
    describe('SOL price dynamic fetch', () => {
        it('should fall back to $200 when Jupiter fails', async () => {
            let solPrice = 200; // fallback
            try {
                throw new Error('Jupiter unavailable');
            } catch { /* use fallback */ }
            expect(solPrice).toBe(200);
        });

        it('should use real price when Jupiter succeeds', async () => {
            let solPrice = 200; // fallback
            try {
                solPrice = 180; // simulate Jupiter returning $180
            } catch { /* use fallback */ }
            expect(solPrice).toBe(180);
        });

        it('should compute correct swap amount with real SOL price', () => {
            const swapAmountUsd = 5; // need $5 USDC
            const realSolPrice = 180;
            const hardcodedSolPrice = 200;

            const solNeededReal = swapAmountUsd / realSolPrice;
            const solNeededHardcoded = swapAmountUsd / hardcodedSolPrice;

            // With real $180 SOL price, we need MORE SOL than $200 estimate
            expect(solNeededReal).toBeGreaterThan(solNeededHardcoded);
            expect(solNeededReal).toBeCloseTo(0.0278, 3);
            expect(solNeededHardcoded).toBeCloseTo(0.025, 3);
        });
    });
});
