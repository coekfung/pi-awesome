/**
 * OpenCode Go usage via the web dashboard page.
 *
 * There is no public usage API, so this reads the workspace dashboard
 * (https://opencode.ai/workspace/{workspaceId}/go) and extracts the embedded
 * usage state from the HTML. The page format is undocumented and may change
 * when the dashboard is updated. Parsing is tolerant of framework
 * bookkeeping such as `$R[12]={...}` assignments and uninitialized
 * `field:null` store values.
 *
 * The `auth` cookie is a login credential equivalent to the account password
 * and expires periodically. It is never logged or included in error
 * messages; treat it like a password.
 */

import { cacheKeyForAuth, clampPercent } from "../core.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type {
  UsageBucket,
  UsageGroup,
  UsageProviderAdapter,
} from "../types.ts";

interface OpenCodeGoUsage {
  rolling: number | null;
  weekly: number | null;
  monthly: number | null;
}

const DASHBOARD_BASE_URL = "https://opencode.ai/workspace";
const ADAPTER_ID = "opencode-go";

type UsageField = "rollingUsage" | "weeklyUsage" | "monthlyUsage";

/**
 * Parses the usage windows out of the dashboard HTML. A field may appear
 * multiple times: once as `field:null` in the initial store state and once
 * as the hydrated value, possibly wrapped as `field:$R[12]={...}`. The
 * object is matched by braces and its values are extracted by name, so
 * neither key order nor the wrapper format matters.
 */
export function parseOpenCodeGoUsage(html: string): OpenCodeGoUsage {
  return {
    rolling: parseWindow(html, "rollingUsage"),
    weekly: parseWindow(html, "weeklyUsage"),
    monthly: parseWindow(html, "monthlyUsage"),
  };
}

function parseWindow(html: string, field: UsageField): number | null {
  let from = 0;
  for (;;) {
    const nameAt = html.indexOf(field, from);
    if (nameAt === -1) return null; // field absent from the page
    let at = nameAt + field.length;
    while (at < html.length && (html[at] === ":" || html[at] === " ")) at++;
    if (html.startsWith("null", at)) {
      from = at + 4; // uninitialized store value; scan the next occurrence
      continue;
    }
    const wrapped = /^\$R\[\d+\]=/.exec(html.slice(at));
    if (wrapped) at += wrapped[0].length;
    const open = html.indexOf("{", at);
    if (open === -1) throw fieldError(field, "no window object");
    const close = matchClose(html, open);
    if (close === -1) throw fieldError(field, "unbalanced window object");
    const body = html.slice(open + 1, close);

    const status = extractString(body, "status");
    if (status !== undefined && status !== "ok") return null;

    const usagePercent = extractNumber(body, "usagePercent");
    if (usagePercent === null) {
      throw fieldError(field, "missing usagePercent");
    }
    return usagePercent;
  }
}

function fieldError(field: string, detail: string): Error {
  return new Error(`usage page changed (${field}: ${detail})`);
}

function matchClose(html: string, open: number): number {
  let depth = 0;
  for (let at = open; at < html.length; at++) {
    if (html[at] === "{") depth++;
    else if (html[at] === "}") {
      depth--;
      if (depth === 0) return at;
    }
  }
  return -1;
}

function extractNumber(body: string, key: string): number | null {
  const at = body.indexOf(key);
  if (at === -1) return null;
  const match = body.slice(at + key.length).match(/^\s*:\s*(-?\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function extractString(body: string, key: string): string | undefined {
  const at = body.indexOf(key);
  if (at === -1) return undefined;
  return body.slice(at + key.length).match(/^\s*:\s*"([^"]*)"/)?.[1];
}

/**
 * Fetches and parses the workspace usage from the dashboard. Requires the
 * `auth` cookie from the browser (opencode.ai domain). The cookie is sent
 * only in the request header and never appears in errors or logs. The caller
 * controls cancellation and timeouts via `signal`.
 */
async function fetchOpenCodeGoUsage(
  workspaceId: string,
  authCookie: string,
  signal?: AbortSignal,
): Promise<OpenCodeGoUsage> {
  const url = `${DASHBOARD_BASE_URL}/${encodeURIComponent(workspaceId)}/go`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "text/html",
        Cookie: `auth=${authCookie}`,
      },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("request timed out");
    }
    throw new Error("network request failed");
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("auth cookie is invalid or expired");
  }
  if (response.status === 404) {
    throw new Error("workspace not found");
  }
  if (!response.ok) {
    throw new Error(`usage endpoint returned ${response.status}`);
  }
  if (!response.url.startsWith(`${DASHBOARD_BASE_URL}/`)) {
    throw new Error("redirected to sign-in; auth cookie is invalid or expired");
  }

  const contentType = response.headers.get("content-type") ?? "";
  let html: string;
  try {
    html = await response.text();
  } catch {
    throw new Error("failed to read usage page");
  }
  if (!contentType.includes("text/html") || !html.includes("<html")) {
    throw new Error("usage endpoint did not return the expected page");
  }

  const usage = parseOpenCodeGoUsage(html);
  if (
    usage.rolling === null &&
    usage.weekly === null &&
    usage.monthly === null
  ) {
    throw new Error("usage page format changed");
  }
  return usage;
}

const OpenCodeGoConfigSchema = Type.Object({
  workspaceId: Type.String(),
  authCookie: Type.String(),
});

type OpenCodeGoAuth = Static<typeof OpenCodeGoConfigSchema>;

/**
 * Returns undefined when the section is absent (adapter stays silent);
 * throws when present but invalid, so misconfiguration is surfaced.
 */
function parseAuth(config: any): OpenCodeGoAuth | undefined {
  if (config === undefined || config === null) return undefined;
  if (!Value.Check(OpenCodeGoConfigSchema, config)) {
    const error = Value.Errors(OpenCodeGoConfigSchema, config)[0];
    throw new Error(`invalid config: ${error.instancePath}: ${error.message}`);
  }
  return Value.Parse(OpenCodeGoConfigSchema, config);
}

function normalizeGroups(usage: OpenCodeGoUsage): UsageGroup[] {
  const buckets: UsageBucket[] = [];
  addWindow(buckets, "5h", usage.rolling);
  addWindow(buckets, "wk", usage.weekly);
  addWindow(buckets, "mo", usage.monthly);
  return buckets.length > 0 ? [{ prefix: "opencode", buckets }] : [];
}

function addWindow(
  buckets: UsageBucket[],
  label: string,
  usagePercent: number | null,
): void {
  if (usagePercent === null) return;
  buckets.push({
    label,
    remaining: clampPercent(100 - usagePercent),
    limit: 100,
    unit: "percent",
  });
}

export const opencodeGoAdapter: UsageProviderAdapter = {
  id: ADAPTER_ID,
  displayName: "OpenCode Go",

  async query(model, _registry, cache, signal, config) {
    const baseUrl = model.baseUrl ?? "";
    if (model.provider !== ADAPTER_ID && !baseUrl.includes("opencode.ai")) {
      return []; // not our provider
    }
    const auth = parseAuth(config);
    if (!auth) return []; // not configured; stay silent

    const cacheKey = cacheKeyForAuth(ADAPTER_ID, {
      headers: { cookie: auth.authCookie, workspace: auth.workspaceId },
    });
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const usage = await fetchOpenCodeGoUsage(
      auth.workspaceId,
      auth.authCookie,
      signal,
    );
    const groups = normalizeGroups(usage);
    cache.set(cacheKey, groups);
    return groups;
  },
};
