/**
 * Reads ~/.pi/agent/mcp.json and .pi/mcp.json for HTTP-based MCP server definitions.
 *
 * Config format:
 * {
 *   "mcpServers": {
 *     "exa": {
 *       "url": "https://mcp.exa.ai/mcp",
 *       "headers": { "x-api-key": "your-key" }
 *     }
 *   }
 * }
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ErrorCode,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export interface McpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

function mergeConfigs(base: McpConfig, overrides: McpConfig): McpConfig {
  return {
    mcpServers: { ...base.mcpServers, ...overrides.mcpServers },
  };
}

const DEFAULT_CONFIG: McpConfig = { mcpServers: {} };

export function loadConfig(cwd: string): McpConfig {
  const globalPath = join(getAgentDir(), "mcp.json");
  const projectPath = join(cwd, ".pi", "mcp.json");

  let global = DEFAULT_CONFIG;
  let project = DEFAULT_CONFIG;

  if (existsSync(globalPath)) {
    try {
      const raw = JSON.parse(readFileSync(globalPath, "utf-8"));
      global = { mcpServers: raw.mcpServers ?? {} };
    } catch {
      console.error(`MCP: Failed to parse ${globalPath}`);
    }
  }

  if (existsSync(projectPath)) {
    try {
      const raw = JSON.parse(readFileSync(projectPath, "utf-8"));
      project = { mcpServers: raw.mcpServers ?? {} };
    } catch {
      console.error(`MCP: Failed to parse ${projectPath}`);
    }
  }

  return mergeConfigs(global, project);
}

let config: McpConfig = DEFAULT_CONFIG;
const clients = new Map<string, Promise<Client>>();

async function createClient(
  serverName: string,
  entry: McpServerConfig,
): Promise<Client> {
  const client = new Client({ name: "pi-mcp", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(entry.url),
    Object.keys(entry.headers ?? {}).length > 0
      ? { requestInit: { headers: entry.headers } }
      : undefined,
  );

  try {
    await client.connect(transport);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to connect to "${serverName}": ${msg}.`);
  }

  return client;
}

async function connectServer(serverName: string): Promise<Client> {
  const cached = clients.get(serverName);
  if (cached) return cached;

  const entry = config.mcpServers[serverName];
  if (!entry) {
    throw new Error(
      `Server "${serverName}" not found. Available servers: ${Object.keys(config.mcpServers).join(", ") || "(none)"}.`,
    );
  }

  const promise = createClient(serverName, entry).catch((error: unknown) => {
    if (clients.get(serverName) === promise) clients.delete(serverName);
    throw error;
  });
  clients.set(serverName, promise);
  return promise;
}

async function forgetServer(serverName: string) {
  const promise = clients.get(serverName);
  clients.delete(serverName);

  const client = await promise?.catch(() => undefined);
  await client?.close().catch(() => undefined);
}

function shouldForgetServer(error: unknown): boolean {
  if (!(error instanceof McpError)) return true;
  return (
    error.code === ErrorCode.ConnectionClosed ||
    error.code === ErrorCode.RequestTimeout ||
    error.code === ErrorCode.ParseError
  );
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.listTools({ cursor });
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);

  return tools;
}

type ToolOutputContent = AgentToolResult<unknown>["content"];
type McpToolOutput = Awaited<ReturnType<Client["callTool"]>>;
type McpContentOutput = Extract<McpToolOutput, { content: unknown[] }>;

function hasMcpContentOutput(
  output: McpToolOutput,
): output is McpContentOutput {
  return Array.isArray((output as { content?: unknown }).content);
}

function formatMcpToolOutput(output: McpToolOutput): ToolOutputContent {
  if (!hasMcpContentOutput(output)) {
    return [{ type: "text", text: JSON.stringify(output) }];
  }

  const content: ToolOutputContent = [];

  for (const item of output.content) {
    switch (item.type) {
      case "text": {
        const t = truncateHead(item.text, {
          maxBytes: DEFAULT_MAX_BYTES,
          maxLines: DEFAULT_MAX_LINES,
        });
        if (t.truncated) {
          const tmpPath = join(tmpdir(), `pi-mcp-${randomUUID()}.txt`);
          writeFileSync(tmpPath, item.text, "utf-8");
          content.push({
            type: "text",
            text:
              t.content +
              `\n[Truncated: ${t.outputLines}/${t.totalLines} lines, ` +
              `${formatSize(t.outputBytes)}/${formatSize(t.totalBytes)}. ` +
              `Full output: ${tmpPath}]`,
          });
        } else {
          content.push({ type: "text", text: item.text });
        }
        break;
      }
      case "image":
        content.push({
          type: "image",
          data: item.data,
          mimeType: item.mimeType,
        });
        break;
      default:
        content.push({ type: "text", text: JSON.stringify(item) });
    }
  }

  const sc = output.structuredContent;
  if (
    sc != null &&
    !(typeof sc === "object" && Object.keys(sc as object).length === 0)
  ) {
    content.push({ type: "text", text: JSON.stringify(sc) });
  }

  return content.length > 0
    ? content
    : [{ type: "text", text: JSON.stringify(output) }];
}

function fallbackText(result: AgentToolResult<unknown>, theme: Theme) {
  const text = result.content.find(
    (c): c is { type: "text"; text: string } => c.type === "text",
  );
  return new Text(theme.fg("toolOutput", text?.text ?? ""), 0, 0);
}

const STATUS_KEY = "mcp";

function formatStatus(theme?: Theme) {
  const total = Object.keys(config.mcpServers).length;
  if (total === 0) return undefined;
  const active = clients.size;
  const text = `💎 mcp: ${active}/${total}`;
  return theme ? theme.fg("accent", text) : text;
}

export default function mcp(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    ctx.ui.setStatus(STATUS_KEY, formatStatus(ctx.ui.theme));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    const clientPromises = [...clients.values()];
    clients.clear();

    const settled = await Promise.allSettled(clientPromises);
    for (const result of settled) {
      if (result.status === "fulfilled") await result.value.close();
    }
  });

  pi.on("before_agent_start", async (event) => {
    const names = Object.keys(config.mcpServers).sort();
    if (names.length === 0) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\nAvailable MCP servers: ${names.map((name) => `\`${name}\``).join(", ")}`,
    };
  });

  pi.registerTool({
    name: "mcp_tools_list",
    label: "MCP Tools List",
    description:
      "List available tools from an MCP server. Connection or auth errors: ask the user. Transient errors (ConnectionClosed, RequestTimeout): retry once.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Name of the MCP server (see available servers in system prompt)",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const client = await connectServer(params.name);
        ctx.ui.setStatus(STATUS_KEY, formatStatus(ctx.ui.theme));
        const tools = await listAllTools(client);
        const toolDocs = tools.map((tool) => {
          const title = tool.title ? ` — ${tool.title}` : "";
          return `## \`${tool.name}\`${title}\n\n${tool.description ?? "No description."}\n\n**Input schema:**\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema)}\n\`\`\``;
        });
        const text = `# MCP tools for \`${params.name}\`\n\n${toolDocs.join("\n\n") || "No tools."}`;
        return {
          content: [{ type: "text", text }],
          details: { name: params.name, tools },
        };
      } catch (error) {
        if (shouldForgetServer(error)) {
          await forgetServer(params.name);
          ctx.ui.setStatus(STATUS_KEY, formatStatus(ctx.ui.theme));
        }
        throw error;
      }
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("mcp tools list ")) +
          theme.fg("muted", args.name),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as
        | { name: string; tools: Array<{ name: string }> }
        | undefined;
      if (!details) return fallbackText(result, theme);

      const count = details.tools.length;
      let text =
        theme.fg("success", "✓ ") +
        theme.fg("muted", `${count} tool${count === 1 ? "" : "s"} from `) +
        theme.fg("accent", details.name);

      if (expanded && count > 0) {
        const names = details.tools
          .map((t) => theme.fg("accent", t.name))
          .join(theme.fg("dim", ", "));
        text += "\n  " + names;
      }

      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "mcp_tools_call",
    label: "MCP Tools Call",
    description:
      "Call a tool on an MCP server. Connection/auth errors: ask the user. Transient errors (ConnectionClosed, RequestTimeout): retry once. Bad arguments: fix them. Tool not found: list tools first.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Name of the MCP server (see available servers in system prompt)",
      }),
      tool: Type.String({
        description:
          "Name of the MCP tool to call. Use mcp_tools_list first to discover available tools.",
      }),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            "Arguments for the MCP tool, matching the tool's inputSchema. Omit if the tool takes no arguments.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const client = await connectServer(params.name);
        ctx.ui.setStatus(STATUS_KEY, formatStatus(ctx.ui.theme));
        const result = await client.callTool({
          name: params.tool,
          arguments: params.arguments ?? {},
        });
        return {
          content: formatMcpToolOutput(result),
          details: {
            server: params.name,
            tool: params.tool,
            isError: result.isError === true,
          },
        };
      } catch (error) {
        if (shouldForgetServer(error)) {
          await forgetServer(params.name);
          ctx.ui.setStatus(STATUS_KEY, formatStatus(ctx.ui.theme));
        }
        throw error;
      }
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("mcp tools call ")) +
          theme.fg("muted", args.name) +
          theme.fg("dim", " / ") +
          theme.fg("accent", args.tool),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as
        | { server: string; tool: string; isError: boolean }
        | undefined;

      const textOutput = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      const isError = details?.isError === true;
      const icon = isError
        ? theme.fg("error", "✗ ")
        : theme.fg("success", "✓ ");
      const server = details?.server ?? "";
      const tool = details?.tool ?? "";
      const header =
        icon +
        theme.fg("muted", server) +
        theme.fg("dim", " / ") +
        theme.fg("accent", tool);

      if (expanded) {
        return new Text(
          header + "\n" + theme.fg("toolOutput", textOutput),
          0,
          0,
        );
      }

      // Collapsed: status + first 3 lines
      const lines = textOutput.split("\n");
      const preview = lines.slice(0, 3).join("\n");
      const suffix =
        lines.length > 3
          ? "\n" + theme.fg("dim", `… ${lines.length - 3} more lines`)
          : "";
      return new Text(
        header + "\n" + theme.fg("toolOutput", preview) + suffix,
        0,
        0,
      );
    },
  });
}
