import { describe, expect, it } from "vitest";
import { phaseOf } from "../src/server/railway/deployment-phase.ts";

describe("phaseOf", () => {
  it.each([
    ["SUCCESS", false, "serving"],
    ["SUCCESS", true, "stopped"],
    ["SLEEPING", false, "serving"],
    ["QUEUED", false, "coming-up"],
    ["WAITING", false, "coming-up"],
    ["INITIALIZING", false, "coming-up"],
    ["BUILDING", false, "coming-up"],
    ["DEPLOYING", false, "coming-up"],
    ["NEEDS_APPROVAL", false, "coming-up"],
    ["CRASHED", false, "down"],
    ["FAILED", false, "down"],
    ["SKIPPED", false, "down"],
    ["REMOVING", false, "going-away"],
    ["REMOVED", false, "going-away"],
  ] as const)("%s (stopped: %s) is %s", (status, stopped, phase) => {
    expect(phaseOf({ status, stopped }, () => {})).toBe(phase);
  });

  it("reads a status it does not know as coming up, and says so once", () => {
    const logged: string[] = [];
    const log = (msg: string) => logged.push(msg);
    expect(phaseOf({ status: "TELEPORTING", stopped: false }, log)).toBe("coming-up");
    expect(phaseOf({ status: "TELEPORTING", stopped: false }, log)).toBe("coming-up");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/TELEPORTING/);
  });
});
