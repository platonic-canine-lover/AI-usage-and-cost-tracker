import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertComplete, IncompleteExportError, parseAnthropicUsage } from "../../src/importers/anthropic.js";
import { parseOpenAiUsage } from "../../src/importers/openai.js";
import { costMicroUsd, findPrice, loadPricing, priceRecords, UnknownModelError, UnpricedCategoryError } from "../../src/pricing.js";
import type { TokenBreakdown } from "../../src/types.js";

const fixtures = path.resolve(import.meta.dirname, "../fixtures");
const load = async (name: string): Promise<unknown> => JSON.parse(await readFile(path.join(fixtures, name), "utf8"));
const tokens = (t: Partial<TokenBreakdown>): TokenBreakdown => ({ uncachedInput: 0, cacheWrite: 0, cacheWriteExtended: 0, cacheRead: 0, output: 0, ...t });
/** USD per million tokens → pico-USD per token, for building prices in tests. */
const usd = (perMillion: string): bigint => {
  const [i, f = ""] = perMillion.split(".");
  return BigInt(i! + f.padEnd(6, "0"));
};

describe("Anthropic usage report parser", () => {
  it("flattens buckets into one record per result and skips empty buckets", async () => {
    const records = parseAnthropicUsage(await load("anthropic-usage-report.json"));
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.model)).toEqual(["claude-sonnet-5-5-20260601", "claude-opus-5-5", "claude-haiku-5-5"]);
  });

  it("keeps uncached input, 5m cache writes, 1h cache writes, cache reads and output separate", async () => {
    const [sonnet] = parseAnthropicUsage(await load("anthropic-usage-report.json"));
    expect(sonnet).toMatchObject({
      provider: "anthropic",
      principal: "apikey_alice",
      tokens: { uncachedInput: 1_200_000, cacheWrite: 100_000, cacheWriteExtended: 0, cacheRead: 800_000, output: 300_000 },
    });
    expect(sonnet!.occurredAt.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("maps 1h cache writes to the extended category", () => {
    const [r] = parseAnthropicUsage({
      data: [
        {
          starting_at: "2026-10-05T00:00:00Z",
          ending_at: "2026-10-06T00:00:00Z",
          results: [{ model: "m", uncached_input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 }, cache_read_input_tokens: 4, output_tokens: 5 }],
        },
      ],
      has_more: false,
      next_page: null,
    });
    expect(r!.tokens).toEqual({ uncachedInput: 1, cacheWrite: 2, cacheWriteExtended: 3, cacheRead: 4, output: 5 });
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
      has_more: false,
    };
    expect(() => parseAnthropicUsage(json)).toThrow(/group_by\[\]=model/);
  });

  it("rejects malformed input with a schema error", () => {
    expect(() => parseAnthropicUsage({ data: [{ starting_at: "yesterday", results: [] }], has_more: false })).toThrow();
  });
});

describe("OpenAI completions usage parser", () => {
  it("derives uncached input from the total, keeps cache reads and writes separate, converts unix times", async () => {
    const records = parseOpenAiUsage(await load("openai-completions-usage.json"));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5-mini",
      principal: "key_carol",
      tokens: { uncachedInput: 1_500_000, cacheWrite: 0, cacheWriteExtended: 0, cacheRead: 500_000, output: 400_000 },
    });
    expect(records[0]!.occurredAt.toISOString()).toBe("2025-10-05T00:00:00.000Z");
  });

  it("subtracts cache writes from the input total too", () => {
    const [r] = parseOpenAiUsage({
      data: [{ start_time: 0, end_time: 1, results: [{ model: "m", input_tokens: 100, input_cached_tokens: 10, input_cache_write_tokens: 20, input_cache_write_12h_tokens: 5, output_tokens: 1 }] }],
      has_more: false,
    });
    expect(r!.tokens).toEqual({ uncachedInput: 65, cacheWrite: 20, cacheWriteExtended: 5, cacheRead: 10, output: 1 });
  });

  it("refuses to guess when sub-totals exceed input_tokens", () => {
    expect(() =>
      parseOpenAiUsage({ data: [{ start_time: 0, end_time: 1, results: [{ model: "m", input_tokens: 5, input_cached_tokens: 10, output_tokens: 1 }] }], has_more: false }),
    ).toThrow(/exceed input_tokens/);
  });

  it("accepts an array of pages", async () => {
    const page = (await load("openai-completions-usage.json")) as object;
    expect(parseOpenAiUsage([{ ...page, has_more: true, next_page: "p2" }, page])).toHaveLength(4);
  });
});

