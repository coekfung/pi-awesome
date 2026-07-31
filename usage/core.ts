import { createHmac, randomBytes } from "node:crypto";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageBucket, UsageGroup } from "./types.ts";

/** Salt regenerated on each process restart — cache keys are not persistent. */
const FINGERPRINT_SALT = randomBytes(32);

/**
 * Stable cache key from auth credentials and provider id.
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

function formatBucket(bucket: UsageBucket): string {
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
export function formatUsageStatusline(
  groups: UsageGroup[],
  ctx: ExtensionContext,
): string | undefined {
  if (groups.length === 0) return undefined;
  const parts = groups.map((g) => {
    const buckets = g.buckets.map(formatBucket).join(" ");
    return `${g.prefix}: ${buckets}`;
  });
  return ctx.ui.theme.fg("accent", `${STATUS_EMOJI} ${parts.join("; ")}`);
}
