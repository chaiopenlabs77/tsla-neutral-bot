import { getRedisClient } from './redis_client';
import { config } from '../config';

const LOCK_PREFIX = 'tsla_neutral:lock:';

export class DistributedLock {
    private lockKey: string;
    private lockValue: string;
    private renewalInterval: NodeJS.Timeout | null = null;
    private isHeld = false;

    constructor(lockName: string) {
        this.lockKey = `${LOCK_PREFIX}${lockName}`;
        this.lockValue = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    /**
     * Attempt to acquire the lock.
     * Returns true if lock acquired, false otherwise.
     */
    async acquire(): Promise<boolean> {
        const redis = getRedisClient();
        const ttlSeconds = Math.ceil(config.DISTRIBUTED_LOCK_TTL_MS / 1000);

        // SETNX with expiry
        const result = await redis.set(this.lockKey, this.lockValue, 'EX', ttlSeconds, 'NX');

        if (result === 'OK') {
            this.isHeld = true;
            this.startRenewal();
            return true;
        }

        return false;
    }

    /**
     * Release the lock if we hold it.
     */
    async release(): Promise<boolean> {
        if (!this.isHeld) return false;

        this.stopRenewal();

        const redis = getRedisClient();

        // Only delete if we still hold the lock (compare-and-delete via Lua)
        const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

        const result = await redis.eval(luaScript, 1, this.lockKey, this.lockValue);
        this.isHeld = result === 1;
        return result === 1;
    }

    /**
     * Check if we currently hold the lock.
     */
    async checkIfHeld(): Promise<boolean> {
        const redis = getRedisClient();
        const currentValue = await redis.get(this.lockKey);
        return currentValue === this.lockValue;
    }

    /**
     * Start automatic lock renewal.
     */
    private startRenewal(): void {
        this.renewalInterval = setInterval(async () => {
            if (!this.isHeld) {
                this.stopRenewal();
                return;
            }

            try {
                const redis = getRedisClient();
                const ttlSeconds = Math.ceil(config.DISTRIBUTED_LOCK_TTL_MS / 1000);

                // Only renew if we still hold the lock
                const luaScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("expire", KEYS[1], ARGV[2])
          else
            return 0
          end
        `;

                const result = await redis.eval(luaScript, 1, this.lockKey, this.lockValue, ttlSeconds);

                if (result !== 1) {
                    console.error('[DistributedLock] Lost lock during renewal!');
                    this.isHeld = false;
                    this.stopRenewal();
                    // Critical: Exit process if we lose the lock to prevent split-brain
                    process.exit(1);
                }
            } catch (error) {
                console.error('[DistributedLock] Renewal error:', error);
            }
        }, config.DISTRIBUTED_LOCK_RENEWAL_MS);
    }

    /**
     * Stop automatic renewal.
     */
    private stopRenewal(): void {
        if (this.renewalInterval) {
            clearInterval(this.renewalInterval);
            this.renewalInterval = null;
        }
    }

    /**
     * Get current lock status for debugging.
     */
    getStatus(): { isHeld: boolean; lockKey: string; lockValue: string } {
        return {
            isHeld: this.isHeld,
            lockKey: this.lockKey,
            lockValue: this.lockValue,
        };
    }
}

/**
 * Convenience function to acquire lock with automatic exit on failure.
 */
export async function acquireOrExit(lockName: string): Promise<DistributedLock> {
    const lock = new DistributedLock(lockName);
    const acquired = await lock.acquire();

    if (!acquired) {
        console.error(`[DistributedLock] Failed to acquire lock '${lockName}'. Another instance may be running.`);
        process.exit(1);
    }

    console.log(`[DistributedLock] Acquired lock '${lockName}'`);
    return lock;
}
