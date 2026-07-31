/**
 * Interactive per-turn metrics table for the /perf command.
 *
 * Rows are built from `perf-metrics` custom entries persisted by perf.ts,
 * each joined with the nearest parent assistant message for token usage and
 * provider/model info.
 */
import {
  DynamicBorder,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  Spacer,
  matchesKey,
  Key,
} from "@earendil-works/pi-tui";

export interface PerfDisplayEntry {
  turn: number;
  ttft?: number;
  duration: number;
  tps?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  provider?: string;
  model?: string;
  time: string;
}

export function collectPerfEntries(sm: {
  getEntries(): unknown[];
}): PerfDisplayEntry[] {
  const all = sm.getEntries() as {
    type: string;
    id: string;
    parentId: string | null;
    timestamp: string;
    customType?: string;
    data?: { ttft?: number; duration: number };
    message?: {
      role: string;
      provider?: string;
      model?: string;
      usage?: { output?: number };
    };
  }[];
  const idMap = new Map(all.map((e) => [e.id, e]));

  const perfEntries = all.filter(
    (e) => e.type === "custom" && e.customType === "perf-metrics",
  ) as {
    parentId: string | null;
    timestamp: string;
    data?: { ttft?: number; duration: number };
  }[];

  return perfEntries.map((perfEntry, i) => {
    // Walk parent chain to find the nearest assistant message
    let currentId: string | null = perfEntry.parentId;
    let assistantMsg: (typeof all)[number]["message"];
    while (currentId) {
      const entry = idMap.get(currentId);
      if (!entry) break;
      if (entry.type === "message" && entry.message?.role === "assistant") {
        assistantMsg = entry.message;
        break;
      }
      currentId = entry.parentId ?? null;
    }

    const usage = assistantMsg?.usage as
      | {
          output?: number;
          input?: number;
          cacheRead?: number;
          cacheWrite?: number;
        }
      | undefined;
    const input = usage?.input;
    const output = usage?.output;
    const cacheRead = usage?.cacheRead;
    const cacheWrite = usage?.cacheWrite;
    const duration = perfEntry.data?.duration ?? 0;
    const tps =
      typeof output === "number" && duration > 0
        ? output / (duration / 1000)
        : undefined;

    return {
      turn: i + 1,
      ttft: perfEntry.data?.ttft,
      duration,
      tps,
      input,
      output,
      cacheRead,
      cacheWrite,
      provider: assistantMsg?.provider,
      model: assistantMsg?.model,
      time: (() => {
        const d = new Date(perfEntry.timestamp);
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      })(),
    };
  });
}

export async function showPerfTable(
  ctx: ExtensionCommandContext,
  entries: PerfDisplayEntry[],
): Promise<void> {
  await ctx.ui.custom((tui, theme, _kb, done) => {
    const maxVisible = Math.max(5, Math.floor(tui.terminal.rows / 2));
    let cursor = 0;
    let offset = 0;

    const W_NUM = 5;
    const W_TIME = 17;
    const W_TTFT = 8;
    const W_TPS = 10;
    const W_DUR = 7;
    const W_INPUT = 7;
    const W_OUTPUT = 7;
    const W_CACHE_R = 7;
    const W_CACHE_W = 7;

    let showTokens = false;

    const padLeft = (s: string, w: number) => s.padStart(w);

    const fmtTok = (n?: number): string => {
      if (n === undefined) return "-".padStart(W_INPUT);
      if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(1)}M`.padStart(W_INPUT);
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`.padStart(W_INPUT);
      return String(n).padStart(W_INPUT);
    };

    const header = () => {
      const num = "#".padEnd(W_NUM);
      const time = "Time".padEnd(W_TIME);
      const ttft = "TTFT".padEnd(W_TTFT);
      const tps = "TPS".padEnd(W_TPS);
      const dur = "Dur".padEnd(W_DUR);
      if (showTokens) {
        const inp = "Inp".padEnd(W_INPUT);
        const out = "Out".padEnd(W_OUTPUT);
        const cr = "CchR".padEnd(W_CACHE_R);
        const cw = "CchW".padEnd(W_CACHE_W);
        return `  ${num}  ${ttft}  ${tps}  ${dur}  ${inp}  ${out}  ${cr}  ${cw}  ${time}  Model`;
      }
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
        padLeft(e.tps !== undefined ? `${e.tps.toFixed(1)}t/s` : "?t/s", W_TPS),
      );
      const dur = theme.fg(
        "success",
        padLeft(`${(e.duration / 1000).toFixed(1)}s`, W_DUR),
      );
      const model = theme.fg("dim", `${e.provider ?? "?"} / ${e.model ?? "?"}`);
      const time = theme.fg("dim", e.time.padEnd(W_TIME));
      const prefix = selected ? theme.fg("accent", "› ") : "  ";
      let line: string;
      if (showTokens) {
        const inp = theme.fg("dim", fmtTok(e.input));
        const out = theme.fg("dim", fmtTok(e.output));
        const cr = theme.fg("dim", fmtTok(e.cacheRead));
        const cw = theme.fg("dim", fmtTok(e.cacheWrite));
        line = `${prefix}${num}  ${ttft}  ${tps}  ${dur}  ${inp}  ${out}  ${cr}  ${cw}  ${time}  ${model}`;
      } else {
        line = `${prefix}${num}  ${ttft}  ${tps}  ${dur}  ${time}  ${model}`;
      }
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
        new Text(
          theme.fg("muted", "  ↑↓ scroll · tab tokens · esc close"),
          1,
          0,
        ),
      );
      container.addChild(new DynamicBorder());
      container.addChild(new Text(theme.fg("dim", header()), 1, 0));
      container.addChild(new Spacer(1));

      const visible = entries.slice(offset, offset + maxVisible);
      for (let i = 0; i < visible.length; i++) {
        container.addChild(
          new Text(renderRow(visible[i], offset + i === cursor), 1, 0),
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
        } else if (matchesKey(data, Key.down) && cursor < entries.length - 1) {
          cursor++;
          if (cursor >= offset + maxVisible) offset = cursor - maxVisible + 1;
          buildUI();
          tui.requestRender();
        } else if (matchesKey(data, Key.tab)) {
          showTokens = !showTokens;
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
}
