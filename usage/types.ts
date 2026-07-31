import type { LRUCache } from "lru-cache";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export interface UsageBucket {
  label: string;
  remaining: number;
  limit: number;
  unit: "percent" | "count" | "usd" | "cny";
}

export interface UsageGroup {
  prefix: string;
  buckets: UsageBucket[];
}

export interface UsageProviderAdapter {
  id: string;
  displayName: string;
  query(
    model: Model<Api>,
    registry: ModelRegistry,
    cache: LRUCache<string, UsageGroup[]>,
    signal: AbortSignal,
    config?: any,
  ): Promise<UsageGroup[]>;
}
