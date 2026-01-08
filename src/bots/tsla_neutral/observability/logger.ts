import pino from 'pino';
import { config } from '../config';

export const logger = pino({
    level: config.LOG_LEVEL,
    formatters: {
        level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
        service: 'tsla-neutral-bot',
        pid: process.pid,
    },
});

// Child loggers for different modules
export const loggers = {
    orchestrator: logger.child({ module: 'orchestrator' }),
    rpc: logger.child({ module: 'rpc' }),
    lp: logger.child({ module: 'lp' }),
    hedge: logger.child({ module: 'hedge' }),
    jito: logger.child({ module: 'jito' }),
    risk: logger.child({ module: 'risk' }),
    reconciler: logger.child({ module: 'reconciler' }),
    watchdog: logger.child({ module: 'watchdog' }),
};

export type LogContext = Record<string, unknown>;

/**
 * Structured log helper for trade events.
 */
export function logTrade(
    action: 'OPEN_LP' | 'CLOSE_LP' | 'OPEN_HEDGE' | 'CLOSE_HEDGE' | 'REBALANCE',
    details: LogContext
): void {
    logger.info({ event: 'trade', action, ...details });
}

/**
 * Structured log helper for errors.
 */
export function logError(module: string, error: unknown, context?: LogContext): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error({
        module,
        error: errorMessage,
        stack: errorStack,
        ...context,
    });
}

/**
 * Structured log helper for metrics snapshots.
 */
export function logMetricsSnapshot(metrics: LogContext): void {
    logger.info({ event: 'metrics_snapshot', ...metrics });
}
