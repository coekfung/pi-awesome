import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let requestStartAt: number | undefined;
	let firstTokenAt: number | undefined;
	let lastTtftMs: number | undefined;
	let lastTps: number | undefined;

	const STATUS_KEY = "ttft";
	const STATUS_PREFIX = "🚀";

	const formatStatus = (ttftMs?: number, tps?: number) => {
		const ttftText = ttftMs === undefined ? "TTFT: unknown" : `TTFT: ${ttftMs}ms`;
		const tpsText = tps === undefined ? "TPS: unknown" : `TPS: ${tps.toFixed(1)} tok/s`;
		return `${STATUS_PREFIX} ${ttftText} ${tpsText}`;
	};

	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", formatStatus(lastTtftMs, lastTps)));
	};

	pi.on("before_provider_request", async (_event, ctx) => {
		requestStartAt = Date.now();
		firstTokenAt = undefined;
		updateStatus(ctx);
		ctx.ui.setWorkingMessage("Sending request to model...");
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (firstTokenAt !== undefined) return;

		const now = Date.now();
		firstTokenAt = now;
		lastTtftMs = requestStartAt === undefined ? undefined : now - requestStartAt;
		updateStatus(ctx);
		ctx.ui.setWorkingMessage("Model is responding...");
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (firstTokenAt === undefined) return;

		const generationMs = Date.now() - firstTokenAt;
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
