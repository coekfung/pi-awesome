/**
 * Compact performance footer for pi.
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
 * - If no qualifying streamed delta or output usage is available, the footer shows `?`.
 */
import { performance } from "node:perf_hooks";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text, Spacer, matchesKey, Key } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
  let requestStartAt: number | undefined;
  let firstTokenAt: number | undefined;
  let lastTtftMs: number | undefined;
  let lastTps: number | undefined;
  let ttftIsStale = false;
  let tpsIsStale = false;
  let pendingMetrics:
    | { ttft?: number; tps?: number; duration: number }
    | undefined;

  const STATUS_KEY = "ttft";
  const STATUS_PREFIX = "🚀 perf:";

  const formatTtft = (ttftMs?: number) =>
    ttftMs === undefined ? "?ms" : `${ttftMs}ms`;
  const formatTps = (tps?: number) =>
    tps === undefined ? "≈?t/s" : `≈${tps.toFixed(1)}t/s`;

  const updateStatus = (ctx: ExtensionContext) => {
    const prefix = ctx.ui.theme.fg("accent", `${STATUS_PREFIX} `);
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
      tps: lastTps,
      duration: generationMs,
    };
  });

  pi.on("turn_end", async (_event, _ctx) => {
    if (pendingMetrics) {
      pi.appendEntry("perf-metrics", pendingMetrics);
      pendingMetrics = undefined;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
  });

  interface PerfDisplayEntry {
    turn: number;
    ttft?: number;
    duration: number;
    tps?: number;
    totalOutput?: number;
    provider?: string;
    model?: string;
    time: string;
  }

  const collectPerfEntries = (sm: {
    getEntries(): unknown[];
  }): PerfDisplayEntry[] => {
    const all = sm.getEntries() as {
      type: string;
      id: string;
      parentId: string | null;
      timestamp: string;
      customType?: string;
      data?: { ttft?: number; tps?: number; duration: number };
      message?: {
        role: string;
        provider?: string;
        model?: string;
        usage?: { output?: number };
      };
    }[];
    const idMap = new Map(all.map((e: { id: string }) => [e.id, e]));

    const perfEntries = all.filter(
      (e: { type: string; customType?: string }) =>
        e.type === "custom" && e.customType === "perf-metrics",
    ) as {
      parentId: string | null;
      timestamp: string;
      data?: { ttft?: number; tps?: number; duration: number };
    }[];

    return perfEntries.map((perfEntry, i) => {
      // Walk parent chain to find the nearest assistant message
      let currentId: string | null = perfEntry.parentId;
      let assistantMsg:
        | { provider?: string; model?: string; usage?: { output?: number } }
        | undefined;
      while (currentId) {
        const entry = idMap.get(currentId) as
          | {
              type: string;
              parentId?: string | null;
              message?: {
                role: string;
                provider?: string;
                model?: string;
                usage?: { output?: number };
              };
            }
          | undefined;
        if (!entry) break;
        if (entry.type === "message" && entry.message?.role === "assistant") {
          assistantMsg = entry.message;
          break;
        }
        currentId = entry.parentId ?? null;
      }

      const totalOutput = assistantMsg?.usage?.output;
      const duration = perfEntry.data?.duration ?? 0;
      const tps =
        typeof totalOutput === "number" && duration > 0
          ? totalOutput / (duration / 1000)
          : undefined;

      return {
        turn: i + 1,
        ttft: perfEntry.data?.ttft,
        duration,
        tps,
        totalOutput,
        provider: assistantMsg?.provider,
        model: assistantMsg?.model,
        time: (() => {
          const d = new Date(perfEntry.timestamp);
          const pad = (n: number) => String(n).padStart(2, "0");
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        })(),
      };
    });
  };

  pi.registerCommand("perf", {
    description: "Show per-turn performance metrics",
    handler: async (_args, ctx) => {
      const entries = collectPerfEntries(ctx.sessionManager);
      if (entries.length === 0) {
        ctx.ui.notify("No perf metrics yet. Run some prompts first.", "info");
        return;
      }

      await ctx.ui.custom((tui, theme, _kb, done) => {
        const maxVisible = Math.max(5, Math.floor(tui.terminal.rows / 2));
        let cursor = 0;
        let offset = 0;

        const W_NUM = 5;
        const W_TIME = 17;
        const W_TTFT = 8;
        const W_TPS = 10;
        const W_DUR = 7;

        const padLeft = (s: string, w: number) => s.padStart(w);

        const header = () => {
          const num = "#".padEnd(W_NUM);
          const time = "Time".padEnd(W_TIME);
          const ttft = "TTFT".padEnd(W_TTFT);
          const tps = "TPS".padEnd(W_TPS);
          const dur = "Dur".padEnd(W_DUR);
          return `  ${num}  ${ttft}  ${tps}  ${dur}  ${time}  Model`;
        };

        const renderRow = (e: PerfDisplayEntry, selected: boolean) => {
          const num = String(e.turn).padEnd(W_NUM);
          const ttftColor = e.ttft !== undefined ? "success" : "warning";
          const ttft = theme.fg(
            ttftColor,
            padLeft(e.ttft !== undefined ? `${e.ttft}ms` : "?ms", W_TTFT),
          );
          const tpsColor = e.tps !== undefined ? "success" : "warning";
          const tps = theme.fg(
            tpsColor,
            padLeft(
              e.tps !== undefined ? `${e.tps.toFixed(1)}t/s` : "?t/s",
              W_TPS,
            ),
          );
          const dur = theme.fg(
            "success",
            padLeft(`${(e.duration / 1000).toFixed(1)}s`, W_DUR),
          );
          const model = theme.fg(
            "dim",
            `${e.provider ?? "?"} / ${e.model ?? "?"}`,
          );
          const time = theme.fg("dim", e.time.padEnd(W_TIME));
          const prefix = selected ? theme.fg("accent", "› ") : "  ";
          let line = `${prefix}${num}  ${ttft}  ${tps}  ${dur}  ${time}  ${model}`;
          if (selected) {
            line = theme.bg("selectedBg", line);
          }
          return line;
        };

        const container = new Container();

        const buildUI = () => {
          container.clear();
          container.addChild(new Spacer(1));
          container.addChild(new DynamicBorder());
          container.addChild(
            new Text(
              theme.fg(
                "accent",
                theme.bold(`  Perf Metrics (${entries.length} turns)`),
              ),
              1,
              0,
            ),
          );
          container.addChild(
            new Text(theme.fg("muted", "  ↑↓ scroll · esc close"), 1, 0),
          );
          container.addChild(new DynamicBorder());
          container.addChild(new Text(theme.fg("dim", header()), 1, 0));
          container.addChild(new Spacer(1));

          const visible = entries.slice(offset, offset + maxVisible);
          for (const e of visible) {
            container.addChild(
              new Text(renderRow(e, e.turn - 1 === cursor), 1, 0),
            );
          }
          for (let i = visible.length; i < maxVisible; i++) {
            container.addChild(new Spacer(1));
          }

          container.addChild(new Spacer(1));
          container.addChild(
            new Text(
              theme.fg("muted", `  (${cursor + 1}/${entries.length})`),
              1,
              0,
            ),
          );
          container.addChild(new DynamicBorder());
        };

        buildUI();

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (matchesKey(data, Key.up) && cursor > 0) {
              cursor--;
              if (cursor < offset) offset = cursor;
              buildUI();
              tui.requestRender();
            } else if (
              matchesKey(data, Key.down) &&
              cursor < entries.length - 1
            ) {
              cursor++;
              if (cursor >= offset + maxVisible)
                offset = cursor - maxVisible + 1;
              buildUI();
              tui.requestRender();
            } else if (
              matchesKey(data, Key.escape) ||
              matchesKey(data, Key.enter)
            ) {
              done(undefined);
            }
          },
        };
      });
    },
  });
}
