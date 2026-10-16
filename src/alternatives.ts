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
  context_tokens: z.number().int().positive().optional(),
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

export const AlternativesFile = z.object({
  version: z.string().min(1).optional(),
  as_of: z.string().optional(),
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
}

export interface LocalEstimate {
  volume: MonthlyVolume;
  model: LocalModel;
  machine: Machine;
  fitsInMemory: boolean;
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
  throughputBasis: "measured" | "estimate" | "spec";
  parity: { benchmark: string; local: number; cloud: number | null; ratio: number | null; localSource: string; cloudSource: string | null }[];
}

const MICRO = 1_000_000;
const toMicro = (usd: number): bigint => BigInt(Math.round(usd * MICRO));

export function estimateLocal(
  volume: MonthlyVolume,
  model: LocalModel,
  machine: Machine,
  cloudBenchmarks: AlternativesFile["cloud_benchmarks"] = {},
): LocalEstimate {
  const promptTps = machine.prompt_tokens_per_sec.value;
  const genTps = machine.generation_tokens_per_sec.value;
  if (promptTps <= 0 || genTps <= 0) throw new RangeError(`${machine.id}: throughput must be positive`);

  const promptSeconds = Number(volume.promptTokens) / promptTps;
  const generationSeconds = Number(volume.outputTokens) / genTps;
  const busySeconds = promptSeconds + generationSeconds;
  const wallClockHours = busySeconds / 3600 / machine.concurrency;
  const monthHours = volume.daysInMonth * 24;
  const utilisation = wallClockHours / monthHours;
  const feasible = utilisation <= 1;

  // Energy: active watts while busy, idle watts the rest of the month (the box is on regardless).
  const activeKwh = (machine.watts_active.value * Math.min(wallClockHours, monthHours)) / 1000;
  const idleKwh = (machine.watts_idle.value * Math.max(monthHours - wallClockHours, 0)) / 1000;
  const energyCostMicroUsd = toMicro((activeKwh + idleKwh) * machine.electricity_usd_per_kwh);

  const hardwareDedicatedMicroUsd = toMicro(machine.price_usd / machine.amortise_months);
  const hardwareProratedMicroUsd = toMicro((machine.price_usd / machine.amortise_months) * Math.min(utilisation, 1));

  const fitsInMemory = model.file_size_gb.value <= machine.memory_gb - machine.os_headroom_gb;

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
    fitsInMemory,
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
    throughputBasis: basis(),
    parity,
  };
}
