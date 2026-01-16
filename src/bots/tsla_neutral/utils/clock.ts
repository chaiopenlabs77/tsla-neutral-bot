import { config } from '../config';

/**
 * Note: Quiet hours functionality has been replaced by market hours logic
 * in the orchestrator using MARKET_OPEN_HOUR_ET / MARKET_CLOSE_HOUR_ET.
 * This stub remains for backwards compatibility.
 */
export function isQuietHours(): boolean {
    // Quiet hours logic is now handled at the orchestrator level via TRADING_HOURS_ONLY
    return false;
}

/**
 * Check if current time is within US trading hours (9:30 AM - 4:00 PM ET).
 * ET is UTC-5 (standard) or UTC-4 (daylight).
 * This is a simplified check using UTC; for production, use a proper timezone library.
 */
export function isUSMarketOpen(): boolean {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();

    // Approximate: NYSE hours are 9:30-16:00 ET
    // ET to UTC: add 5 hours (standard time), add 4 hours (daylight)
    // Using conservative range: 14:30 - 21:00 UTC (covers both)
    const currentUTC = utcHours * 60 + utcMinutes;
    const marketOpen = 14 * 60 + 30; // 14:30 UTC
    const marketClose = 21 * 60; // 21:00 UTC

    // Check if it's a weekday
    const dayOfWeek = now.getUTCDay();
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

    return isWeekday && currentUTC >= marketOpen && currentUTC <= marketClose;
}

/**
 * Get time until next market open (approximate).
 */
export function getTimeUntilMarketOpen(): number {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const currentUTC = utcHours * 60 + utcMinutes;
    const marketOpen = 14 * 60 + 30; // 14:30 UTC

    if (currentUTC < marketOpen) {
        return (marketOpen - currentUTC) * 60 * 1000;
    }

    // Next day
    return (24 * 60 - currentUTC + marketOpen) * 60 * 1000;
}

/**
 * Get monotonic time for interval calculations (avoids leap second issues).
 */
export function getMonotonicTime(): number {
    return performance.now();
}

/**
 * Check if a timestamp is stale.
 */
export function isStale(timestamp: number, maxAgeMs: number): boolean {
    return Date.now() - timestamp > maxAgeMs;
}
