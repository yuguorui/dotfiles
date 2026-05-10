import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from "@mariozechner/pi-coding-agent";
import { AgentSession, createToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

/**
 * async-tools
 *
 * Keep only latency-sensitive/core tools synchronous. Everything else in the
 * active tool scope is exposed to the model as async_<tool>, and the original
 * synchronous tool is hidden from the active tool list.
 *
 * Execution strategy:
 * - Built-in tools can be executed directly in the background because pi exports
 *   createToolDefinition().
 * - Extension/package tool implementations are not exposed through ExtensionAPI,
 *   so this extension installs a narrow AgentSession prototype hook that observes
 *   AgentSession._toolDefinitions after pi builds the tool registry. This keeps
 *   async_<tool> wrappers able to call original execute() functions without
 *   changing upstream pi code.
 * - If the hook is unavailable in a future pi version, async_<tool> fails fast
 *   instead of re-enabling synchronous tools.
 */

const ESSENTIAL_SYNC_TOOLS = new Set([
  "read",
  "edit",
  "write",
  "todo",
  "ask_user_question",
  "async_jobs",
]);

const ALREADY_ASYNC_TOOLS = new Set([
  "process",
  "loop_control",
  "Agent",
  "get_subagent_result",
  "steer_subagent",
]);

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const MAX_FOLLOWUP_CHARS = 48_000;

type JobStatus = "queued" | "running" | "completed" | "failed";

interface AsyncJob {
  id: string;
  toolName: string;
  asyncToolName: string;
  args: unknown;
  status: JobStatus;
  createdAt: string;
  completedAt?: string;
  result?: AgentToolResult<unknown>;
  error?: string;
  mode: "background";
}

let nextJobId = 1;
const jobs = new Map<string, AsyncJob>();
const asyncToOriginal = new Map<string, string>();
const originalToAsync = new Map<string, string>();
const registeredAsyncTools = new Set<string>();
const runtimeToolDefinitions = new Map<string, ToolDefinition<any, any, any>>();
const ASYNC_TOOLS_PATCH = Symbol.for("pi.async-tools.AgentSession.patch");

(globalThis as any).__piAsyncTools = {
  jobs,
  asyncToOriginal,
  originalToAsync,
  registeredAsyncTools,
  runtimeToolDefinitions,
};

function installAgentSessionToolDefinitionHook() {
  const proto = (AgentSession as any)?.prototype;
  if (!proto || proto[ASYNC_TOOLS_PATCH]) return;

  const originalRefresh = proto._refreshToolRegistry;
  if (typeof originalRefresh !== "function") return;

  proto._refreshToolRegistry = function patchedRefreshToolRegistry(...args: unknown[]) {
    const result = originalRefresh.apply(this, args);
    const definitions = this?._toolDefinitions;
    if (definitions instanceof Map) {
      for (const [name, entry] of definitions.entries()) {
        const definition = entry?.definition;
        if (definition?.name && !isAsyncToolName(definition.name)) {
          runtimeToolDefinitions.set(name, definition);
        }
      }
    }
    return result;
  };

  proto[ASYNC_TOOLS_PATCH] = true;
}

function isAsyncToolName(name: string): boolean {
  return name.startsWith("async_");
}

function shouldWrapTool(name: string): boolean {
  return !ESSENTIAL_SYNC_TOOLS.has(name) && !ALREADY_ASYNC_TOOLS.has(name) && !isAsyncToolName(name);
}

function asyncNameFor(toolName: string): string {
  const safe = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `async_${safe}`;
}

function newJobId(toolName: string): string {
  return `async-${toolName.replace(/[^a-zA-Z0-9_-]/g, "_")}-${nextJobId++}`;
}

function truncate(text: string, max = MAX_FOLLOWUP_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[async-tools: output truncated at ${max} characters; use async_jobs get to inspect the stored job result.]`;
}

function textFromResult(result: AgentToolResult<unknown>): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "text") parts.push(item.text);
    else if (item.type === "image") parts.push("[image result omitted from text follow-up]");
    else parts.push(`[${item.type} result omitted]`);
  }
  return parts.join("\n");
}

function formatJobSummary(job: AsyncJob): string {
  const base = [
    `Async job ${job.id}`,
    `Tool: ${job.toolName}`,
    `Mode: ${job.mode}`,
    `Status: ${job.status}`,
    `Created: ${job.createdAt}`,
  ];
  if (job.completedAt) base.push(`Completed: ${job.completedAt}`);
  if (job.error) base.push(`Error: ${job.error}`);
  return base.join("\n");
}

function formatJobResultPrompt(job: AsyncJob): string {
  const header = `${formatJobSummary(job)}\n\nArguments:\n${JSON.stringify(job.args, null, 2)}\n`;
  if (job.error) return `${header}\nThe async job failed. Use this error to decide the next step:\n${job.error}`;
  if (!job.result) return `${header}\nThe async job finished without a stored result.`;
  return truncate(`${header}\nResult:\n${textFromResult(job.result)}`);
}

function sendFollowUp(pi: ExtensionAPI, ctx: ExtensionContext, text: string) {
  if (ctx.isIdle()) pi.sendUserMessage(text);
  else pi.sendUserMessage(text, { deliverAs: "followUp" });
}

function getExecutableDefinition(toolName: string, ctx: ExtensionContext): ToolDefinition<any, any, any> | undefined {
  const runtimeDefinition = runtimeToolDefinitions.get(toolName);
  if (runtimeDefinition) return runtimeDefinition;

  if (BUILTIN_TOOL_NAMES.has(toolName)) {
    return createToolDefinition(toolName as any, ctx.cwd) as ToolDefinition<any, any, any>;
  }

  return undefined;
}

function startBackgroundJob(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  job: AsyncJob,
  definition: ToolDefinition<any, any, any>,
) {
  setTimeout(async () => {
    job.status = "running";
    try {
      const result = await definition.execute(job.id, job.args as any, undefined, undefined, ctx);
      job.result = result as AgentToolResult<unknown>;
      job.status = "completed";
      job.completedAt = new Date().toISOString();
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.stack || error.message : String(error);
      job.completedAt = new Date().toISOString();
    }

    sendFollowUp(
      pi,
      ctx,
      `Async tool result is ready. Continue the user's task using this result.\n\n${formatJobResultPrompt(job)}`,
    );
  }, 0);
}

function registerAsyncJobsTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "async_jobs",
    label: "Async Jobs",
    description: "List or inspect async tool jobs created by async_<tool> wrappers.",
    promptSnippet: "List or inspect async tool wrapper jobs.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("get")], {
        description: "Use list to show recent jobs, or get to inspect one job.",
      }),
      id: Type.Optional(Type.String({ description: "Job id for action=get." })),
    }),
    async execute(_toolCallId, params) {
      if (params.action === "list") {
        const recent = [...jobs.values()].slice(-20).map(formatJobSummary).join("\n\n");
        return {
          content: [{ type: "text", text: recent || "No async jobs yet." }],
          details: { jobs: [...jobs.values()] },
        };
      }

      if (!params.id) throw new Error('async_jobs action="get" requires id.');
      const job = jobs.get(params.id);
      if (!job) {
        return { content: [{ type: "text", text: `No async job found with id ${params.id}.` }], details: { found: false } };
      }
      return { content: [{ type: "text", text: formatJobResultPrompt(job) }], details: job };
    },
  });
}

function registerAsyncWrapper(pi: ExtensionAPI, tool: ToolInfo) {
  const asyncToolName = asyncNameFor(tool.name);
  if (registeredAsyncTools.has(asyncToolName)) return;

  registeredAsyncTools.add(asyncToolName);
  asyncToOriginal.set(asyncToolName, tool.name);
  originalToAsync.set(tool.name, asyncToolName);

  pi.registerTool({
    name: asyncToolName,
    label: `async ${tool.name}`,
    description:
      `Start ${tool.name} asynchronously. Returns a job id immediately; async-tools will send a follow-up prompt when the result is ready. Original description: ${tool.description}`,
    promptSnippet: `Start ${tool.name} asynchronously and receive a follow-up when it completes.`,
    promptGuidelines: [
      `Use ${asyncToolName} instead of ${tool.name}; ${tool.name} is intentionally hidden because it can block the current turn.`,
      `After calling ${asyncToolName}, continue other independent work. The async result will arrive as a follow-up prompt.`,
    ],
    parameters: tool.parameters as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const job: AsyncJob = {
        id: newJobId(tool.name),
        toolName: tool.name,
        asyncToolName,
        args: params,
        status: "queued",
        createdAt: new Date().toISOString(),
        mode: "background",
      };
      jobs.set(job.id, job);

      const definition = getExecutableDefinition(tool.name, ctx);
      if (!definition) {
        job.status = "failed";
        job.completedAt = new Date().toISOString();
        job.error = `async-tools could not access execute() for ${tool.name}. The synchronous tool remains hidden; no fallback handoff is allowed.`;
        return {
          content: [{ type: "text", text: job.error }],
          details: { id: job.id, toolName: tool.name, asyncToolName, error: job.error },
        };
      }

      startBackgroundJob(pi, ctx, job, definition);

      return {
        content: [
          {
            type: "text",
            text: `Started async job ${job.id} for ${tool.name}. Continue other independent work; a follow-up prompt will arrive when ready. Use async_jobs get id=${job.id} to inspect it later.`,
          },
        ],
        details: { id: job.id, toolName: tool.name, asyncToolName, mode: job.mode },
      };
    },
  });
}

