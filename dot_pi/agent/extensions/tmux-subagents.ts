import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const EXT_ID = "tmux-agents";
const MAX_PREVIEW_CHARS = 12_000;
const MAX_WIDGET_AGENTS = 6;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type AgentStatus = "running" | "completed" | "failed" | "stopped" | "unknown";
type ExtensionMode = "disabled" | "inherit";

interface AgentRecord {
  id: string;
  description: string;
  sessionName: string;
  cwd: string;
  rootDir: string;
  agentDir: string;
  socketPath: string;
  promptFile: string;
  eventsFile: string;
  stderrFile: string;
  runnerFile: string;
  exitFile: string;
  resultFile: string;
  notify: boolean;
  extensions: ExtensionMode;
  tools?: string;
  model?: string;
  thinking?: string;
  status: AgentStatus;
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  notified?: boolean;
  stoppedAt?: number;
}

interface ExitInfo {
  exitCode?: number;
  completedAt?: number;
}

interface ParsedEvents {
  agentStarted: boolean;
  agentEnded: boolean;
  assistantText: string;
  toolStarts: number;
  toolEnds: number;
  toolErrors: number;
  activeTools: string[];
  lastTool?: string;
  parseErrors: number;
  lastEventType?: string;
}

interface RefreshedRecord {
  record: AgentRecord;
  parsed: ParsedEvents;
}

let records = new Map<string, AgentRecord>();
let nextId = 1;
let currentCtx: ExtensionContext | undefined;
let widgetTimer: ReturnType<typeof setInterval> | undefined;

function now(): number { return Date.now(); }

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

function truncateMiddle(text: string, max = MAX_PREVIEW_CHARS): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 80) / 2);
  return text.slice(0, keep) + `\n\n...[truncated ${text.length - max} chars]...\n\n` + text.slice(-keep);
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function rootDir(cwd: string): string { return join(cwd, ".pi", "tmux-agents"); }
function socketPath(cwd: string): string { return join(rootDir(cwd), "tmux.sock"); }
function sessionIdFromCtx(ctx?: ExtensionContext): string {
  return ctx?.sessionManager?.getSessionId?.() ?? "unknown-session";
}

function registryPath(cwd: string, sessionId = "unknown-session"): string {
  return join(rootDir(cwd), "sessions", sessionId, "agents.json");
}

function safeDescription(s: unknown): string {
  const raw = typeof s === "string" && s.trim() ? s.trim() : "tmux agent";
  return raw.slice(0, 80);
}

function makeId(): string {
  const id = `ta-${Date.now().toString(36)}-${nextId++}`;
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function ensureRoot(cwd: string): string {
  const dir = rootDir(cwd);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function loadRegistry(cwd: string, sessionId: string): Map<string, AgentRecord> {
  const file = registryPath(cwd, sessionId);
  if (!existsSync(file)) return new Map();
  try {
    const arr = JSON.parse(readFileSync(file, "utf-8")) as AgentRecord[];
    const map = new Map<string, AgentRecord>();
    for (const r of arr) {
      if (r?.id && r?.agentDir) map.set(r.id, r);
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveRegistry(cwd: string): void {
  ensureRoot(cwd);
  const sessionId = sessionIdFromCtx(currentCtx);
  const file = registryPath(cwd, sessionId);
  mkdirSync(dirname(file), { recursive: true });
  const relevant = [...records.values()].filter(r => r.cwd === cwd);
  writeFileSync(file, JSON.stringify(relevant, null, 2), "utf-8");
}

function readJsonFile<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

async function tmux(pi: ExtensionAPI, socket: string, args: string[], signal?: AbortSignal) {
  return pi.exec("tmux", ["-S", socket, ...args], { signal, timeout: 10_000 });
}

async function hasTmuxSession(pi: ExtensionAPI, record: AgentRecord, signal?: AbortSignal): Promise<boolean> {
  const res = await tmux(pi, record.socketPath, ["has-session", "-t", record.sessionName], signal);
  return res.code === 0;
}

function extractMessageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" && typeof part.text === "string") return part.text;
    return "";
  }).join("");
}

function parseEventsFile(path: string): ParsedEvents {
  const parsed: ParsedEvents = {
    agentStarted: false,
    agentEnded: false,
    assistantText: "",
    toolStarts: 0,
    toolEnds: 0,
    toolErrors: 0,
    activeTools: [],
    parseErrors: 0,
  };

  if (!existsSync(path)) return parsed;
  let text = "";
  try { text = readFileSync(path, "utf-8"); } catch { return parsed; }

  const active = new Map<string, string>();
  let deltaText = "";
  let finalAssistantText = "";

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { parsed.parseErrors++; continue; }
    parsed.lastEventType = event.type;

    switch (event.type) {
      case "agent_start":
        parsed.agentStarted = true;
        break;
      case "agent_end":
        parsed.agentEnded = true;
        break;
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame?.type === "text_delta" && typeof ame.delta === "string") deltaText += ame.delta;
        break;
      }
      case "message_end": {
        if (event.message?.role === "assistant") {
          const t = extractMessageText(event.message);
          if (t.trim()) finalAssistantText = t;
        }
        break;
      }
      case "tool_execution_start":
        parsed.toolStarts++;
        if (event.toolCallId && event.toolName) active.set(event.toolCallId, event.toolName);
        parsed.lastTool = event.toolName;
        break;
      case "tool_execution_end":
        parsed.toolEnds++;
        if (event.isError) parsed.toolErrors++;
        if (event.toolCallId) active.delete(event.toolCallId);
        parsed.lastTool = event.toolName;
        break;
    }
  }

  parsed.activeTools = [...active.values()];
  parsed.assistantText = finalAssistantText || deltaText;
  return parsed;
}

