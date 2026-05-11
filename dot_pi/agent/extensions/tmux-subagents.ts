import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  type Component,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const EXT_ID = "tmux-agents";
const STATUS_WIDGET_ID = `${EXT_ID}:status`;
const LOG_DOCK_WIDGET_ID = `${EXT_ID}:dock`;
const MAX_PREVIEW_CHARS = 12_000;
const MAX_CACHED_ASSISTANT_CHARS = 64_000;
const MAX_WIDGET_AGENTS = 6;
const DEFAULT_DOCK_HEIGHT = 12;
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

interface EventParseCache {
  offset: number;
  partialLine: string;
  parsed: ParsedEvents;
  activeTools: Map<string, string>;
}

let records = new Map<string, AgentRecord>();
const eventParseCache = new Map<string, EventParseCache>();
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

function emptyParsedEvents(): ParsedEvents {
  return {
    agentStarted: false,
    agentEnded: false,
    assistantText: "",
    toolStarts: 0,
    toolEnds: 0,
    toolErrors: 0,
    activeTools: [],
    parseErrors: 0,
  };
}

function capAssistantText(parsed: ParsedEvents): void {
  if (parsed.assistantText.length > MAX_CACHED_ASSISTANT_CHARS) {
    parsed.assistantText = parsed.assistantText.slice(-MAX_CACHED_ASSISTANT_CHARS);
  }
}

function applyEventToParsed(event: any, parsed: ParsedEvents, active: Map<string, string>): void {
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
      if (ame?.type === "text_delta" && typeof ame.delta === "string") {
        parsed.assistantText += ame.delta;
        capAssistantText(parsed);
      }
      break;
    }
    case "message_end": {
      if (event.message?.role === "assistant") {
        const t = extractMessageText(event.message);
        if (t.trim()) {
          parsed.assistantText = t;
          capAssistantText(parsed);
        }
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

function parseEventsFile(path: string): ParsedEvents {
  let cache = eventParseCache.get(path);
  if (!cache) {
    cache = { offset: 0, partialLine: "", parsed: emptyParsedEvents(), activeTools: new Map() };
    eventParseCache.set(path, cache);
  }

  let size = 0;
  try { size = statSync(path).size; } catch { return cache.parsed; }

  if (size < cache.offset) {
    cache.offset = 0;
    cache.partialLine = "";
    cache.parsed = emptyParsedEvents();
    cache.activeTools.clear();
  }

  if (size === cache.offset) {
    cache.parsed.activeTools = [...cache.activeTools.values()];
    return cache.parsed;
  }

  const bytesToRead = size - cache.offset;
  const buffer = Buffer.allocUnsafe(bytesToRead);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, cache.offset);
    cache.offset += bytesRead;
    const chunk = buffer.subarray(0, bytesRead).toString("utf-8");
    const combined = cache.partialLine + chunk;
    const lines = combined.split("\n");
    cache.partialLine = combined.endsWith("\n") ? "" : (lines.pop() ?? "");

    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) continue;
      try {
        applyEventToParsed(JSON.parse(line), cache.parsed, cache.activeTools);
      } catch {
        cache.parsed.parseErrors++;
      }
    }
  } catch {
    // Keep the last good parsed snapshot if the file is temporarily unreadable.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }

  cache.parsed.activeTools = [...cache.activeTools.values()];
  return cache.parsed;
}

async function refreshRecord(pi: ExtensionAPI, record: AgentRecord, signal?: AbortSignal, persist = true): Promise<RefreshedRecord> {
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
  if (persist) saveRegistry(record.cwd);
  return { record, parsed };
}

