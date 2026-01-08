import { PublicKey } from '@solana/web3.js';

// ============================================================================
// State Machine
// ============================================================================
export enum BotState {
    IDLE = 'IDLE',
    OPENING_LP = 'OPENING_LP',
    HEDGING = 'HEDGING',
    REBALANCING = 'REBALANCING',
    CLOSING_LP = 'CLOSING_LP',
    CLOSING_HEDGE = 'CLOSING_HEDGE',
    ERROR_RECOVERY = 'ERROR_RECOVERY',
    SHUTTING_DOWN = 'SHUTTING_DOWN',
}

export interface StateMachineState {
    currentState: BotState;
    lpPositionMint: string | null;
    hedgePositionId: string | null;
    lastLpDelta: number;
    lastHedgeDelta: number;
    lastRebalanceTime: number;
    outOfRangeSince: number | null;
    consecutiveFailures: number;
    lastError: string | null;
}

// ============================================================================
// Positions
// ============================================================================
export interface LPPosition {
    mint: PublicKey;
    poolAddress: PublicKey;
    lowerTick: number;
    upperTick: number;
    liquidity: bigint;
    tokenAAmount: bigint;
    tokenBAmount: bigint;
    inRange: boolean;
    entryPrice: number;
}

export interface HedgePosition {
    positionId: string;
    market: string;
    side: 'SHORT' | 'LONG';
    size: number;
    entryPrice: number;
    leverage: number;
    liquidationPrice: number;
    unrealizedPnl: number;
    marginUsed: number;
}

// ============================================================================
// Prices
// ============================================================================
export interface PriceData {
    poolPrice: number;
    pythPrice: number;
    pythConfidence: number;
    pythPublishTime: number;
    markPrice: number;
    oraclePrice: number;
    divergencePercent: number;
}

// ============================================================================
// Rebalance
// ============================================================================
export interface RebalanceDecision {
    shouldRebalance: boolean;
    reason: string;
    currentDelta: number;
    targetDelta: number;
    sizeToAdjust: number;
    estimatedSlippage: number;
    estimatedGasCost: number;
    blocked: boolean;
    blockReason?: string;
}

// ============================================================================
// Metrics
// ============================================================================
export interface CycleMetrics {
    cycleId: string;
    timestamp: number;
    lpFeesEarned: number;
    rebalanceCost: number;
    fundingPaid: number;
    slippageCost: number;
    gasCost: number;
    netPnl: number;
    deltaBeforeRebalance: number;
    deltaAfterRebalance: number;
}

// ============================================================================
// RPC Health
// ============================================================================
export interface RpcHealth {
    endpoint: string;
    latencyMs: number;
    lastBlockhash: string;
    lastBlockHeight: number;
    lastChecked: number;
    isHealthy: boolean;
    consecutiveFailures: number;
}

// ============================================================================
// Jito Bundle
// ============================================================================
export interface BundleResult {
    bundleId: string;
    status: 'pending' | 'landed' | 'failed' | 'expired';
    slot?: number;
    tipAccountUsed: string;
    tipAmount: number;
    txSignatures: string[];
    error?: string;
}

// ============================================================================
// Alerts
// ============================================================================
export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface Alert {
    id: string;
    severity: AlertSeverity;
    type: string;
    message: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
}
