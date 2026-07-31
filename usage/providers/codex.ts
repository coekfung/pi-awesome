import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { cacheKeyForAuth, clampPercent, windowLabel } from "../core.ts";
import type {
  UsageBucket,
  UsageGroup,
  UsageProviderAdapter,
} from "../types.ts";

// Expected JSON shape from the Codex usage endpoint

const CodexWindowSchema = Type.Object({
  used_percent: Type.Number(),
  limit_window_seconds: Type.Optional(Type.Number()),
});

const CodexRateLimitSchema = Type.Object({
  primary_window: Type.Optional(Type.Union([CodexWindowSchema, Type.Null()])),
  secondary_window: Type.Optional(Type.Union([CodexWindowSchema, Type.Null()])),
});

const CodexUsageResponseSchema = Type.Object({
  rate_limit: Type.Optional(CodexRateLimitSchema),
});

type CodexWindow = Static<typeof CodexWindowSchema>;
type CodexUsageResponse = Static<typeof CodexUsageResponseSchema>;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ADAPTER_ID = "openai-codex";

function normalizeGroups(data: CodexUsageResponse): UsageGroup[] {
  if (!data.rate_limit) return [];
  const buckets: UsageBucket[] = [];
  addWindow(buckets, data.rate_limit.primary_window);
  addWindow(buckets, data.rate_limit.secondary_window);
  return buckets.length > 0 ? [{ prefix: "codex", buckets }] : [];
}

function addWindow(
  buckets: UsageBucket[],
  window: CodexWindow | null | undefined,
): void {
  if (!window) return;
  buckets.push({
    label: windowLabel(window.limit_window_seconds ?? 0),
    remaining: clampPercent(100 - window.used_percent),
    limit: 100,
    unit: "percent",
  });
}

function authorizationFrom(auth: {
  apiKey?: string;
  headers?: Record<string, string | null>;
}): string | undefined {
  const headerVal = Object.entries(auth.headers ?? {}).find(
    ([key]) => key.toLowerCase() === "authorization",
  )?.[1];
  if (headerVal) return headerVal;
  return auth.apiKey ? `Bearer ${auth.apiKey}` : undefined;
}

export const codexAdapter: UsageProviderAdapter = {
  id: ADAPTER_ID,
  displayName: "OpenAI Codex",

  async query(model, registry, cache, signal) {
    const modelAuth = await registry.getApiKeyAndHeaders(model);

    const baseUrl = model.baseUrl ?? "";
    if (!baseUrl.startsWith("https://chatgpt.com")) return [];

    // Extract authorization from model-level or provider-level auth
    let authHeaders: Record<string, string> = {};
    if (modelAuth.ok) {
      const authz = authorizationFrom({
        apiKey: modelAuth.apiKey,
        headers: modelAuth.headers,
      });
      if (authz) authHeaders.Authorization = authz;
    }
    if (!authHeaders.Authorization) {
      const provider = await registry.getProviderAuth(ADAPTER_ID);
      if (provider) {
        const authz = authorizationFrom({
          apiKey: provider.auth.apiKey,
          headers: provider.auth.headers,
        });
        if (authz) authHeaders.Authorization = authz;
      }
    }
    if (!authHeaders.Authorization) return [];

    const cacheKey = cacheKeyForAuth(ADAPTER_ID, {
      headers: authHeaders,
    });

    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const response = await fetch(CODEX_USAGE_URL, {
      headers: authHeaders,
      signal,
    });
    if (!response.ok) {
      throw new Error(`Codex usage returned ${response.status}`);
    }

    const raw = await response.json();
    const data = Value.Parse(CodexUsageResponseSchema, raw);
    const groups = normalizeGroups(data);

    cache.set(cacheKey, groups);
    return groups;
  },
};
