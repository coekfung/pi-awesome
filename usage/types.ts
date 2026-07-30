import type { LRUCache } from "lru-cache";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, JsonValue>;

export interface UsageBucket {
  label: string;
  remaining: number;
  limit: number;
  unit: "percent" | "count" | "usd";
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
    cache: LRUCache<string, JsonObject>,
    signal: AbortSignal,
  ): Promise<UsageGroup[]>;
}
