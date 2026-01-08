import { DistributedLock } from '../infra/distributed_lock';
import { closeRedis } from '../infra/redis_client';

type ShutdownHandler = () => Promise<void>;

const shutdownHandlers: ShutdownHandler[] = [];
let isShuttingDown = false;
let currentLock: DistributedLock | null = null;

/**
 * Register a handler to run during graceful shutdown.
 * Handlers run in reverse order of registration (LIFO).
 */
export function onShutdown(handler: ShutdownHandler): void {
    shutdownHandlers.unshift(handler);
}

/**
 * Register the distributed lock for cleanup on shutdown.
 */
export function setLockForShutdown(lock: DistributedLock): void {
    currentLock = lock;
}

/**
 * Check if shutdown is in progress.
 */
export function isShutdownInProgress(): boolean {
    return isShuttingDown;
}

/**
 * Initiate graceful shutdown.
 */
async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
        console.log(`[Shutdown] Already shutting down, ignoring ${signal}`);
        return;
    }

    isShuttingDown = true;
    console.log(`\n[Shutdown] Received ${signal}, starting graceful shutdown...`);

    // Set a hard timeout
    const hardTimeout = setTimeout(() => {
        console.error('[Shutdown] Hard timeout reached, forcing exit');
        process.exit(1);
    }, 30000);

    try {
        // Run shutdown handlers
        for (const handler of shutdownHandlers) {
            try {
                await handler();
            } catch (error) {
                console.error('[Shutdown] Handler error:', error);
            }
        }

        // Release distributed lock
        if (currentLock) {
            try {
                await currentLock.release();
                console.log('[Shutdown] Released distributed lock');
            } catch (error) {
                console.error('[Shutdown] Failed to release lock:', error);
            }
        }

        // Close Redis
        try {
            await closeRedis();
            console.log('[Shutdown] Closed Redis connection');
        } catch (error) {
            console.error('[Shutdown] Failed to close Redis:', error);
        }

        clearTimeout(hardTimeout);
        console.log('[Shutdown] Graceful shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('[Shutdown] Error during shutdown:', error);
        clearTimeout(hardTimeout);
        process.exit(1);
    }
}

/**
 * Install signal handlers. Call once at startup.
 */
export function installSignalHandlers(): void {
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
        console.error('[Fatal] Uncaught exception:', error);
        gracefulShutdown('uncaughtException');
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason) => {
        console.error('[Fatal] Unhandled rejection:', reason);
        gracefulShutdown('unhandledRejection');
    });

    console.log('[Shutdown] Signal handlers installed');
}
