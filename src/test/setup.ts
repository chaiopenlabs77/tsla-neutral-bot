// Test setup - mock environment variables
process.env.WALLET_PRIVATE_KEY = 'test_private_key_for_testing_only';
process.env.RPC_ENDPOINT_1 = 'https://api.mainnet-beta.solana.com';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.DRY_RUN = 'true';
process.env.LOG_LEVEL = 'silent'; // Quiet logs during tests
