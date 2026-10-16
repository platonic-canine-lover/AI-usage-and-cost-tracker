import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertComplete, IncompleteExportError, parseAnthropicUsage } from "../../src/importers/anthropic.js";
import { parseOpenAiUsage } from "../../src/importers/openai.js";
import { costMicroUsd, findPrice, loadPricing, priceRecords, UnknownModelError } from "../../src/pricing.js";

const fixtures = path.resolve(import.meta.dirname, "../fixtures");
const load = async (name: string): Promise<unknown> => JSON.parse(await readFile(path.join(fixtures, name), "utf8"));

describe("Anthropic usage report parser", () => {
  it("flattens buckets into one record per result and skips empty buckets", async () => {
    const records = parseAnthropicUsage(await load("anthropic-usage-report.json"));
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.model)).toEqual(["claude-sonnet-5-5-20260601", "claude-opus-5-5", "claude-haiku-5-5"]);
  });

  it("counts cache writes as input and cache reads as cached", async () => {
    const [sonnet] = parseAnthropicUsage(await load("anthropic-usage-report.json"));
    expect(sonnet).toMatchObject({
      provider: "anthropic",
      principal: "apikey_alice",
      inputTokens: 1_300_000, // 1.2M uncached + 100k cache write
      cachedTokens: 800_000,
      outputTokens: 300_000,
    });
    expect(sonnet!.occurredAt.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("produces stable external ids so re-imports are idempotent", async () => {
    const a = parseAnthropicUsage(await load("anthropic-usage-report.json"));
    const b = parseAnthropicUsage(await load("anthropic-usage-report.json"));
    expect(a.map((r) => r.externalId)).toEqual(b.map((r) => r.externalId));
    expect(new Set(a.map((r) => r.externalId)).size).toBe(a.length);
  });

  it("refuses reports that were not grouped by model", () => {
    const json = {
      data: [{ starting_at: "2026-10-05T00:00:00Z", ending_at: "2026-10-06T00:00:00Z", results: [{ uncached_input_tokens: 1, output_tokens: 1 }] }],
    };
    expect(() => parseAnthropicUsage(json)).toThrow(/group_by\[\]=model/);
  });

  it("rejects malformed input with a schema error", () => {
    expect(() => parseAnthropicUsage({ data: [{ starting_at: "yesterday", results: [] }] })).toThrow();
  });
});

describe("OpenAI completions usage parser", () => {
  it("separates cached tokens out of input_tokens and converts unix times", async () => {
    const records = parseOpenAiUsage(await load("openai-completions-usage.json"));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5-mini",
      principal: "key_carol",
      inputTokens: 1_500_000,
      cachedTokens: 500_000,
      outputTokens: 400_000,
    });
    expect(records[0]!.occurredAt.toISOString()).toBe("2025-10-05T00:00:00.000Z");
  });

  it("accepts an array of pages", async () => {
    const page = (await load("openai-completions-usage.json")) as object;
    expect(parseOpenAiUsage([{ ...page, has_more: true, next_page: "p2" }, page])).toHaveLength(4);
  });
});

describe("pricing", () => {
  it("matches the longest prefix so dated snapshots resolve to their family", async () => {
    const table = await loadPricing(path.join(fixtures, "pricing.test.json"));
    expect(findPrice(table, "anthropic", "claude-sonnet-5-5-20260601")?.input_per_million_usd).toBe(2);
    expect(findPrice(table, "openai", "gpt-5-mini")?.input_per_million_usd).toBe(1);
    expect(findPrice(table, "openai", "gpt-5")?.input_per_million_usd).toBe(5);
    expect(findPrice(table, "openai", "gpt-9")).toBeUndefined();
  });

  it("computes integer micro-dollars", () => {
    const price = { input_per_million_usd: 2, cached_input_per_million_usd: 0.2, output_per_million_usd: 10 };
    // 1.3M in * $2 + 0.8M cached * $0.2 + 0.3M out * $10 = 2.6 + 0.16 + 3.0 = $5.76
    expect(costMicroUsd(price, { inputTokens: 1_300_000, cachedTokens: 800_000, outputTokens: 300_000 })).toBe(5_760_000n);
  });

  it("falls back to the input rate when no cached rate is given", () => {
    const price = { input_per_million_usd: 0.5, output_per_million_usd: 2.5 };
    expect(costMicroUsd(price, { inputTokens: 0, cachedTokens: 1_000_000, outputTokens: 0 })).toBe(500_000n);
  });

  it("errors on unknown models unless explicitly allowed", async () => {
    const table = await loadPricing(path.join(fixtures, "pricing.test.json"));
    const records = parseOpenAiUsage({
      data: [{ start_time: 0, end_time: 1, results: [{ model: "gpt-9", input_tokens: 10, output_tokens: 1 }] }],
    });
    expect(() => priceRecords(table, records)).toThrow(UnknownModelError);
    const { priced, unknownModels } = priceRecords(table, records, { allowUnknownModels: true });
    expect(priced[0]).toMatchObject({ costMicroUsd: 0n, priced: false });
    expect(unknownModels).toEqual(["openai/gpt-9"]);
  });
});

