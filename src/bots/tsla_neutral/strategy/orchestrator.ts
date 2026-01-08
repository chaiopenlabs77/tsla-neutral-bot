import { config } from '../config';
import { BotState, StateMachineState, CycleMetrics } from '../types';
import {
    loadState,
    transitionState,
    recordSuccess,
    recordFailure,
    canOperate,
} from '../state_machine';
import { getRpcManager } from '../clients/rpc_manager';
import { evaluateRebalance } from './risk_manager';
import { loggers, logMetricsSnapshot } from '../observability/logger';
import { rebalanceCounter } from '../observability/metrics';
import { alerts } from '../observability/alerter';
import { isShutdownInProgress, onShutdown } from '../utils/shutdown';
import { sleep, Backoff } from '../utils/backoff';
import { getMonotonicTime } from '../utils/clock';

const log = loggers.orchestrator;

export class Orchestrator {
    private state: StateMachineState | null = null;
    private isRunning = false;
    private backoff = new Backoff();
    private cycleCount = 0;

    /**
     * Initialize the orchestrator.
     */
    async initialize(): Promise<void> {
        log.info({ event: 'initializing' });

        // Load state from Redis
        this.state = await loadState();

        // Start RPC health checks
        getRpcManager().startHealthChecks();

        // Register shutdown handler
        onShutdown(async () => {
            log.info({ event: 'shutdown_handler_triggered' });
            await this.stop();
        });

        log.info({ event: 'initialized', state: this.state!.currentState });
    }

    /**
     * Start the main loop.
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            log.warn({ event: 'already_running' });
            return;
        }

        this.isRunning = true;
        alerts.botStarted();
        log.info({ event: 'starting_main_loop', interval: config.LOOP_INTERVAL_MS });

        while (this.isRunning && !isShutdownInProgress()) {
            const cycleStart = getMonotonicTime();
            this.cycleCount++;

            try {
                await this.runCycle();
                this.backoff.reset();
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                log.error({ event: 'cycle_error', cycle: this.cycleCount, error: errorMessage });

                if (this.state) {
                    this.state = await recordFailure(this.state, errorMessage);
                }

                // Apply backoff
                await this.backoff.wait();
            }

            // Wait for next cycle
            const cycleDuration = getMonotonicTime() - cycleStart;
            const sleepTime = Math.max(0, config.LOOP_INTERVAL_MS - cycleDuration);

            if (sleepTime > 0 && this.isRunning) {
                await sleep(sleepTime);
            }
        }

        log.info({ event: 'main_loop_exited' });
    }

    /**
     * Stop the orchestrator.
     */
    async stop(): Promise<void> {
        if (!this.isRunning) return;

        log.info({ event: 'stopping' });
        this.isRunning = false;

        // Transition to shutdown state
        if (this.state && canOperate(this.state)) {
            this.state = await transitionState(this.state, BotState.SHUTTING_DOWN);
        }

        // Stop RPC health checks
        getRpcManager().stopHealthChecks();

        alerts.botStopped('graceful_shutdown');
        log.info({ event: 'stopped' });
    }

    /**
     * Run a single cycle.
     */
    private async runCycle(): Promise<void> {
        if (!this.state || !canOperate(this.state)) {
            log.debug({ event: 'skip_cycle', reason: 'cannot_operate' });
            return;
        }

        log.debug({ event: 'cycle_start', cycle: this.cycleCount });

        // In DRY_RUN mode, just log what we would do
        if (config.DRY_RUN) {
            await this.runDryRunCycle();
            return;
        }

        // TODO: Implement actual trading logic
        // 1. Fetch LP position delta
        // 2. Fetch hedge position delta
        // 3. Fetch price data
        // 4. Evaluate rebalance decision
        // 5. Execute if needed

        // Placeholder for now
        const decision = evaluateRebalance(
            this.state,
            0, // lpDelta - placeholder
            0, // hedgeDelta - placeholder
            0, // estimatedGasCost - placeholder
            true // isLpInRange - placeholder
        );

        if (decision.shouldRebalance && !decision.blocked) {
            log.info({
                event: 'rebalance_triggered',
                reason: decision.reason,
                currentDelta: decision.currentDelta,
                sizeToAdjust: decision.sizeToAdjust,
            });

            rebalanceCounter.inc({ reason: decision.reason, status: 'pending' });

            // TODO: Execute rebalance
        }

        this.state = await recordSuccess(this.state);
    }

    /**
     * Run a dry-run cycle (no actual trades).
     */
    private async runDryRunCycle(): Promise<void> {
        // Simulate fetching data
        const mockLpDelta = 1000; // $1000 long exposure
        const mockHedgeDelta = -950; // $950 short exposure
        const mockGasCost = 0.001; // 0.001 SOL

        const decision = evaluateRebalance(
            this.state!,
            mockLpDelta,
            mockHedgeDelta,
            mockGasCost,
            true
        );

        const metrics: Partial<CycleMetrics> = {
            cycleId: `cycle-${this.cycleCount}`,
            timestamp: Date.now(),
            deltaBeforeRebalance: decision.currentDelta,
        };

        logMetricsSnapshot({
            cycle: this.cycleCount,
            dryRun: true,
            lpDelta: mockLpDelta,
            hedgeDelta: mockHedgeDelta,
            netDelta: decision.currentDelta,
            shouldRebalance: decision.shouldRebalance,
            reason: decision.reason,
        });

        if (decision.shouldRebalance && !decision.blocked) {
            log.info({
                event: 'dry_run_would_rebalance',
                reason: decision.reason,
                sizeToAdjust: decision.sizeToAdjust,
            });
        }

        log.debug({ event: 'cycle_complete', cycle: this.cycleCount });
    }

    /**
     * Get current state.
     */
    getState(): StateMachineState | null {
        return this.state;
    }

    /**
     * Get cycle count.
     */
    getCycleCount(): number {
        return this.cycleCount;
    }
}
