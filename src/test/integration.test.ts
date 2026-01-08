/**
 * Integration test that verifies the full bot initialization flow.
 * This test mocks external dependencies (Redis, RPC) but tests the
 * real integration between modules.
 */

import { BotState } from '../bots/tsla_neutral/types';

// Mock all external dependencies
jest.mock('ioredis', () => {
    return jest.fn().mockImplementation(() => ({
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(1),
        ping: jest.fn().mockResolvedValue('PONG'),
        quit: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        eval: jest.fn().mockResolvedValue(1), // For distributed lock Lua scripts
    }));
});

jest.mock('@solana/web3.js', () => ({
    Connection: jest.fn().mockImplementation(() => ({
        getLatestBlockhash: jest.fn().mockResolvedValue({
            blockhash: 'test-blockhash',
            lastValidBlockHeight: 12345,
        }),
        getBalance: jest.fn().mockResolvedValue(1000000000), // 1 SOL
        getMultipleAccountsInfo: jest.fn().mockResolvedValue([]),
    })),
    PublicKey: jest.fn().mockImplementation((key) => ({ toBase58: () => key })),
    LAMPORTS_PER_SOL: 1000000000,
}));

// Import after mocking
import { getRedisClient, healthCheckRedis } from '../bots/tsla_neutral/infra/redis_client';
import { DistributedLock } from '../bots/tsla_neutral/infra/distributed_lock';
import { loadState, saveState, transitionState, clearState } from '../bots/tsla_neutral/state_machine';

describe('Integration: Bot Initialization', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Redis Connection', () => {
        it('should connect to Redis successfully', async () => {
            const healthy = await healthCheckRedis();
            expect(healthy).toBe(true);
        });

        it('should return singleton client', () => {
            const client1 = getRedisClient();
            const client2 = getRedisClient();
            expect(client1).toBe(client2);
        });
    });

    describe('State Machine', () => {
        it('should load default state when no existing state', async () => {
            const state = await loadState();
            expect(state.currentState).toBe(BotState.IDLE);
            expect(state.lpPositionMint).toBeNull();
            expect(state.consecutiveFailures).toBe(0);
        });

        it('should save and transition state', async () => {
            const initialState = await loadState();
            const newState = await transitionState(initialState, BotState.OPENING_LP, {
                lpPositionMint: 'test-mint',
            });

            expect(newState.currentState).toBe(BotState.OPENING_LP);
            expect(newState.lpPositionMint).toBe('test-mint');
        });

        it('should clear state', async () => {
            await clearState();
            // Should not throw
        });
    });

    describe('Distributed Lock', () => {
        it('should acquire lock successfully', async () => {
            const lock = new DistributedLock('test-lock');
            const acquired = await lock.acquire();
            expect(acquired).toBe(true);

            // Cleanup
            await lock.release();
        });

        it('should release lock', async () => {
            const lock = new DistributedLock('test-lock-2');
            await lock.acquire();
            const released = await lock.release();
            expect(released).toBe(true);
        });

        it('should report lock status', async () => {
            const lock = new DistributedLock('test-lock-3');
            const status = lock.getStatus();
            expect(status).toHaveProperty('lockKey');
            expect(status).toHaveProperty('lockValue');
            expect(status).toHaveProperty('isHeld');
        });
    });
});

describe('Integration: Full Cycle Simulation', () => {
    it('should simulate a complete dry-run cycle', async () => {
        // Load initial state
        const state = await loadState();
        expect(state.currentState).toBe(BotState.IDLE);

        // Simulate state transitions through a rebalance cycle
        let currentState = state;

        // Move to REBALANCING
        currentState = await transitionState(currentState, BotState.REBALANCING);
        expect(currentState.currentState).toBe(BotState.REBALANCING);

        // Complete rebalance, return to IDLE
        currentState = await transitionState(currentState, BotState.IDLE, {
            lastRebalanceTime: Date.now(),
        });
        expect(currentState.currentState).toBe(BotState.IDLE);
        expect(currentState.lastRebalanceTime).toBeGreaterThan(0);
    });

    it('should handle error recovery flow', async () => {
        let state = await loadState();

        // Simulate consecutive failures
        for (let i = 0; i < 5; i++) {
            state = await transitionState(state, state.currentState, {
                consecutiveFailures: state.consecutiveFailures + 1,
                lastError: `Error ${i + 1}`,
            });
        }

        expect(state.consecutiveFailures).toBe(5);
        expect(state.lastError).toBe('Error 5');

        // Transition to error recovery
        state = await transitionState(state, BotState.ERROR_RECOVERY);
        expect(state.currentState).toBe(BotState.ERROR_RECOVERY);

        // Recovery succeeds, back to IDLE
        state = await transitionState(state, BotState.IDLE, {
            consecutiveFailures: 0,
            lastError: null,
        });
        expect(state.currentState).toBe(BotState.IDLE);
        expect(state.consecutiveFailures).toBe(0);
    });
});
