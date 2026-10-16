/**
 * "What if we ran this locally?"
 *
 * Takes the token volume a team actually pushed through a cloud provider in a
 * month and asks what the same volume would cost, and how long it would take,
 * on a local model on a machine you own.
 *
 * Everything that is not derivable from the imported usage comes from an
 * alternatives JSON file (see alternatives.example.json): the local model's
 * size and benchmark scores, the machine's bandwidth, throughput, price,
 * power and tariff. Each throughput figure carries a `basis` of "measured" or
 * "estimate" and a source, and the report prints which it is, because the
 * whole answer swings on it.
 *
 * What the report does not do: it does not turn benchmark scores into a
 * probability of success. It shows the local model's published score next
 * to the cloud model's on the same benchmark, where you have supplied both,
 * and calls the ratio "benchmark parity". Treat that as a prompt to run your
 * own evaluation on your own tasks (see the cross-model judging tool).
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Provider } from "./types.js";

const Sourced = z.object({
  value: z.number().nonnegative(),
  basis: z.enum(["measured", "estimate", "spec"]),
  source: z.string().min(1),
  note: z.string().optional(),
});
export type Sourced = z.infer<typeof Sourced>;

const BenchmarkScore = z.object({
  score: z.number(),
  source: z.string().min(1),
  note: z.string().optional(),
});

const LocalModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parameters_b: z.number().positive(),
  quantisation: z.string().min(1),
  file_size_gb: Sourced,
  /** Maximum context the model supports. */
  context_tokens: z.number().int().positive().optional(),
  /** Context you intend to run with; the KV cache is sized for this, not the maximum. */
  working_context_tokens: z.number().int().positive().optional(),
  /** KV cache memory per 1,000 tokens of context, at the cache precision you run. Unknown → memory check is partial. */
  kv_cache_gb_per_1k_tokens: Sourced.optional(),
  /** Runtime overhead beyond weights and KV cache (compute buffers, Metal/CUDA allocations). */
  runtime_overhead_gb: Sourced.optional(),
  licence: z.string().optional(),
  benchmarks: z.record(BenchmarkScore).default({}),
});
export type LocalModel = z.infer<typeof LocalModel>;

const Machine = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  memory_gb: z.number().positive(),
  /** Memory the OS and other processes keep; the model and its KV cache must fit in what is left. */
  os_headroom_gb: z.number().nonnegative().default(6),
  memory_bandwidth_gbs: Sourced,
  prompt_tokens_per_sec: Sourced,
  generation_tokens_per_sec: Sourced,
  /** How many requests the machine serves at once at the stated per-request throughput. 1 unless you have measured batching. */
  concurrency: z.number().int().positive().default(1),
  price_usd: z.number().nonnegative(),
  amortise_months: z.number().int().positive(),
  watts_active: Sourced,
  watts_idle: Sourced,
  electricity_usd_per_kwh: z.number().nonnegative(),
});
export type Machine = z.infer<typeof Machine>;

const Currency = z.enum(["USD", "GBP", "EUR"]);

/** A named hourly rate for the reviewer's time. The report prints one human block per rate, so you can see the answer at minimum wage and at an engineer's rate side by side. */
const HumanRate = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  hourly: z.number().nonnegative(),
  currency: Currency.default("USD"),
  source: z.string().min(1),
  note: z.string().optional(),
});
export type HumanRate = z.infer<typeof HumanRate>;

const HumanSchema = z
  .object({
    /** Single-rate shorthand; equivalent to one rate {id:"default", hourly: x, currency: "USD"}. */
    hourly_usd: z.number().nonnegative().optional(),
    rates: z.array(HumanRate).default([]),
    /** USD per unit of each non-USD currency used in `rates`. Required for any such currency. Sourced, because it moves. */
    fx_usd_per: z.record(Currency, Sourced).default({}),
    /** Minutes a person spends per task when no task_outcomes are recorded for the model: a fallback assumption, labelled as such. */
    default_review_minutes_per_task: z.number().nonnegative().optional(),
  })
  .superRefine((h, ctx) => {
    if (h.hourly_usd === undefined && h.rates.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "human needs hourly_usd or at least one entry in rates" });
    }
    for (const r of h.rates) {
      if (r.currency !== "USD" && !h.fx_usd_per[r.currency]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `rate "${r.id}" is in ${r.currency} but fx_usd_per.${r.currency} is not set` });
      }
    }
  });
