# TSLA-USDC Delta Neutral Bot

A production-grade delta-neutral trading bot for TSLAx-USDC on Solana. Provides concentrated liquidity on Raydium CLMM while hedging TSLA exposure through Flash Trade perpetual futures.

## Strategy Overview

```
┌─────────────────┐     ┌─────────────────┐
│  Raydium CLMM   │     │   Flash Trade   │
│   TSLAx-USDC    │     │   TSLA Perps    │
│   (Long TSLA)   │ ←─→ │   (Short TSLA)  │
└─────────────────┘     └─────────────────┘
         ↓                       ↓
    Yield from LP          Hedge Exposure
    Trading Fees            Delta = 0
```

**Key Features:**
- **Delta Neutral**: Long exposure from LP is hedged with short perp
- **Concentrated Liquidity**: Tight ranges (±5% default) for higher capital efficiency
- **Auto-Recenter**: Automatically repositions LP when price moves out of range
- **MEV Protection**: Jito bundle submission for atomic execution
- **Risk Management**: Quiet hours, liquidation monitoring, circuit breakers

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your wallet and RPC endpoints

# Run in dry-run mode (no real trades)
npm run dev

# Run tests
npm test

# Build for production
npm run build
npm start
```

## Architecture

```
src/bots/tsla_neutral/
├── clients/           # Protocol interactions
│   ├── lp_client.ts       # Raydium CLMM
│   ├── flash_trade_client.ts  # Flash Trade perps
│   ├── jito_client.ts     # MEV bundle submission
│   ├── pyth_client.ts     # Oracle prices
│   └── rpc_manager.ts     # Multi-RPC failover
├── infra/             # Infrastructure
│   ├── redis_client.ts    # State persistence
│   └── distributed_lock.ts # Split-brain prevention
├── observability/     # Monitoring
│   ├── logger.ts          # Pino structured logging
│   ├── metrics.ts         # Prometheus metrics
│   └── alerter.ts         # Telegram alerts
├── strategy/          # Core logic
│   ├── orchestrator.ts    # Main loop & state machine
│   └── risk_manager.ts    # Delta calc, rebalance decisions
├── utils/             # Utilities
│   ├── backoff.ts         # Exponential retry
│   ├── clock.ts           # Quiet hours, timing
│   └── shutdown.ts        # Graceful shutdown
├── watchdog/          # External monitoring
│   └── watchdog.ts        # Health checks, kill switch
├── config.ts          # Environment configuration
├── types.ts           # TypeScript interfaces
├── state_machine.ts   # Redis-backed state persistence
└── index.ts           # Entry point
```

## Configuration

All settings via environment variables in `.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `DRY_RUN` | Simulate trades without execution | `true` |
| `RPC_ENDPOINT_1` | Primary Solana RPC | Required |
| `WALLET_PRIVATE_KEY` | Base58 encoded private key | Required |
| `RANGE_WIDTH_PERCENT` | LP range width (±%) | `0.05` |
| `DELTA_DRIFT_THRESHOLD_PERCENT` | Rebalance trigger | `0.05` |
| `QUIET_HOURS_START_UTC` | Avoid US market open | `14:30` |
| `QUIET_HOURS_END_UTC` | Avoid US market open | `15:15` |

See `.env.example` for all options.

## State Machine

```
     ┌──────┐
     │ IDLE │◄────────────────────────┐
     └──┬───┘                         │
        │ price out of range          │
        ▼                             │
  ┌─────────────┐                     │
  │ CLOSING_LP  │                     │
  └─────┬───────┘                     │
        │                             │
        ▼                             │
  ┌───────────┐                       │
  │ SWAPPING  │                       │
  └─────┬─────┘                       │
        │                             │
        ▼                             │
  ┌────────────┐                      │
  │ OPENING_LP │                      │
  └─────┬──────┘                      │
        │                             │
        ▼                             │
  ┌─────────────┐   delta drift       │
  │ REBALANCING │─────────────────────┘
  └─────────────┘
```

## Monitoring

### Prometheus Metrics (`:9090/metrics`)
- `tsla_neutral_delta_gauge` - Current net delta
- `tsla_neutral_lp_value_gauge` - LP position value
- `tsla_neutral_hedge_value_gauge` - Hedge position value
- `tsla_neutral_tx_total` - Transactions by type/status
- `tsla_neutral_tx_latency_seconds` - TX confirmation latency

### Telegram Alerts
Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for alerts on:
- Bot started/stopped
- Rebalance executed
- Liquidation warnings
- Critical errors

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

**Test Coverage:**
- `backoff.test.ts` - Exponential retry logic
- `clock.test.ts` - Quiet hours, staleness checks
- `risk_manager.test.ts` - Delta calc, rebalance decisions
- `integration.test.ts` - Full initialization flow

## Production Deployment

### PM2
```bash
npm run build
pm2 start dist/bots/tsla_neutral/index.js --name tsla-neutral
```

### Systemd
```ini
[Unit]
Description=TSLA Neutral Bot
After=network.target redis.service

[Service]
Type=simple
User=solana
WorkingDirectory=/opt/tsla-neutral
ExecStart=/usr/bin/node dist/bots/tsla_neutral/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Docker
```bash
docker build -t tsla-neutral .
docker run -d --name tsla-neutral \
  --env-file .env \
  --network host \
  tsla-neutral
```

## Security

- **No plaintext keys**: Use SOPS, HashiCorp Vault, or hardware wallet
- **Distributed lock**: Prevents multiple instances (split-brain)
- **Graceful shutdown**: Clean position exit on SIGTERM
- **External watchdog**: Separate process monitors health

## Risk Warnings

⚠️ **This is experimental software for educational purposes.**

- Concentrated liquidity positions can suffer impermanent loss
- Perpetual futures carry liquidation risk
- Oracle manipulation can cause unexpected losses
- Never trade with funds you can't afford to lose

## License

MIT
