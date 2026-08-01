import type { LRUCache } from "lru-cache";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export interface QuotaBucket {
  label: string;
  remaining: number;
  limit: number;
  unit: "percent" | "count" | "usd" | "cny";
}

export interface QuotaGroup {
  prefix: string;
  buckets: QuotaBucket[];
}

export interface QuotaProviderAdapter {
  id: string;
  displayName: string;
  query(
    model: Model<Api>,
    registry: ModelRegistry,
    cache: LRUCache<string, QuotaGroup[]>,
    signal: AbortSignal,
    config?: any,
  ): Promise<QuotaGroup[]>;
}
