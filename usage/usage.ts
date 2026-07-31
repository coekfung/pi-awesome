import { LRUCache } from "lru-cache";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ResourceDiagnostic,
} from "@earendil-works/pi-coding-agent";

import { formatUsageStatusline, parseConfigFile, type Config } from "./core.ts";
import { codexAdapter } from "./providers/codex.ts";
import { deepseekAdapter } from "./providers/deepseek.ts";
import { opencodeGoAdapter } from "./providers/opencode-go.ts";
import type { UsageGroup, UsageProviderAdapter } from "./types.ts";

const STATUS_KEY = "usage";
const CACHE_MAX = 32;
const CACHE_TTL_MS = 5 * 60 * 1000;
const QUERY_TIMEOUT_MS = 15_000;

export default function usageExtension(pi: ExtensionAPI) {
  const cache = new LRUCache<string, UsageGroup[]>({
    max: CACHE_MAX,
    ttl: CACHE_TTL_MS,
  });

  // Controller of the in-flight query; undefined when idle. Superseding or
  // shutdown always aborts first, so `signal.aborted` marks a stale refresh.
  let inFlight: AbortController | undefined;

  // usage.json merged config for the current session, passed to adapters.
  let config: Config = {};

  // Usage queries repeat every turn, so each distinct failure is reported
  // once per session instead of on every refresh.
  const notifiedFailures = new Set<string>();

  const clearStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const refreshStatus = async (ctx: ExtensionContext, signal: AbortSignal) => {
    const model = ctx.model;
    const adapter = model && adapters.find((a) => a.id === model.provider);
    if (!model || !adapter) {
      clearStatus(ctx);
      return;
    }

    try {
      const groups = await adapter.query(
        model,
        ctx.modelRegistry,
        cache,
        signal,
        config?.[adapter.id],
      );

      if (!signal.aborted) {
        ctx.ui.setStatus(STATUS_KEY, formatUsageStatusline(groups, ctx));
      }
    } catch (error) {
      if (signal.aborted) return;
      clearStatus(ctx);
      const msg = error instanceof Error ? error.message : String(error);
      const key = `${adapter.id}:${msg}`;
      if (!notifiedFailures.has(key)) {
        notifiedFailures.add(key);
        ctx.ui.notify(`Usage: ${adapter.displayName}: ${msg}`, "warning");
      }
    }
  };

  const scheduleRefresh = (ctx: ExtensionContext, force = false) => {
    if (inFlight) {
      if (!force) return;
      inFlight.abort();
    }
    const current = new AbortController();
    inFlight = current;
    void refreshStatus(
      ctx,
      AbortSignal.any([current.signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]),
    ).finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
  };

  pi.on("session_start", (_event, ctx) => {
    const diagnostics: ResourceDiagnostic[] = [];
    config = parseConfigFile(join(getAgentDir(), "usage.json"), diagnostics);
    for (const d of diagnostics) {
      ctx.ui.notify(`Usage: ${d.message} (${d.path})`, "warning");
    }
    notifiedFailures.clear();
    scheduleRefresh(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    scheduleRefresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    scheduleRefresh(ctx, true);
  });

  pi.on("turn_start", (_event, ctx) => {
    scheduleRefresh(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    inFlight?.abort();
    inFlight = undefined;
    config = {};
    cache.clear();
    clearStatus(ctx);
  });
}

const adapters: UsageProviderAdapter[] = [
  codexAdapter,
  deepseekAdapter,
  opencodeGoAdapter,
];
