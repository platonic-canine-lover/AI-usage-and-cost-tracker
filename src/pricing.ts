/**
 * Cost estimation from token counts.
 *
 * Prices are deliberately NOT hard-coded: they change, and a stale number
 * silently corrupts every report. They live in a JSON file (see
 * pricing.example.json) expressed in USD per million tokens, one rate per
 * token category, and the CLI takes `--pricing <file>`.
 *
 * Three rules:
 *   1. Unknown model: the import fails unless `allowUnknownModels`, in which
 *      case the line is imported at $0 and reported.
 *   2. Known model but a category with tokens > 0 has no rate: the import
 *      fails (UnpricedCategoryError). A cache write is never silently priced
 *      at the input rate.
 *   3. Prices are decimal strings (numbers are accepted but converted via
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

const ModelPrice = z.object({
  input_per_million_usd: PriceValue,
  cache_write_per_million_usd: PriceValue.optional(),
  cache_write_extended_per_million_usd: PriceValue.optional(),
  cache_read_per_million_usd: PriceValue.optional(),
  output_per_million_usd: PriceValue,
});
export type ModelPrice = z.infer<typeof ModelPrice>;

const RATE_KEY: Record<TokenCategory, keyof ModelPrice> = {
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
export function costMicroUsd(price: ModelPrice, tokens: TokenBreakdown, ctx?: { provider: Provider; model: string }): bigint {
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
  return (pico + PICO_PER_MICRO / 2n) / PICO_PER_MICRO;
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
): { priced: PricedRecord[]; unknownModels: string[]; pricingVersion: string; pricingHash: string } {
  const unknown = new Set<string>();
  const priced = records.map((r): PricedRecord => {
    const price = findPrice(table, r.provider, r.model);
    if (!price) {
      if (!opts.allowUnknownModels) throw new UnknownModelError(r.provider, r.model);
      unknown.add(`${r.provider}/${r.model}`);
      return { ...r, costMicroUsd: 0n, priced: false };
    }
    return { ...r, costMicroUsd: costMicroUsd(price, r.tokens, { provider: r.provider, model: r.model }), priced: true };
  });
  return { priced, unknownModels: [...unknown].sort(), pricingVersion: table.version, pricingHash: table.hash };
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
