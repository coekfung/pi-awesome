import { Type } from "typebox";
import { Value } from "typebox/value";

import { cacheKeyForAuth } from "../core.ts";
import type {
  UsageBucket,
  UsageGroup,
  UsageProviderAdapter,
} from "../types.ts";

// Expected JSON shape from the DeepSeek balance endpoint

const DeepSeekBalanceInfoSchema = Type.Object({
  currency: Type.String(),
  total_balance: Type.String(),
});

const DeepSeekBalanceResponseSchema = Type.Object({
  balance_infos: Type.Array(DeepSeekBalanceInfoSchema),
});

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

function normalizeGroups(data: {
  balance_infos: { currency: string; total_balance: string }[];
}): UsageGroup[] {
  const buckets: UsageBucket[] = [];
  for (const info of data.balance_infos) {
    const remaining = Number(info.total_balance);
    if (!Number.isFinite(remaining)) continue;
    buckets.push({
      label: "rem",
      remaining,
      limit: remaining,
      unit: info.currency.toUpperCase() === "CNY" ? "cny" : "usd",
    });
  }
  return buckets.length > 0 ? [{ prefix: "deepseek", buckets }] : [];
}

export const deepseekAdapter: UsageProviderAdapter = {
  id: "deepseek",
  displayName: "DeepSeek",

  async query(model, registry, cache, signal) {
    const modelAuth = await registry.getApiKeyAndHeaders(model);
    if (!modelAuth.ok || !modelAuth.apiKey) return [];

    const cacheKey = cacheKeyForAuth("deepseek", {
      apiKey: modelAuth.apiKey,
    });
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const url = new URL("/user/balance", model.baseUrl ?? DEEPSEEK_BASE_URL);
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${modelAuth.apiKey}`,
      },
      signal,
    });
    if (!response.ok) {
      throw new Error(`DeepSeek balance returned ${response.status}`);
    }

    const raw = await response.json();
    const data = Value.Parse(DeepSeekBalanceResponseSchema, raw);
    const groups = normalizeGroups(data);

    cache.set(cacheKey, groups);
    return groups;
  },
};
