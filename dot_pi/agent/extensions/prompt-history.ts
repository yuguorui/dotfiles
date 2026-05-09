/**
 * prompt-history — cross-session prompt history with up/down arrow navigation.
 *
 * Press Up when the cursor is on the first line to cycle through previous
 * user prompts from the same working directory. Press Down to cycle forward.
 * If text is already typed, only prompts starting with that prefix are matched.
 *
 * Usage: drop this file into ~/.pi/agent/extensions/ and /reload.
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of unique prompts to keep in memory. */
const MAX_PROMPTS = 500;

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a user-message content field.
 *
 * Pi stores user content in two forms:
 *   - legacy:  "hello world"
 *   - current: [{"type": "text", "text": "hello world"}]
 *
 * Non-text blocks (images, tool calls) are silently skipped.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n");
  }
  return "";
}

/**
 * Keys that should pass through to the editor *without* exiting history
 * navigation.  Cursor-movement keys let the user position the caret inside
 * a recalled prompt; Enter / Shift+Enter submit or insert a newline as-is.
 */
function isNavigationPassthroughKey(data: string): boolean {
  const keys = [
    // cursor movement
    "left", "right", "home", "end", "pageUp", "pageDown",
    "alt+left", "alt+right", "ctrl+left", "ctrl+right",
    "ctrl+a", "ctrl+e", "ctrl+b", "ctrl+f",
    "alt+b", "alt+f",
    "ctrl+home", "ctrl+end",
    "ctrl+]", "ctrl+alt+]",
    // submit / newline – keep the recalled text
    "enter", "shift+enter",
  ];
  return keys.some((k) => matchesKey(data, k));
}

// ---------------------------------------------------------------------------
// Prompt loader
// ---------------------------------------------------------------------------

interface TimedPrompt {
  text: string;
  timestamp: number;
}

/**
 * Scan the per-cwd session directory and extract all user prompts from
 * all session files.  Results are timestamp-descending, deduplicated by
 * exact text, and capped to {@link MAX_PROMPTS}.
 */
function loadPrompts(sessionDir: string): string[] {
  if (!existsSync(sessionDir)) return [];

  const allFiles = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));

  const raw: TimedPrompt[] = [];

  for (const file of allFiles) {
    try {
      const lines = readFileSync(join(sessionDir, file), "utf-8").split("\n");
      for (const line of lines) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "message" && entry.message?.role === "user") {
            const text = extractText(entry.message.content);
            if (text) {
              raw.push({
                text,
                timestamp: new Date(entry.timestamp ?? 0).getTime(),
              });
            }
          }
        } catch {
          // Malformed JSON line – skip.
        }
      }
    } catch {
      // Unreadable file – skip.
    }
  }

  // Most-recent first, deduplicate, then cap.
  raw.sort((a, b) => b.timestamp - a.timestamp);

  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of raw) {
    if (seen.has(p.text)) continue;
    seen.add(p.text);
    result.push(p.text);
    if (result.length >= MAX_PROMPTS) break;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Custom editor
// ---------------------------------------------------------------------------

/**
 * Wraps the default editor to intercept Up / Down on the first visual line.
 *
 * State machine:
 *   IDLE  – normal editing.
 *   NAV   – user pressed Up on line 0; each Up/Down walks the match list.
 *
 * Transition table:
 *   IDLE + Up (line 0)  → NAV,  snapshot current text as prefix.
 *   NAV  + Up           → move toward older matches.
 *   NAV  + Down         → move toward newer matches.
 *   NAV  + Down @ idx 0 → restore prefix, return to IDLE.
 *   NAV  + any other key → IDLE (edit normally).
 */
class PromptHistoryEditor extends CustomEditor {
  /** Full prompt list (newest first), shared by reference with the extension. */
  private crossSessionPrompts: string[] = [];

  /** -1 = IDLE; ≥0 = position in `matches`. */
  private historyNavIndex = -1;

  /** Text captured from the editor when navigation started (the prefix). */
  private preNavText = "";

  // -- public helpers -------------------------------------------------------

  setPrompts(prompts: string[]) {
    this.crossSessionPrompts = prompts;
  }

  // -- keyboard interception ------------------------------------------------

  handleInput(data: string): void {
    if (matchesKey(data, "up")) {
      const cursor = this.getCursor();
      if (cursor.line === 0) {
        this.navigateUp();
        return;
      }
    }

    // While navigating: Down walks the match list, cursor-movement /
    // Enter / Shift+Enter pass through, anything else exits navigation.
    if (this.historyNavIndex >= 0) {
      if (matchesKey(data, "down")) {
        this.navigateDown();
        return;
      }
      if (!isNavigationPassthroughKey(data)) {
        this.exitNavigation();
      }
    }

    super.handleInput(data);
  }

  // -- navigation -----------------------------------------------------------

  /** Move one step toward older matches. */
  private navigateUp(): void {
    if (this.historyNavIndex < 0) {
      // Enter navigation mode: snapshot current editor content.
      this.preNavText = this.getText();
    }

    const matches = this.getMatches();
    if (matches.length === 0) return;

    this.historyNavIndex = Math.min(
      this.historyNavIndex + 1,
      matches.length - 1,
    );
    this.setText(matches[this.historyNavIndex]!);
  }

  /** Move one step toward newer matches, or exit navigation. */
  private navigateDown(): void {
    if (this.historyNavIndex <= 0) {
      // Restore the original prefix, then drop out of navigation.
      this.setText(this.preNavText);
      this.exitNavigation();
      return;
    }

    const matches = this.getMatches();
    this.historyNavIndex--;
    this.setText(matches[this.historyNavIndex]!);
  }

  /** Return the subset of prompts whose text starts with `preNavText`. */
  private getMatches(): string[] {
    const prefix = this.preNavText;
    return prefix
      ? this.crossSessionPrompts.filter((p) => p.startsWith(prefix))
      : this.crossSessionPrompts;
  }

  /**
   * Reset navigation state without touching the editor text.
   *
   * Callers that need to restore {@link preNavText} (e.g. Down at index 0)
   * must call {@code setText(this.preNavText)} before this method.
   */
  private exitNavigation(): void {
    this.preNavText = "";
    this.historyNavIndex = -1;
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // The prompt array is shared by reference between the extension and the
  // editor so that runtime additions (before_agent_start) are immediately
  // visible in the editor without a separate sync step.
  let prompts: string[] = [];

  pi.on("session_start", (_event, ctx) => {
    // Map cwd → session directory slug, e.g. /Users/yuguorui → --Users-yuguorui--
    const normalized = ctx.cwd.replace(/\/+$/, "").replace(/^\//, "");
    const cwdSlug = "--" + normalized.replace(/\//g, "-") + "--";
    const sessionDir = join(homedir(), ".pi", "agent", "sessions", cwdSlug);

    prompts = loadPrompts(sessionDir);

    ctx.ui.setEditorComponent((tui, theme, kb) => {
      const editor = new PromptHistoryEditor(tui, theme, kb);
      editor.setPrompts(prompts);
      return editor;
    });
  });

  // Immediately add every submitted prompt so it appears in Up/Down
  // navigation without waiting for a restart.
  pi.on("before_agent_start", (event) => {
    const text = extractText(event.prompt);
    if (!text) return;

    // Deduplicate: remove existing identical entry, then prepend.
    const idx = prompts.indexOf(text);
    if (idx !== -1) prompts.splice(idx, 1);
    prompts.unshift(text);

    // Keep the array bounded.
    if (prompts.length > MAX_PROMPTS) prompts.length = MAX_PROMPTS;
  });
}