export type Human = z.infer<typeof HumanSchema>;

/** Every configured rate, resolved to USD per hour, in file order. */
export function humanRatesUsd(human: Human): { id: string; label: string; hourlyUsd: number; currency: string; hourly: number; fxBasis: string | null }[] {
  const out: ReturnType<typeof humanRatesUsd> = [];
  if (human.hourly_usd !== undefined) out.push({ id: "default", label: "default", hourlyUsd: human.hourly_usd, currency: "USD", hourly: human.hourly_usd, fxBasis: null });
  for (const r of human.rates) {
    const fx = r.currency === "USD" ? { value: 1, basis: null } : human.fx_usd_per[r.currency]!;
    out.push({ id: r.id, label: r.label, hourlyUsd: r.hourly * fx.value, currency: r.currency, hourly: r.hourly, fxBasis: fx.basis });
  }
  return out;
}

export const AlternativesFile = z.object({
  version: z.string().min(1).optional(),
  as_of: z.string().optional(),
  human: HumanSchema.optional(),
  local_models: z.array(LocalModel).min(1),
  machines: z.array(Machine).min(1),
  /** Published scores for the cloud models you use, keyed "provider/model-prefix", so the report can show parity. */
  cloud_benchmarks: z.record(z.record(BenchmarkScore)).default({}),
});
export type AlternativesFile = z.infer<typeof AlternativesFile>;

export async function loadAlternatives(file: string): Promise<AlternativesFile> {
  return AlternativesFile.parse(JSON.parse(await readFile(file, "utf8")));
}

/** One month of one team's usage on one cloud provider, as the report needs it. */
export interface MonthlyVolume {
  teamId: string;
  teamName: string;
  provider: Provider;
  model: string;
  monthStart: string;
  /** All tokens the model had to read: uncached input + cache writes + cache reads. Locally there is no cache discount to model. */
  promptTokens: bigint;
  outputTokens: bigint;
  cloudCostMicroUsd: bigint;
  daysInMonth: number;
  /** True when the month is the current one and therefore incomplete. */
  monthToDate: boolean;
  /** Days of the month covered: daysInMonth for a complete month, elapsed days for the current one. */
  daysCovered: number;
}

/** Recorded human effort for a model, from the task_quality view. */
export interface TaskQuality {
  attempts: number;
  accepted: number;
  avgReviewMinutes: number;
  avgRetries: number;
  acceptanceRate: number;
}

export interface LocalEstimate {
  volume: MonthlyVolume;
  model: LocalModel;
  machine: Machine;
  memory: {
    weightsGb: number;
    kvCacheGb: number | null;
    overheadGb: number | null;
    availableGb: number;
    weightsFit: boolean;
    /** null when the KV cache size is unknown: "weights fit; full-context feasibility unverified". */
    fullContextFits: boolean | null;
    verdict: string;
  };
  promptSeconds: number;
  generationSeconds: number;
  /** Wall-clock hours with the machine's concurrency applied. */
  wallClockHours: number;
  monthHours: number;
  /** wallClockHours / monthHours: above 1 means the machine cannot keep up. */
  utilisation: number;
  feasible: boolean;
  energyCostMicroUsd: bigint;
  /** Hardware cost if the machine is dedicated to this: price / amortise_months, whole. */
  hardwareDedicatedMicroUsd: bigint;
  /** Hardware cost prorated by utilisation (shared machine). */
  hardwareProratedMicroUsd: bigint;
  localCostDedicatedMicroUsd: bigint;
  localCostProratedMicroUsd: bigint;
  cloudCostMicroUsd: bigint;
  /** One block per configured rate, empty when no human section is configured. Local and cloud side by side, each marked recorded, assumed or none. */
  human: {
    id: string;
    label: string;
    hourlyUsd: number;
    currency: string;
    hourly: number;
    fxBasis: string | null;
    local: HumanSide;
    cloud: HumanSide;
  }[];
  throughputBasis: "measured" | "estimate" | "spec";
  parity: { benchmark: string; local: number; cloud: number | null; ratio: number | null; localSource: string; cloudSource: string | null }[];
}

