import { getRedisClient } from './infra/redis_client';
import { BotState, StateMachineState } from './types';
import { loggers } from './observability/logger';
import { stateGauge } from './observability/metrics';

const log = loggers.orchestrator;
const STATE_KEY = 'tsla_neutral:state';

// Map state to numeric value for Prometheus
const stateToNumber: Record<BotState, number> = {
    [BotState.IDLE]: 0,
    [BotState.OPENING_LP]: 1,
    [BotState.HEDGING]: 2,
    [BotState.REBALANCING]: 3,
    [BotState.CLOSING_LP]: 4,
    [BotState.CLOSING_HEDGE]: 5,
    [BotState.ERROR_RECOVERY]: 6,
    [BotState.SHUTTING_DOWN]: 7,
};

/**
 * Get default initial state.
 */
function getDefaultState(): StateMachineState {
    return {
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
}

/**
 * Load state from Redis.
 */
export async function loadState(): Promise<StateMachineState> {
    const redis = getRedisClient();
    const data = await redis.get(STATE_KEY);

    if (!data) {
        log.info({ event: 'state_init', msg: 'No existing state, using defaults' });
        return getDefaultState();
    }

    try {
        const state = JSON.parse(data) as StateMachineState;
        log.info({ event: 'state_loaded', state: state.currentState });
        stateGauge.set(stateToNumber[state.currentState]);
        return state;
    } catch (error) {
        log.error({ event: 'state_parse_error', error });
        return getDefaultState();
    }
}

/**
 * Save state to Redis.
 */
export async function saveState(state: StateMachineState): Promise<void> {
    const redis = getRedisClient();
    await redis.set(STATE_KEY, JSON.stringify(state));
    stateGauge.set(stateToNumber[state.currentState]);
}

/**
 * Transition to a new state.
 */
export async function transitionState(
    currentState: StateMachineState,
    newState: BotState,
    updates: Partial<StateMachineState> = {}
): Promise<StateMachineState> {
    const previousState = currentState.currentState;

    const updatedState: StateMachineState = {
        ...currentState,
        ...updates,
        currentState: newState,
    };

    await saveState(updatedState);

    log.info({
        event: 'state_transition',
        from: previousState,
        to: newState,
        updates: Object.keys(updates),
    });

    return updatedState;
}

/**
 * Record a failure and potentially enter error recovery.
 */
export async function recordFailure(
    currentState: StateMachineState,
    error: string
): Promise<StateMachineState> {
    const consecutiveFailures = currentState.consecutiveFailures + 1;

    if (consecutiveFailures >= 5) {
        return transitionState(currentState, BotState.ERROR_RECOVERY, {
            consecutiveFailures,
            lastError: error,
        });
    }

    return transitionState(currentState, currentState.currentState, {
        consecutiveFailures,
        lastError: error,
    });
}

/**
 * Record a success and reset failure counter.
 */
export async function recordSuccess(currentState: StateMachineState): Promise<StateMachineState> {
    if (currentState.consecutiveFailures === 0 && currentState.lastError === null) {
        return currentState;
    }

    return transitionState(currentState, currentState.currentState, {
        consecutiveFailures: 0,
        lastError: null,
    });
}

/**
 * Check if state allows operations.
 */
export function canOperate(state: StateMachineState): boolean {
    return (
        state.currentState !== BotState.ERROR_RECOVERY &&
        state.currentState !== BotState.SHUTTING_DOWN
    );
}

/**
 * Clear state (for testing/reset).
 */
export async function clearState(): Promise<void> {
    const redis = getRedisClient();
    await redis.del(STATE_KEY);
    log.info({ event: 'state_cleared' });
}