function asyncToolsStatus(): string {
  const wrapped = [...originalToAsync.keys()].sort();
  const captured = wrapped.filter((name) => runtimeToolDefinitions.has(name) || BUILTIN_TOOL_NAMES.has(name));
  const handoff = wrapped.filter((name) => !runtimeToolDefinitions.has(name) && !BUILTIN_TOOL_NAMES.has(name));

  return [
    `wrapped: ${wrapped.join(", ") || "none"}`,
    `background-capable: ${captured.join(", ") || "none"}`,
    `missing-execute: ${handoff.join(", ") || "none"}`,
    `active: ${[...registeredAsyncTools].sort().join(", ") || "none"}`,
  ].join("\n");
}

function refreshAsyncTools(pi: ExtensionAPI, notify?: (message: string) => void) {
  const allTools = pi.getAllTools();
  const active = new Set(pi.getActiveTools());

  for (const tool of allTools) {
    if (active.has(tool.name) && shouldWrapTool(tool.name)) registerAsyncWrapper(pi, tool);
  }

  const nextActive = new Set<string>();
  for (const name of active) {
    if (shouldWrapTool(name)) {
      const asyncName = originalToAsync.get(name) ?? asyncNameFor(name);
      nextActive.add(asyncName);
    } else {
      nextActive.add(name);
    }
  }

  nextActive.add("async_jobs");
  pi.setActiveTools([...nextActive]);

  notify?.(`async-tools active\n${asyncToolsStatus()}\nkept sync: ${[...ESSENTIAL_SYNC_TOOLS].join(", ")}`);
}

export default function (pi: ExtensionAPI) {
  installAgentSessionToolDefinitionHook();
  registerAsyncJobsTool(pi);

  pi.on("session_start", async (_event, ctx) => {
    refreshAsyncTools(pi, ctx.hasUI ? (message) => ctx.ui.notify(message, "info") : undefined);
  });

  pi.on("session_tree", async () => {
    refreshAsyncTools(pi);
  });

  pi.registerCommand("async-tools", {
    description: "Refresh async tool wrappers and hide wrapped synchronous tools. Usage: /async-tools [status]",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "status") {
        ctx.ui.notify(`async-tools status\n${asyncToolsStatus()}`, "info");
        return;
      }
      refreshAsyncTools(pi, (message) => ctx.ui.notify(message, "info"));
    },
  });
}
