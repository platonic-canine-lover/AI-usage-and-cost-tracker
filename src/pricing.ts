/**
 * Cost estimation from token counts.
 *
 * Prices are deliberately NOT hard-coded: they change, and a stale number
 * silently corrupts every report. They live in a JSON file (see
 * pricing.example.json) expressed in USD per million tokens, one rate per
 * token category, and the CLI takes `--pricing <file>`.
 *
 * A rate is a function of three things, not one: the model, the context
 * bucket the request fell in (long prompts cost more), and the service tier
 * (batch is discounted, priority is not). So a model entry may carry
 *   long_context:  { from_tokens, <the five rates again> }
 *   service_tiers: { "batch": "0.5", "priority": "1.25", ... }  (multipliers)
 * and the importer reads the export's context_window and service_tier.
 *
 * Rules:
 *   1. Unknown model: the import fails unless `allowUnknownModels`, in which
 *      case the line is imported at $0 and reported.
 *   2. Known model but a category with tokens > 0 has no rate: the import
 *      fails (UnpricedCategoryError). A cache write is never silently priced
 *      at the input rate.
 *   3. A model with long_context or service_tiers needs the export grouped by
 *      context_window / service_tier. A null in either fails the import
 *      (UngroupedExportError) unless `allowUngrouped`, which prices at the
 *      base rate and standard tier and writes a pricing_note on the row.
 *   4. A service tier in the export with no multiplier in the file fails the
 *      import (UnpricedServiceTierError); "standard" and "default" are 1.
 *   5. The export's context buckets are the provider's, not the price list's.
 *      Anthropic reports "0-200k" and "200k-1M"; Haiku 5.5's price break is
 *      at 100k. A bucket wholly above the break gets the long-context rates;
 *      wholly below, the base rates; a bucket that straddles the break is
 *      priced at the base rate and the row carries a pricing_note saying
 *      that requests above the break inside it are under-priced. That is a
 *      limit of the export, and it is recorded rather than hidden.
 *   6. Prices are decimal strings (numbers are accepted but converted via
 *      their shortest decimal representation) with at most 6 decimal places,
 *      which is exact as integer pico-USD per token (1 USD per million tokens
 *      = 1,000,000 pico-USD per token). There is no float arithmetic: cost is
 *      tokens × pico-rate summed in BigInt, rounded half-up to micro-USD once
 *      per line.
 *
 * Provenance: a pricing file carries a `version` label; a content hash is
 * always computed as well, and both are stamped on every imported row. The
 * importer also stores the full table in `pricing_snapshots` keyed by hash,
 * so a historical figure can be reproduced even if a version label is reused.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { TOKEN_CATEGORIES, type Provider, type TokenBreakdown, type TokenCategory, type UsageRecord } from "./types.js";

export const MICRO = 1_000_000;
/** pico-USD per micro-USD */
const PICO_PER_MICRO = 1_000_000n;
export const PRICE_DECIMALS = 6;

const PriceValue = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const text = typeof v === "number" ? String(v) : v.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `price must be a non-negative decimal like "3" or "0.075", got "${text}"` });
    return z.NEVER;
  }
  const frac = m[2] ?? "";
  if (frac.length > PRICE_DECIMALS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `price "${text}" has more than ${PRICE_DECIMALS} decimal places` });
    return z.NEVER;
  }
  // USD per million tokens → pico-USD per token: shift the decimal point six places.
  return BigInt(m[1]! + frac.padEnd(PRICE_DECIMALS, "0"));
});

const Rates = z.object({
  input_per_million_usd: PriceValue,
  cache_write_per_million_usd: PriceValue.optional(),
  cache_write_extended_per_million_usd: PriceValue.optional(),
  cache_read_per_million_usd: PriceValue.optional(),
  output_per_million_usd: PriceValue,
});
export type Rates = z.infer<typeof Rates>;

/** A multiplier like "0.5" or "1.25", kept exact as parts per million. */
const Multiplier = PriceValue;
const MULTIPLIER_ONE = 1_000_000n;

