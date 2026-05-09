import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  const timeout = Number.parseInt(process.env.PI_BASH_TIMEOUT_SECONDS ?? "", 10) || 300;

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as { command: string; timeout?: number };
    if (input.timeout === undefined || input.timeout <= 0) {
      input.timeout = timeout;
    }
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n## Bash Tool Timeout\n\nThe \`bash\` tool has a default timeout of ${timeout}s. When you omit \`timeout\`, this default is applied automatically. For long-running commands, set an explicit \`timeout\` that fits the workload.\n`,
  }));
}
