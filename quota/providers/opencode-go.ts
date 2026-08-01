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
  QuotaBucket,
  QuotaGroup,
  QuotaProviderAdapter,
} from "../types.ts";

interface OpenCodeGoQuota {
  rolling: number | null;
  weekly: number | null;
  monthly: number | null;
}

const DASHBOARD_BASE_URL = "https://opencode.ai/workspace";
const ADAPTER_ID = "opencode-go";

type QuotaField = "rollingUsage" | "weeklyUsage" | "monthlyUsage";

/**
 * Parses the usage windows out of the dashboard HTML. Each window is a flat
 * object in the page's embedded seroval store state, e.g.
 * `rollingUsage:$R[35]={status:"ok",resetInSec:17551,usagePercent:0}`. The
 * same field name may also appear earlier as a `field:null` placeholder in
 * the billing state, and key order inside the object is not fixed; the
 * regex skips placeholders and matches values by name, so neither matters.
 */
export function parseOpenCodeGoQuota(html: string): OpenCodeGoQuota {
  return {
    rolling: parseWindow(html, "rollingUsage"),
    weekly: parseWindow(html, "weeklyUsage"),
    monthly: parseWindow(html, "monthlyUsage"),
  };
}

function parseWindow(html: string, field: QuotaField): number | null {
  const match = new RegExp(
    `${field}:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{([^{}]*)\\}`,
  ).exec(html);
  if (!match) return null; // field absent, or only a `field:null` placeholder
  const body = match[1];
  const status = /status\s*:\s*"([^"]*)"/.exec(body)?.[1];
  if (status !== undefined && status !== "ok") return null;
  const usagePercent = /usagePercent\s*:\s*(-?\d+(?:\.\d+)?)/.exec(body)?.[1];
  if (usagePercent === undefined) {
    throw fieldError(field, "missing usagePercent");
  }
  return Number(usagePercent);
}

function fieldError(field: string, detail: string): Error {
  return new Error(`usage page changed (${field}: ${detail})`);
}

/**
 * Fetches and parses the workspace usage from the dashboard. Requires the
 * `auth` cookie from the browser (opencode.ai domain). The cookie is sent
 * only in the request header and never appears in errors or logs. The caller
 * controls cancellation and timeouts via `signal`.
 */
async function fetchOpenCodeGoQuota(
  workspaceId: string,
  authCookie: string,
  signal?: AbortSignal,
): Promise<OpenCodeGoQuota> {
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

  const quota = parseOpenCodeGoQuota(html);
  if (
    quota.rolling === null &&
    quota.weekly === null &&
    quota.monthly === null
  ) {
    throw new Error("usage data unavailable");
  }
  return quota;
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

function normalizeGroups(quota: OpenCodeGoQuota): QuotaGroup[] {
  const buckets: QuotaBucket[] = [];
  addWindow(buckets, "5h", quota.rolling);
  addWindow(buckets, "wk", quota.weekly);
  addWindow(buckets, "mo", quota.monthly);
  return buckets.length > 0 ? [{ prefix: "opencode", buckets }] : [];
}

function addWindow(
  buckets: QuotaBucket[],
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

export const opencodeGoAdapter: QuotaProviderAdapter = {
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

    const quota = await fetchOpenCodeGoQuota(
      auth.workspaceId,
      auth.authCookie,
      signal,
    );
    const groups = normalizeGroups(quota);
    cache.set(cacheKey, groups);
    return groups;
  },
};
