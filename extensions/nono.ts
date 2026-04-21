/**
 * nono Extension — detect nono sandbox status.
 *
 * nono is a capability-based sandbox tool (https://github.com/always-further/nono).
 * It wraps the entire agent process, so this extension only *detects* presence
 * rather than applying any policy.
 *
 * Detection strategy:
 * - Active sandbox: any environment variable prefixed with `NONO_` is present.
 * - Installed CLI: `nono --version` succeeds.
 */
import { execSync } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "nono";

interface NonoStatus {
  installed: boolean;
  version?: string;
  active: boolean;
  envVars: Record<string, string>;
}

function detectNonoStatus(): NonoStatus {
  const envVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NONO_") && value !== undefined) {
      envVars[key] = value;
    }
  }

  let installed = false;
  let version: string | undefined;
  try {
    const output = execSync("nono --version", {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    installed = true;
    const match = output.match(/nono\s+(\S+)/i);
    version = match?.[1];
  } catch {
    // nono not on PATH
  }

  return {
    installed,
    version,
    active: Object.keys(envVars).length > 0,
    envVars,
  };
}

export default function (pi: ExtensionAPI) {
  let lastStatus: NonoStatus | undefined;

  const refreshStatus = () => {
    lastStatus = detectNonoStatus();
    return lastStatus;
  };

  const formatStatus = (status: NonoStatus, ctx: ExtensionContext) => {
    const theme = ctx.ui.theme;
    const prefix = theme.fg("accent", "🛡️ nono: ");
    if (status.active) {
      return `${prefix}${theme.fg("accent", `v${status.version}`)}`;
    }
    if (status.installed) {
      return `${prefix}inactive`;
    }
    return `${prefix}${theme.fg("dim", "uninstalled")}`;
  };

  pi.on("session_start", async (_event, ctx) => {
    const status = refreshStatus();
    ctx.ui.setStatus(STATUS_KEY, formatStatus(status, ctx));

    if (status.active) {
      ctx.ui.notify("nono sandbox is active", "info");
    }
  });

  pi.registerCommand("nono", {
    description: "Show nono sandbox detection status",
    handler: async (_args, ctx) => {
      const status = lastStatus ?? refreshStatus();
      const lines = [
        "nono Detection Status:",
        `  Installed: ${status.installed ? "yes" : "no"}`,
      ];
      if (status.version) {
        lines.push(`  Version:   ${status.version}`);
      }
      lines.push(`  Active:    ${status.active ? "yes" : "no"}`);
      const envKeys = Object.keys(status.envVars);
      if (envKeys.length > 0) {
        lines.push("  Env vars:");
        for (const key of envKeys) {
          lines.push(`    ${key}`);
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
