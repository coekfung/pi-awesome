/**
 * Compact performance footer for pi.
 *
 * Display format:
 *   🚀 Perf: 820ms; ≈31.2t/s
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
 * - `provider_usage.output` may include provider-specific reasoning/output accounting.
 * - If no qualifying streamed delta or output usage is available, the footer shows `?`.
 */
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let requestStartAt: number | undefined;
	let firstTokenAt: number | undefined;
	let lastTtftMs: number | undefined;
	let lastTps: number | undefined;

	const STATUS_KEY = "ttft";
	const STATUS_PREFIX = "🚀";

	const formatStatus = (ttftMs?: number, tps?: number) => {
		const ttftText = ttftMs === undefined ? "?ms" : `${ttftMs}ms`;
		const tpsText = tps === undefined ? "≈?t/s" : `≈${tps.toFixed(1)}t/s`;
		return `${STATUS_PREFIX} Perf: ${ttftText}; ${tpsText}`;
	};

	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", formatStatus(lastTtftMs, lastTps)));
	};

	pi.on("before_provider_request", async (_event, ctx) => {
		requestStartAt = performance.now();
		firstTokenAt = undefined;
		lastTtftMs = undefined;
		lastTps = undefined;
		updateStatus(ctx);
		ctx.ui.setWorkingMessage("Sending request to model...");
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (firstTokenAt !== undefined) return;

		const streamEvent = event.assistantMessageEvent;
		if (streamEvent.type !== "text_delta" && streamEvent.type !== "thinking_delta") return;
		if (!streamEvent.delta.trim()) return;

		const now = performance.now();
		firstTokenAt = now;
		lastTtftMs = requestStartAt === undefined ? undefined : Math.round(now - requestStartAt);
		updateStatus(ctx);
		ctx.ui.setWorkingMessage("Model is responding...");
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
		updateStatus(ctx);
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		ctx.ui.setWorkingMessage();
	});

	pi.on("agent_end", async (_event, ctx) => {
		requestStartAt = undefined;
		firstTokenAt = undefined;
		ctx.ui.setWorkingMessage();
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});
}
