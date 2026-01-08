import { config } from '../config';

/**
 * Exponential backoff with jitter for retry logic.
 */
export class Backoff {
    private currentDelay: number;
    private readonly initialDelay: number;
    private readonly maxDelay: number;
    private readonly multiplier: number;

    constructor(
        initialDelay = config.BACKOFF_INITIAL_MS,
        maxDelay = config.BACKOFF_MAX_MS,
        multiplier = config.BACKOFF_MULTIPLIER
    ) {
        this.initialDelay = initialDelay;
        this.maxDelay = maxDelay;
        this.multiplier = multiplier;
        this.currentDelay = initialDelay;
    }

    /**
     * Get the next backoff delay with jitter.
     */
    getNextDelay(): number {
        const delay = this.currentDelay;
        // Add jitter: ±25% randomness
        const jitter = delay * 0.25 * (Math.random() * 2 - 1);
        const delayWithJitter = Math.max(this.initialDelay, delay + jitter);

        // Increase for next time
        this.currentDelay = Math.min(this.currentDelay * this.multiplier, this.maxDelay);

        return Math.round(delayWithJitter);
    }

    /**
     * Reset backoff to initial delay (call on success).
     */
    reset(): void {
        this.currentDelay = this.initialDelay;
    }

    /**
     * Wait for the backoff delay.
     */
    async wait(): Promise<void> {
        const delay = this.getNextDelay();
        await sleep(delay);
    }

    /**
     * Get current state for logging.
     */
    getState(): { currentDelay: number; maxDelay: number } {
        return {
            currentDelay: this.currentDelay,
            maxDelay: this.maxDelay,
        };
    }
}

/**
 * Simple sleep utility.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options: {
        maxAttempts?: number;
        backoff?: Backoff;
        shouldRetry?: (error: unknown) => boolean;
        onRetry?: (attempt: number, error: unknown, delay: number) => void;
    } = {}
): Promise<T> {
    const maxAttempts = options.maxAttempts ?? 5;
    const backoff = options.backoff ?? new Backoff();
    const shouldRetry = options.shouldRetry ?? (() => true);
    const onRetry = options.onRetry ?? (() => { });

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const result = await fn();
            backoff.reset();
            return result;
        } catch (error) {
            lastError = error;

            if (attempt === maxAttempts || !shouldRetry(error)) {
                throw error;
            }

            const delay = backoff.getNextDelay();
            onRetry(attempt, error, delay);
            await sleep(delay);
        }
    }

    throw lastError;
}
