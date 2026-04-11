#!/usr/bin/env node
/**
 * Minimal Tavily /search caller for the feishu-tavily-search skill pack.
 * Env: TAVILY_API_KEY (required). No config file reads.
 */
const TAVILY_URL = "https://api.tavily.com/search";

function readStdinIfTty() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
  });
}

async function main() {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          "TAVILY_API_KEY is not set. Add it to the gateway environment and restart the gateway.",
      }),
    );
    process.exit(1);
  }

  const argvQuery = process.argv[2]?.trim();
  const stdin = await readStdinIfTty();
  const query = argvQuery || stdin;
  if (!query) {
    console.error(
      JSON.stringify({
        ok: false,
        error: 'Missing query. Usage: node scripts/tavily-search.mjs "<query>" [json-overrides]',
      }),
    );
    process.exit(1);
  }

  let overrides = {};
  const rawOverrides = process.argv[3]?.trim();
  if (rawOverrides) {
    try {
      overrides = JSON.parse(rawOverrides);
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
        throw new Error("overrides must be a JSON object");
      }
    } catch (e) {
      console.error(
        JSON.stringify({
          ok: false,
          error: `Invalid JSON overrides: ${String(e)}`,
        }),
      );
      process.exit(1);
    }
  }

  const body = {
    api_key: apiKey,
    query,
    search_depth: "basic",
    max_results: 8,
    ...overrides,
  };

  const res = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error(
      JSON.stringify({
        ok: false,
        error: `Non-JSON response (${res.status}): ${text.slice(0, 500)}`,
      }),
    );
    process.exit(1);
  }

  if (!res.ok) {
    console.error(JSON.stringify({ ok: false, status: res.status, body: data }));
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});
