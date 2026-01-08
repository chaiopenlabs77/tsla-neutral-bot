/**
 * In-Memory Mock Redis for dry runs without Redis.
 * Set USE_MOCK_REDIS=true in .env to use this.
 */

import Redis from 'ioredis';
import { config } from '../config';

// In-memory storage for mock mode
const mockStorage = new Map<string, string>();

// Mock Redis interface
const mockRedis = {
    get: async (key: string) => mockStorage.get(key) ?? null,
    set: async (key: string, value: string, ..._args: unknown[]) => {
        mockStorage.set(key, value);
        return 'OK';
    },
    del: async (key: string) => {
        mockStorage.delete(key);
        return 1;
    },
    ping: async () => 'PONG',
    quit: async () => undefined,
    on: () => mockRedis,
    eval: async () => 1,
    expire: async () => 1,
};

// Singleton Redis client with connection pooling
let redisClient: Redis | typeof mockRedis | null = null;

export function getRedisClient(): Redis | typeof mockRedis {
    if (!redisClient) {
        // Check for mock mode
        if (process.env.USE_MOCK_REDIS === 'true') {
            console.log('[Redis] Using in-memory mock (USE_MOCK_REDIS=true)');
            redisClient = mockRedis;
            return redisClient;
        }

        redisClient = new Redis(config.REDIS_URL, {
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                if (times > 10) {
                    return null; // Stop retrying
                }
                return Math.min(times * 100, 3000);
            },
            enableReadyCheck: true,
            lazyConnect: true,
        });

        redisClient.on('error', (err) => {
            console.error('[Redis] Connection error:', err.message);
        });

        redisClient.on('connect', () => {
            console.log('[Redis] Connected');
        });

        redisClient.on('ready', () => {
            console.log('[Redis] Ready');
        });
    }
    return redisClient;
}

export async function healthCheckRedis(): Promise<boolean> {
    try {
        const client = getRedisClient();
        const result = await client.ping();
        return result === 'PONG';
    } catch (error) {
        return false;
    }
}

export async function closeRedis(): Promise<void> {
    if (redisClient && 'quit' in redisClient) {
        await redisClient.quit();
        redisClient = null;
    }
}
