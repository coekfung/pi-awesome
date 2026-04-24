/**
 * fix-deepseek-reasoning — patch missing reasoning_content for DeepSeek reasoning models.
 *
 * DeepSeek reasoning models require every assistant message in the conversation
 * history to carry a `reasoning_content` field.  pi's convertMessages can drop
 * the field in edge cases (empty thinking, model-ID mismatch, etc.), which
 * causes a 400 error: "The `reasoning_content` in the thinking mode must be
 * passed back to the API."
 *
 * This extension intercepts `before_provider_request`, detects reasoning
 * models, and fills in `reasoning_content: ""` on assistant messages that
 * are missing it.  Non-reasoning models and messages that already carry the
 * field are left untouched.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface ProviderMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  reasoning_content?: string;
}

interface ProviderPayload {
  messages?: ProviderMessage[];
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    // Only patch reasoning models.
    if (!ctx.model?.reasoning) return;

    const payload = event.payload as ProviderPayload | undefined;
    if (!payload) return;

    const messages = payload.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    // Check whether any assistant message is missing reasoning_content.
    let needsFix = false;
    for (const msg of messages) {
      if (
        msg.role === "assistant" &&
        msg.reasoning_content === undefined &&
        // Skip placeholder assistant messages that carry no real content.
        !(msg.content == null && msg.tool_calls == null)
      ) {
        needsFix = true;
        break;
      }
    }

    if (!needsFix) return;

    // Patch missing reasoning_content.
    const fixed = messages.map((msg) => {
      if (msg.role === "assistant" && msg.reasoning_content === undefined) {
        return { ...msg, reasoning_content: "" };
      }
      return msg;
    });

    return { ...payload, messages: fixed };
  });
}