export interface HumanSide {
  basis: "recorded" | "assumed" | "none";
  attempts: number;
  acceptanceRate: number | null;
  avgReviewMinutes: number | null;
  avgRetries: number | null;
  /** Review time at the hourly rate, per attempt. */
  reviewCostPerAttemptMicroUsd: bigint | null;
  /** Review cost per accepted result: per-attempt cost ÷ acceptance rate. null if nothing was accepted. */
  reviewCostPerAcceptedMicroUsd: bigint | null;
}

const MICRO = 1_000_000;
const toMicro = (usd: number): bigint => BigInt(Math.round(usd * MICRO));

export function humanSide(quality: TaskQuality | undefined, hourlyUsd: number, defaultReviewMinutes?: number): HumanSide {
  const none: HumanSide = { basis: "none", attempts: 0, acceptanceRate: null, avgReviewMinutes: null, avgRetries: null, reviewCostPerAttemptMicroUsd: null, reviewCostPerAcceptedMicroUsd: null };
  if (quality && quality.attempts > 0) {
    const perAttempt = toMicro((quality.avgReviewMinutes / 60) * hourlyUsd);
    return {
      basis: "recorded",
      attempts: quality.attempts,
      acceptanceRate: quality.acceptanceRate,
      avgReviewMinutes: quality.avgReviewMinutes,
      avgRetries: quality.avgRetries,
      reviewCostPerAttemptMicroUsd: perAttempt,
      reviewCostPerAcceptedMicroUsd: quality.acceptanceRate > 0 ? toMicro(((quality.avgReviewMinutes / 60) * hourlyUsd) / quality.acceptanceRate) : null,
    };
  }
  if (defaultReviewMinutes !== undefined) {
    const perAttempt = toMicro((defaultReviewMinutes / 60) * hourlyUsd);
    return { basis: "assumed", attempts: 0, acceptanceRate: null, avgReviewMinutes: defaultReviewMinutes, avgRetries: null, reviewCostPerAttemptMicroUsd: perAttempt, reviewCostPerAcceptedMicroUsd: null };
  }
  return none;
}

export function memoryCheck(model: LocalModel, machine: Machine): LocalEstimate["memory"] {
  const availableGb = machine.memory_gb - machine.os_headroom_gb;
  const weightsGb = model.file_size_gb.value;
  const context = model.working_context_tokens ?? model.context_tokens ?? null;
  const kvCacheGb = model.kv_cache_gb_per_1k_tokens && context ? (model.kv_cache_gb_per_1k_tokens.value * context) / 1000 : null;
  const overheadGb = model.runtime_overhead_gb?.value ?? null;
  const weightsFit = weightsGb <= availableGb;
  const fullContextFits = kvCacheGb === null ? null : weightsGb + kvCacheGb + (overheadGb ?? 0) <= availableGb;
  const verdict = !weightsFit
    ? `weights (${weightsGb} GB) do not fit in ${availableGb} GB available`
    : fullContextFits === null
      ? `weights fit (${weightsGb} of ${availableGb} GB); full-context feasibility unverified: no kv_cache_gb_per_1k_tokens supplied`
      : fullContextFits
        ? `weights ${weightsGb} GB + KV cache ${kvCacheGb!.toFixed(1)} GB at ${context} tokens${overheadGb !== null ? ` + overhead ${overheadGb} GB` : ""} fit in ${availableGb} GB [KV figure: ${model.kv_cache_gb_per_1k_tokens!.basis}]`
        : `weights ${weightsGb} GB + KV cache ${kvCacheGb!.toFixed(1)} GB at ${context} tokens${overheadGb !== null ? ` + overhead ${overheadGb} GB` : ""} EXCEED ${availableGb} GB; reduce working_context_tokens [KV figure: ${model.kv_cache_gb_per_1k_tokens!.basis}]`;
  return { weightsGb, kvCacheGb, overheadGb, availableGb, weightsFit, fullContextFits, verdict };
}

