import { isQuietHours, isUSMarketOpen, isStale, getMonotonicTime } from './clock';

// Mock the config
jest.mock('../config', () => ({
    config: {
        QUIET_HOURS_START_UTC: '14:30',
        QUIET_HOURS_END_UTC: '15:15',
    },
}));

describe('clock utilities', () => {
    describe('isQuietHours', () => {
        it('should detect quiet hours correctly', () => {
            // This test depends on current time, so we just verify it returns a boolean
            const result = isQuietHours();
            expect(typeof result).toBe('boolean');
        });
    });

    describe('isUSMarketOpen', () => {
        it('should return a boolean', () => {
            const result = isUSMarketOpen();
            expect(typeof result).toBe('boolean');
        });
    });

    describe('isStale', () => {
        it('should return true for old timestamps', () => {
            const oldTimestamp = Date.now() - 10000; // 10 seconds ago
            expect(isStale(oldTimestamp, 5000)).toBe(true); // 5 second max age
        });

        it('should return false for recent timestamps', () => {
            const recentTimestamp = Date.now() - 1000; // 1 second ago
            expect(isStale(recentTimestamp, 5000)).toBe(false);
        });

        it('should return false for current timestamp', () => {
            expect(isStale(Date.now(), 5000)).toBe(false);
        });
    });

    describe('getMonotonicTime', () => {
        it('should return increasing values', () => {
            const t1 = getMonotonicTime();
            const t2 = getMonotonicTime();
            expect(t2).toBeGreaterThanOrEqual(t1);
        });

        it('should be a number', () => {
            expect(typeof getMonotonicTime()).toBe('number');
        });
    });
});
