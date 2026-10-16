import path from "node:path";
import { describe, expect, it } from "vitest";
import { estimateLocal, humanSide, loadAlternatives, memoryCheck, type LocalModel, type Machine, type MonthlyVolume } from "../../src/alternatives.js";

const model: LocalModel = {
  id: "m",
  name: "Model",
  parameters_b: 27,
  quantisation: "Q4",
  file_size_gb: { value: 17, basis: "spec", source: "s" },
  benchmarks: {
    "SWE-bench Pro": { score: 60, source: "s" },
    "Other": { score: 80, source: "s" },
  },
};
const machine: Machine = {
  id: "box",
  name: "Box",
  memory_gb: 32,
  os_headroom_gb: 6,
  memory_bandwidth_gbs: { value: 170, basis: "spec", source: "s" },
  prompt_tokens_per_sec: { value: 100, basis: "measured", source: "s" },
  generation_tokens_per_sec: { value: 10, basis: "measured", source: "s" },
  concurrency: 1,
  price_usd: 3600,
  amortise_months: 36,
  watts_active: { value: 100, basis: "measured", source: "s" },
  watts_idle: { value: 10, basis: "measured", source: "s" },
  electricity_usd_per_kwh: 0.5,
};
const volume: MonthlyVolume = {
  teamId: "t",
  teamName: "Team",
  provider: "anthropic",
  model: "claude-sonnet-5-5-20260601",
  monthStart: "2026-10-01",
  promptTokens: 36_000_000n, // 360,000 s at 100 tok/s = 100 h
  outputTokens: 1_800_000n, // 180,000 s at 10 tok/s = 50 h
  cloudCostMicroUsd: 200_000_000n, // $200
  daysInMonth: 30, // 720 h
  monthToDate: false,
  daysCovered: 30,
};

