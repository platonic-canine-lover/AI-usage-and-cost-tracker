/**
 * Cost estimation from token counts.
 *
 * Prices are deliberately NOT hard-coded: they change, and a stale number
 * silently corrupts every report. They live in a JSON file (see
 * pricing.example.json) expressed in USD per million tokens, and the CLI takes
 * `--pricing <file>`. Unknown models are an error unless the caller opts in to
 * zero-cost lines with `allowUnknownModels`, in which case they are reported.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Provider, UsageRecord } from "./types.js";

export const MICRO = 1_000_000;

const ModelPrice = z.object({
  input_per_million_usd: z.number().nonnegative(),
  cached_input_per_million_usd: z.number().nonnegative().optional(),
  output_per_million_usd: z.number().nonnegative(),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

export const PricingTable = z.object({
  anthropic: z.record(ModelPrice).default({}),
  openai: z.record(ModelPrice).default({}),
});
export type PricingTable = z.infer<typeof PricingTable>;

export async function loadPricing(file: string): Promise<PricingTable> {
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  return PricingTable.parse(raw);
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

/** Integer micro-USD. Rounds half up per line; totals are sums of integers, so no float drift across a report. */
export function costMicroUsd(price: ModelPrice, r: Pick<UsageRecord, "inputTokens" | "outputTokens" | "cachedTokens">): number {
  const cachedRate = price.cached_input_per_million_usd ?? price.input_per_million_usd;
  const usd =
    (r.inputTokens * price.input_per_million_usd +
      r.cachedTokens * cachedRate +
      r.outputTokens * price.output_per_million_usd) /
    1_000_000;
  return Math.round(usd * MICRO);
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
  costMicroUsd: number;
  priced: boolean;
}

export function priceRecords(
  table: PricingTable,
  records: UsageRecord[],
  opts: { allowUnknownModels?: boolean } = {},
): { priced: PricedRecord[]; unknownModels: string[] } {
  const unknown = new Set<string>();
  const priced = records.map((r): PricedRecord => {
    const price = findPrice(table, r.provider, r.model);
    if (!price) {
      if (!opts.allowUnknownModels) throw new UnknownModelError(r.provider, r.model);
      unknown.add(`${r.provider}/${r.model}`);
      return { ...r, costMicroUsd: 0, priced: false };
    }
    return { ...r, costMicroUsd: costMicroUsd(price, r), priced: true };
  });
  return { priced, unknownModels: [...unknown].sort() };
}

export const formatUsd = (microUsd: number | bigint | string): string => {
  const n = typeof microUsd === "string" ? Number(microUsd) : Number(microUsd);
  return `$${(n / MICRO).toFixed(2)}`;
};
