import {
    calculateNetDelta,
    checkOracleDivergence,
    checkPythConfidence,
    checkLiquidationRisk,
    evaluateRebalance,
    checkFundingRateSpike,
} from './risk_manager';
import { BotState, PriceData, StateMachineState } from '../types';

// Mock the config
jest.mock('../config', () => ({
    config: {
        ORACLE_DIVERGENCE_THRESHOLD_PERCENT: 0.005, // 0.5%
        PYTH_CONFIDENCE_THRESHOLD_PERCENT: 0.01, // 1%
        LIQUIDATION_WARNING_PERCENT: 0.10, // 10%
        DELTA_DRIFT_THRESHOLD_PERCENT: 0.05, // 5%
        MAX_OUT_OF_RANGE_DURATION_MS: 3600000, // 1 hour
        FUNDING_RATE_SPIKE_THRESHOLD: 0.001, // 0.1%
    },
}));

// Mock observability
jest.mock('../observability/logger', () => ({
    loggers: {
        risk: {
            warn: jest.fn(),
            error: jest.fn(),
            info: jest.fn(),
            debug: jest.fn(),
        },
    },
}));

jest.mock('../observability/metrics', () => ({
    deltaGauge: { set: jest.fn() },
    oracleDivergenceGauge: { set: jest.fn() },
    liquidationDistanceGauge: { set: jest.fn() },
}));

jest.mock('../observability/alerter', () => ({
    alerts: {
        oracleDivergence: jest.fn(),
        liquidationWarning: jest.fn(),
    },
}));

jest.mock('../utils/clock', () => ({
    isQuietHours: jest.fn(() => false),
}));

jest.mock('../utils/sol_reserve', () => ({
    isGasCostAcceptable: jest.fn(() => true),
}));

describe('Risk Manager', () => {
    describe('calculateNetDelta', () => {
        it('should sum LP and hedge deltas', () => {
            expect(calculateNetDelta(1000, -1000)).toBe(0);
            expect(calculateNetDelta(1000, -900)).toBe(100);
            expect(calculateNetDelta(1000, -1100)).toBe(-100);
        });

        it('should handle zero deltas', () => {
            expect(calculateNetDelta(0, 0)).toBe(0);
            expect(calculateNetDelta(1000, 0)).toBe(1000);
            expect(calculateNetDelta(0, -500)).toBe(-500);
        });
    });

    describe('checkOracleDivergence', () => {
        it('should detect dangerous divergence', () => {
            const priceData: PriceData = {
                poolPrice: 100,
                pythPrice: 101,
                pythConfidence: 0.5,
                pythPublishTime: Date.now(),
                markPrice: 100.5,
                oraclePrice: 101,
                divergencePercent: 0.01, // 1% > 0.5% threshold
            };

            const result = checkOracleDivergence(priceData);
            expect(result.isDangerous).toBe(true);
            expect(result.divergencePercent).toBe(0.01);
        });

        it('should allow minor divergence', () => {
            const priceData: PriceData = {
                poolPrice: 100,
                pythPrice: 100.2,
                pythConfidence: 0.5,
                pythPublishTime: Date.now(),
                markPrice: 100.1,
                oraclePrice: 100.2,
                divergencePercent: 0.002, // 0.2% < 0.5% threshold
            };

            const result = checkOracleDivergence(priceData);
            expect(result.isDangerous).toBe(false);
        });
    });

    describe('checkPythConfidence', () => {
        it('should accept tight confidence intervals', () => {
            const priceData: PriceData = {
                poolPrice: 100,
                pythPrice: 100,
                pythConfidence: 0.5, // 0.5% of price
                pythPublishTime: Date.now(),
                markPrice: 100,
                oraclePrice: 100,
                divergencePercent: 0,
            };

            expect(checkPythConfidence(priceData)).toBe(true);
        });

        it('should reject wide confidence intervals', () => {
            const priceData: PriceData = {
                poolPrice: 100,
                pythPrice: 100,
                pythConfidence: 2, // 2% of price > 1% threshold
                pythPublishTime: Date.now(),
                markPrice: 100,
                oraclePrice: 100,
                divergencePercent: 0,
            };

            expect(checkPythConfidence(priceData)).toBe(false);
        });
    });

    describe('checkLiquidationRisk', () => {
        it('should detect risk for short when price approaches liquidation', () => {
            const result = checkLiquidationRisk(100, 108, 'SHORT');
            // Distance = (108 - 100) / 100 = 8% < 10% threshold
            expect(result.isAtRisk).toBe(true);
            expect(result.distancePercent).toBeCloseTo(0.08);
        });

        it('should not alert when far from liquidation', () => {
            const result = checkLiquidationRisk(100, 150, 'SHORT');
            // Distance = 50% > 10% threshold
            expect(result.isAtRisk).toBe(false);
        });

        it('should handle long positions correctly', () => {
            const result = checkLiquidationRisk(100, 92, 'LONG');
            // Distance = (100 - 92) / 100 = 8% < 10% threshold
            expect(result.isAtRisk).toBe(true);
        });
    });

    describe('evaluateRebalance', () => {
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

        it('should not rebalance when delta is within threshold', () => {
            const decision = evaluateRebalance(baseState, 1000, -1000, 0, true);
            expect(decision.shouldRebalance).toBe(false);
            expect(decision.reason).toBe('within_threshold');
        });

        it('should rebalance when delta drift exceeds threshold', () => {
            // LP = 1000, Hedge = -900, Net = 100 (10% drift)
            const decision = evaluateRebalance(baseState, 1000, -900, 0, true);
            expect(decision.shouldRebalance).toBe(true);
            expect(decision.reason).toBe('delta_drift');
        });

        it('should block rebalance when state is not IDLE', () => {
            const nonIdleState = { ...baseState, currentState: BotState.REBALANCING };
            const decision = evaluateRebalance(nonIdleState, 1000, -500, 0, true);
            expect(decision.shouldRebalance).toBe(false);
            expect(decision.blocked).toBe(true);
            expect(decision.blockReason).toContain('REBALANCING');
        });
    });

    describe('checkFundingRateSpike', () => {
        it('should detect spike against short position', () => {
            // Negative funding = shorts pay longs
            expect(checkFundingRateSpike(-0.002, 'SHORT')).toBe(true);
        });

        it('should not alert for favorable funding', () => {
            // Positive funding = longs pay shorts (good for shorts)
            expect(checkFundingRateSpike(0.002, 'SHORT')).toBe(false);
        });

        it('should detect spike against long position', () => {
            expect(checkFundingRateSpike(0.002, 'LONG')).toBe(true);
        });

        it('should not alert for small funding rates', () => {
            expect(checkFundingRateSpike(-0.0005, 'SHORT')).toBe(false);
        });
    });
});
