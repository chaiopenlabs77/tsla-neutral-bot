import 'dotenv/config';
import { config } from './config';
import { acquireOrExit } from './infra/distributed_lock';
import { healthCheckRedis } from './infra/redis_client';
import { installSignalHandlers, setLockForShutdown } from './utils/shutdown';
import { startMetricsServer, stopMetricsServer } from './observability/metrics';
import { logger } from './observability/logger';
import { alerts, alertCritical } from './observability/alerter';
import { Orchestrator } from './strategy/orchestrator';

async function main(): Promise<void> {
    logger.info({ event: 'startup', dryRun: config.DRY_RUN });

    // Install signal handlers first
    installSignalHandlers();

    // Check Redis health
    const redisHealthy = await healthCheckRedis();
    if (!redisHealthy) {
        logger.error({ event: 'redis_unhealthy', msg: 'Cannot connect to Redis' });
        process.exit(1);
    }
    logger.info({ event: 'redis_connected' });

    // Acquire distributed lock (prevents split-brain)
    const lock = await acquireOrExit('tsla_neutral_bot');
    setLockForShutdown(lock);

    // Start metrics server
    startMetricsServer();

    // Initialize and start orchestrator
    const orchestrator = new Orchestrator();
    await orchestrator.initialize();
    await orchestrator.start();

    // Cleanup (reached on shutdown)
    await stopMetricsServer();
    logger.info({ event: 'exit', msg: 'Goodbye!' });
}

main().catch((error) => {
    logger.error({ event: 'fatal_error', error: error.message, stack: error.stack });
    alertCritical('FATAL_ERROR', `Bot crashed: ${error.message}`);
    process.exit(1);
});
