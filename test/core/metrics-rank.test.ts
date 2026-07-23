import { describe, expect, it } from "vitest";

import {
  PlanSummary,
  comparePlanSummaries,
  rankPlans,
} from "../../src/core/metrics";

/**
 * price 欠落（costComplete: false）を含む案どうしの比較で、費用基準が
 * スキップされ次の基準（歩留まり）で順位が決まることを検証する（S-05）。
 */
function mk(
  id: string,
  opts: {
    cost: number | null;
    costComplete: boolean;
    yield: number;
    cutCount?: number;
    stockCounts?: Record<string, number>;
  },
): PlanSummary {
  return {
    id,
    method: { "1d": "ffd", "2d": "maxrects-bssf" },
    stocks: [],
    totals: {
      cost: opts.cost,
      costComplete: opts.costComplete,
      yield: opts.yield,
      cutCount: opts.cutCount ?? 0,
      stockCounts: opts.stockCounts ?? { b1: 1 },
    },
  };
}

const RANK: ("cost" | "waste" | "cuts")[] = ["cost", "waste", "cuts"];

describe("comparePlanSummaries（S-05 費用ゲート）", () => {
  it("両案とも costComplete=false のとき費用基準を飛ばし歩留まりで決める", () => {
    // A は部分合計では安い（100）が歩留まりが低い、B は部分合計では高い（300）
    // が歩留まりが高い。費用が確定していないため、費用ではなく歩留まりで B が上位。
    const a = mk("A", { cost: 100, costComplete: false, yield: 0.7 });
    const b = mk("B", { cost: 300, costComplete: false, yield: 0.9 });
    // B が上位（負値で a より b が前）: compare(b, a) < 0
    expect(comparePlanSummaries(b, a, RANK)).toBeLessThan(0);
    expect(comparePlanSummaries(a, b, RANK)).toBeGreaterThan(0);
    expect(rankPlans([a, b], RANK)).toEqual(["B", "A"]);
  });

  it("片方だけ costComplete=false でも費用基準はスキップされる", () => {
    const a = mk("A", { cost: 100, costComplete: true, yield: 0.7 });
    const b = mk("B", { cost: 300, costComplete: false, yield: 0.9 });
    // 費用比較不可 → 歩留まりで B が上位。
    expect(rankPlans([a, b], RANK)).toEqual(["B", "A"]);
  });

  it("両案とも costComplete=true なら費用で決める（安い方が上位）", () => {
    const a = mk("A", { cost: 100, costComplete: true, yield: 0.7 });
    const b = mk("B", { cost: 300, costComplete: true, yield: 0.9 });
    // 費用が確定 → 安い A が上位（歩留まりでは B が高いが費用が優先）。
    expect(rankPlans([a, b], RANK)).toEqual(["A", "B"]);
  });
});
