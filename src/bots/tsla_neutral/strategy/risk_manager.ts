import { config } from '../config';
import { PriceData, RebalanceDecision, StateMachineState, BotState } from '../types';
import { loggers } from '../observability/logger';
import { deltaGauge, oracleDivergenceGauge, liquidationDistanceGauge } from '../observability/metrics';
import { alerts } from '../observability/alerter';
import { isQuietHours } from '../utils/clock';
import { isGasCostAcceptable } from '../utils/sol_reserve';

const log = loggers.risk;

/**
 * Calculate net delta from LP and hedge positions.
 */
export function calculateNetDelta(lpDelta: number, hedgeDelta: number): number {
    // LP gives us positive delta (long exposure)
    // Short hedge gives us negative delta
    return lpDelta + hedgeDelta;
}

/**
 * Check if oracle prices are diverging dangerously.
 */
export function checkOracleDivergence(priceData: PriceData): {
    isDangerous: boolean;
    divergencePercent: number;
} {
    const divergencePercent = priceData.divergencePercent;
    const isDangerous = Math.abs(divergencePercent) > config.ORACLE_DIVERGENCE_THRESHOLD_PERCENT;

    oracleDivergenceGauge.set(divergencePercent * 100);

    if (isDangerous) {
        log.warn({
            event: 'oracle_divergence',
            poolPrice: priceData.poolPrice,
            pythPrice: priceData.pythPrice,
            divergencePercent: divergencePercent * 100,
        });
        alerts.oracleDivergence(divergencePercent);
    }

    return { isDangerous, divergencePercent };
}

/**
 * Check if Pyth confidence interval is acceptable.
 */
export function checkPythConfidence(priceData: PriceData): boolean {
    const confidencePercent = priceData.pythConfidence / priceData.pythPrice;
    const isAcceptable = confidencePercent <= config.PYTH_CONFIDENCE_THRESHOLD_PERCENT;

    if (!isAcceptable) {
        log.warn({
            event: 'pyth_confidence_wide',
            price: priceData.pythPrice,
            confidence: priceData.pythConfidence,
            confidencePercent: confidencePercent * 100,
        });
    }

    return isAcceptable;
}

/**
 * Check distance to liquidation.
 */
export function checkLiquidationRisk(
    currentPrice: number,
    liquidationPrice: number,
    positionSide: 'SHORT' | 'LONG'
): { isAtRisk: boolean; distancePercent: number } {
    let distancePercent: number;

    if (positionSide === 'SHORT') {
        // For short, liquidation happens when price goes UP
        distancePercent = (liquidationPrice - currentPrice) / currentPrice;
    } else {
        // For long, liquidation happens when price goes DOWN
        distancePercent = (currentPrice - liquidationPrice) / currentPrice;
    }

    const isAtRisk = distancePercent <= config.LIQUIDATION_WARNING_PERCENT;

    liquidationDistanceGauge.set(distancePercent * 100);

    if (isAtRisk) {
        log.error({
            event: 'liquidation_risk',
            currentPrice,
            liquidationPrice,
            distancePercent: distancePercent * 100,
            positionSide,
        });
        alerts.liquidationWarning(distancePercent, liquidationPrice, currentPrice);
    }

    return { isAtRisk, distancePercent };
}

/**
 * Determine if rebalancing is needed and allowed.
 */
export function evaluateRebalance(
    state: StateMachineState,
    lpDelta: number,
    hedgeDelta: number,
    estimatedGasCost: number,
    isLpInRange: boolean
): RebalanceDecision {
    const netDelta = calculateNetDelta(lpDelta, hedgeDelta);
    const driftPercent = Math.abs(netDelta) / Math.max(Math.abs(lpDelta), 1);

    deltaGauge.set(netDelta);

    // Check blocking conditions
    if (state.currentState !== BotState.IDLE) {
        return {
            shouldRebalance: false,
            reason: 'not_idle',
            currentDelta: netDelta,
            targetDelta: 0,
            sizeToAdjust: 0,
            estimatedSlippage: 0,
            estimatedGasCost,
            blocked: true,
            blockReason: `Current state is ${state.currentState}`,
        };
    }

    if (isQuietHours()) {
        return {
            shouldRebalance: false,
            reason: 'quiet_hours',
            currentDelta: netDelta,
            targetDelta: 0,
            sizeToAdjust: 0,
            estimatedSlippage: 0,
            estimatedGasCost,
            blocked: true,
            blockReason: 'Within quiet hours (market open volatility)',
        };
    }

    if (!isGasCostAcceptable(estimatedGasCost)) {
        return {
            shouldRebalance: false,
            reason: 'gas_too_high',
            currentDelta: netDelta,
            targetDelta: 0,
            sizeToAdjust: 0,
            estimatedSlippage: 0,
            estimatedGasCost,
            blocked: true,
            blockReason: `Gas cost ${estimatedGasCost} exceeds limit`,
        };
    }

    // Check if LP is out of range for too long
    if (!isLpInRange && state.outOfRangeSince) {
        const outOfRangeDuration = Date.now() - state.outOfRangeSince;
        if (outOfRangeDuration > config.MAX_OUT_OF_RANGE_DURATION_MS) {
            return {
                shouldRebalance: true,
                reason: 'out_of_range_too_long',
                currentDelta: netDelta,
                targetDelta: 0,
                sizeToAdjust: -hedgeDelta, // Close hedge to match 0 LP exposure
                estimatedSlippage: 0,
                estimatedGasCost,
                blocked: false,
            };
        }
    }

    // Check delta drift threshold
    if (driftPercent >= config.DELTA_DRIFT_THRESHOLD_PERCENT) {
        return {
            shouldRebalance: true,
            reason: 'delta_drift',
            currentDelta: netDelta,
            targetDelta: 0,
            sizeToAdjust: netDelta, // Positive netDelta = need short, negative = need to close short
            estimatedSlippage: 0,
            estimatedGasCost,
            blocked: false,
        };
    }

    return {
        shouldRebalance: false,
        reason: 'within_threshold',
        currentDelta: netDelta,
        targetDelta: 0,
        sizeToAdjust: 0,
        estimatedSlippage: 0,
        estimatedGasCost,
        blocked: false,
    };
}

/**
 * Check if funding rate is spiking against us.
 */
export function checkFundingRateSpike(fundingRate: number, positionSide: 'SHORT' | 'LONG'): boolean {
    // For short: negative funding = shorts pay longs = bad for us
    // For long: positive funding = longs pay shorts = bad for us
    const isAgainstUs =
        (positionSide === 'SHORT' && fundingRate < 0) || (positionSide === 'LONG' && fundingRate > 0);

    const isSpiking = Math.abs(fundingRate) > config.FUNDING_RATE_SPIKE_THRESHOLD;

    if (isAgainstUs && isSpiking) {
        log.warn({
            event: 'funding_rate_spike',
            fundingRate,
            positionSide,
            threshold: config.FUNDING_RATE_SPIKE_THRESHOLD,
        });
        return true;
    }

    return false;
}
