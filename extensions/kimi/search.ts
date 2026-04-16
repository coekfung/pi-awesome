import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  toToolResponse,
  ok,
  error,
  type Result,
  getKimiModel,
  getKimiApiKey,
  hasKimiAuth,
} from "./common.js";

const parameters = Type.Object({
  query: Type.String({ description: "The query text to search for." }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      default: 5,
      description:
        "The number of results to return. Typically you do not need to set this value.",
    }),
  ),
  include_content: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Whether to include page content in results. This can consume many tokens.",
    }),
  ),
});

interface SearchResultItem {
  site_name: string;
  title: string;
  url: string;
  snippet: string;
  content: string;
  date: string;
  icon: string;
  mime: string;
}

function normalizeLimit(limit: unknown): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) {
    return 5;
  }
  const int = Math.floor(limit);
  return Math.max(1, Math.min(20, int));
}

function parseSearchResponse(data: unknown): SearchResultItem[] {
  if (!data || typeof data !== "object") {
    throw new Error("Response is not an object");
  }
  const root = data as Record<string, unknown>;
  if (!Array.isArray(root.search_results)) {
    throw new Error("search_results is missing");
  }
  return root.search_results.map((item: unknown, index: number) => {
    if (!item || typeof item !== "object") {
      throw new Error(`search_results[${index}] is invalid`);
    }
    const row = item as Record<string, unknown>;
    const required = ["site_name", "title", "url", "snippet"];
    for (const key of required) {
      if (typeof row[key] !== "string") {
        throw new Error(`${key} is missing in search_results[${index}]`);
      }
    }
    return {
      site_name: row.site_name as string,
      title: row.title as string,
      url: row.url as string,
      snippet: row.snippet as string,
      content: typeof row.content === "string" ? row.content : "",
      date: typeof row.date === "string" ? row.date : "",
      icon: typeof row.icon === "string" ? row.icon : "",
      mime: typeof row.mime === "string" ? row.mime : "",
    };
  });
}

async function executeSearch(
  params: { query: string; limit?: number; include_content?: boolean },
  toolCallId: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<Result> {
  const model = getKimiModel(ctx);
  if (!model) {
    return error("Kimi model not available.", "Model unavailable");
  }
  const apiKey = await getKimiApiKey(ctx);

  const url = `${model.baseUrl}/v1/search`;
  const timeoutMs = 30_000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...(model.headers ?? {}),
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Msh-Tool-Call-Id": toolCallId,
      },
      body: JSON.stringify({
        text_query: params.query,
        limit: normalizeLimit(params.limit),
        enable_page_crawling: Boolean(params.include_content),
        timeout_seconds: 30,
      }),
      signal: controller.signal,
    });

    if (response.status !== 200) {
      return error(
        `Failed to search. Status: ${response.status}. This may indicates that the search service is currently unavailable.`,
        "Failed to search",
      );
    }

    const results = parseSearchResponse(await response.json());
    const chunks: string[] = [];
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (i > 0) {
        chunks.push("---\n\n");
      }
      chunks.push(
        `Title: ${result.title}\nDate: ${result.date ?? ""}\nURL: ${result.url}\nSummary: ${result.snippet}\n\n`,
      );
      if (result.content) {
        chunks.push(`${result.content}\n\n`);
      }
    }
    return ok(chunks.join(""));
  } catch (e) {
    return error(
      `Failed to parse search results. Error: ${String(e)}. This may indicates that the search service is currently unavailable.`,
      "Failed to parse search results",
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export default function searchExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!hasKimiAuth(ctx)) {
      return;
    }

    pi.registerTool({
      name: "kimi_search",
      label: "Kimi Search",
      description:
        "Search the internet for latest information (news, docs, releases, blogs, papers).",
      parameters,
      renderCall(args, theme, _context) {
        let text = theme.fg("toolTitle", theme.bold("Kimi Search "));
        text += theme.fg("accent", `"${args.query}"`);
        if (args.include_content) {
          text += theme.fg("dim", " [with content]");
        }
        return new Text(text, 0, 0);
      },
      renderResult(result, { expanded, isPartial }, theme, _context) {
        if (isPartial) {
          return new Text(theme.fg("warning", "Searching..."), 0, 0);
        }
        const details = result.details as
          | { is_error?: boolean; message?: string }
          | undefined;
        if (details?.is_error) {
          return new Text(
            theme.fg("error", `Error: ${details.message || "Search failed"}`),
            0,
            0,
          );
        }

        const text = result.content[0]?.text ?? "";
        const count = text.split("---\n\n").filter((s) => s.trim()).length ||
          text.split("\n").filter((s) => s.trim()).length;

        let display = theme.fg("success", `✓ ${count} result(s)`);
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
        const result = await executeSearch(params, toolCallId, execCtx, signal);
        return toToolResponse(result);
      },
    });
  });
}