async function refreshRecord(pi: ExtensionAPI, record: AgentRecord, signal?: AbortSignal): Promise<RefreshedRecord> {
  const exitInfo = readJsonFile<ExitInfo>(record.exitFile);
  const parsed = parseEventsFile(record.eventsFile);
  const tmuxRunning = record.status !== "stopped" ? await hasTmuxSession(pi, record, signal).catch(() => false) : false;

  if (record.status === "stopped") {
    // Keep explicit stopped status.
  } else if (tmuxRunning) {
    record.status = "running";
  } else if (typeof exitInfo?.exitCode === "number") {
    record.exitCode = exitInfo.exitCode;
    record.completedAt = exitInfo.completedAt ? exitInfo.completedAt * 1000 : record.completedAt ?? now();
    record.status = exitInfo.exitCode === 0 && parsed.agentEnded ? "completed" : "failed";
  } else if (record.status === "running") {
    record.status = "unknown";
  }

  const result = {
    id: record.id,
    description: record.description,
    status: record.status,
    exitCode: record.exitCode,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    toolStarts: parsed.toolStarts,
    toolEnds: parsed.toolEnds,
    toolErrors: parsed.toolErrors,
    agentEnded: parsed.agentEnded,
    parseErrors: parsed.parseErrors,
    assistantText: parsed.assistantText,
  };
  try { writeFileSync(record.resultFile, JSON.stringify(result, null, 2), "utf-8"); } catch { /* ignore */ }
  saveRegistry(record.cwd);
  return { record, parsed };
}

async function refreshAll(pi: ExtensionAPI, cwd: string): Promise<RefreshedRecord[]> {
  const out: RefreshedRecord[] = [];
  for (const record of records.values()) {
    if (record.cwd === cwd) out.push(await refreshRecord(pi, record).catch(() => ({ record, parsed: parseEventsFile(record.eventsFile) })));
  }
  return out;
}

function statusIcon(status: AgentStatus): string {
  switch (status) {
    case "running": return SPINNER[Math.floor(Date.now() / 250) % SPINNER.length]!;
    case "completed": return "✓";
    case "failed": return "✗";
    case "stopped": return "■";
    default: return "?";
  }
}

