import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { cacheKeyForAuth, windowLabel } from "../core.js";
import type {
  UsageBucket,
  UsageGroup,
  UsageProviderAdapter,
} from "../types.js";

// Expected JSON shape from the Codex usage endpoint

const CodexWindowSchema = Type.Object({
  used_percent: Type.Number(),
  limit_window_seconds: Type.Optional(Type.Number()),
});

const CodexRateLimitSchema = Type.Object({
  primary_window: Type.Optional(Type.Union([CodexWindowSchema, Type.Null()])),
  secondary_window: Type.Optional(Type.Union([CodexWindowSchema, Type.Null()])),
});

const CodexLimitSchema = Type.Object({
  limit_name: Type.Optional(Type.String()),
  rate_limit: Type.Optional(Type.Union([CodexRateLimitSchema, Type.Null()])),
});

const CodexUsageResponseSchema = Type.Object({
  rate_limit: Type.Optional(CodexRateLimitSchema),
  additional_rate_limits: Type.Optional(
    Type.Union([Type.Array(CodexLimitSchema), Type.Null()]),
  ),
});

type CodexWindow = Static<typeof CodexWindowSchema>;
type CodexRateLimit = Static<typeof CodexRateLimitSchema>;
type CodexUsageResponse = Static<typeof CodexUsageResponseSchema>;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function normalizeGroups(data: CodexUsageResponse): UsageGroup[] {
  const groups: UsageGroup[] = [];

  if (data.rate_limit) {
    const buckets = groupBuckets(data.rate_limit);
    if (buckets.length > 0) groups.push({ prefix: "codex", buckets });
  }

  for (const item of data.additional_rate_limits ?? []) {
    const id = item.limit_name;
    if (!id || !item.rate_limit) continue;
    const prefix = groupPrefix(id);
    if (groups.some((g) => g.prefix === prefix)) continue;
    const buckets = groupBuckets(item.rate_limit);
    if (buckets.length > 0) groups.push({ prefix, buckets });
  }

  return groups;
}

function groupBuckets(rateLimit: CodexRateLimit): UsageBucket[] {
  const buckets: UsageBucket[] = [];
  addWindow(buckets, rateLimit.primary_window);
  addWindow(buckets, rateLimit.secondary_window);
  return buckets;
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

function groupPrefix(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function selectGroups(groups: UsageGroup[], modelId: string): UsageGroup[] {
  if (groups.length === 0) return [];

  const normalized = normalizeKey(modelId);
  if (!normalized) return [];

  const modelKey = `-${normalized}-`;
  let match: { group: UsageGroup; keyLength: number } | undefined;
  for (const group of groups) {
    const key = normalizeKey(group.prefix);
    if (
      key &&
      modelKey.includes(`-${key}-`) &&
      (!match || key.length > match.keyLength)
    ) {
      match = { group, keyLength: key.length };
    }
  }

  if (match) return [match.group];

  return [
    groups.find((g) => g.prefix === "codex") ?? (groups[0] as UsageGroup),
  ];
}

function normalizeKey(value: string): string | undefined {
  const separated = value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = separated.length;
  while (separated[start] === "-") start += 1;
  while (end > start && separated[end - 1] === "-") end -= 1;
  return separated.slice(start, end) || undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
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
  id: "openai-codex",
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
      const provider = await registry.getProviderAuth("openai-codex");
      if (provider) {
        const authz = authorizationFrom({
          apiKey: provider.auth.apiKey,
          headers: provider.auth.headers,
        });
        if (authz) authHeaders.Authorization = authz;
      }
    }
    if (!authHeaders.Authorization) return [];

    const cacheKey = cacheKeyForAuth("openai-codex", {
      headers: authHeaders,
    });

    const cached = cache.get(cacheKey);
    if (cached) {
      return selectGroups(cached, model.id);
    }

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
    return selectGroups(groups, model.id);
  },
};
