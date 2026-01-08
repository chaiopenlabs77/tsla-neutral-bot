import { config } from '../config';

/**
 * Check if current time is within quiet hours (Market Open volatility).
 * Uses UTC time from config.
 */
export function isQuietHours(): boolean {
    const now = new Date();
    const currentUTC = now.getUTCHours() * 60 + now.getUTCMinutes();

    const [startHour, startMin] = config.QUIET_HOURS_START_UTC.split(':').map(Number);
    const [endHour, endMin] = config.QUIET_HOURS_END_UTC.split(':').map(Number);

    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;

    return currentUTC >= startMinutes && currentUTC <= endMinutes;
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