describe("local alternative estimate", () => {
  it("turns token volume into wall-clock time and utilisation", () => {
    const e = estimateLocal(volume, model, machine);
    expect(e.promptSeconds).toBe(360_000);
    expect(e.generationSeconds).toBe(180_000);
    expect(e.wallClockHours).toBe(150);
    expect(e.monthHours).toBe(720);
    expect(e.utilisation).toBeCloseTo(150 / 720, 6);
    expect(e.feasible).toBe(true);
  });

  it("prices energy as active watts while busy plus idle watts the rest of the month", () => {
    const e = estimateLocal(volume, model, machine);
    // active 100 W × 150 h = 15 kWh; idle 10 W × 570 h = 5.7 kWh; 20.7 kWh × $0.5 = $10.35
    expect(e.energyCostMicroUsd).toBe(10_350_000n);
  });

  it("gives hardware cost both dedicated and prorated by utilisation", () => {
    const e = estimateLocal(volume, model, machine);
    expect(e.hardwareDedicatedMicroUsd).toBe(100_000_000n); // $3600 / 36
    expect(e.hardwareProratedMicroUsd).toBe(BigInt(Math.round((100 * 150) / 720 * 1_000_000)));
    expect(e.localCostDedicatedMicroUsd).toBe(110_350_000n);
    expect(e.cloudCostMicroUsd).toBe(200_000_000n);
  });

  it("flags a machine that cannot keep up and caps prorated hardware at the full amount", () => {
    const e = estimateLocal({ ...volume, promptTokens: 360_000_000n }, model, machine); // 1000 h prompt alone
    expect(e.feasible).toBe(false);
    expect(e.utilisation).toBeGreaterThan(1);
    expect(e.hardwareProratedMicroUsd).toBe(e.hardwareDedicatedMicroUsd);
    expect(e.energyCostMicroUsd).toBe(BigInt(Math.round((100 * 720) / 1000 * 0.5 * 1_000_000))); // all active, no idle
  });

  it("concurrency divides wall-clock time", () => {
    const e = estimateLocal(volume, model, { ...machine, concurrency: 3 });
    expect(e.wallClockHours).toBe(50);
  });

  it("memory check: weights alone give an unverified verdict, not a pass", () => {
    const m = memoryCheck(model, machine);
    expect(m.weightsFit).toBe(true);
    expect(m.fullContextFits).toBeNull();
    expect(m.verdict).toMatch(/full-context feasibility unverified/);
    expect(memoryCheck({ ...model, file_size_gb: { ...model.file_size_gb, value: 28 } }, machine).weightsFit).toBe(false);
  });

  it("memory check: with a KV cache figure it sizes the cache for the working context and can fail", () => {
    const withKv: LocalModel = {
      ...model,
      context_tokens: 262_144,
      working_context_tokens: 32_768,
      kv_cache_gb_per_1k_tokens: { value: 0.125, basis: "estimate", source: "s" }, // 4 GB at 32k
      runtime_overhead_gb: { value: 1.5, basis: "estimate", source: "s" },
    };
    const ok = memoryCheck(withKv, machine); // 17 + 4 + 1.5 = 22.5 ≤ 26
    expect(ok.kvCacheGb).toBeCloseTo(4.096, 3);
    expect(ok.fullContextFits).toBe(true);
    const noWorking: LocalModel = { ...withKv };
    delete noWorking.working_context_tokens;
    const full = memoryCheck(noWorking, machine); // sized for 262k: 32.8 GB
    expect(full.fullContextFits).toBe(false);
    expect(full.verdict).toMatch(/EXCEED/);
  });

  it("month-to-date volumes scale available hours, idle energy and hardware share to the elapsed days", () => {
    const mtd = { ...volume, monthToDate: true, daysCovered: 10 }; // 240 h window
    const e = estimateLocal(mtd, model, machine);
    expect(e.monthHours).toBe(240);
    expect(e.utilisation).toBeCloseTo(150 / 240, 6);
    // active 100 W × 150 h = 15 kWh; idle 10 W × 90 h = 0.9 kWh; 15.9 × $0.5 = $7.95
    expect(e.energyCostMicroUsd).toBe(7_950_000n);
    // hardware: $100/month × 10/30
    expect(e.hardwareDedicatedMicroUsd).toBe(33_333_333n);
  });

  it("human side: no hourly rate → not costed; recorded outcomes → per-attempt and per-accepted cost", () => {
    expect(estimateLocal(volume, model, machine).human).toBeNull();
    const human = { hourly_usd: 60 };
    const recorded = humanSide({ attempts: 10, accepted: 8, avgReviewMinutes: 15, avgRetries: 0.5, acceptanceRate: 0.8 }, human);
    expect(recorded.basis).toBe("recorded");
    expect(recorded.reviewCostPerAttemptMicroUsd).toBe(15_000_000n); // 15 min at $60/h = $15
    expect(recorded.reviewCostPerAcceptedMicroUsd).toBe(18_750_000n); // $15 / 0.8
    const assumed = humanSide(undefined, { hourly_usd: 60, default_review_minutes_per_task: 5 });
    expect(assumed).toMatchObject({ basis: "assumed", reviewCostPerAttemptMicroUsd: 5_000_000n, reviewCostPerAcceptedMicroUsd: null });
    expect(humanSide(undefined, human).basis).toBe("none");
    expect(humanSide({ attempts: 3, accepted: 0, avgReviewMinutes: 30, avgRetries: 2, acceptanceRate: 0 }, human).reviewCostPerAcceptedMicroUsd).toBeNull();
  });

  it("human side is attached per model and kept separate from machine cost", () => {
    const e = estimateLocal(volume, model, machine, {}, {
      human: { hourly_usd: 60 },
      localQuality: { attempts: 4, accepted: 2, avgReviewMinutes: 20, avgRetries: 1, acceptanceRate: 0.5 },
      cloudQuality: { attempts: 4, accepted: 4, avgReviewMinutes: 5, avgRetries: 0, acceptanceRate: 1 },
    });
    expect(e.human!.local.reviewCostPerAcceptedMicroUsd).toBe(40_000_000n); // $20 / 0.5
    expect(e.human!.cloud.reviewCostPerAcceptedMicroUsd).toBe(5_000_000n);
    expect(e.localCostDedicatedMicroUsd).toBe(110_350_000n); // unchanged by human figures
  });

  it("shows benchmark parity only where a cloud score was supplied, and never a probability", () => {
    const e = estimateLocal(volume, model, machine, {
      "anthropic/claude-sonnet-5-5": { "SWE-bench Pro": { score: 75, source: "c" } },
    });
    expect(e.parity).toEqual([
      { benchmark: "SWE-bench Pro", local: 60, cloud: 75, ratio: 0.8, localSource: "s", cloudSource: "c" },
      { benchmark: "Other", local: 80, cloud: null, ratio: null, localSource: "s", cloudSource: null },
    ]);
    expect(JSON.stringify(e, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/probab/i);
  });

  it("reports estimate as the basis if any throughput figure is an estimate", () => {
    expect(estimateLocal(volume, model, machine).throughputBasis).toBe("measured");
    expect(
      estimateLocal(volume, model, { ...machine, generation_tokens_per_sec: { value: 8, basis: "estimate", source: "s" } }).throughputBasis,
    ).toBe("estimate");
  });

  it("the shipped example file validates and every figure carries a source", async () => {
    const alt = await loadAlternatives(path.resolve(import.meta.dirname, "../../alternatives.example.json"));
    expect(alt.local_models[0]!.id).toBe("qwen3.8-27b-q4_k_m");
    const m = alt.machines[0]!;
    for (const f of [m.memory_bandwidth_gbs, m.prompt_tokens_per_sec, m.generation_tokens_per_sec, m.watts_active, m.watts_idle]) {
      expect(f.source).toMatch(/^https?:\/\//);
    }
    expect(m.prompt_tokens_per_sec.basis).toBe("estimate"); // honest until someone measures
  });
});
