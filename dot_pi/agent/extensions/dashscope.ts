export default function (pi) {
  pi.registerProvider("bailian", {
    baseUrl: process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: process.env.DASHSCOPE_API_KEY,
    api: "openai-completions",
    models: [
      {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "input": ["text"],
        "reasoning": true,
        "thinkingLevelMap": {
          "minimal": "high",
          "low": "high",
          "medium": "high",
          "high": "high",
          "xhigh": "max"
        },
        "cost": {
          "input": 1.74,
          "output": 3.48,
          "cacheRead": 0.145,
          "cacheWrite": 0
        },
        "compat": {
          "requiresReasoningContentOnAssistantMessages": true,
          "thinkingFormat": "deepseek"
        }
      },
      {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "contextWindow": 1000000,
        "maxTokens": 384000,
        "input": ["text"],
        "reasoning": true,
        "thinkingLevelMap": {
          "minimal": "high",
          "low": "high",
          "medium": "high",
          "high": "high",
          "xhigh": "max"
        },
        "cost": {
          "input": 0.14,
          "output": 0.28,
          "cacheRead": 0.028,
          "cacheWrite": 0
        },
        "compat": {
          "requiresReasoningContentOnAssistantMessages": true,
          "thinkingFormat": "deepseek"
        }
      },
      {
        "id": "glm-5.1",
        "name": "GLM 5.1",
        "contextWindow": 202000,
        "maxTokens": 128000,
        "input": ["text"],
        "reasoning": true,
        "cost": {
          "input": 0.56,
          "output": 2.22,
          "cacheRead": 0,
          "cacheWrite": 0
        },
        "compat": {
          "requiresReasoningContentOnAssistantMessages": true,
          "thinkingFormat": "zai"
        }
      }
    ]
  });

  // DashScope DeepSeek V4 enforces max_completion_tokens > thinking_budget. The server reserves
  // thinking_budget=32768 for reasoning_effort=high|max, but pi-ai's simple-options.js caps
  // maxTokens at Math.min(model.maxTokens, 32000), so requests fail with InvalidParameter.
  // Bump max_completion_tokens past the server-side budget for reasoning calls.
  pi.on("before_provider_request", (event) => {
    const payload: any = event.payload;
    if (!payload || typeof payload !== "object") return;
    const model = typeof payload.model === "string" ? payload.model : "";
    if (!model.startsWith("deepseek-v4")) return;
    const reasoningEnabled =
      payload.thinking?.type === "enabled" || typeof payload.reasoning_effort === "string";
    if (!reasoningEnabled) return;
    const effort = payload.reasoning_effort;
    const budget = effort === "max" || effort === "high" ? 32768 : 8192;
    const minMaxCompletion = budget + 4096;
    if (typeof payload.max_completion_tokens !== "number" || payload.max_completion_tokens <= budget) {
      payload.max_completion_tokens = Math.max(payload.max_completion_tokens || 0, minMaxCompletion);
    }
    return payload;
  });
}
