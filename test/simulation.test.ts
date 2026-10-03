import { describe, expect, it } from "vitest";
import { simulate } from "./simulation/simulate.ts";

// Seeded simulation (test/simulation/simulate.ts). CI runs a fixed range of seeds;
// SIM_SEEDS=500 runs more, SIM_SEED=<n> replays one, SIM_STEPS sets the length.
const STEPS = Number(process.env.SIM_STEPS ?? 80);
const FIRST = Number(process.env.SIM_FIRST_SEED ?? 1);
const seeds = process.env.SIM_SEED
  ? [Number(process.env.SIM_SEED)]
  : Array.from({ length: Number(process.env.SIM_SEEDS ?? 10) }, (_, i) => FIRST + i);

describe("simulation: no duplicate, no orphan, everything converges", () => {
  it.each(seeds)("seed %i", { timeout: 120_000 }, async (seed) => {
    const report = await simulate({ seed, steps: STEPS });
    if (process.env.SIM_TRACE) console.log(report.trace.join("\n"));
    expect(report.trace.at(-1)).toMatch(/every lifetime ran out/);
  });
});
