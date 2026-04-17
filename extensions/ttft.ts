/**
 * Compact performance footer for pi.
 *
 * Display format:
 *   🚀 Perf: 820ms, ≈31.2t/s
 *
 * Convention used by this lightweight extension:
 * - `ms` is TTFT to the first non-empty streamed assistant delta.
 * - The first streamed delta may be either `text_delta` or `thinking_delta`.
 * - `≈t/s` is an approximate provider-based throughput, not strict Visible TPS.
 *
 * Formulas:
 * - TTFT = t_first_streamed_delta - t_request_start
 * - Approx_TPS = provider_usage.output / (t_message_end - t_first_streamed_delta)
 *
 * Notes:
 * - Metrics are scoped to the latest provider request, not the full user prompt lifecycle.
 * - If the agent performs tool calls and sends another model request, the previous perf status stays visible until replacement metrics are available.
 * - While replacement metrics are pending, the prefix and separator stay accented while only stale TTFT/TPS values are shown without extra coloring.
 * - `provider_usage.output` may include provider-specific reasoning/output accounting.
 * - If no qualifying streamed delta or output usage is available, the footer shows `?`.
 */
import { performance } from "node:perf_hooks";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let requestStartAt: number | undefined;
  let firstTokenAt: number | undefined;
  let lastTtftMs: number | undefined;
  let lastTps: number | undefined;
  let ttftIsStale = false;
  let tpsIsStale = false;

  const STATUS_KEY = "ttft";
  const STATUS_PREFIX = "🚀";

  const formatTtft = (ttftMs?: number) =>
    ttftMs === undefined ? "?ms" : `${ttftMs}ms`;
  const formatTps = (tps?: number) =>
    tps === undefined ? "≈?t/s" : `≈${tps.toFixed(1)}t/s`;

  const updateStatus = (ctx: ExtensionContext) => {
    const prefix = ctx.ui.theme.fg("accent", `${STATUS_PREFIX} Perf: `);
    const separator = ctx.ui.theme.fg("accent", ", ");
    const ttftText = formatTtft(lastTtftMs);
    const tpsText = formatTps(lastTps);
    const ttft = ttftIsStale ? ttftText : ctx.ui.theme.fg("accent", ttftText);
    const tps = tpsIsStale ? tpsText : ctx.ui.theme.fg("accent", tpsText);
    ctx.ui.setStatus(STATUS_KEY, `${prefix}${ttft}${separator}${tps}`);
  };

  pi.on("before_provider_request", async (_event, ctx) => {
    requestStartAt = performance.now();
    firstTokenAt = undefined;
    ttftIsStale = lastTtftMs !== undefined;
    tpsIsStale = lastTps !== undefined;
    updateStatus(ctx);
    ctx.ui.setWorkingMessage("Warming up the neurons...");
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (firstTokenAt !== undefined) return;

    const streamEvent = event.assistantMessageEvent;
    if (
      streamEvent.type !== "text_delta" &&
      streamEvent.type !== "thinking_delta"
    )
      return;
    if (!streamEvent.delta.trim()) return;

    const now = performance.now();
    firstTokenAt = now;
    lastTtftMs =
      requestStartAt === undefined
        ? undefined
        : Math.round(now - requestStartAt);
    ttftIsStale = false;
    updateStatus(ctx);
    ctx.ui.setWorkingMessage("Thoughts on the move...");
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (firstTokenAt === undefined) return;

    const generationMs = performance.now() - firstTokenAt;
    const outputTokens = event.message.usage?.output;
    lastTps =
      typeof outputTokens === "number" && outputTokens > 0 && generationMs > 0
        ? outputTokens / (generationMs / 1000)
        : undefined;
    tpsIsStale = false;
    updateStatus(ctx);
    ctx.ui.setWorkingMessage();
  });

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
  });
}