export function estimateLocal(
  volume: MonthlyVolume,
  model: LocalModel,
  machine: Machine,
  cloudBenchmarks: AlternativesFile["cloud_benchmarks"] = {},
  opts: { human?: Human | undefined; localQuality?: TaskQuality | undefined; cloudQuality?: TaskQuality | undefined } = {},
): LocalEstimate {
  const promptTps = machine.prompt_tokens_per_sec.value;
  const genTps = machine.generation_tokens_per_sec.value;
  if (promptTps <= 0 || genTps <= 0) throw new RangeError(`${machine.id}: throughput must be positive`);

  const promptSeconds = Number(volume.promptTokens) / promptTps;
  const generationSeconds = Number(volume.outputTokens) / genTps;
  const busySeconds = promptSeconds + generationSeconds;
  const wallClockHours = busySeconds / 3600 / machine.concurrency;
  // For the current month, compare month-to-date usage with month-to-date hours, idle time and hardware share.
  const monthHours = volume.daysCovered * 24;
  const utilisation = wallClockHours / monthHours;
  const feasible = utilisation <= 1;

  // Energy: active watts while busy, idle watts the rest of the month (the box is on regardless).
  const activeKwh = (machine.watts_active.value * Math.min(wallClockHours, monthHours)) / 1000;
  const idleKwh = (machine.watts_idle.value * Math.max(monthHours - wallClockHours, 0)) / 1000;
  const energyCostMicroUsd = toMicro((activeKwh + idleKwh) * machine.electricity_usd_per_kwh);

  const monthShare = volume.daysCovered / volume.daysInMonth;
  const hardwareDedicatedMicroUsd = toMicro((machine.price_usd / machine.amortise_months) * monthShare);
  const hardwareProratedMicroUsd = toMicro((machine.price_usd / machine.amortise_months) * monthShare * Math.min(utilisation, 1));

  const memory = memoryCheck(model, machine);

  const cloudKey = Object.keys(cloudBenchmarks)
    .filter((k) => `${volume.provider}/${volume.model}`.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  const cloudScores = cloudKey ? cloudBenchmarks[cloudKey] : undefined;
  const parity = Object.entries(model.benchmarks).map(([benchmark, local]) => {
    const cloud = cloudScores?.[benchmark];
    return {
      benchmark,
      local: local.score,
      cloud: cloud?.score ?? null,
      ratio: cloud && cloud.score !== 0 ? Number((local.score / cloud.score).toFixed(3)) : null,
      localSource: local.source,
      cloudSource: cloud?.source ?? null,
    };
  });

  const basis = (): LocalEstimate["throughputBasis"] => {
    const b = [machine.prompt_tokens_per_sec.basis, machine.generation_tokens_per_sec.basis];
    if (b.includes("estimate")) return "estimate";
    if (b.includes("spec")) return "spec";
    return "measured";
  };

  return {
    volume,
    model,
    machine,
    memory,
    promptSeconds,
    generationSeconds,
    wallClockHours,
    monthHours,
    utilisation,
    feasible,
    energyCostMicroUsd,
    hardwareDedicatedMicroUsd,
    hardwareProratedMicroUsd,
    localCostDedicatedMicroUsd: energyCostMicroUsd + hardwareDedicatedMicroUsd,
    localCostProratedMicroUsd: energyCostMicroUsd + hardwareProratedMicroUsd,
    cloudCostMicroUsd: volume.cloudCostMicroUsd,
    human: opts.human
      ? humanRatesUsd(opts.human).map((r) => ({
          ...r,
          local: humanSide(opts.localQuality, r.hourlyUsd, opts.human!.default_review_minutes_per_task),
          cloud: humanSide(opts.cloudQuality, r.hourlyUsd, opts.human!.default_review_minutes_per_task),
        }))
      : [],
    throughputBasis: basis(),
    parity,
  };
}