describe("pricing: per-category rates", () => {
  it("matches the longest prefix so dated snapshots resolve to their family", async () => {
    const table = await loadPricing(path.join(fixtures, "pricing.test.json"));
    expect(findPrice(table, "anthropic", "claude-sonnet-5-5-20260601")?.input_per_million_usd).toBe(usd("2"));
    expect(findPrice(table, "openai", "gpt-5-mini")?.input_per_million_usd).toBe(usd("1"));
    expect(findPrice(table, "openai", "gpt-5")?.input_per_million_usd).toBe(usd("5"));
    expect(findPrice(table, "openai", "gpt-9")).toBeUndefined();
  });

  it("prices each category at its own rate", () => {
    const price = {
      input_per_million_usd: usd("2"),
      cache_write_per_million_usd: usd("2.5"),
      cache_write_extended_per_million_usd: usd("4"),
      cache_read_per_million_usd: usd("0.2"),
      output_per_million_usd: usd("10"),
    };
    // 1.2M*2 + 0.1M*2.5 + 0.05M*4 + 0.8M*0.2 + 0.3M*10 = 2.4 + 0.25 + 0.2 + 0.16 + 3.0 = $6.01
    expect(costMicroUsd(price, tokens({ uncachedInput: 1_200_000, cacheWrite: 100_000, cacheWriteExtended: 50_000, cacheRead: 800_000, output: 300_000 }))).toBe(6_010_000n);
  });

  it("never prices a cache write at the input rate: a category with tokens but no rate is an error", () => {
    const price = { input_per_million_usd: usd("2"), output_per_million_usd: usd("10") };
    expect(() => costMicroUsd(price, tokens({ cacheWrite: 1 }), { provider: "anthropic", model: "m" })).toThrow(UnpricedCategoryError);
    expect(() => costMicroUsd(price, tokens({ cacheWriteExtended: 1 }))).toThrow(UnpricedCategoryError);
    expect(() => costMicroUsd(price, tokens({ cacheRead: 1 }))).toThrow(UnpricedCategoryError);
  });

  it("a category with zero tokens needs no rate", () => {
    const price = { input_per_million_usd: usd("2"), output_per_million_usd: usd("10") };
    expect(costMicroUsd(price, tokens({ uncachedInput: 1_000_000, output: 0 }))).toBe(2_000_000n);
    expect(costMicroUsd(price, tokens({}))).toBe(0n);
  });

  it("cache-write multipliers make the figure larger than input-rate pricing would have", () => {
    const withRates = { input_per_million_usd: usd("3"), cache_write_per_million_usd: usd("3.75"), cache_write_extended_per_million_usd: usd("6"), output_per_million_usd: usd("15") };
    const t = tokens({ cacheWrite: 1_000_000, cacheWriteExtended: 1_000_000 });
    const correct = costMicroUsd(withRates, t);
    const asInput = costMicroUsd(withRates, tokens({ uncachedInput: 2_000_000 }));
    expect(correct).toBe(9_750_000n);
    expect(asInput).toBe(6_000_000n);
    expect(correct > asInput).toBe(true);
  });

  it("errors on unknown models unless explicitly allowed, and reports the version and hash", async () => {
    const table = await loadPricing(path.join(fixtures, "pricing.test.json"));
    const records = parseOpenAiUsage({ data: [{ start_time: 0, end_time: 1, results: [{ model: "gpt-9", input_tokens: 10, output_tokens: 1 }] }], has_more: false });
    expect(() => priceRecords(table, records)).toThrow(UnknownModelError);
    const { priced, unknownModels, pricingVersion, pricingHash } = priceRecords(table, records, { allowUnknownModels: true });
    expect(priced[0]).toMatchObject({ costMicroUsd: 0n, priced: false });
    expect(unknownModels).toEqual(["openai/gpt-9"]);
    expect(pricingVersion).toBe("test-v1");
    expect(pricingHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("pricing: precision and provenance", () => {
  it("parses prices from exact decimal strings, up to 6 places, with no float step", async () => {
    const table = await loadPricing(path.join(fixtures, "pricing.test.json"));
    expect(findPrice(table, "anthropic", "claude-sonnet-5-5")?.cache_read_per_million_usd).toBe(200_000n);
    expect(findPrice(table, "anthropic", "claude-opus-5-5")?.cache_write_per_million_usd).toBe(12_500_000n);
  });

  it("accepts JSON numbers but rejects more than 6 decimal places", async () => {
    const table = await loadPricing(path.join(fixtures, "pricing.versioned.test.json"));
    expect(findPrice(table, "anthropic", "claude-haiku-5-5")?.input_per_million_usd).toBe(500_000n);
    await expect(loadPricing(path.join(fixtures, "pricing.bad-precision.test.json"))).rejects.toThrow(/more than 6 decimal places/);
  });

  it("the smallest supported increment prices exactly", () => {
    // $0.000001 per million tokens = 1 pico-USD per token. 1M tokens = 1 micro-USD.
    const price = { input_per_million_usd: 1n, output_per_million_usd: 0n };
    expect(costMicroUsd(price, tokens({ uncachedInput: 1_000_000 }))).toBe(1n);
    expect(costMicroUsd(price, tokens({ uncachedInput: 499_999 }))).toBe(0n); // 0.499999 micro → rounds down
    expect(costMicroUsd(price, tokens({ uncachedInput: 500_000 }))).toBe(1n); // exactly half → rounds up
  });

  it("does not lose precision at volumes beyond Number.MAX_SAFE_INTEGER micro-dollars", () => {
    const price = { input_per_million_usd: 0n, output_per_million_usd: usd("100") };
    expect(costMicroUsd(price, tokens({ output: 10_000_000_000_000 }))).toBe(1_000_000_000_000_000n);
  });

  it("rejects non-integer token counts rather than truncating", () => {
    expect(() => costMicroUsd({ input_per_million_usd: 1n, output_per_million_usd: 1n }, tokens({ uncachedInput: 1.5 }))).toThrow(RangeError);
  });

  it("derives the version from the hash when none is declared, and the hash always identifies the content", async () => {
    const a = await loadPricing(path.join(fixtures, "pricing.versioned.test.json"));
    const b = await loadPricing(path.join(fixtures, "pricing.test.json"));
    expect(a.version).toBe("2026-10-list-v3");
    expect(a.hash).not.toBe(b.hash);
    expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("export completeness", () => {
  const complete = async () => (await load("anthropic-usage-report.json")) as { has_more: boolean; next_page: null };

  it("accepts a single explicitly final page", async () => {
    expect(parseAnthropicUsage(await complete())).toHaveLength(3);
  });

  it("rejects a page with has_more missing (not a complete provider response)", async () => {
    const page: Record<string, unknown> = { ...(await complete()) };
    delete page.has_more;
    expect(() => parseAnthropicUsage(page)).toThrow(/no has_more field/);
    expect(() => assertComplete([{}], {})).toThrow(IncompleteExportError);
  });

  it("rejects a final page with has_more=true, from either provider", async () => {
    const page = await complete();
    const oai = (await load("openai-completions-usage.json")) as object;
    expect(() => parseAnthropicUsage({ ...page, has_more: true, next_page: "page_x" })).toThrow(IncompleteExportError);
    expect(() => parseOpenAiUsage({ ...oai, has_more: true })).toThrow(IncompleteExportError);
  });

  it("rejects a final page that is has_more=false but still carries a cursor", () => {
    expect(() => assertComplete([{ has_more: false, next_page: "stale" }], {})).toThrow(/has_more=false but a next_page cursor/);
  });

  it("accepts a chain of pages that ends with has_more=false", async () => {
    const page = await complete();
    expect(parseAnthropicUsage([{ ...page, has_more: true, next_page: "p2" }, { ...page, has_more: false, next_page: null }])).toHaveLength(6);
  });

  it("rejects a chain where a non-final page claims to be the last, or lacks a cursor", () => {
    expect(() => assertComplete([{ has_more: false, next_page: null }, { has_more: false, next_page: null }], {})).toThrow(/page 1 is marked as the final page/);
    expect(() => assertComplete([{ has_more: true, next_page: null }, { has_more: false, next_page: null }], {})).toThrow(/no next_page cursor/);
  });

  it("rejects an empty page list", () => {
    expect(() => assertComplete([], {})).toThrow(/no pages/);
  });

  it("can be overridden explicitly", async () => {
    const page = await complete();
    expect(parseAnthropicUsage({ ...page, has_more: true }, { allowPartial: true })).toHaveLength(3);
    expect(parseAnthropicUsage([], { allowPartial: true })).toHaveLength(0);
  });
});
