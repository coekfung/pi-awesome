/**
 * Compact performance footer and /perf per-turn viewer for pi.
 *
 * Display format:
 *   🚀 Perf: 820ms, ≈31.2t/s
 *
 * Convention used by this lightweight extension:
 * - `ms` is TTFT to the first non-empty streamed assistant delta.
 * - The first streamed delta may be `text_delta`, `thinking_delta`, or `tool_calls_delta`.
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
 * - Persisted metrics store only TTFT and generation duration; `/perf` reads provider/model/output usage from the preceding assistant message.
 * - If no qualifying streamed delta or output usage is available, the footer shows `?`.
 */
import { performance } from "node:perf_hooks";
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  SelectList,
  Text,
  TruncatedText,
  visibleWidth,
  type SelectItem,
} from "@mariozechner/pi-tui";

interface PerfMetrics {
  ttft?: number;
  duration: number;
}

interface PerfModel {
  provider: string;
  modelId: string;
}

interface PerfMetricEntry {
  id: string;
  timestamp: string;
  ttft?: number;
  duration: number;
  outputTokens?: number;
  tps?: number;
  model?: PerfModel;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNumber = (value: unknown): value is number => typeof value === "number";

const isPerfMetrics = (value: unknown): value is PerfMetrics => {
  if (!isRecord(value)) return false;

  return (
    (value.ttft === undefined || isNumber(value.ttft)) &&
    isNumber(value.duration)
  );
};

const calculateTps = (outputTokens: number | undefined, durationMs: number) =>
  outputTokens !== undefined && outputTokens > 0 && durationMs > 0
    ? outputTokens / (durationMs / 1000)
    : undefined;

const getPerfMetricEntries = (ctx: ExtensionContext): PerfMetricEntry[] => {
  const metrics: PerfMetricEntry[] = [];
  let lastAssistant:
    | { model: PerfModel; outputTokens: number | undefined }
    | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const output = entry.message.usage?.output;
      lastAssistant = {
        model: {
          provider: entry.message.provider,
          modelId: entry.message.model,
        },
        outputTokens: isNumber(output) ? output : undefined,
      };
      continue;
    }

    if (entry.type !== "custom" || entry.customType !== "perf-metrics")
      continue;

    const data = entry.data;
    if (!isPerfMetrics(data)) continue;

    metrics.push({
      id: entry.id,
      timestamp: entry.timestamp,
      ttft: data.ttft,
      duration: data.duration,
      outputTokens: lastAssistant?.outputTokens,
      tps: calculateTps(lastAssistant?.outputTokens, data.duration),
      model: lastAssistant?.model,
    });
    lastAssistant = undefined;
  }

  return metrics;
};

const SELECT_LIST_COLUMN_GAP = 2;

const average = (values: number[]) =>
  values.length === 0
    ? undefined
    : values.reduce((sum, value) => sum + value, 0) / values.length;

