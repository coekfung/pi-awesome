import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type {
  ExtensionContext,
  ResourceDiagnostic,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { QuotaBucket, QuotaGroup } from "./types.ts";

/** Salt regenerated on each process restart — cache keys are not persistent. */
const FINGERPRINT_SALT = randomBytes(32);

/**
 * quota.json contents — a map of provider id to provider-specific config.
 * Adapters parse their own section; the shape is up to each provider.
 */
export type Config = Record<string, any>;

const QuotaConfigSchema = Type.Record(Type.String(), Type.Unknown());

export function parseConfigFile(
  path: string,
  diagnostics: ResourceDiagnostic[],
): Config {
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!Value.Check(QuotaConfigSchema, raw)) {
      const error = Value.Errors(QuotaConfigSchema, raw)[0];
      diagnostics.push({
        type: "warning",
        path,
        message: `Invalid config: ${error.instancePath}: ${error.message}`,
      });
      return {};
    }
    return Value.Parse(QuotaConfigSchema, raw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    diagnostics.push({
      type: "warning",
      path,
      message: `Failed to parse config: ${msg}`,
    });
    return {};
  }
}

/**
 * Process-local stable cache key from auth credentials and provider id.
 */
export function cacheKeyForAuth(
  provider: string,
  auth: { apiKey?: string; headers?: Record<string, string | null> },
): string {
  const headers = Object.entries(auth.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const canonical = JSON.stringify({ apiKey: auth.apiKey ?? "", headers });
  const fp = createHmac("sha256", FINGERPRINT_SALT)
    .update(canonical)
    .digest("hex");
  return `${provider}:${fp}`;
}

/** Clamps a percentage into the 0-100 range. */
export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Compact time-window label for statusline display. */
export function windowLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "5h";
  const minutes = Math.round(seconds / 60);
  if (minutes >= 43_200) return `${Math.round(minutes / 43_200)}mo`;
  if (minutes % 10_080 === 0) {
    const weeks = minutes / 10_080;
    return weeks === 1 ? "wk" : `${weeks}w`;
  }
  if (minutes % 1_440 === 0) {
    const days = minutes / 1_440;
    return days === 1 ? "d" : `${days}d`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "h" : `${hours}h`;
  }
  return `${minutes}m`;
}

const STATUS_EMOJI = "📊";

function formatBucket(bucket: QuotaBucket): string {
  switch (bucket.unit) {
    case "percent":
      return `${Math.round(bucket.remaining)}% ${bucket.label}`;
    case "count":
      return `${bucket.remaining}/${bucket.limit} ${bucket.label}`;
    case "usd":
      return `$${bucket.remaining.toFixed(2)} ${bucket.label}`;
    case "cny":
      return `¥${bucket.remaining.toFixed(2)} ${bucket.label}`;
  }
}

/** Build an accent-colored single-line status string. */
export function formatQuotaStatusline(
  groups: QuotaGroup[],
  ctx: ExtensionContext,
): string | undefined {
  if (groups.length === 0) return undefined;
  const parts = groups.map((g) => {
    const buckets = g.buckets.map(formatBucket).join(" ");
    return `${g.prefix}: ${buckets}`;
  });
  return ctx.ui.theme.fg("accent", `${STATUS_EMOJI} ${parts.join("; ")}`);
}