async function refreshAll(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<RefreshedRecord[]> {
  const cwdRecords = [...records.values()].filter(record => record.cwd === cwd);
  const refreshed = await Promise.all(
    cwdRecords.map(record => refreshRecord(pi, record, signal, false).catch(() => ({ record, parsed: parseEventsFile(record.eventsFile) }))),
  );
  if (cwdRecords.length > 0) saveRegistry(cwd);
  return refreshed;
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

type DockVisibility = "hidden" | "collapsed" | "open";

let dockVisibility: DockVisibility = "hidden";
let dockFocusedAgentId: string | null = null;
let dockComponent: TmuxAgentDockComponent | null = null;
let dockTui: { requestRender(): void } | null = null;

function isLive(status: AgentStatus): boolean {
  return status === "running";
}

function statusLabel(status: AgentStatus, exitCode?: number): string {
  switch (status) {
    case "running": return "running";
    case "completed": return "exit(0)";
    case "failed": return `exit(${exitCode ?? "?"})`;
    case "stopped": return "stopped";
    default: return status;
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function renderPanelRule(width: number, theme: Theme): string {
  return theme.fg("dim", "─".repeat(Math.max(0, width)));
}

function renderPanelTitleLine(title: string, width: number, theme: Theme): string {
  const titleText = ` ${title} `;
  const borderLen = Math.max(0, width - visibleWidth(titleText));
  const left = Math.floor(borderLen / 2);
  const right = borderLen - left;
  return theme.fg("dim", "─".repeat(left)) + theme.fg("accent", theme.bold(titleText)) + theme.fg("dim", "─".repeat(right));
}

function createPanelPadder(width: number): (content: string) => string {
  const innerWidth = Math.max(0, width - 2);
  return (content: string) => {
    const line = visibleWidth(content) > innerWidth ? truncateToWidth(content, innerWidth) : content;
    return ` ${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))} `;
  };
}

function snapshotRecords(cwd: string): RefreshedRecord[] {
  return [...records.values()]
    .filter(record => record.cwd === cwd)
    .map(record => ({ record, parsed: parseEventsFile(record.eventsFile) }))
    .sort((a, b) => {
      const liveDiff = Number(isLive(b.record.status)) - Number(isLive(a.record.status));
      if (liveDiff !== 0) return liveDiff;
      return (b.record.completedAt ?? b.record.startedAt) - (a.record.completedAt ?? a.record.startedAt);
    });
}

function readTail(path: string, maxLines: number): string[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean).slice(-maxLines).map(stripAnsi);
  } catch {
    return [];
  }
}

function outputPreviewLines(item: RefreshedRecord, maxLines: number): string[] {
  const text = item.parsed.assistantText.trim();
  if (text) return text.split(/\r?\n/).filter(Boolean).slice(-maxLines).map(stripAnsi);
  if (item.parsed.activeTools.length) return [`active tools: ${item.parsed.activeTools.join(", ")}`];
  const stderr = readTail(item.record.stderrFile, maxLines);
  if (stderr.length) return stderr;
  if (item.record.status === "running") return ["(no assistant output yet)"];
  return ["(no output)"];
}

function renderStatusWidget(refreshed: RefreshedRecord[], theme: Theme, maxWidth: number): string[] {
  if (refreshed.length === 0) return [];
  const ordered = [...refreshed].sort((a, b) => {
    const liveDiff = Number(isLive(b.record.status)) - Number(isLive(a.record.status));
    if (liveDiff !== 0) return liveDiff;
    return (b.record.completedAt ?? b.record.startedAt) - (a.record.completedAt ?? a.record.startedAt);
  });

  const prefix = theme.fg("dim", "tmux agents: ");
  const separator = theme.fg("dim", " | ");
  const parts: string[] = [];
  let currentLen = visibleWidth(prefix);

  for (const [index, item] of ordered.entries()) {
    const { record, parsed } = item;
    const name = record.description.length > 20 ? `${record.description.slice(0, 17)}...` : record.description;
    const tone = record.status === "running" ? "accent" : record.status === "completed" ? "dim" : record.status === "failed" ? "error" : "warning";
    const tool = record.status === "running" && parsed.activeTools.length ? `:${parsed.activeTools[0]}` : "";
    const formatted = `${theme.fg(tone as any, name)} ${theme.fg("dim", statusLabel(record.status, record.exitCode) + tool)}`;
    const remaining = ordered.length - index - 1;
    const suffix = remaining > 0 ? separator + theme.fg("dim", `+${remaining} more`) : "";
    const needed = (parts.length ? visibleWidth(separator) : 0) + visibleWidth(formatted) + visibleWidth(suffix);
    if (currentLen + needed > maxWidth && parts.length > 0) {
      parts.push(theme.fg("dim", `+${ordered.length - index} more`));
      break;
    }
    parts.push(formatted);
    currentLen += (parts.length > 1 ? visibleWidth(separator) : 0) + visibleWidth(formatted);
    if (parts.length >= MAX_WIDGET_AGENTS) {
      const hidden = ordered.length - parts.length;
      if (hidden > 0) parts.push(theme.fg("dim", `+${hidden} more`));
      break;
    }
  }

  const line = prefix + parts.join(separator);
  return [visibleWidth(line) > maxWidth ? truncateToWidth(line, maxWidth) : line];
}

async function updateWidget(pi: ExtensionAPI): Promise<void> {
  const ctx = currentCtx;
  if (!ctx?.hasUI) return;
  const refreshed = await refreshAll(pi, ctx.cwd).catch(() => []);
  let notificationDirty = false;
  for (const item of refreshed) notificationDirty = (await maybeNotify(pi, item)) || notificationDirty;
  if (notificationDirty) saveRegistry(ctx.cwd);

  const maxWidth = process.stdout.columns || 120;
  const statusLines = renderStatusWidget(refreshed, ctx.ui.theme, maxWidth);
  ctx.ui.setWidget(STATUS_WIDGET_ID, statusLines.length ? statusLines : undefined, { placement: "belowEditor" });

  const running = refreshed.filter(item => item.record.status === "running");
  if (dockVisibility === "collapsed" && running.length === 0) dockVisibility = "hidden";

  if (dockVisibility === "hidden") {
    ctx.ui.setWidget(LOG_DOCK_WIDGET_ID, undefined);
    dockComponent?.dispose();
    dockComponent = null;
    dockTui = null;
    return;
  }

  const mode = dockVisibility;
  const height = mode === "collapsed" ? 3 : DEFAULT_DOCK_HEIGHT;
  if (dockComponent && dockTui) {
    dockComponent.update({ mode, focusedAgentId: dockFocusedAgentId, height });
    dockTui.requestRender();
    return;
  }

  ctx.ui.setWidget(
    LOG_DOCK_WIDGET_ID,
    (tui: { requestRender(): void }, theme: Theme) => {
      dockTui = tui;
      dockComponent = new TmuxAgentDockComponent({ cwd: ctx.cwd, theme, tui, mode, focusedAgentId: dockFocusedAgentId, height });
      return dockComponent;
    },
    { placement: "aboveEditor" },
  );
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

async function maybeNotify(pi: ExtensionAPI, refreshed: RefreshedRecord): Promise<boolean> {
  const { record, parsed } = refreshed;
  if (!record.notify || record.notified) return false;
  if (record.status !== "completed" && record.status !== "failed" && record.status !== "stopped") return false;
  record.notified = true;
  const summary = truncateMiddle(parsed.assistantText.trim() || "No assistant output.", 4000);
  pi.sendMessage({
    customType: "tmux-agent-notification",
    content: `Tmux agent ${record.id} ${record.status}: ${record.description}\n\n${summary}\n\nEvents: ${record.eventsFile}\nStderr: ${record.stderrFile}`,
    display: true,
    details: { id: record.id, status: record.status, description: record.description },
  }, { deliverAs: "followUp", triggerTurn: true });
  return true;
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

function formatAgentLine(item: RefreshedRecord, theme: Theme, selected = false, width = 120): string {
  const { record, parsed } = item;
  const duration = formatDuration((record.completedAt ?? now()) - record.startedAt);
  const icon = statusIcon(record.status);
  const tone = record.status === "running" ? "accent" : record.status === "completed" ? "success" : record.status === "failed" ? "error" : "warning";
  const tool = record.status === "running" && parsed.activeTools.length ? ` · ${parsed.activeTools.slice(0, 2).join(",")}` : parsed.toolEnds ? ` · ${parsed.toolEnds} tools` : "";
  const prefix = selected ? theme.fg("accent", "> ") : "  ";
  const line = `${prefix}${theme.fg(tone as any, icon)} ${theme.fg("accent", record.description)} ${theme.fg("dim", `(${record.id})`)} ${theme.fg("dim", statusLabel(record.status, record.exitCode))} ${theme.fg("dim", duration)}${theme.fg("dim", tool)}`;
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

class TmuxAgentDockComponent implements Component {
  private cwd: string;
  private theme: Theme;
  private tui: { requestRender(): void };
  private mode: "collapsed" | "open";
  private focusedAgentId: string | null;
  private height: number;

  constructor(opts: { cwd: string; theme: Theme; tui: { requestRender(): void }; mode: "collapsed" | "open"; focusedAgentId: string | null; height: number }) {
    this.cwd = opts.cwd;
    this.theme = opts.theme;
    this.tui = opts.tui;
    this.mode = opts.mode;
    this.focusedAgentId = opts.focusedAgentId;
    this.height = opts.height;
  }

  update(opts: { mode: "collapsed" | "open"; focusedAgentId: string | null; height: number }): void {
    this.mode = opts.mode;
    this.focusedAgentId = opts.focusedAgentId;
    this.height = opts.height;
    this.tui.requestRender();
  }

  handleInput(_data: string): boolean { return false; }
  invalidate(): void { /* render is cheap and reads live files */ }
  dispose(): void { /* no subscriptions */ }

  render(width: number): string[] {
    return this.mode === "collapsed" ? this.renderCollapsed(width) : this.renderOpen(width);
  }

  private renderCollapsed(width: number): string[] {
    const theme = this.theme;
    const pad = createPanelPadder(width);
    const items = snapshotRecords(this.cwd);
    const running = items.filter(item => item.record.status === "running");
    const finished = items.filter(item => item.record.status !== "running");

    const parts = running.slice(0, 4).map(item => `${theme.fg("accent", "●")} ${item.record.description}`);
    if (running.length > 4) parts.push(theme.fg("dim", `+${running.length - 4} running`));
    if (finished.length > 0) parts.push(theme.fg("dim", `+${finished.length} finished`));

    const latest = (this.focusedAgentId ? items.find(i => i.record.id === this.focusedAgentId) : undefined) ?? running[0] ?? items[0];
    const lastLine = latest ? outputPreviewLines(latest, 1)[0] ?? "" : "No tmux agents";

    return [
      renderPanelRule(width, theme),
      pad(parts.length ? parts.join(theme.fg("dim", " | ")) : theme.fg("dim", "No tmux agents")),
      pad(theme.fg("dim", truncateToWidth(lastLine, Math.max(0, width - 2)))),
    ];
  }

  private renderOpen(width: number): string[] {
    const theme = this.theme;
    const pad = createPanelPadder(width);
    const innerWidth = Math.max(0, width - 2);
    const items = snapshotRecords(this.cwd);
    const selected = (this.focusedAgentId ? items.find(i => i.record.id === this.focusedAgentId) : undefined) ?? items.find(i => i.record.status === "running") ?? items[0];
    const lines: string[] = [renderPanelTitleLine("Tmux Agents", width, theme)];

    if (!selected) {
      lines.push(pad(theme.fg("dim", "No tmux agents")));
      lines.push(pad(theme.fg("dim", "Use tmux_agent_spawn to start one")));
      return lines.slice(0, this.height);
    }

    for (const item of items.slice(0, 4)) {
      lines.push(pad(formatAgentLine(item, theme, item.record.id === selected.record.id, innerWidth)));
    }
    if (items.length > 4) lines.push(pad(theme.fg("dim", `+${items.length - 4} more — open /ta for the full panel`)));

    lines.push(renderPanelRule(width, theme));
    lines.push(pad(`${theme.fg("accent", selected.record.description)} ${theme.fg("dim", `(${selected.record.id})`)} ${theme.fg("dim", statusLabel(selected.record.status, selected.record.exitCode))}`));

    const remaining = Math.max(1, this.height - lines.length - 2);
    for (const line of outputPreviewLines(selected, remaining)) lines.push(pad(line));
    while (lines.length < this.height - 1) lines.push(pad(""));
    lines.push(pad(`${theme.fg("dim", "/ta")} panel  ${theme.fg("dim", "/ta:dock toggle")} dock  ${theme.fg("dim", "tmux attach available in result")}`));
    return lines.slice(0, this.height);
  }
}

class TmuxAgentsPanelComponent implements Component {
  private selectedIndex = 0;
  private logScrollOffset = 0;

  constructor(
    private opts: {
      cwd: string;
      theme: Theme;
      tui: { requestRender(): void };
      onClose(): void;
      onFocus(id: string): void;
      onStop(id: string): Promise<void>;
      onClearFinished(): void;
    },
  ) {}

  handleInput(data: string): boolean {
    const items = snapshotRecords(this.opts.cwd);
    if ((matchesKey(data, "down") || data === "j") && items.length) {
      this.selectedIndex = Math.min(this.selectedIndex + 1, items.length - 1);
      this.logScrollOffset = 0;
      this.opts.tui.requestRender();
      return true;
    }
    if ((matchesKey(data, "up") || data === "k") && items.length) {
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.logScrollOffset = 0;
      this.opts.tui.requestRender();
      return true;
    }
    if (data === "J") { this.logScrollOffset = Math.max(0, this.logScrollOffset - 5); this.opts.tui.requestRender(); return true; }
    if (data === "K") { this.logScrollOffset += 5; this.opts.tui.requestRender(); return true; }
    if (matchesKey(data, "return") && items[this.selectedIndex]) {
      this.opts.onFocus(items[this.selectedIndex]!.record.id);
      this.opts.onClose();
      return true;
    }
    if (data === "x" && items[this.selectedIndex]) {
      void this.opts.onStop(items[this.selectedIndex]!.record.id).finally(() => this.opts.tui.requestRender());
      return true;
    }
    if (data === "c" || data === "C") {
      this.opts.onClearFinished();
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, snapshotRecords(this.opts.cwd).length - 1));
      this.opts.tui.requestRender();
      return true;
    }
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.opts.onClose();
      return true;
    }
    return true;
  }

  invalidate(): void { /* stateless render */ }

  render(width: number): string[] {
    const theme = this.opts.theme;
    const pad = createPanelPadder(width);
    const innerWidth = Math.max(0, width - 2);
    const lines: string[] = [renderPanelTitleLine("Tmux Subagents", width, theme)];
    const items = snapshotRecords(this.opts.cwd);

    if (items.length === 0) {
      lines.push(pad(""));
      lines.push(pad(theme.fg("dim", "No tmux agents for this session")));
      lines.push(pad(theme.fg("dim", "Use tmux_agent_spawn to start background work")));
      lines.push(pad(""));
    } else {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, items.length - 1));
      lines.push(pad(theme.fg("dim", "Agent".padEnd(34)) + theme.fg("dim", "Status".padEnd(14)) + theme.fg("dim", "Time".padEnd(8)) + theme.fg("dim", "Tools")));
      lines.push(renderPanelRule(width, theme));
      const maxRows = Math.min(8, items.length);
      for (let i = 0; i < maxRows; i++) {
        const item = items[i]!;
        const r = item.record;
        const p = item.parsed;
        const marker = i === this.selectedIndex ? theme.fg("accent", "> ") : "  ";
        const agent = `${r.description} ${theme.fg("dim", `(${r.id})`)}`;
        const status = statusLabel(r.status, r.exitCode);
        const time = formatDuration((r.completedAt ?? now()) - r.startedAt);
        const tools = r.status === "running" && p.activeTools.length ? p.activeTools.join(",") : `${p.toolEnds}/${p.toolStarts}`;
        const row = marker + truncateToWidth(agent, 32).padEnd(Math.max(0, 32 + (agent.length - visibleWidth(agent)))) + status.padEnd(14) + time.padEnd(8) + tools;
        lines.push(pad(row));
      }
      if (items.length > maxRows) lines.push(pad(theme.fg("dim", `+${items.length - maxRows} more`)));

      const selected = items[this.selectedIndex]!;
      lines.push(renderPanelRule(width, theme));
      lines.push(pad(`${theme.fg("accent", "Output:")} ${selected.record.description} ${theme.fg("dim", `(${selected.record.id})`)}`));
      const outputLines = outputPreviewLines(selected, 200);
      const previewRows = Math.max(4, Math.min(12, outputLines.length));
      const end = Math.max(0, outputLines.length - this.logScrollOffset);
      const start = Math.max(0, end - previewRows);
      const visible = outputLines.slice(start, end);
      for (const line of visible) lines.push(pad(truncateToWidth(line, innerWidth)));
      while (visible.length < previewRows) { visible.push(""); lines.push(pad("")); }
    }

    lines.push(renderPanelRule(width, theme));
    lines.push(pad(`${theme.fg("dim", "enter")} focus dock  ${theme.fg("dim", "j/k")} select  ${theme.fg("dim", "x")} stop  ${theme.fg("dim", "c")} clear finished  ${theme.fg("dim", "q")} quit`));
    return lines;
  }
}