describe("pricing provenance and integer safety", () => {
  it("derives a version from the file content when none is declared", async () => {
    const table = await loadPricing(path.join(fixtures, "pricing.test.json"));
    expect(table.version).toMatch(/^sha256:[0-9a-f]{12}$/);
    const { pricingVersion } = priceRecords(table, []);
    expect(pricingVersion).toBe(table.version);
  });

  it("uses a declared version verbatim", async () => {
    const table = await loadPricing(path.join(fixtures, "pricing.versioned.test.json"));
    expect(table.version).toBe("2026-10-list-v3");
  });

  it("does not lose precision at volumes beyond Number.MAX_SAFE_INTEGER micro-dollars", () => {
    // 10 trillion output tokens at $100/M = $1,000,000,000 = 1e15 micro-USD; still exact,
    // and 1e13 tokens * 100000 nano = 1e18 nano-USD, past 2^53, where a float path would drift.
    const price = { input_per_million_usd: 0, output_per_million_usd: 100 };
    expect(costMicroUsd(price, { inputTokens: 0, cachedTokens: 0, outputTokens: 10_000_000_000_000 })).toBe(1_000_000_000_000_000n);
  });

  it("rounds half-up once per line, not per term", () => {
    // 1 token at $0.0005/M = 0.5 nano... below micro precision: 0.0005 USD/M → 0.0005 micro/token → 0.5 nano. Rounds to 0 nano per token? No:
    // toNanoPerToken rounds the PRICE to whole nano (0.0005 * 1000 = 0.5 → 1 nano/token). 1 token → 1 nano → 0 micro (half-up at 500 nano).
    expect(costMicroUsd({ input_per_million_usd: 0.0005, output_per_million_usd: 0 }, { inputTokens: 1, cachedTokens: 0, outputTokens: 0 })).toBe(0n);
    // 500 tokens → 500 nano → rounds up to 1 micro.
    expect(costMicroUsd({ input_per_million_usd: 0.0005, output_per_million_usd: 0 }, { inputTokens: 500, cachedTokens: 0, outputTokens: 0 })).toBe(1n);
  });

  it("rejects non-integer token counts rather than truncating", () => {
    expect(() => costMicroUsd({ input_per_million_usd: 1, output_per_million_usd: 1 }, { inputTokens: 1.5, cachedTokens: 0, outputTokens: 0 })).toThrow(RangeError);
  });
});

describe("export completeness", () => {
  it("rejects a single page with has_more=true", async () => {
    const page = (await load("anthropic-usage-report.json")) as { has_more: boolean };
    const oai = (await load("openai-completions-usage.json")) as object;
    expect(() => parseAnthropicUsage({ ...page, has_more: true, next_page: "page_x" })).toThrow(IncompleteExportError);
    expect(() => parseOpenAiUsage({ ...oai, has_more: true })).toThrow(IncompleteExportError);
  });

  it("accepts a chain of pages that ends with has_more=false", async () => {
    const page = (await load("anthropic-usage-report.json")) as { has_more: boolean };
    expect(parseAnthropicUsage([{ ...page, has_more: true, next_page: "p2" }, { ...page, has_more: false, next_page: null }])).toHaveLength(6);
  });

  it("rejects a chain where a non-final page claims to be the last", () => {
    expect(() => assertComplete([{ has_more: false }, { has_more: false }], {})).toThrow(/page 1 is marked as the final page/);
  });

  it("can be overridden explicitly", async () => {
    const page = (await load("anthropic-usage-report.json")) as object;
    expect(parseAnthropicUsage({ ...page, has_more: true }, { allowPartial: true })).toHaveLength(3);
  });
});
