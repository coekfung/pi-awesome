import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const supportsFast = (provider: string | undefined) =>
  provider === "openai" || provider === "openai-codex";

export default function (pi: ExtensionAPI) {
  let enabled = false;

  const updateStatus = (ctx: ExtensionContext) => {
    if (!supportsFast(ctx.model?.provider)) {
      ctx.ui.setStatus("openai-fast", undefined);
      return;
    }

    const theme = ctx.ui.theme;
    const prefix = theme.fg("accent", "⚡️ fast: ");
    const state = theme.fg(enabled ? "accent" : "dim", enabled ? "on" : "off");
    ctx.ui.setStatus("openai-fast", prefix + state);
  };

  pi.on("session_start", (_event, ctx) => {
    enabled = false;
    updateStatus(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.registerCommand("fast", {
    description: "Toggle OpenAI fast mode",
    handler: async (_args, ctx) => {
      if (!supportsFast(ctx.model?.provider)) {
        ctx.ui.notify("Fast mode requires OpenAI or OpenAI Codex", "warning");
        return;
      }

      enabled = !enabled;
      updateStatus(ctx);
      ctx.ui.notify(`Fast mode: ${enabled ? "on" : "off"}`, "info");
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !supportsFast(ctx.model?.provider)) return;

    return {
      ...(event.payload as Record<string, unknown>),
      service_tier:
        ctx.model?.provider === "openai-codex" ? "priority" : "fast",
    };
  });
}
