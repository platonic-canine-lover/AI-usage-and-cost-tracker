/**
 * Cost estimation from token counts.
 *
 * Prices are deliberately NOT hard-coded: they change, and a stale number
 * silently corrupts every report. They live in a JSON file (see
 * pricing.example.json) expressed in USD per million tokens, and the CLI takes
 * `--pricing <file>`. Unknown models are an error unless the caller opts in to
 * zero-cost lines with `allowUnknownModels`, in which case they are reported.
 *
 * Provenance: every pricing file carries a `version` (or one is derived from
 * its content hash), and every imported row records which version priced it,
 * so a report can always say which price list it was built from.
 *
 * Arithmetic is integer-only via BigInt. USD per million tokens is exactly
 * micro-USD per token, so cost = tokens * price; prices with decimals are
 * carried at nano-USD precision and rounded half-up once per line.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Provider, UsageRecord } from "./types.js";

export const MICRO = 1_000_000;
const NANO_PER_MICRO = 1000n;

const ModelPrice = z.object({
  input_per_million_usd: z.number().nonnegative(),
  cached_input_per_million_usd: z.number().nonnegative().optional(),
  output_per_million_usd: z.number().nonnegative(),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

export const PricingTable = z.object({
  version: z.string().min(1).optional(),
  as_of: z.string().optional(),
  anthropic: z.record(ModelPrice).default({}),
  openai: z.record(ModelPrice).default({}),
});
export type PricingTable = z.infer<typeof PricingTable> & { version: string };

export async function loadPricing(file: string): Promise<PricingTable> {
  const text = await readFile(file, "utf8");
  const parsed = PricingTable.parse(JSON.parse(text));
  const version = parsed.version ?? `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  return { ...parsed, version };
}

/**
 * Longest-prefix match so a dated snapshot ("claude-sonnet-5-5-20260601")
 * resolves to the family entry ("claude-sonnet-5-5") without listing every date.
 */
export function findPrice(table: PricingTable, provider: Provider, model: string): ModelPrice | undefined {
  const entries = table[provider];
  let best: { key: string; price: ModelPrice } | undefined;
  for (const [key, price] of Object.entries(entries)) {
    if (model === key || model.startsWith(key)) {
      if (!best || key.length > best.key.length) best = { key, price };
    }
  }
  return best?.price;
}

/** USD per million tokens → nano-USD per token, as an integer. */
const toNanoPerToken = (usdPerMillion: number): bigint => {
  if (!Number.isFinite(usdPerMillion) || usdPerMillion < 0) throw new RangeError(`Invalid price ${usdPerMillion}`);
  return BigInt(Math.round(usdPerMillion * 1000));
};

const toBig = (n: number, what: string): bigint => {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${what} must be a non-negative integer, got ${n}`);
  return BigInt(n);
};

/** Integer micro-USD, rounded half-up once per line. Totals are sums of integers, so no drift across a report. */
export function costMicroUsd(price: ModelPrice, r: Pick<UsageRecord, "inputTokens" | "outputTokens" | "cachedTokens">): bigint {
  const cachedRate = price.cached_input_per_million_usd ?? price.input_per_million_usd;
  const nano =
    toBig(r.inputTokens, "inputTokens") * toNanoPerToken(price.input_per_million_usd) +
    toBig(r.cachedTokens, "cachedTokens") * toNanoPerToken(cachedRate) +
    toBig(r.outputTokens, "outputTokens") * toNanoPerToken(price.output_per_million_usd);
  return (nano + NANO_PER_MICRO / 2n) / NANO_PER_MICRO;
}

export class UnknownModelError extends Error {
  constructor(
    public readonly provider: Provider,
    public readonly model: string,
  ) {
    super(`No price for ${provider} model "${model}". Add it to the pricing file or pass --allow-unknown-models.`);
  }
}

export interface PricedRecord extends UsageRecord {
  costMicroUsd: bigint;
  priced: boolean;
}

export function priceRecords(
  table: PricingTable,
  records: UsageRecord[],
  opts: { allowUnknownModels?: boolean } = {},
): { priced: PricedRecord[]; unknownModels: string[]; pricingVersion: string } {
  const unknown = new Set<string>();
  const priced = records.map((r): PricedRecord => {
    const price = findPrice(table, r.provider, r.model);
    if (!price) {
      if (!opts.allowUnknownModels) throw new UnknownModelError(r.provider, r.model);
      unknown.add(`${r.provider}/${r.model}`);
      return { ...r, costMicroUsd: 0n, priced: false };
    }
    return { ...r, costMicroUsd: costMicroUsd(price, r), priced: true };
  });
  return { priced, unknownModels: [...unknown].sort(), pricingVersion: table.version };
}

export const sumMicroUsd = (records: { costMicroUsd: bigint }[]): bigint => records.reduce((s, r) => s + r.costMicroUsd, 0n);

/** Format micro-USD (bigint, or the string Postgres returns for bigint columns) as dollars with cents. */
export const formatUsd = (microUsd: bigint | string | number): string => {
  const big = typeof microUsd === "bigint" ? microUsd : BigInt(typeof microUsd === "number" ? Math.round(microUsd) : microUsd);
  const sign = big < 0n ? "-" : "";
  const abs = big < 0n ? -big : big;
  const cents = (abs + 5000n) / 10000n; // half-up to the cent
  return `${sign}$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};