export default function (pi: ExtensionAPI) {
  let requestStartAt: number | undefined;
  let firstTokenAt: number | undefined;
  let lastTtftMs: number | undefined;
  let lastTps: number | undefined;
  let ttftIsStale = false;
  let tpsIsStale = false;
  let pendingMetrics: PerfMetrics | undefined;

  const STATUS_KEY = "ttft";
  const STATUS_PREFIX = "🚀 perf:";

  const formatTtft = (ttftMs?: number) =>
    ttftMs === undefined ? "?ms" : `${ttftMs}ms`;
  const formatTps = (tps?: number) =>
    tps === undefined ? "≈?t/s" : `≈${tps.toFixed(1)}t/s`;
  const formatDuration = (durationMs: number) =>
    durationMs < 1000
      ? `${Math.round(durationMs)}ms`
      : `${(durationMs / 1000).toFixed(1)}s`;
  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleTimeString();
  };
  const formatModel = (model?: PerfModel) =>
    model ? `${model.provider}/${model.modelId}` : "unknown model";
  const formatOutputTokens = (outputTokens?: number) =>
    outputTokens === undefined ? "?" : outputTokens.toString();

  const updateStatus = (ctx: ExtensionContext) => {
    const prefix = ctx.ui.theme.fg("accent", `${STATUS_PREFIX} `);
    const separator = ctx.ui.theme.fg("accent", ", ");
    const ttftText = formatTtft(lastTtftMs);
    const tpsText = formatTps(lastTps);
    const ttft = ttftIsStale ? ttftText : ctx.ui.theme.fg("accent", ttftText);
    const tps = tpsIsStale ? tpsText : ctx.ui.theme.fg("accent", tpsText);
    ctx.ui.setStatus(STATUS_KEY, `${prefix}${ttft}${separator}${tps}`);
  };

  pi.registerCommand("perf", {
    description: "Show per-turn performance metrics",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/perf requires interactive mode", "error");
        return;
      }

      const metrics = getPerfMetricEntries(ctx);
      if (metrics.length === 0) {
        ctx.ui.notify("No perf metrics yet", "info");
        return;
      }

      const avgTtft = average(
        metrics.map((metric) => metric.ttft).filter(isNumber),
      );
      const avgTps = average(
        metrics.map((metric) => metric.tps).filter(isNumber),
      );
      const avgDuration = average(metrics.map((metric) => metric.duration));
      const rows = metrics.map((metric, index) => ({
        metric,
        turn: String(index + 1),
        output: formatOutputTokens(metric.outputTokens),
        ttft: formatTtft(metric.ttft),
        tps: formatTps(metric.tps),
        duration: formatDuration(metric.duration),
      }));
      const maxWidth = (values: string[]) =>
        Math.max(...values.map((value) => visibleWidth(value)));
      const turnWidth = maxWidth(rows.map((row) => row.turn));
      const outputWidth = maxWidth(rows.map((row) => row.output));
      const ttftWidth = maxWidth(rows.map((row) => row.ttft));
      const tpsWidth = maxWidth(rows.map((row) => row.tps));
      const durationWidth = maxWidth(rows.map((row) => row.duration));
      const items: SelectItem[] = rows.map((row) => ({
        value: row.metric.id,
        label: `#${row.turn.padStart(turnWidth)}  out ${row.output.padStart(outputWidth)}  ttft ${row.ttft.padStart(ttftWidth)}  tps ${row.tps.padStart(tpsWidth)}  gen ${row.duration.padStart(durationWidth)}`,
        description: `${formatModel(row.metric.model)} • ${formatTimestamp(row.metric.timestamp)}`,
      }));
      const desiredMetricColumnWidth =
        maxWidth(items.map((item) => item.label)) + SELECT_LIST_COLUMN_GAP;

      await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
        const maxVisible = Math.max(5, Math.floor(tui.terminal.rows / 2));
        const metricColumnWidth = Math.min(
          desiredMetricColumnWidth,
          Math.max(40, Math.floor(tui.terminal.columns * 0.65)),
        );
        const container = new Container();
        const border = () =>
          new DynamicBorder((text: string) => theme.fg("accent", text));
        const turnLabel = metrics.length === 1 ? "turn" : "turns";
        const summary = `${metrics.length} ${turnLabel} • avg ${formatTtft(
          avgTtft === undefined ? undefined : Math.round(avgTtft),
        )}, ${formatTps(avgTps)} • avg gen ${formatDuration(avgDuration ?? 0)}`;

        const keyText = (
          keybinding:
            | "tui.select.up"
            | "tui.select.down"
            | "tui.select.confirm"
            | "tui.select.cancel",
        ) => keybindings.getKeys(keybinding).join("/");

        const selectList = new SelectList(
          items,
          maxVisible,
          {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          },
          {
            minPrimaryColumnWidth: metricColumnWidth,
            maxPrimaryColumnWidth: metricColumnWidth,
          },
        );

        selectList.setSelectedIndex(items.length - 1);
        selectList.onSelect = () => done();
        selectList.onCancel = () => done();

        container.addChild(border());
        container.addChild(
          new Text(theme.fg("accent", theme.bold("  🚀 Perf Metrics")), 0, 0),
        );
        container.addChild(
          new TruncatedText(
            theme.fg(
              "muted",
              `  ${keyText("tui.select.up")}/${keyText("tui.select.down")}: move. ${keyText("tui.select.confirm")}/${keyText("tui.select.cancel")}: close`,
            ),
            0,
            0,
          ),
        );
        container.addChild(new Text(theme.fg("muted", `  ${summary}`), 0, 0));
        container.addChild(border());
        container.addChild(selectList);
        container.addChild(border());

        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    requestStartAt = performance.now();
    firstTokenAt = undefined;
    ttftIsStale = lastTtftMs !== undefined;
    tpsIsStale = lastTps !== undefined;
    pendingMetrics = undefined;
    updateStatus(ctx);
    ctx.ui.setWorkingMessage("Warming up the neurons...");
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (firstTokenAt !== undefined) return;

    const streamEvent = event.assistantMessageEvent;
    if (
      streamEvent.type !== "text_delta" &&
      streamEvent.type !== "thinking_delta" &&
      streamEvent.type !== "toolcall_delta"
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

    // Defer appendEntry to turn_end so the assistant message is already
    // persisted in the session tree (message_end fires before persistence).
    pendingMetrics = {
      ttft: lastTtftMs,
      duration: generationMs,
    };
  });

  pi.on("turn_end", async (_event, _ctx) => {
    if (pendingMetrics) {
      pi.appendEntry<PerfMetrics>("perf-metrics", pendingMetrics);
      pendingMetrics = undefined;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
  });
}
