import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnthropicUsage } from "../../src/importers/anthropic.js";
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
    const page = await load("openai-completions-usage.json");
    expect(parseOpenAiUsage([page, page])).toHaveLength(4);
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
    expect(costMicroUsd(price, { inputTokens: 1_300_000, cachedTokens: 800_000, outputTokens: 300_000 })).toBe(5_760_000);
  });

  it("falls back to the input rate when no cached rate is given", () => {
    const price = { input_per_million_usd: 0.5, output_per_million_usd: 2.5 };
    expect(costMicroUsd(price, { inputTokens: 0, cachedTokens: 1_000_000, outputTokens: 0 })).toBe(500_000);
  });

  it("errors on unknown models unless explicitly allowed", async () => {
    const table = await loadPricing(path.join(fixtures, "pricing.test.json"));
    const records = parseOpenAiUsage({
      data: [{ start_time: 0, end_time: 1, results: [{ model: "gpt-9", input_tokens: 10, output_tokens: 1 }] }],
    });
    expect(() => priceRecords(table, records)).toThrow(UnknownModelError);
    const { priced, unknownModels } = priceRecords(table, records, { allowUnknownModels: true });
    expect(priced[0]).toMatchObject({ costMicroUsd: 0, priced: false });
    expect(unknownModels).toEqual(["openai/gpt-9"]);
  });
});