async function updateWidget(pi: ExtensionAPI): Promise<void> {
  const ctx = currentCtx;
  if (!ctx?.hasUI) return;
  const refreshed = await refreshAll(pi, ctx.cwd).catch(() => []);
  for (const item of refreshed) await maybeNotify(pi, item);
  const running = refreshed.filter(item => item.record.status === "running");
  const visible = running
    .sort((a, b) => b.record.startedAt - a.record.startedAt)
    .slice(0, MAX_WIDGET_AGENTS);

  if (visible.length === 0) {
    ctx.ui.setWidget(EXT_ID, undefined);
    return;
  }

  const lines = ["● Tmux Agents"];
  for (const { record, parsed } of visible) {
    const age = formatDuration((record.completedAt ?? now()) - record.startedAt);
    const tools = record.status === "running" && parsed.activeTools.length
      ? ` · ${parsed.activeTools.slice(0, 2).join(",")}`
      : parsed.toolEnds > 0
        ? ` · ${parsed.toolEnds} tools`
        : "";
    lines.push(`├─ ${statusIcon(record.status)} ${record.id}  ${record.status.padEnd(9)} ${record.description} · ${age}${tools}`);
  }
  if (running.length > visible.length) lines.push(`└─ ${running.length - visible.length} more running`);
  ctx.ui.setWidget(EXT_ID, lines);
}

function buildPrompt(id: string, prompt: string): string {
  return `You are a tmux-managed pi subagent. Work autonomously on the assigned task and provide a clear final answer when finished.\n\nSubagent ID: ${id}\n\nTask:\n${prompt}`;
}

function buildRunner(record: AgentRecord): string {
  const args: string[] = ["--mode", "json", "-p"];
  if (record.extensions === "disabled") args.push("--no-extensions");
  if (record.model) args.push("--model", record.model);
  if (record.thinking) args.push("--thinking", record.thinking);
  if (record.tools) args.push("--tools", record.tools);

  const argString = args.map(shellQuote).join(" ");
  return `#!/bin/sh
set +e
cd ${shellQuote(record.cwd)}
code=$?
if [ "$code" -ne 0 ]; then
  printf '{"exitCode":%s,"completedAt":%s}\n' "$code" "$(date +%s)" > ${shellQuote(record.exitFile)}
  exit "$code"
fi
pi ${argString} "$(cat ${shellQuote(record.promptFile)})" < /dev/null > ${shellQuote(record.eventsFile)} 2> ${shellQuote(record.stderrFile)}
code=$?
printf '{"exitCode":%s,"completedAt":%s}\n' "$code" "$(date +%s)" > ${shellQuote(record.exitFile)}
exit "$code"
`;
}

async function maybeNotify(pi: ExtensionAPI, refreshed: RefreshedRecord): Promise<void> {
  const { record, parsed } = refreshed;
  if (!record.notify || record.notified) return;
  if (record.status !== "completed" && record.status !== "failed" && record.status !== "stopped") return;
  record.notified = true;
  saveRegistry(record.cwd);
  const summary = truncateMiddle(parsed.assistantText.trim() || "No assistant output.", 4000);
  pi.sendMessage({
    customType: "tmux-agent-notification",
    content: `Tmux agent ${record.id} ${record.status}: ${record.description}\n\n${summary}\n\nEvents: ${record.eventsFile}\nStderr: ${record.stderrFile}`,
    display: true,
    details: { id: record.id, status: record.status, description: record.description },
  }, { deliverAs: "followUp", triggerTurn: true });
}

function tmuxListCommand(recordOrCwd: AgentRecord | string): string {
  const socket = typeof recordOrCwd === "string" ? socketPath(recordOrCwd) : recordOrCwd.socketPath;
  return `tmux -S ${shellQuote(socket)} list-sessions`;
}

function tmuxAttachCommand(record: AgentRecord): string {
  return `tmux -S ${shellQuote(record.socketPath)} attach -t ${shellQuote(record.sessionName)}`;
}

