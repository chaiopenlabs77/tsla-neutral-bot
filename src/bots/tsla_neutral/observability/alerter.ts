import { config } from '../config';
import { Alert, AlertSeverity } from '../types';
import { logger } from './logger';

// Rate limiting state
const lastAlertByType = new Map<string, number>();

/**
 * Check if an alert should be rate-limited.
 */
function isRateLimited(alertType: string): boolean {
    const lastSent = lastAlertByType.get(alertType);
    if (!lastSent) return false;

    return Date.now() - lastSent < config.ALERT_RATE_LIMIT_MS;
}

/**
 * Record that an alert was sent.
 */
function recordAlertSent(alertType: string): void {
    lastAlertByType.set(alertType, Date.now());
}

/**
 * Send alert via Telegram.
 */
async function sendTelegramAlert(alert: Alert): Promise<boolean> {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
        return false;
    }

    const emoji = {
        INFO: 'ℹ️',
        WARNING: '⚠️',
        CRITICAL: '🚨',
    }[alert.severity];

    const message = `${emoji} *${alert.severity}*: ${alert.type}\n\n${alert.message}`;

    try {
        const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: config.TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'Markdown',
            }),
        });

        return response.ok;
    } catch (error) {
        logger.error({ module: 'alerter', error: 'Failed to send Telegram alert' });
        return false;
    }
}

/**
 * Send an alert with rate limiting.
 */
export async function sendAlert(
    severity: AlertSeverity,
    type: string,
    message: string,
    metadata?: Record<string, unknown>
): Promise<void> {
    // Always log the alert
    const logLevel = severity === 'CRITICAL' ? 'error' : severity === 'WARNING' ? 'warn' : 'info';
    logger[logLevel]({ event: 'alert', severity, type, message, ...metadata });

    // Check rate limiting
    if (isRateLimited(type)) {
        logger.debug({ event: 'alert_rate_limited', type });
        return;
    }

    const alert: Alert = {
        id: `${type}-${Date.now()}`,
        severity,
        type,
        message,
        timestamp: Date.now(),
        metadata,
    };

    // Send via configured channels
    const telegramSent = await sendTelegramAlert(alert);

    if (telegramSent) {
        recordAlertSent(type);
    }
}

// Convenience methods
export const alertInfo = (type: string, message: string, metadata?: Record<string, unknown>) =>
    sendAlert('INFO', type, message, metadata);

export const alertWarning = (type: string, message: string, metadata?: Record<string, unknown>) =>
    sendAlert('WARNING', type, message, metadata);

export const alertCritical = (type: string, message: string, metadata?: Record<string, unknown>) =>
    sendAlert('CRITICAL', type, message, metadata);

// Pre-defined alert types
export const alerts = {
    oracleDivergence: (divergence: number) =>
        alertWarning('ORACLE_DIVERGENCE', `Pool vs Pyth divergence: ${(divergence * 100).toFixed(2)}%`, { divergence }),

    liquidationWarning: (distance: number, liquidationPrice: number, currentPrice: number) =>
        alertCritical('LIQUIDATION_WARNING', `Position near liquidation! Distance: ${(distance * 100).toFixed(2)}%`, {
            distance,
            liquidationPrice,
            currentPrice,
        }),

    txFailure: (txType: string, error: string) =>
        alertWarning('TX_FAILURE', `Transaction failed: ${txType}`, { txType, error }),

    rpcUnhealthy: (endpoint: string) =>
        alertWarning('RPC_UNHEALTHY', `RPC endpoint unhealthy: ${endpoint}`, { endpoint }),

    stateReconciliationMismatch: (redisState: string, chainState: string) =>
        alertCritical('STATE_MISMATCH', `Redis state doesn't match chain!`, { redisState, chainState }),

    lowSolBalance: (balance: number, required: number) =>
        alertWarning('LOW_SOL_BALANCE', `SOL balance low: ${balance.toFixed(4)} (need ${required})`, { balance, required }),

    highMemoryUsage: (used: number, baseline: number) =>
        alertWarning('HIGH_MEMORY', `Heap usage: ${used}MB (${((used / baseline - 1) * 100).toFixed(0)}% above baseline)`, {
            used,
            baseline,
        }),

    botStarted: () => alertInfo('BOT_STARTED', 'TSLA Neutral Bot started'),

    botStopped: (reason: string) => alertInfo('BOT_STOPPED', `Bot stopped: ${reason}`, { reason }),
};
