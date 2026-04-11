---
name: feishu-tavily-search
description: |
  Web search via Tavily HTTP API using a small bundled Node script. Use when the user
  asks for fresh web results, news lookup, or verification while working in Feishu or
  any channel. Requires TAVILY_API_KEY in the gateway process environment.
---

# Feishu Tavily search (skill)

Bundled **instruction + script** skill (ClawHub-style). It does **not** replace the
optional OpenClaw `tavily` plugin tools; it gives a self-contained path when you only
need a quick Tavily search from the agent.

## Prerequisites

1. **Tavily API key** from [tavily.com](https://tavily.com/) (dashboard).
2. Key must be available to the **gateway / agent host process** as **`TAVILY_API_KEY`**
   (same variable name as OpenClaw’s [Tavily tool docs](https://docs.openclaw.ai/tools/tavily)).

If the variable is missing, the script exits with a clear JSON error on stderr.

## How to run the search

From the directory that contains this `SKILL.md` (the skill pack root, `baseDir`):

```bash
node scripts/tavily-search.mjs "your search query here"
```

Optional JSON overrides (merged into the Tavily request body after `api_key` and `query`):

```bash
node scripts/tavily-search.mjs "climate news" '{"max_results":10,"search_depth":"advanced"}'
```

Script prints **one JSON object** to stdout (Tavily response or `{ "ok": false, "error": "..." }`).

## Interpreting results

- Use `results[]` entries for title, `url`, and `content` snippets.
- When `answer` is present, it is Tavily’s short synthesized answer — still verify critical facts.

## Security notes

- Queries and the API key are sent to **`https://api.tavily.com`** only.
- Do not paste the API key into chat; configure it in the host environment (see below).
