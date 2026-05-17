function loadStreamSimpleAnthropic() {
  const { existsSync, realpathSync } = require("node:fs");
  const { dirname, join, resolve } = require("node:path");

  const candidates = [];
  const scopes = ["@earendil-works", "@mariozechner"];

  // Works when pi exposes its bundled dependencies through Node resolution.
  for (const scope of scopes) {
    try {
      candidates.push(require.resolve(`${scope}/pi-ai/dist/providers/anthropic.js`));
    } catch {
      // Ignore and try installation-layout based fallbacks below.
    }
  }

  // Homebrew/current pi resolves /opt/homebrew/bin/pi to
  // .../pi-coding-agent/<version>/libexec/bin/pi, with dependencies under
  // ../lib/node_modules/@earendil-works/pi-coding-agent/node_modules/.
  const addFromPiBin = (piBin) => {
    if (!piBin || !existsSync(piBin)) return;
    try {
      const realPiBin = realpathSync(piBin);
      const dir = dirname(realPiBin);

      for (const scope of scopes) {
        candidates.push(
          resolve(dir, `../node_modules/${scope}/pi-ai/dist/providers/anthropic.js`),
        );
        candidates.push(
          resolve(
            dir,
            `../lib/node_modules/${scope}/pi-coding-agent/node_modules/${scope}/pi-ai/dist/providers/anthropic.js`,
          ),
        );
        candidates.push(
          resolve(
            dir,
            `../libexec/lib/node_modules/${scope}/pi-coding-agent/node_modules/${scope}/pi-ai/dist/providers/anthropic.js`,
          ),
        );
      }
    } catch {
      // Ignore broken symlinks/unreadable paths.
    }
  };

  addFromPiBin(process.argv[1]);
  addFromPiBin("/opt/homebrew/bin/pi");
  addFromPiBin("/usr/local/bin/pi");

  // npm global layouts, useful if pi is installed outside Homebrew.
  for (const root of ["/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"]) {
    for (const scope of scopes) {
      candidates.push(
        join(root, `${scope}/pi-coding-agent/node_modules/${scope}/pi-ai/dist/providers/anthropic.js`),
      );
    }
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

const knownModelConfigs = {
  "qwen3.6-max-preview": {
    id: "qwen3.6-max-preview",
    name: "Qwen3.6 Max Preview",
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 65536,
    cost: { input: 1.3, output: 7.83, cacheRead: 0.26, cacheWrite: 0 },
  },
  "qwen3.6-plus": {
    id: "qwen3.6-plus",
    name: "Qwen3.6 Plus",
    reasoning: false,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 65536,
    cost: { input: 0.29, output: 1.74, cacheRead: 0, cacheWrite: 0 },
  },
  "qwen3.6-27b": {
    id: "qwen3.6-27b",
    name: "Qwen3.6 27B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 65536,
    cost: { input: 0.43, output: 2.61, cacheRead: 0, cacheWrite: 0 },
  },
  "deepseek-v4-pro": {
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
  "deepseek-v4-flash": {
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
  "glm-5.1": {
    id: "glm-5.1",
    name: "GLM 5.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 65536,
    cost: { input: 0.87, output: 3.48, cacheRead: 0, cacheWrite: 0 },
  },
  "kimi-k2.5": {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 65536,
    cost: { input: 0.58, output: 3.04, cacheRead: 0, cacheWrite: 0 },
  },
};

function staticModels() {
  return Object.values(knownModelConfigs).map((model) => ({ ...model }));
}

function prettyModelName(id) {
  return id
    .split("-")
    .map((part) => {
      if (/^\d+(?:\.\d+)?[bkm]?$/i.test(part)) return part.toUpperCase();
      if (["qwen", "glm", "kimi"].includes(part.toLowerCase())) return part.toUpperCase();
      if (part.toLowerCase() === "deepseek") return "DeepSeek";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function inferModelConfig(id) {
  if (knownModelConfigs[id]) return { ...knownModelConfigs[id] };

  const lower = id.toLowerCase();
  const reasoning =
    lower.includes("thinking") ||
    lower.startsWith("qwq") ||
    lower.startsWith("deepseek-") ||
    lower.startsWith("glm-") ||
    lower.startsWith("kimi-") ||
    lower.includes("max-preview");

  const model = {
    id,
    name: prettyModelName(id),
    reasoning,
    input: ["text"],
    contextWindow: lower.includes("1m") || lower.includes("max") || lower.startsWith("deepseek-v4") ? 1000000 : 131072,
    maxTokens: 65536,
    // Dynamic model list endpoints usually do not expose pricing. Keep unknown
    // model cost at 0 instead of hard-coding stale or wrong prices.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  if (lower.startsWith("deepseek-")) {
    model.thinkingLevelMap = { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" };
    model.compat = { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" };
  }

  return model;
}

function normalizeModelListUrl(url) {
  if (!url) return undefined;
  const trimmed = url.replace(/\/+$/, "");
  if (trimmed.endsWith("/models")) return trimmed;
  if (trimmed.endsWith("/chat/completions")) return `${trimmed.slice(0, -"/chat/completions".length)}/models`;
  return `${trimmed}/models`;
}

function modelListUrls() {
  const explicit = process.env.DASHSCOPE_ANTHROPIC_MODEL_LIST_URL || process.env.DASHSCOPE_MODEL_LIST_URL;
  if (explicit) return [normalizeModelListUrl(explicit)];

  const urls = [];
  if (process.env.DASHSCOPE_BASE_URL) {
    urls.push(normalizeModelListUrl(process.env.DASHSCOPE_BASE_URL));
  }

  // DashScope's Anthropic-compatible endpoint does not reliably expose /v1/models;
  // the OpenAI-compatible /models endpoint is the practical discovery endpoint.
  urls.push("https://dashscope.aliyuncs.com/compatible-mode/v1/models");
  urls.push("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models");
  urls.push("https://dashscope-us.aliyuncs.com/compatible-mode/v1/models");
  urls.push("https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1/models");

  return [...new Set(urls.filter(Boolean))];
}

function parseRemoteModelIds(payload) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  return rows
    .map((row) => typeof row === "string" ? row : row?.id || row?.model || row?.name)
    .filter((id) => typeof id === "string" && id.trim())
    .map((id) => id.trim());
}

function defaultAnthropicModelFilter() {
  // By default, expose every model returned by DashScope's /models endpoint.
  // Set DASHSCOPE_ANTHROPIC_MODEL_FILTER to a regex if you want to narrow it.
  return /.*/;
}

async function discoverModels() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey || process.env.DASHSCOPE_ANTHROPIC_DYNAMIC_MODELS === "0") {
    return staticModels();
  }

  const errors = [];
  for (const url of modelListUrls()) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const ids = [...new Set(parseRemoteModelIds(await response.json()))];
      const filter = process.env.DASHSCOPE_ANTHROPIC_MODEL_FILTER
        ? new RegExp(process.env.DASHSCOPE_ANTHROPIC_MODEL_FILTER)
        : defaultAnthropicModelFilter();
      const models = ids.filter((id) => filter.test(id)).map(inferModelConfig);

      if (models.length > 0) return models;
      errors.push(`${url}: no matching models`);
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (process.env.DASHSCOPE_ANTHROPIC_DEBUG === "1") {
    console.warn(`[dashscope-anthropic] dynamic model discovery failed:\n${errors.join("\n")}`);
  }
  return staticModels();
}

export default async function (pi) {
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
    models: await discoverModels(),
  });
}
