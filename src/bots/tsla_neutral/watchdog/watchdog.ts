/**
 * External Watchdog
 * 
 * A separate process that monitors the main bot and can trigger
 * emergency actions if the bot becomes unresponsive or enters
 * a dangerous state.
 */

import { getRedisClient, healthCheckRedis } from '../infra/redis_client';
import { config } from '../config';
import { BotState, StateMachineState } from '../types';
import { alertCritical, alertWarning } from '../observability/alerter';

const WATCHDOG_INTERVAL = 30000; // Check every 30 seconds
const HEARTBEAT_KEY = 'tsla_neutral:heartbeat';
const STATE_KEY = 'tsla_neutral:state';
const MAX_HEARTBEAT_AGE_MS = 120000; // 2 minutes

interface WatchdogStatus {
    botHealthy: boolean;
    lastHeartbeat: number | null;
    currentState: BotState | null;
    alertsSent: number;
}

export class Watchdog {
    private isRunning = false;
    private intervalId: NodeJS.Timeout | null = null;
    private status: WatchdogStatus = {
        botHealthy: true,
        lastHeartbeat: null,
        currentState: null,
        alertsSent: 0,
    };

    /**
     * Start the watchdog monitoring loop.
     */
    start(): void {
        if (this.isRunning) {
            console.log('[Watchdog] Already running');
            return;
        }

        this.isRunning = true;
        console.log('[Watchdog] Starting monitoring...');

        this.intervalId = setInterval(() => {
            this.runCheck().catch((error) => {
                console.error('[Watchdog] Check failed:', error);
            });
        }, WATCHDOG_INTERVAL);

        // Run initial check
        this.runCheck().catch(console.error);
    }

    /**
     * Stop the watchdog.
     */
    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        console.log('[Watchdog] Stopped');
    }

    /**
     * Run a single health check.
     */
    private async runCheck(): Promise<void> {
        try {
            // Check Redis health
            const redisHealthy = await healthCheckRedis();
            if (!redisHealthy) {
                await this.handleUnhealthyRedis();
                return;
            }

            // Check heartbeat
            const heartbeat = await this.getHeartbeat();
            this.status.lastHeartbeat = heartbeat;

            if (heartbeat === null || Date.now() - heartbeat > MAX_HEARTBEAT_AGE_MS) {
                await this.handleMissingHeartbeat();
                return;
            }

            // Check bot state
            const state = await this.getState();
            this.status.currentState = state?.currentState ?? null;

            if (state) {
                await this.checkStateHealth(state);
            }

            // Bot is healthy
            this.status.botHealthy = true;
        } catch (error) {
            console.error('[Watchdog] Error during check:', error);
            this.status.botHealthy = false;
        }
    }

    /**
     * Get the last heartbeat timestamp.
     */
    private async getHeartbeat(): Promise<number | null> {
        const redis = getRedisClient();
        const heartbeat = await redis.get(HEARTBEAT_KEY);
        return heartbeat ? parseInt(heartbeat, 10) : null;
    }

    /**
     * Get the current bot state.
     */
    private async getState(): Promise<StateMachineState | null> {
        const redis = getRedisClient();
        const stateJson = await redis.get(STATE_KEY);
        if (!stateJson) return null;

        try {
            return JSON.parse(stateJson) as StateMachineState;
        } catch {
            return null;
        }
    }

    /**
     * Check if bot state indicates a problem.
     */
    private async checkStateHealth(state: StateMachineState): Promise<void> {
        // Check for stuck in error recovery
        if (state.currentState === BotState.ERROR_RECOVERY) {
            await alertWarning('BOT_ERROR_STATE', 'Bot is in ERROR_RECOVERY state', {
                consecutiveFailures: state.consecutiveFailures,
                lastError: state.lastError,
            });
        }

        // Check for too many consecutive failures
        if (state.consecutiveFailures >= 10) {
            await alertCritical(
                'HIGH_FAILURE_COUNT',
                `Bot has ${state.consecutiveFailures} consecutive failures`,
                { lastError: state.lastError }
            );
        }
    }

    /**
     * Handle Redis connection failure.
     */
    private async handleUnhealthyRedis(): Promise<void> {
        this.status.botHealthy = false;
        this.status.alertsSent++;

        console.error('[Watchdog] Redis unhealthy!');
        await alertCritical('REDIS_UNHEALTHY', 'Watchdog cannot connect to Redis');
    }

    /**
     * Handle missing or stale heartbeat.
     */
    private async handleMissingHeartbeat(): Promise<void> {
        this.status.botHealthy = false;
        this.status.alertsSent++;

        const lastHeartbeatAge = this.status.lastHeartbeat
            ? Math.floor((Date.now() - this.status.lastHeartbeat) / 1000)
            : 'never';

        console.error(`[Watchdog] Bot heartbeat missing! Last seen: ${lastHeartbeatAge}s ago`);

        await alertCritical('BOT_UNRESPONSIVE', `Bot heartbeat missing for ${lastHeartbeatAge}s`, {
            lastHeartbeat: this.status.lastHeartbeat,
            threshold: MAX_HEARTBEAT_AGE_MS,
        });

        // TODO: Implement kill switch
        // This could trigger emergency position closure or process restart
    }

    /**
     * Get current watchdog status.
     */
    getStatus(): WatchdogStatus {
        return { ...this.status };
    }
}

/**
 * Send heartbeat from the main bot.
 * Should be called regularly from the orchestrator.
 */
export async function sendHeartbeat(): Promise<void> {
    const redis = getRedisClient();
    await redis.set(HEARTBEAT_KEY, Date.now().toString());
}

/**
 * Run watchdog as standalone process.
 */
if (require.main === module) {
    const watchdog = new Watchdog();
    watchdog.start();

    process.on('SIGINT', () => {
        console.log('\n[Watchdog] Shutting down...');
        watchdog.stop();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        watchdog.stop();
        process.exit(0);
    });
}
