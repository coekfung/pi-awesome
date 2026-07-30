import { LRUCache } from "lru-cache";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { formatUsageStatusline } from "./core.js";
import { codexAdapter } from "./providers/codex.js";
import type { UsageGroup, UsageProviderAdapter } from "./types.js";

const STATUS_KEY = "usage";
const CACHE_MAX = 32;
const CACHE_TTL_MS = 5 * 60 * 1000;
const QUERY_TIMEOUT_MS = 15_000;

export default function usageExtension(pi: ExtensionAPI) {
  const cache = new LRUCache<string, UsageGroup[]>({
    max: CACHE_MAX,
    ttl: CACHE_TTL_MS,
  });

  let pending = false;
  let controller: AbortController | undefined;

  const clearStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const refreshStatus = async (
    ctx: ExtensionContext,
    signal: AbortSignal,
    current: AbortController,
  ) => {
    const model = ctx.model;
    if (!model) {
      clearStatus(ctx);
      return;
    }

    const adapter = adapters.find((a) => a.id === model.provider);
    if (!adapter) {
      clearStatus(ctx);
      return;
    }

    try {
      const groups = await adapter.query(
        model,
        ctx.modelRegistry,
        cache,
        signal,
      );

      if (controller === current && !signal.aborted) {
        ctx.ui.setStatus(STATUS_KEY, formatUsageStatusline(groups, ctx));
      }
    } catch {
      if (controller === current && !signal.aborted) clearStatus(ctx);
    }
  };

  const scheduleRefresh = (ctx: ExtensionContext, force = false) => {
    if (pending) {
      if (!force) return;
      controller?.abort();
    }
    pending = true;
    const current = new AbortController();
    controller = current;
    void refreshStatus(
      ctx,
      AbortSignal.any([current.signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]),
      current,
    ).finally(() => {
      if (controller === current) pending = false;
    });
  };

  pi.on("session_start", (_event, ctx) => {
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
    controller?.abort();
    controller = undefined;
    pending = false;
    cache.clear();
    clearStatus(ctx);
  });
}

const adapters: UsageProviderAdapter[] = [codexAdapter];
