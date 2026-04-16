import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export const KIMI_PROVIDER = "kimi-coding";
export const KIMI_MODEL_ID = "kimi-for-coding";

export function getKimiModel(ctx: ExtensionContext) {
  return ctx.modelRegistry.find(KIMI_PROVIDER, KIMI_MODEL_ID);
}

export async function getKimiApiKey(ctx: ExtensionContext): Promise<string> {
  return (await ctx.modelRegistry.getApiKeyForProvider(KIMI_PROVIDER)) || "";
}

export function hasKimiAuth(ctx: ExtensionContext): boolean {
  const model = getKimiModel(ctx);
  if (!model) return false;
  return ctx.modelRegistry.hasConfiguredAuth(model);
}

export interface Result {
  is_error: boolean;
  output: string;
  message: string;
  brief: string;
}

export function ok(output: string, message = "", brief = ""): Result {
  return { is_error: false, output, message, brief };
}

export function error(message: string, brief: string, output = ""): Result {
  return { is_error: true, output, message, brief };
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll(/&#x([\da-fA-F]+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

export function extractMeaningfulText(html: string): string {
  const stripped = html
    .replaceAll(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gis, " ")
    .replaceAll(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gis, " ")
    .replaceAll(
      /<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gis,
      " ",
    )
    .replaceAll(/<!--([\s\S]*?)-->/g, " ")
    .replaceAll(
      /<\/?(h[1-6]|p|div|article|section|li|tr|td|th|ul|ol|br)\b[^>]*>/gi,
      "\n",
    )
    .replaceAll(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(stripped)
    .replaceAll(/\r\n?/g, "\n")
    .replaceAll(/\t/g, " ")
    .replaceAll(/[ \u00A0]+/g, " ")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
  return decoded;
}

export function toToolResponse(result: Result) {
  const text =
    result.output ||
    result.message ||
    (result.is_error ? "Tool execution failed." : "");
  return {
    content: [{ type: "text" as const, text }],
    details: {
      is_error: result.is_error,
      message: result.message,
      brief: result.brief,
      output: result.output,
    },
  };
}