function renderToolCall(toolName: string, action: string, mainArg: string | undefined, theme: Theme, optionArgs: string[] = []): Component {
  const parts = [theme.fg("toolTitle", theme.bold(`${toolName}:`)), theme.fg("accent", action)];
  if (mainArg) parts.push(theme.fg("accent", mainArg));
  parts.push(...optionArgs.map(a => theme.fg("dim", a)));
  return new Text(parts.join(" "), 0, 0);
}

function renderToolResult(result: AgentToolResult<any>, options: ToolRenderResultOptions, theme: Theme): Component {
  const details = result.details ?? {};
  const textBlock = result.content.find(c => c.type === "text") as { type: "text"; text: string } | undefined;
  const raw = textBlock?.text ?? "";
  const status = details.status as AgentStatus | undefined;
  const tone = !details.success ? "error" : status === "completed" ? "success" : status === "failed" ? "error" : status === "running" ? "accent" : "muted";
  if (!options.expanded) {
    const summary = details.message ?? (details.id ? `${details.id} ${status ?? ""}` : raw.split(/\r?\n/)[0] ?? "");
    return new Text(theme.fg(tone as any, truncateToWidth(summary, 160)), 0, 0);
  }

  const lines: string[] = [];
  if (details.message) lines.push(theme.fg(tone as any, details.message));
  if (Array.isArray(details.agents)) {
    for (const agent of details.agents) {
      lines.push(`- ${theme.fg("accent", agent.description ?? agent.id)} ${theme.fg("dim", `(${agent.id})`)} ${theme.fg("dim", agent.status ?? "")}`);
    }
  }
  if (details.eventsFile) lines.push(`events: ${theme.fg("accent", details.eventsFile)}`);
  if (raw && !details.message) lines.push(raw);
  else if (raw) lines.push("", theme.fg("dim", raw));
  return new Text(lines.join("\n"), 0, 0);
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (widgetTimer) clearInterval(widgetTimer);
    widgetTimer = undefined;
    dockComponent?.dispose();
    dockComponent = null;
    dockTui = null;
    eventParseCache.clear();
    currentCtx?.ui.setWidget(STATUS_WIDGET_ID, undefined);
    currentCtx?.ui.setWidget(LOG_DOCK_WIDGET_ID, undefined);
    currentCtx?.ui.setWidget(EXT_ID, undefined);

    currentCtx = ctx;
    ensureRoot(ctx.cwd);
    records = loadRegistry(ctx.cwd, sessionIdFromCtx(ctx));
    widgetTimer = setInterval(() => { void updateWidget(pi); }, 2_000);
    await updateWidget(pi);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (widgetTimer) clearInterval(widgetTimer);
    widgetTimer = undefined;
    currentCtx = undefined;
    dockComponent?.dispose();
    dockComponent = null;
    dockTui = null;
    eventParseCache.clear();
    ctx.ui.setWidget(STATUS_WIDGET_ID, undefined);
    ctx.ui.setWidget(LOG_DOCK_WIDGET_ID, undefined);
    ctx.ui.setWidget(EXT_ID, undefined);
  });

  pi.registerCommand("ta", {
    description: "View and manage tmux subagents",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      await refreshAll(pi, ctx.cwd);
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new TmuxAgentsPanelComponent({
        cwd: ctx.cwd,
        theme,
        tui,
        onClose: () => done(),
        onFocus: (id: string) => {
          dockFocusedAgentId = id;
          dockVisibility = "open";
          void updateWidget(pi);
        },
        onStop: async (id: string) => {
          const record = records.get(id);
          if (!record) return;
          await tmux(pi, record.socketPath, ["kill-session", "-t", record.sessionName]).catch(() => undefined);
          record.status = "stopped";
          record.stoppedAt = now();
          record.completedAt = record.completedAt ?? now();
          saveRegistry(record.cwd);
          await updateWidget(pi);
        },
        onClearFinished: () => {
          for (const [id, record] of records) {
            if (record.cwd === ctx.cwd && record.status !== "running") {
              eventParseCache.delete(record.eventsFile);
              records.delete(id);
            }
          }
          saveRegistry(ctx.cwd);
          void updateWidget(pi);
        },
      }));
    },
  });

  pi.registerCommand("ta:dock", {
    description: "Control tmux subagent dock visibility",
    getArgumentCompletions: () => [
      { value: "show", label: "show — expand the dock" },
      { value: "collapse", label: "collapse — show compact dock" },
      { value: "hide", label: "hide — hide the dock" },
      { value: "toggle", label: "toggle — cycle dock visibility" },
    ],
    handler: async (args, _ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "show" || arg === "open") dockVisibility = "open";
      else if (arg === "collapse" || arg === "collapsed") dockVisibility = "collapsed";
      else if (arg === "hide") dockVisibility = "hidden";
      else if (dockVisibility === "hidden") dockVisibility = "collapsed";
      else if (dockVisibility === "collapsed") dockVisibility = "open";
      else dockVisibility = "collapsed";
      await updateWidget(pi);
    },
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

      if (ctx.hasUI && dockVisibility === "hidden") dockVisibility = "collapsed";
      dockFocusedAgentId = id;
      await updateWidget(pi);
      const message = `Started tmux agent.\nID: ${id}\nDescription: ${record.description}\nSession: ${record.sessionName}\nTmux socket: ${record.socketPath}\nTmux list: ${tmuxListCommand(record)}\nTmux attach: ${tmuxAttachCommand(record)}\nEvents: ${record.eventsFile}\nNotify: ${record.notify}`;
      return {
        content: [{ type: "text" as const, text: message }],
        details: { action: "spawn", success: true, message: `Started ${record.description} (${id})`, id, description: record.description, status: record.status, eventsFile: record.eventsFile },
      };
    },
    renderCall(args, theme) {
      const opts = [args.notify ? "notify=true" : "", args.extensions === "inherit" ? "extensions=inherit" : ""].filter(Boolean);
      return renderToolCall("Tmux Agent", "spawn", args.description ? `\"${args.description}\"` : undefined, theme, opts);
    },
    renderResult(result, options, theme) {
      return renderToolResult(result, options, theme);
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
      if (!record) return { content: [{ type: "text" as const, text: `Agent not found: ${params.id}` }], details: { action: "result", success: false, message: `Agent not found: ${params.id}`, id: params.id } };

      const deadline = now() + (typeof params.timeoutMs === "number" ? params.timeoutMs : 60_000);
      let refreshed = await refreshRecord(pi, record, signal);
      while (params.wait === true && refreshed.record.status === "running" && now() < deadline && !signal?.aborted) {
        await new Promise(r => setTimeout(r, 1_000));
        refreshed = await refreshRecord(pi, record, signal);
      }
      if (await maybeNotify(pi, refreshed)) saveRegistry(record.cwd);
      await updateWidget(pi);

      const maxChars = typeof params.maxChars === "number" ? Math.max(1000, params.maxChars) : MAX_PREVIEW_CHARS;
      const output = truncateMiddle(refreshed.parsed.assistantText.trim() || "No assistant output yet.", maxChars);
      return {
        content: [{ type: "text" as const, text: `${describeRecord(refreshed.record, refreshed.parsed)}\n\n--- Assistant Output ---\n${output}` }],
        details: { action: "result", success: true, message: `${record.description} ${statusLabel(record.status, record.exitCode)}`, id: record.id, description: record.description, status: record.status, parsed: refreshed.parsed },
      };
    },
    renderCall(args, theme) {
      const opts = [args.wait ? "wait=true" : "", typeof args.timeoutMs === "number" ? `timeout=${args.timeoutMs}ms` : ""].filter(Boolean);
      return renderToolCall("Tmux Agent", "result", args.id, theme, opts);
    },
    renderResult(result, options, theme) {
      return renderToolResult(result, options, theme);
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
      if (refreshed.length === 0) return { content: [{ type: "text" as const, text: "No tmux agents for this pi session." }], details: { action: "list", success: true, message: "No tmux agents", agents: [] } };
      const sorted = refreshed.sort((a, b) => b.record.startedAt - a.record.startedAt);
      const lines = sorted
        .map(({ record, parsed }) => `${statusIcon(record.status)} ${record.id}  ${record.status.padEnd(9)} ${record.description}  tools:${parsed.toolEnds}/${parsed.toolStarts}  ${formatDuration((record.completedAt ?? now()) - record.startedAt)}`);
      const header = `Tmux agents for session ${sessionIdFromCtx(ctx)} (${refreshed.length}):\nTmux socket: ${socketPath(ctx.cwd)}\nTmux list: ${tmuxListCommand(ctx.cwd)}`;
      return {
        content: [{ type: "text" as const, text: `${header}\n${lines.join("\n")}` }],
        details: { action: "list", success: true, message: `${refreshed.length} tmux agent(s)`, agents: sorted.map(({ record, parsed }) => ({ id: record.id, description: record.description, status: record.status, toolStarts: parsed.toolStarts, toolEnds: parsed.toolEnds })) },
      };
    },
    renderCall(_args, theme) {
      return renderToolCall("Tmux Agent", "list", undefined, theme);
    },
    renderResult(result, options, theme) {
      return renderToolResult(result, options, theme);
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
      if (!record) return { content: [{ type: "text" as const, text: `Agent not found: ${params.id}` }], details: { action: "stop", success: false, message: `Agent not found: ${params.id}`, id: params.id } };
      const res = await tmux(pi, record.socketPath, ["kill-session", "-t", record.sessionName], signal);
      record.status = "stopped";
      record.stoppedAt = now();
      record.completedAt = record.completedAt ?? now();
      saveRegistry(record.cwd);
      await updateWidget(pi);
      const message = `Stopped ${record.id} (${record.description}). tmux exit: ${res.code}`;
      return { content: [{ type: "text" as const, text: message }], details: { action: "stop", success: true, message, id: record.id, description: record.description, status: record.status } };
    },
    renderCall(args, theme) {
      return renderToolCall("Tmux Agent", "stop", args.id, theme);
    },
    renderResult(result, options, theme) {
      return renderToolResult(result, options, theme);
    },
  });
}
