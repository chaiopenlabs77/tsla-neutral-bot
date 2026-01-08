import { Backoff, sleep, withRetry } from './backoff';

describe('Backoff', () => {
    describe('getNextDelay', () => {
        it('should return initial delay on first call', () => {
            const backoff = new Backoff(1000, 60000, 2);
            const delay = backoff.getNextDelay();
            // With jitter, should be within 25% of 1000
            expect(delay).toBeGreaterThanOrEqual(750);
            expect(delay).toBeLessThanOrEqual(1250);
        });

        it('should increase delay exponentially', () => {
            const backoff = new Backoff(1000, 60000, 2);
            backoff.getNextDelay(); // 1000
            const second = backoff.getNextDelay(); // ~2000
            // With jitter, second should be around 2000
            expect(second).toBeGreaterThanOrEqual(1500);
            expect(second).toBeLessThanOrEqual(2500);
        });

        it('should not exceed max delay', () => {
            const backoff = new Backoff(1000, 5000, 2);
            for (let i = 0; i < 10; i++) {
                backoff.getNextDelay();
            }
            const delay = backoff.getNextDelay();
            expect(delay).toBeLessThanOrEqual(6250); // max + 25% jitter
        });

        it('should reset after calling reset()', () => {
            const backoff = new Backoff(1000, 60000, 2);
            backoff.getNextDelay();
            backoff.getNextDelay();
            backoff.getNextDelay();
            backoff.reset();
            const delay = backoff.getNextDelay();
            expect(delay).toBeGreaterThanOrEqual(750);
            expect(delay).toBeLessThanOrEqual(1250);
        });
    });
});

describe('sleep', () => {
    it('should wait for specified time', async () => {
        const start = Date.now();
        await sleep(100);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(90);
        expect(elapsed).toBeLessThan(200);
    });
});

describe('withRetry', () => {
    it('should return result on success', async () => {
        const fn = jest.fn().mockResolvedValue('success');
        const result = await withRetry(fn);
        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure', async () => {
        const fn = jest
            .fn()
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValue('success');

        const result = await withRetry(fn, {
            maxAttempts: 3,
            backoff: new Backoff(10, 100, 2), // Fast backoff for tests
        });

        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw after max attempts', async () => {
        const fn = jest.fn().mockRejectedValue(new Error('always fails'));

        await expect(
            withRetry(fn, {
                maxAttempts: 3,
                backoff: new Backoff(10, 100, 2),
            })
        ).rejects.toThrow('always fails');

        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should call onRetry callback', async () => {
        const fn = jest
            .fn()
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValue('success');
        const onRetry = jest.fn();

        await withRetry(fn, {
            maxAttempts: 3,
            backoff: new Backoff(10, 100, 2),
            onRetry,
        });

        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
    });

    it('should respect shouldRetry predicate', async () => {
        const fn = jest.fn().mockRejectedValue(new Error('permanent'));

        await expect(
            withRetry(fn, {
                maxAttempts: 5,
                backoff: new Backoff(10, 100, 2),
                shouldRetry: (error) => (error as Error).message !== 'permanent',
            })
        ).rejects.toThrow('permanent');

        expect(fn).toHaveBeenCalledTimes(1); // No retries
    });
});