const ModelPrice = Rates.extend({
  /** Rates for prompts at or above `from_tokens`; the base rates apply below it. */
  long_context: Rates.extend({ from_tokens: z.number().int().positive() }).optional(),
  /** Multiplier on the whole line per provider service tier. "standard" and "default" are 1 unless listed. */
  service_tiers: z.record(Multiplier).optional(),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

const RATE_KEY: Record<TokenCategory, keyof Rates> = {
  uncachedInput: "input_per_million_usd",
  cacheWrite: "cache_write_per_million_usd",
  cacheWriteExtended: "cache_write_extended_per_million_usd",
  cacheRead: "cache_read_per_million_usd",
  output: "output_per_million_usd",
};

const PricingFile = z.object({
  version: z.string().min(1).optional(),
  as_of: z.string().optional(),
  anthropic: z.record(ModelPrice).default({}),
  openai: z.record(ModelPrice).default({}),
});

export interface PricingTable extends z.infer<typeof PricingFile> {
  /** Operator-supplied label, or the hash when none was given. */
  version: string;
  /** sha256 of the file bytes; identifies the exact configuration regardless of label. */
  hash: string;
  /** The file as loaded, kept for the pricing_snapshots audit table. */
  raw: unknown;
}

export async function loadPricing(file: string): Promise<PricingTable> {
  const text = await readFile(file, "utf8");
  const raw: unknown = JSON.parse(text);
  const parsed = PricingFile.parse(raw);
  const hash = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  return { ...parsed, version: parsed.version ?? hash.slice(0, 19), hash, raw };
}

/**
 * Longest-prefix match so a dated snapshot ("claude-sonnet-5-5-20260601")
 * resolves to the family entry ("claude-sonnet-5-5") without listing every date.
 */
export function findPrice(table: Pick<PricingTable, "anthropic" | "openai">, provider: Provider, model: string): ModelPrice | undefined {
  const entries = table[provider];
  let best: { key: string; price: ModelPrice } | undefined;
  for (const [key, price] of Object.entries(entries)) {
    if (model === key || model.startsWith(key)) {
      if (!best || key.length > best.key.length) best = { key, price };
    }
  }
  return best?.price;
}

export class UnpricedCategoryError extends Error {
  constructor(
    public readonly provider: Provider,
    public readonly model: string,
    public readonly category: TokenCategory,
    public readonly tokens: number,
  ) {
    super(
      `${provider} model "${model}" has ${tokens} ${category} tokens but the pricing file gives no ${RATE_KEY[category]} for it. ` +
        `Add the rate (it is not the same as the input rate); nothing was imported.`,
    );
  }
}

const toBig = (n: number, what: string): bigint => {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${what} must be a non-negative integer, got ${n}`);
  return BigInt(n);
};

/**
 * Integer micro-USD for one line. Every category with tokens needs a rate;
 * categories with zero tokens need none. Rounded half-up once, at the end.
 */
export function costMicroUsd(
  price: Rates,
  tokens: TokenBreakdown,
  ctx?: { provider: Provider; model: string },
  multiplier: bigint = MULTIPLIER_ONE,
): bigint {
  let pico = 0n;
  for (const category of TOKEN_CATEGORIES) {
    const n = toBig(tokens[category], category);
    if (n === 0n) continue;
    const rate = price[RATE_KEY[category]];
    if (rate === undefined) {
      throw new UnpricedCategoryError(ctx?.provider ?? "anthropic", ctx?.model ?? "?", category, tokens[category]);
    }
    pico += n * rate;
  }
  // Apply the tier multiplier to the exact pico total, then round once.
  const scaled = pico * multiplier;
  const denom = PICO_PER_MICRO * MULTIPLIER_ONE;
  return (scaled + denom / 2n) / denom;
}

export class UngroupedExportError extends Error {
  constructor(provider: Provider, model: string, field: "service_tier" | "context_window") {
    super(
      `${provider} model "${model}" is priced by ${field} but the export has no ${field} (it was not grouped by it). ` +
        `Re-export with group_by[]=${field}, or pass --allow-ungrouped to price at the ${field === "service_tier" ? "standard tier" : "base rate"} and flag the rows.`,
    );
  }
}

export class UnpricedServiceTierError extends Error {
  constructor(provider: Provider, model: string, tier: string) {
    super(
      `${provider} model "${model}" has usage on service tier "${tier}" but the pricing file gives no service_tiers["${tier}"] multiplier for it. ` +
        `Add it (batch is usually "0.5"; priority is more than 1); nothing was imported.`,
    );
  }
}

/** "0-200k" → [0, 200000]; "200k-1M" → [200000, 1000000]. Unknown shapes return undefined. */
export function parseContextBucket(bucket: string): [number, number] | undefined {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)-(\d+(?:\.\d+)?)([kKmM]?)$/.exec(bucket.trim());
  if (!m) return undefined;
  const unit = (u: string) => (u.toLowerCase() === "k" ? 1_000 : u.toLowerCase() === "m" ? 1_000_000 : 1);
  return [Number(m[1]) * unit(m[2]!), Number(m[3]) * unit(m[4]!)];
}

export interface Resolved {
  rates: Rates;
  multiplier: bigint;
  /** Why the figure may not be the invoice figure, or null when it should be. */
  note: string | null;
}

/**
 * Pick the rate set and tier multiplier for one line. See rules 3 to 5 above.
 */
export function resolveRates(
  price: ModelPrice,
  line: { serviceTier: string | null; contextWindow: string | null },
  ctx: { provider: Provider; model: string },
  opts: { allowUngrouped?: boolean } = {},
): Resolved {
  const notes: string[] = [];
  let rates: Rates = price;
  if (price.long_context) {
    const from = price.long_context.from_tokens;
    if (line.contextWindow === null) {
      if (!opts.allowUngrouped) throw new UngroupedExportError(ctx.provider, ctx.model, "context_window");
      notes.push(`export not grouped by context_window; priced at the base rate, prompts over ${from} tokens are under-priced`);
    } else {
      const span = parseContextBucket(line.contextWindow);
      if (!span) {
        throw new Error(`${ctx.provider} model "${ctx.model}": context_window bucket "${line.contextWindow}" is not of the form 0-200k`);
      }
      const [lo, hi] = span;
      if (lo >= from) {
        rates = price.long_context;
      } else if (hi > from) {
        notes.push(
          `context bucket ${line.contextWindow} straddles the ${from}-token price break; priced at the base rate, prompts over ${from} tokens inside it are under-priced`,
        );
      }
    }
  }
  let multiplier = MULTIPLIER_ONE;
  const tiers = price.service_tiers;
  if (tiers && Object.values(tiers).some((m) => m !== MULTIPLIER_ONE)) {
    if (line.serviceTier === null) {
      if (!opts.allowUngrouped) throw new UngroupedExportError(ctx.provider, ctx.model, "service_tier");
      notes.push("export not grouped by service_tier; priced at the standard tier");
    }
  }
  if (line.serviceTier !== null) {
    const listed = tiers?.[line.serviceTier];
    if (listed !== undefined) multiplier = listed;
    else if (line.serviceTier !== "standard" && line.serviceTier !== "default") {
      throw new UnpricedServiceTierError(ctx.provider, ctx.model, line.serviceTier);
    }
  }
  return { rates, multiplier, note: notes.length ? notes.join("; ") : null };
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
  /** Set when the figure is known to be an approximation (see resolveRates). */
  pricingNote: string | null;
}

export function priceRecords(
  table: PricingTable,
  records: UsageRecord[],
  opts: { allowUnknownModels?: boolean; allowUngrouped?: boolean } = {},
): { priced: PricedRecord[]; unknownModels: string[]; flagged: number; pricingVersion: string; pricingHash: string } {
  const unknown = new Set<string>();
  let flagged = 0;
  const priced = records.map((r): PricedRecord => {
    const price = findPrice(table, r.provider, r.model);
    if (!price) {
      if (!opts.allowUnknownModels) throw new UnknownModelError(r.provider, r.model);
      unknown.add(`${r.provider}/${r.model}`);
      return { ...r, costMicroUsd: 0n, priced: false, pricingNote: "model not in pricing file; cost recorded as $0" };
    }
    const ctx = { provider: r.provider, model: r.model };
    const { rates, multiplier, note } = resolveRates(price, r, ctx, opts);
    if (note) flagged += 1;
    return { ...r, costMicroUsd: costMicroUsd(rates, r.tokens, ctx, multiplier), priced: true, pricingNote: note };
  });
  return { priced, unknownModels: [...unknown].sort(), flagged, pricingVersion: table.version, pricingHash: table.hash };
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
