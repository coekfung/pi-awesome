import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  toToolResponse,
  ok,
  error,
  type Result,
  extractMeaningfulText,
  getKimiModel,
  getKimiApiKey,
  getToolResultText,
  hasKimiAuth,
} from "./common.js";

const parameters = Type.Object({
  url: Type.String({ description: "The URL to fetch content from." }),
});

async function fetchWithService(
  params: { url: string },
  toolCallId: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<Result> {
  const model = getKimiModel(ctx);
  if (!model) {
    return error("Kimi model not available.", "Model unavailable");
  }
  const apiKey = await getKimiApiKey(ctx);

  const url = `${model.baseUrl}/v1/fetch`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...(model.headers ?? {}),
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/markdown",
        "Content-Type": "application/json",
        "X-Msh-Tool-Call-Id": toolCallId,
      },
      body: JSON.stringify({ url: params.url }),
      signal,
    });

    if (response.status !== 200) {
      return error(
        `Failed to fetch URL via service. Status: ${response.status}.`,
        "Failed to fetch URL via fetch service",
      );
    }
    return ok(
      await response.text(),
      "The returned content is the main content extracted from the page.",
    );
  } catch (e) {
    return error(
      `Failed to fetch URL via service due to network error: ${String(e)}. This may indicate the service is unreachable.`,
      "Network error when calling fetch service",
    );
  }
}

async function fetchWithHttpGet(
  params: { url: string },
  signal?: AbortSignal,
): Promise<Result> {
  let response: Response;
  let respText: string;
  try {
    response = await fetch(params.url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      signal,
    });

    if (response.status >= 400) {
      return error(
        `Failed to fetch URL. Status: ${response.status}. This may indicate the page is not accessible or the server is down.`,
        `HTTP ${response.status} error`,
      );
    }
    respText = await response.text();
    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();
    if (
      contentType.startsWith("text/plain") ||
      contentType.startsWith("text/markdown")
    ) {
      return ok(
        respText,
        "The returned content is the full content of the page.",
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return error(
      `Failed to fetch URL due to network error: ${message}. This may indicate the URL is invalid or the server is unreachable.`,
      "Network error",
    );
  }

  if (!respText) {
    return ok("", "The response body is empty.", "Empty response body");
  }
  const extractedText = extractMeaningfulText(respText);
  if (!extractedText) {
    return error(
      "Failed to extract meaningful content from the page. This may indicate the page content is not suitable for text extraction, or the page requires JavaScript to render its content.",
      "No content extracted",
    );
  }
  return ok(
    extractedText,
    "The returned content is the main text content extracted from the page.",
  );
}

export default function fetchExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!hasKimiAuth(ctx)) {
      return;
    }

    pi.registerTool({
      name: "kimi_fetch",
      label: "Kimi Fetch",
      description: "Fetch a URL and extract main text content from the page.",
      parameters,
      renderCall(args, theme, _context) {
        let text = theme.fg("toolTitle", theme.bold("Kimi Fetch "));
        text += theme.fg("accent", args.url);
        return new Text(text, 0, 0);
      },
      renderResult(result, { expanded, isPartial }, theme, _context) {
        if (isPartial) {
          return new Text(theme.fg("warning", "Fetching..."), 0, 0);
        }
        const details = result.details as
          | { is_error?: boolean; message?: string }
          | undefined;
        if (details?.is_error) {
          return new Text(
            theme.fg("error", `Error: ${details.message || "Fetch failed"}`),
            0,
            0,
          );
        }

        const text = getToolResultText(result);
        const size = text.length
          ? `${(text.length / 1024).toFixed(1)}KB`
          : "0KB";

        let display = theme.fg("success", `✓ Fetched ${size}`);
        if (!expanded) {
          display += ` ${theme.fg("dim", keyHint("app.tools.expand", "to expand"))}`;
          return new Text(display, 0, 0);
        }

        const lines = text.split("\n").slice(0, 15);
        display += "\n" + lines.map((l) => theme.fg("dim", l)).join("\n");
        if (text.split("\n").length > 15) {
          display += `\n${theme.fg("muted", "...")}`;
        }
        return new Text(display, 0, 0);
      },
      async execute(toolCallId, params, signal, _onUpdate, execCtx) {
        const serviceRet = await fetchWithService(
          params,
          toolCallId,
          execCtx,
          signal,
        );
        if (!serviceRet.is_error) {
          return toToolResponse(serviceRet);
        }
        return toToolResponse(await fetchWithHttpGet(params, signal));
      },
    });
  });
}
