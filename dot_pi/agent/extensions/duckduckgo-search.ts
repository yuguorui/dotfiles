import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchParams {
  query: string;
  maxResults?: number;
  region?: string;
  safeSearch?: "on" | "moderate" | "off";
  time?: "day" | "week" | "month" | "year";
}

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/145.0 Safari/537.36";

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)));
}

function stripTags(input: string): string {
  return decodeHtml(input.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attr(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`${name}=["']([^"']+)["']`, "i"));
  return match ? decodeHtml(match[1]!) : undefined;
}

function resolveDuckDuckGoUrl(rawUrl: string): string {
  let url = rawUrl.trim();
  if (url.startsWith("//")) url = `https:${url}`;

  try {
    const parsed = new URL(url);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
  } catch {
    // Keep the raw URL below.
  }

  return decodeHtml(url);
}

function parseResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // DuckDuckGo HTML groups organic results in elements containing result__body.
  const blocks = html.match(/<div[^>]+class=["'][^"']*result__body[^"']*["'][\s\S]*?(?=<div[^>]+class=["'][^"']*result__body|<\/body>)/gi) ?? [];

  for (const block of blocks) {
    const anchor = block.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]*>[\s\S]*?<\/a>/i);
    if (!anchor) continue;

    const href = attr(anchor[0], "href");
    if (!href) continue;

    const url = resolveDuckDuckGoUrl(href);
    if (!url || seen.has(url)) continue;

    const title = stripTags(anchor[0]);
    if (!title) continue;

    const snippetMatch = block.match(/<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>[\s\S]*?<\/a>/i)
      ?? block.match(/<div[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>[\s\S]*?<\/div>/i);
    const snippet = snippetMatch ? stripTags(snippetMatch[0]) : "";

    seen.add(url);
    results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }

  return results;
}

function safeSearchValue(value: SearchParams["safeSearch"]): string {
  switch (value) {
    case "on":
      return "1";
    case "off":
      return "-2";
    case "moderate":
    default:
      return "-1";
  }
}

function timeValue(value: SearchParams["time"]): string | undefined {
  switch (value) {
    case "day":
      return "d";
    case "week":
      return "w";
    case "month":
      return "m";
    case "year":
      return "y";
    default:
      return undefined;
  }
}

async function duckDuckGoSearch(params: SearchParams, signal?: AbortSignal): Promise<SearchResult[]> {
  const maxResults = Math.max(1, Math.min(params.maxResults ?? 8, 20));
  const url = new URL(DDG_HTML_URL);
  url.searchParams.set("q", params.query);
  url.searchParams.set("kl", params.region ?? "wt-wt");
  url.searchParams.set("kp", safeSearchValue(params.safeSearch));

  const df = timeValue(params.time);
  if (df) url.searchParams.set("df", df);

  const response = await fetch(url, {
    signal,
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo HTML search failed: HTTP ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  return parseResults(html, maxResults);
}

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No DuckDuckGo results found for: ${query}`;

  return [
    `DuckDuckGo results for: ${query}`,
    "",
    ...results.map((result, index) => {
      const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`];
      if (result.snippet) lines.push(`   ${result.snippet}`);
      return lines.join("\n");
    }),
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "duckduckgo_search",
    label: "DuckDuckGo Search",
    description:
      "Search the web with DuckDuckGo's no-key HTML endpoint. Use for lightweight public web search; results may be rate-limited by DuckDuckGo.",
    promptGuidelines: [
      "Use duckduckgo_search when the user asks for a web search and no API-key search provider is required.",
      "For pages that need full content after search, fetch the selected URL with web_fetch.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      maxResults: Type.Optional(Type.Number({ description: "Maximum results to return, 1-20. Default: 8." })),
      region: Type.Optional(Type.String({ description: "DuckDuckGo region code, e.g. wt-wt, us-en, cn-zh. Default: wt-wt." })),
      safeSearch: Type.Optional(
        Type.Union([Type.Literal("on"), Type.Literal("moderate"), Type.Literal("off")], {
          description: "SafeSearch level. Default: moderate.",
        }),
      ),
      time: Type.Optional(
        Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
          description: "Optional time filter.",
        }),
      ),
    }),
    async execute(_toolCallId, params: SearchParams, signal) {
      const results = await duckDuckGoSearch(params, signal);
      return {
        content: [{ type: "text", text: formatResults(params.query, results) }],
        details: { query: params.query, results },
      };
    },
  });

  pi.registerCommand("ddg", {
    description: "Search DuckDuckGo. Usage: /ddg <query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /ddg <query>", "warning");
        return;
      }

      try {
        const results = await duckDuckGoSearch({ query, maxResults: 8 });
        ctx.ui.notify(formatResults(query, results), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
