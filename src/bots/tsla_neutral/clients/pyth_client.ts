/**
 * Pyth Oracle Client
 * 
 * Fetches price data from Pyth Network via Hermes API.
 * Uses the new hermes-client for fresh price updates.
 */

import { HermesClient } from '@pythnetwork/hermes-client';
import { config } from '../config';
import { PriceData } from '../types';
import { loggers } from '../observability/logger';
import { oracleDivergenceGauge } from '../observability/metrics';

const log = loggers.risk;

// Pyth price feed response
interface PythPrice {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
}

interface PythPriceUpdate {
    id: string;
    price: PythPrice;
    ema_price: PythPrice;
}

export class PythClient {
    private hermesClient: HermesClient;
    private tslaPriceFeedId: string;
    private lastPriceUpdate: PythPriceUpdate | null = null;

    constructor() {
        this.hermesClient = new HermesClient(config.PYTH_HERMES_ENDPOINT);
        // Strip 0x prefix if present (Hermes API expects raw hex)
        const feedId = config.PYTH_TSLA_PRICE_FEED_ID;
        this.tslaPriceFeedId = feedId.startsWith('0x') ? feedId.slice(2) : feedId;
    }

    /**
     * Fetch latest price update for TSLA.
     */
    async fetchLatestPrice(): Promise<PythPriceUpdate | null> {
        if (!this.tslaPriceFeedId) {
            log.warn({ event: 'no_price_feed_id', msg: 'PYTH_TSLA_PRICE_FEED_ID not configured' });
            return null;
        }

        try {
            log.debug({ event: 'fetching_pyth_price', feedId: this.tslaPriceFeedId });

            const priceUpdates = await this.hermesClient.getLatestPriceUpdates([this.tslaPriceFeedId]);

            if (priceUpdates.parsed && priceUpdates.parsed.length > 0) {
                const update = priceUpdates.parsed[0] as PythPriceUpdate;
                this.lastPriceUpdate = update;
                return update;
            }

            return null;
        } catch (error) {
            log.error({
                event: 'pyth_fetch_error',
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    /**
     * Convert Pyth price to number.
     */
    private pythPriceToNumber(price: PythPrice): number {
        return Number(price.price) * Math.pow(10, price.expo);
    }

    /**
     * Get TSLA price in USD.
     */
    async getTSLAPrice(): Promise<{ price: number; confidence: number; publishTime: number } | null> {
        const update = await this.fetchLatestPrice();
        if (!update) {
            return null;
        }

        return {
            price: this.pythPriceToNumber(update.price),
            confidence: Number(update.price.conf) * Math.pow(10, update.price.expo),
            publishTime: update.price.publish_time,
        };
    }

    /**
     * Check if Pyth price is stale.
     */
    isPriceStale(maxAgeSeconds: number = 60): boolean {
        if (!this.lastPriceUpdate) {
            return true;
        }

        const now = Math.floor(Date.now() / 1000);
        return now - this.lastPriceUpdate.price.publish_time > maxAgeSeconds;
    }

    /**
     * Check if confidence interval is acceptable.
     */
    isConfidenceAcceptable(thresholdPercent: number = config.PYTH_CONFIDENCE_THRESHOLD_PERCENT): boolean {
        if (!this.lastPriceUpdate) {
            return false;
        }

        const price = this.pythPriceToNumber(this.lastPriceUpdate.price);
        const confidence = Number(this.lastPriceUpdate.price.conf) * Math.pow(10, this.lastPriceUpdate.price.expo);
        const confidencePercent = confidence / price;

        return confidencePercent <= thresholdPercent;
    }

    /**
     * Build PriceData object by comparing Pyth price with pool price.
     */
    buildPriceData(poolPrice: number, markPrice?: number): PriceData | null {
        if (!this.lastPriceUpdate) {
            return null;
        }

        const pythPrice = this.pythPriceToNumber(this.lastPriceUpdate.price);
        const pythConfidence = Number(this.lastPriceUpdate.price.conf) * Math.pow(10, this.lastPriceUpdate.price.expo);
        const divergencePercent = (poolPrice - pythPrice) / pythPrice;

        const priceData: PriceData = {
            poolPrice,
            pythPrice,
            pythConfidence,
            pythPublishTime: this.lastPriceUpdate.price.publish_time,
            markPrice: markPrice ?? poolPrice,
            oraclePrice: pythPrice,
            divergencePercent,
        };

        oracleDivergenceGauge.set(Math.abs(divergencePercent) * 100);

        return priceData;
    }

    /**
     * Get VAA for on-chain price update.
     * This is needed if the protocol requires a fresh Pyth update in the TX.
     */
    async getVAA(): Promise<string | null> {
        if (!this.tslaPriceFeedId) {
            return null;
        }

        try {
            const priceUpdates = await this.hermesClient.getLatestPriceUpdates([this.tslaPriceFeedId]);

            if (priceUpdates.binary && priceUpdates.binary.data && priceUpdates.binary.data.length > 0) {
                return priceUpdates.binary.data[0];
            }

            return null;
        } catch (error) {
            log.error({
                event: 'vaa_fetch_error',
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }
}
