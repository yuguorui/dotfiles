function loadStreamSimpleAnthropic() {
  const { existsSync, realpathSync } = require("node:fs");
  const { dirname, join, resolve } = require("node:path");

  const candidates = [];

  // Works when pi exposes its bundled dependencies through Node resolution.
  try {
    candidates.push(require.resolve("@mariozechner/pi-ai/dist/providers/anthropic.js"));
  } catch {
    // Ignore and try installation-layout based fallbacks below.
  }

  // Homebrew resolves /opt/homebrew/bin/pi to
  // .../@mariozechner/pi-coding-agent/dist/cli.js. From there, pi-ai lives in
  // ../node_modules/@mariozechner/pi-ai/.
  const addFromPiBin = (piBin) => {
    if (!piBin || !existsSync(piBin)) return;
    try {
      const realPiBin = realpathSync(piBin);
      candidates.push(
        resolve(
          dirname(realPiBin),
          "../node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js",
        ),
      );

      // Fallback for layouts where piBin is the Cellar wrapper rather than the
      // final dist/cli.js symlink target.
      candidates.push(
        resolve(
          dirname(realPiBin),
          "../libexec/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js",
        ),
      );
    } catch {
      // Ignore broken symlinks/unreadable paths.
    }
  };

  addFromPiBin(process.argv[1]);
  addFromPiBin("/opt/homebrew/bin/pi");
  addFromPiBin("/usr/local/bin/pi");

  // npm global layouts, useful if pi is installed outside Homebrew.
  for (const root of ["/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"]) {
    candidates.push(
      join(root, "@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js"),
    );
  }

  const tried = [];
  for (const candidate of [...new Set(candidates)]) {
    tried.push(candidate);
    if (!existsSync(candidate)) continue;
    const mod = require(candidate);
    if (typeof mod.streamSimpleAnthropic === "function") {
      return mod.streamSimpleAnthropic;
    }
  }

  throw new Error(`Unable to locate pi-ai anthropic provider. Tried:\n${tried.join("\n")}`);
}

export default function (pi) {
  // Reuse pi's bundled Anthropic streaming handler, but resolve it dynamically
  // instead of pinning a Homebrew Cellar version (0.72.0, 0.73.1, ...).
  // Route through the "github-copilot" code path so the Anthropic SDK uses
  // Bearer auth (authToken) instead of x-api-key, which DashScope expects.
  const streamSimpleAnthropic = loadStreamSimpleAnthropic();

  function streamWithBearerAuth(model, context, options) {
    return streamSimpleAnthropic(
      { ...model, provider: "github-copilot" },
      context,
      options,
    );
  }

  pi.registerProvider("bailian-anthropic", {
    baseUrl: process.env.DASHSCOPE_ANTHROPIC_BASE_URL || "https://dashscope.aliyuncs.com/anthropic",
    apiKey: process.env.DASHSCOPE_API_KEY,
    api: "anthropic-messages",
    streamSimple: streamWithBearerAuth,

    models: [
      {
        id: "qwen3.6-max-preview",
        name: "Qwen3.6 Max Preview",
        reasoning: true,
        input: ["text"],
        contextWindow: 1000000,
        maxTokens: 65536,
        cost: { input: 1.3, output: 7.83, cacheRead: 0.26, cacheWrite: 0 },
      },
      {
        id: "qwen3.6-plus",
        name: "Qwen3.6 Plus",
        reasoning: false,
        input: ["text"],
        contextWindow: 1000000,
        maxTokens: 65536,
        cost: { input: 0.29, output: 1.74, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "qwen3.6-27b",
        name: "Qwen3.6 27B",
        reasoning: false,
        input: ["text"],
        contextWindow: 131072,
        maxTokens: 65536,
        cost: { input: 0.43, output: 2.61, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        input: ["text"],
        contextWindow: 1000000,
        maxTokens: 65536,
        thinkingLevelMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" },
        cost: { input: 1.74, output: 3.48, cacheRead: 0.35, cacheWrite: 0 },
        compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: true,
        input: ["text"],
        contextWindow: 1000000,
        maxTokens: 65536,
        thinkingLevelMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" },
        cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
        compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
      },
      {
        id: "glm-5.1",
        name: "GLM 5.1",
        reasoning: true,
        input: ["text"],
        contextWindow: 131072,
        maxTokens: 65536,
        cost: { input: 0.87, output: 3.48, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "kimi-k2.5",
        name: "Kimi K2.5",
        reasoning: true,
        input: ["text"],
        contextWindow: 131072,
        maxTokens: 65536,
        cost: { input: 0.58, output: 3.04, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}
