/**
 * Loop — run a prompt or slash command on a recurring interval.
 *
 * This is a local replacement for pi-mono-loop. The important difference is
 * single-flight delivery: each loop may have at most one prompt queued/running.
 * If the timer fires again before the previous prompt has been consumed by the
 * agent and completed, that tick is skipped instead of accumulating another
 * follow-up message.
 *
 * Usage:
 *   /loop [interval] <prompt>
 *   /loop list
 *   /loop stop [id]
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_INTERVAL = "10m";
const MIN_INTERVAL_MS = 10_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const USAGE_MESSAGE = `Usage: /loop [interval] <prompt>

Run a prompt or slash command on a recurring interval.

Intervals: Ns, Nm, Nh, Nd (e.g. 5m, 30m, 2h, 1d). Minimum is 10s.
If no interval is specified, defaults to ${DEFAULT_INTERVAL}.

Subcommands:
  /loop list           — list active loops
  /loop stop           — cancel all active loops
  /loop stop <id>      — cancel a specific loop by ID

Behavior:
  Each loop is single-flight: if a previous tick is still queued or running,
  the next tick is skipped instead of adding another queued message.

Examples:
  /loop 5m /review
  /loop 30m check the deploy
  /loop 1h run the tests
  /loop check the deploy          (defaults to ${DEFAULT_INTERVAL})
  /loop check the deploy every 20m`;

type LoopStatus = "idle" | "queued" | "running";

interface LoopEntry {
  id: string;
  prompt: string;
  intervalMs: number;
  createdAt: Date;
  fireCount: number;
  skippedCount: number;
  status: LoopStatus;
  timer: ReturnType<typeof setInterval>;
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface ParseResult {
  intervalMs: number;
  intervalLabel: string;
  prompt: string;
}

interface LoopToolParams {
  action: "start" | "list" | "stop" | "stop_all";
  prompt?: string;
  interval?: string;
  id?: string;
  runImmediately?: boolean;
}

interface ScheduleOptions {
  prompt: string;
  intervalMs: number;
  intervalLabel: string;
  runImmediately: boolean;
  isIdle: () => boolean;
  notify?: (message: string, level: "info" | "warning" | "error") => void;
}

const activeLoops = new Map<string, LoopEntry>();
let nextLoopId = 1;

function parseIntervalToken(token: string): number | null {
  const m = token.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (!m) return null;

  const n = Number.parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  switch (unit) {
    case "s":
      return n * 1_000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      return null;
  }
}

function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function parseArgs(input: string): ParseResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  const leading = parts[0]!;
  const leadingMs = parseIntervalToken(leading);
  if (leadingMs !== null) {
    return {
      intervalMs: leadingMs,
      intervalLabel: leading.toLowerCase(),
      prompt: parts.slice(1).join(" ").trim(),
    };
  }

  const trailingExact = trimmed.match(
    /^([\s\S]+?)\s+every\s+(\d+(?:\.\d+)?)(s|m|h|d|seconds?|minutes?|hours?|days?)$/i,
  );
  if (trailingExact) {
    const rawUnit = trailingExact[3]!.toLowerCase();
    const canonicalUnit = rawUnit.startsWith("s")
      ? "s"
      : rawUnit.startsWith("m")
        ? "m"
        : rawUnit.startsWith("h")
          ? "h"
          : "d";
    const token = `${trailingExact[2]}${canonicalUnit}`;
    return {
      intervalMs: parseIntervalToken(token)!,
      intervalLabel: token,
      prompt: trailingExact[1]!.trim(),
    };
  }

  return {
    intervalMs: parseIntervalToken(DEFAULT_INTERVAL)!,
    intervalLabel: DEFAULT_INTERVAL,
    prompt: trimmed,
  };
}

function generateId(): string {
  return `loop-${nextLoopId++}`;
}

function cancelLoop(entry: LoopEntry): void {
  clearInterval(entry.timer);
  clearTimeout(entry.expiryTimer);
  activeLoops.delete(entry.id);
}

function cancelAllLoops(): number {
  const count = activeLoops.size;
  for (const entry of activeLoops.values()) cancelLoop(entry);
  return count;
}

function matchingQueuedLoops(prompt: unknown): LoopEntry[] {
  if (typeof prompt !== "string") return [];
  return [...activeLoops.values()].filter((entry) => entry.status === "queued" && entry.prompt === prompt);
}

function describeLoop(entry: LoopEntry): string {
  return `• ${entry.id}  every ${formatInterval(entry.intervalMs)}  status: ${entry.status}  fires: ${entry.fireCount}  skipped: ${entry.skippedCount}  prompt: "${entry.prompt}"`;
}

function listLoopsText(): string {
  if (activeLoops.size === 0) return "No active loops.";
  return `Active loops (${activeLoops.size}):\n${[...activeLoops.values()].map(describeLoop).join("\n")}`;
}

function scheduleLoop(pi: ExtensionAPI, options: ScheduleOptions): LoopEntry {
  const effectiveMs = Math.max(options.intervalMs, MIN_INTERVAL_MS);
  const id = generateId();

  const sendPrompt = () => {
    const entry = activeLoops.get(id);
    if (!entry) return;

    if (entry.status !== "idle") {
      entry.skippedCount++;
      return;
    }

    entry.status = "queued";
    entry.fireCount++;

    if (options.isIdle()) {
      pi.sendUserMessage(entry.prompt);
    } else {
      pi.sendUserMessage(entry.prompt, { deliverAs: "followUp" });
    }
  };

  const timer = setInterval(sendPrompt, effectiveMs);
  const expiryTimer = setTimeout(() => {
    const entry = activeLoops.get(id);
    if (!entry) return;
    cancelLoop(entry);
    options.notify?.(`Loop "${id}" auto-expired after ${formatInterval(MAX_AGE_MS)}.`, "info");
  }, MAX_AGE_MS);

  const entry: LoopEntry = {
    id,
    prompt: options.prompt,
    intervalMs: effectiveMs,
    createdAt: new Date(),
    fireCount: 0,
    skippedCount: 0,
    status: "idle",
    timer,
    expiryTimer,
  };
  activeLoops.set(id, entry);

  if (options.runImmediately) sendPrompt();
  return entry;
}

function scheduleMessage(entry: LoopEntry): string {
  return (
    `Loop scheduled!\n` +
    `  ID: ${entry.id}\n` +
    `  Prompt: "${entry.prompt}"\n` +
    `  Interval: every ${formatInterval(entry.intervalMs)}\n` +
    `  Delivery: single-flight; ticks are skipped while the prior prompt is queued/running\n` +
    `  Auto-expires: after ${formatInterval(MAX_AGE_MS)}\n` +
    `  Cancel with: /loop stop ${entry.id}`
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("loop", {
    description: `Run a prompt on a recurring interval. Usage: /loop [interval] <prompt> (default: ${DEFAULT_INTERVAL})`,
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (!trimmed || trimmed === "help") {
        ctx.ui.notify(USAGE_MESSAGE, "info");
        return;
      }

      if (trimmed === "list") {
        ctx.ui.notify(listLoopsText(), "info");
        return;
      }

      if (trimmed === "stop") {
        const count = cancelAllLoops();
        ctx.ui.notify(count > 0 ? `Cancelled ${count} loop(s).` : "No active loops to cancel.", "info");
        return;
      }

      if (trimmed.startsWith("stop ")) {
        const id = trimmed.slice(5).trim();
        const entry = activeLoops.get(id);
        if (!entry) {
          ctx.ui.notify(`No loop found with ID "${id}". Use /loop list to see active loops.`, "warning");
          return;
        }
        cancelLoop(entry);
        ctx.ui.notify(`Loop "${id}" cancelled.`, "info");
        return;
      }

      const parsed = parseArgs(trimmed);
      if (!parsed?.prompt) {
        ctx.ui.notify(USAGE_MESSAGE, "warning");
        return;
      }

      if (parsed.intervalMs < MIN_INTERVAL_MS) {
        ctx.ui.notify(
          `Interval "${parsed.intervalLabel}" is below the minimum (${formatInterval(MIN_INTERVAL_MS)}). Using ${formatInterval(MIN_INTERVAL_MS)} instead.`,
          "warning",
        );
      }

      const entry = scheduleLoop(pi, {
        prompt: parsed.prompt,
        intervalMs: parsed.intervalMs,
        intervalLabel: parsed.intervalLabel,
        runImmediately: true,
        isIdle: () => ctx.isIdle(),
        notify: (message, level) => ctx.ui.notify(message, level),
      });

      ctx.ui.notify(scheduleMessage(entry), "info");
    },
  });

  pi.registerTool({
    name: "loop_control",
    label: "Loop Control",
    description:
      "Start, list, or stop recurring prompt loops. Loops are single-flight: a loop will not queue a new prompt while its previous prompt is still queued or running.",
    promptGuidelines: [
      "Only use loop_control when the user explicitly asks to schedule, repeat, monitor, or stop recurring work.",
      "Prefer runImmediately=false when creating a loop from inside an active agent turn, unless the user explicitly wants the first run now.",
      "Use loop_control list before stopping a loop if the target ID is unclear.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("list"),
        Type.Literal("stop"),
        Type.Literal("stop_all"),
      ]),
      prompt: Type.Optional(Type.String({ description: "Prompt to run for action=start." })),
      interval: Type.Optional(Type.String({ description: "Interval for action=start, e.g. 30s, 5m, 2h, 1d. Default: 10m." })),
      id: Type.Optional(Type.String({ description: "Loop ID for action=stop, e.g. loop-1." })),
      runImmediately: Type.Optional(
        Type.Boolean({ description: "Whether action=start should run the prompt immediately. Default: false for model-created loops." }),
      ),
    }),
    async execute(_toolCallId, params: LoopToolParams, _signal, _onUpdate, ctx) {
      if (params.action === "list") {
        return { content: [{ type: "text", text: listLoopsText() }], details: { loops: [...activeLoops.values()].map(describeLoop) } };
      }

      if (params.action === "stop_all") {
        const count = cancelAllLoops();
        return {
          content: [{ type: "text", text: count > 0 ? `Cancelled ${count} loop(s).` : "No active loops to cancel." }],
          details: { cancelled: count },
        };
      }

      if (params.action === "stop") {
        if (!params.id) throw new Error('loop_control action="stop" requires id.');
        const entry = activeLoops.get(params.id);
        if (!entry) {
          return {
            content: [{ type: "text", text: `No loop found with ID "${params.id}".\n\n${listLoopsText()}` }],
            details: { stopped: false, id: params.id },
          };
        }
        cancelLoop(entry);
        return {
          content: [{ type: "text", text: `Loop "${params.id}" cancelled.` }],
          details: { stopped: true, id: params.id },
        };
      }

      if (params.action === "start") {
        const prompt = params.prompt?.trim();
        if (!prompt) throw new Error('loop_control action="start" requires prompt.');

        const intervalLabel = params.interval?.trim() || DEFAULT_INTERVAL;
        const intervalMs = parseIntervalToken(intervalLabel);
        if (intervalMs === null) throw new Error(`Invalid interval "${intervalLabel}". Use Ns, Nm, Nh, or Nd, e.g. 30s, 5m, 2h, 1d.`);

        const effectiveMs = Math.max(intervalMs, MIN_INTERVAL_MS);
        const entry = scheduleLoop(pi, {
          prompt,
          intervalMs: effectiveMs,
          intervalLabel,
          runImmediately: params.runImmediately ?? false,
          isIdle: () => ctx.isIdle(),
        });

        const warning = intervalMs < MIN_INTERVAL_MS ? `\nNote: interval "${intervalLabel}" was below minimum; using ${formatInterval(MIN_INTERVAL_MS)}.` : "";
        return {
          content: [{ type: "text", text: `${scheduleMessage(entry)}${warning}` }],
          details: { id: entry.id, prompt: entry.prompt, intervalMs: entry.intervalMs, runImmediately: params.runImmediately ?? false },
        };
      }

      throw new Error(`Unknown loop_control action: ${(params as { action?: string }).action}`);
    },
  });

  pi.on("before_agent_start", (event) => {
    for (const entry of matchingQueuedLoops(event.prompt)) {
      entry.status = "running";
    }
  });

  pi.on("agent_end", () => {
    for (const entry of activeLoops.values()) {
      if (entry.status === "running") entry.status = "idle";
    }
  });

  pi.on("session_shutdown", () => {
    cancelAllLoops();
  });
}