function describeRecord(record: AgentRecord, parsed: ParsedEvents): string {
  const duration = formatDuration((record.completedAt ?? now()) - record.startedAt);
  const parts = [
    `Agent: ${record.id}`,
    `Description: ${record.description}`,
    `Status: ${record.status}`,
    `Session: ${record.sessionName}`,
    `Tmux socket: ${record.socketPath}`,
    `Tmux list: ${tmuxListCommand(record)}`,
    `Tmux attach: ${tmuxAttachCommand(record)}`,
    `Duration: ${duration}`,
    `Exit code: ${record.exitCode ?? "(pending)"}`,
    `Tools: ${parsed.toolEnds}/${parsed.toolStarts}${parsed.toolErrors ? ` (${parsed.toolErrors} errors)` : ""}`,
    `Events: ${record.eventsFile}`,
    `Stderr: ${record.stderrFile}`,
    `Result JSON: ${record.resultFile}`,
  ];
  if (record.status === "running" && parsed.activeTools.length) parts.push(`Active tools: ${parsed.activeTools.join(", ")}`);
  if (parsed.parseErrors) parts.push(`JSON parse errors: ${parsed.parseErrors}`);
  return parts.join("\n");
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    ensureRoot(ctx.cwd);
    records = loadRegistry(ctx.cwd, sessionIdFromCtx(ctx));
    if (!widgetTimer) widgetTimer = setInterval(() => { void updateWidget(pi); }, 2_000);
    await updateWidget(pi);
  });

  pi.on("session_shutdown", async () => {
    if (widgetTimer) clearInterval(widgetTimer);
    widgetTimer = undefined;
    currentCtx = undefined;
  });

  pi.registerTool({
    name: "tmux_agent_spawn",
    label: "Tmux Agent Spawn",
    description: "Start a tmux-managed pi subagent in JSON stream print mode. Uses a project-local tmux socket and returns immediately.",
    promptSnippet: "Start a background pi subagent in an isolated tmux socket and parse its JSONL event stream.",
    promptGuidelines: [
      "Use tmux_agent_spawn for independent background work that should not block the main agent.",
      "Set tmux_agent_spawn notify to true only when the main conversation should receive an automatic follow-up on completion.",
      "Use tmux_agent_result to inspect tmux agent output; do not parse tmux panes.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Task prompt for the subagent." }),
      description: Type.String({ description: "Short 3-5 word description shown in status widget." }),
      notify: Type.Optional(Type.Boolean({ description: "If true, automatically send a follow-up message when this subagent completes. Default false; use true when the main agent should continue from the result without manual polling." })),
      extensions: Type.Optional(Type.String({ description: "Whether the child pi loads extensions: disabled or inherit. Default disabled to avoid recursion." })),
      tools: Type.Optional(Type.String({ description: "Optional comma-separated pi tool allowlist passed to --tools." })),
      model: Type.Optional(Type.String({ description: "Optional model pattern/id passed to --model." })),
      thinking: Type.Optional(Type.String({ description: "Optional thinking level passed to --thinking." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const root = ensureRoot(cwd);
      const id = makeId();
      const sessionId = sessionIdFromCtx(ctx);
      const agentDir = join(root, "sessions", sessionId, id);
      mkdirSync(agentDir, { recursive: true });

      const extMode: ExtensionMode = params.extensions === "inherit" ? "inherit" : "disabled";

      const record: AgentRecord = {
        id,
        description: safeDescription(params.description),
        sessionName: `pi-agent-${id}`,
        cwd,
        rootDir: join(root, "sessions", sessionId),
        agentDir,
        socketPath: socketPath(cwd),
        promptFile: join(agentDir, "prompt.txt"),
        eventsFile: join(agentDir, "events.jsonl"),
        stderrFile: join(agentDir, "stderr.log"),
        runnerFile: join(agentDir, "run.sh"),
        exitFile: join(agentDir, "exit.json"),
        resultFile: join(agentDir, "result.json"),
        notify: params.notify === true,
        extensions: extMode,
        tools: typeof params.tools === "string" && params.tools.trim() ? params.tools.trim() : undefined,
        model: typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined,
        thinking: typeof params.thinking === "string" && params.thinking.trim() ? params.thinking.trim() : undefined,
        status: "running",
        startedAt: now(),
      };

      await writeFile(record.promptFile, buildPrompt(id, params.prompt), "utf-8");
      await writeFile(record.runnerFile, buildRunner(record), "utf-8");
      await chmod(record.runnerFile, 0o755);
      await writeFile(join(agentDir, "metadata.json"), JSON.stringify(record, null, 2), "utf-8");

      records.set(id, record);
      saveRegistry(cwd);

      const res = await tmux(pi, record.socketPath, ["new-session", "-d", "-s", record.sessionName, "-c", cwd, `sh ${shellQuote(record.runnerFile)}`], signal);
      if (res.code !== 0) {
        record.status = "failed";
        record.completedAt = now();
        record.exitCode = res.code;
        saveRegistry(cwd);
        throw new Error(`tmux failed to start agent: ${res.stderr || res.stdout || `exit ${res.code}`}`);
      }

      await updateWidget(pi);
      return {
        content: [{ type: "text" as const, text: `Started tmux agent.\nID: ${id}\nDescription: ${record.description}\nSession: ${record.sessionName}\nTmux socket: ${record.socketPath}\nTmux list: ${tmuxListCommand(record)}\nTmux attach: ${tmuxAttachCommand(record)}\nEvents: ${record.eventsFile}\nNotify: ${record.notify}` }],
        details: { id, status: record.status, eventsFile: record.eventsFile },
      };
    },
  });

  pi.registerTool({
    name: "tmux_agent_result",
    label: "Tmux Agent Result",
    description: "Read status and parsed output for a tmux-managed pi subagent from its JSONL event stream.",
    parameters: Type.Object({
      id: Type.String({ description: "Tmux agent ID." }),
      wait: Type.Optional(Type.Boolean({ description: "If true, wait up to timeoutMs for terminal status." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait time when wait is true. Default 60000." })),
      maxChars: Type.Optional(Type.Number({ description: "Maximum assistant output chars to return. Default 12000." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const record = records.get(params.id);
      if (!record) return { content: [{ type: "text" as const, text: `Agent not found: ${params.id}` }] };

      const deadline = now() + (typeof params.timeoutMs === "number" ? params.timeoutMs : 60_000);
      let refreshed = await refreshRecord(pi, record, signal);
      while (params.wait === true && refreshed.record.status === "running" && now() < deadline && !signal?.aborted) {
        await new Promise(r => setTimeout(r, 1_000));
        refreshed = await refreshRecord(pi, record, signal);
      }
      await maybeNotify(pi, refreshed);
      await updateWidget(pi);

      const maxChars = typeof params.maxChars === "number" ? Math.max(1000, params.maxChars) : MAX_PREVIEW_CHARS;
      const output = truncateMiddle(refreshed.parsed.assistantText.trim() || "No assistant output yet.", maxChars);
      return {
        content: [{ type: "text" as const, text: `${describeRecord(refreshed.record, refreshed.parsed)}\n\n--- Assistant Output ---\n${output}` }],
        details: { id: record.id, status: record.status, parsed: refreshed.parsed },
      };
    },
  });

  pi.registerTool({
    name: "tmux_agent_list",
    label: "Tmux Agent List",
    description: "List tmux-managed pi subagents for the current project.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const refreshed = await refreshAll(pi, ctx.cwd);
      await updateWidget(pi);
      if (refreshed.length === 0) return { content: [{ type: "text" as const, text: "No tmux agents for this pi session." }] };
      const lines = refreshed
        .sort((a, b) => b.record.startedAt - a.record.startedAt)
        .map(({ record, parsed }) => `${statusIcon(record.status)} ${record.id}  ${record.status.padEnd(9)} ${record.description}  tools:${parsed.toolEnds}/${parsed.toolStarts}  ${formatDuration((record.completedAt ?? now()) - record.startedAt)}`);
      const header = `Tmux agents for session ${sessionIdFromCtx(ctx)} (${refreshed.length}):\nTmux socket: ${socketPath(ctx.cwd)}\nTmux list: ${tmuxListCommand(ctx.cwd)}`;
      return { content: [{ type: "text" as const, text: `${header}\n${lines.join("\n")}` }] };
    },
  });

  pi.registerTool({
    name: "tmux_agent_stop",
    label: "Tmux Agent Stop",
    description: "Stop a tmux-managed pi subagent by killing its tmux session on the project-local socket.",
    parameters: Type.Object({
      id: Type.String({ description: "Tmux agent ID." }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const record = records.get(params.id);
      if (!record) return { content: [{ type: "text" as const, text: `Agent not found: ${params.id}` }] };
      const res = await tmux(pi, record.socketPath, ["kill-session", "-t", record.sessionName], signal);
      record.status = "stopped";
      record.stoppedAt = now();
      record.completedAt = record.completedAt ?? now();
      saveRegistry(record.cwd);
      await updateWidget(pi);
      return { content: [{ type: "text" as const, text: `Stopped ${record.id} (${record.description}). tmux exit: ${res.code}` }] };
    },
  });
}
