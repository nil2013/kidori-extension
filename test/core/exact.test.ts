import { describe, expect, it } from "vitest";

import { Budget, BudgetExceededError } from "../../src/core/exact/budget";
import { exactPack1d } from "../../src/core/exact/exact1d";
import { exactPack2d } from "../../src/core/exact/exact2d";
import { AUTO_LIMIT, runExact } from "../../src/core/exact";
import type { Part, Project, Stock } from "../../src/core/types";
import { DEFAULT_RANK } from "../../src/core/types";
import { Placement1D } from "../../src/core/packing/common";

function makeProject(overrides: {
  stocks: Stock[];
  parts: Part[];
  kerf?: number;
  edgeTrim?: number;
  exact?: "auto" | "on" | "off";
}): Project {
  return {
    meta: { project: "テスト", units: "mm", schemaVersion: "0.2" },
    settings: {
      kerf: overrides.kerf ?? 0,
      edgeTrim: overrides.edgeTrim ?? 0,
      candidates: 3,
      rank: [...DEFAULT_RANK],
      exact: overrides.exact ?? "auto",
      selectedPlan: null,
    },
    stocks: overrides.stocks,
    parts: overrides.parts,
  };
}

function bar(id: string, length: number, price: number | null = null): Stock {
  return { id, label: id, kind: "bar", length, width: 89, thickness: 19, price };
}

function sheet(id: string, length: number, width: number): Stock {
  return { id, label: id, kind: "sheet", length, width, thickness: 18, price: null };
}

function part(
  id: string,
  stock: string,
  length: number,
  opts: { qty?: number; width?: number | null; rot?: boolean } = {},
): Part {
  return {
    id,
    label: id,
    qty: opts.qty ?? 1,
    stock,
    length,
    width: opts.width ?? null,
    rot: opts.rot ?? true,
    features: [],
  };
}

describe("exactPack1d", () => {
  it("FFD が3本使う入力で真の最小2本を見つける", () => {
    // FFD: [500,400] [400,300,200] [200] の3ビン。最適: [500,300,200] [400,400,200] の2ビン。
    const result = exactPack1d(
      [500, 400, 400, 300, 200, 200],
      1000,
      0,
      new Budget(1_000_000),
    );
    expect(result.count).toBe(2);
    const total = result.bins.flat().length;
    expect(total).toBe(6);
  });

  it("kerf を消費モデルどおり考慮する（境界の等号成立を許容）", () => {
    // 900 + 3 + 900 = 1803 === usable → 1本に収まる。
    const result = exactPack1d([900, 900], 1803, 3, new Budget(1_000_000));
    expect(result.count).toBe(1);
  });

  it("kerf により1本に収まらない場合は2本", () => {
    const result = exactPack1d([900, 900], 1802, 3, new Budget(1_000_000));
    expect(result.count).toBe(2);
  });

  it("空入力は0本", () => {
    const result = exactPack1d([], 1000, 3, new Budget(1_000_000));
    expect(result.count).toBe(0);
    expect(result.bins).toEqual([]);
  });

  it("予算超過で BudgetExceededError を投げる", () => {
    // 下界=2 < FFD=3 のため DFS に入る入力（上のケースと同じ）。
    expect(() =>
      exactPack1d([500, 400, 400, 300, 200, 200], 1000, 0, new Budget(1)),
    ).toThrow(BudgetExceededError);
  });
});

describe("exactPack2d", () => {
  it("面積下界と一致する詰め込みを見つける", () => {
    // 910×1820 の窓に 450×450 ×8 → 面積下界1、1枚に収まる。
    const items = Array.from({ length: 8 }, (_, i) => ({
      idx: i,
      w: 450,
      h: 450,
      rot: true,
    }));
    const result = exactPack2d(items, 1820, 910, new Budget(1_000_000));
    expect(result.lowerBound).toBe(1);
    expect(result.count).toBe(1);
    expect(result.sheets[0]).toHaveLength(8);
  });

  it("入り切らない部材は2枚目に割り付ける", () => {
    // 400×900 ×5: 4枚まで1枚目（400×4=1600≤1820）、5枚目は2枚目。
    const items = Array.from({ length: 5 }, (_, i) => ({
      idx: i,
      w: 400,
      h: 900,
      rot: false,
    }));
    const result = exactPack2d(items, 1820, 910, new Budget(1_000_000));
    expect(result.count).toBe(2);
  });

  it("回転により1枚に収まるケースを見つける", () => {
    // 窓 1000×500。700×400 と 500×550(rot可→550×500…不可。回転で 400×700 は縦700>500不可)
    // 代わりに: 600×450 と 450×350 → 600+350=950 ≤1000 で横並び可（回転なしでも可）。
    // 回転が必須のケース: 窓 1000×500、部材A 900×450、部材B 450×90。
    // B を回転（90×450）すると 900+90=990 ≤ 1000 で1枚に収まる。
    const items = [
      { idx: 0, w: 900, h: 450, rot: false },
      { idx: 1, w: 450, h: 90, rot: true },
    ];
    const result = exactPack2d(items, 1000, 500, new Budget(1_000_000));
    expect(result.count).toBe(1);
  });
});

describe("runExact", () => {
  it("exact: off では実行しない", () => {
    const project = makeProject({
      stocks: [bar("b", 1820)],
      parts: [part("p", "b", 900)],
      exact: "off",
    });
    const result = runExact(project);
    expect(result.ran).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.reason).toContain("off");
  });

  it("exact: auto で部材数が上限超過なら省略する", () => {
    const project = makeProject({
      stocks: [bar("b", 1820)],
      parts: [part("p", "b", 300, { qty: AUTO_LIMIT + 1 })],
      exact: "auto",
    });
    const result = runExact(project);
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("省略");
  });

  it("exact: on では部材数上限を超えても実行する", () => {
    const project = makeProject({
      stocks: [bar("b", 1820)],
      parts: [part("p", "b", 300, { qty: AUTO_LIMIT + 1 })],
      exact: "on",
    });
    const result = runExact(project);
    expect(result.ran).toBe(true);
    expect(result.plan).not.toBeNull();
  });

  it("bar の案 X: edgeTrim 起点で kerf を挟んで配置し seq を採番する", () => {
    const project = makeProject({
      stocks: [bar("b", 1820)],
      parts: [part("p", "b", 800, { qty: 2 })],
      kerf: 3,
      edgeTrim: 5,
    });
    const result = runExact(project);
    expect(result.ran).toBe(true);
    expect(result.proven).toBe(true);
    const plan = result.plan!;
    expect(plan.id).toBe("X");
    expect(plan.method1d).toBe("exact");
    // 800+3+800=1603 ≤ 1810 → 1本。
    expect(plan.units).toHaveLength(1);
    const placements = plan.units[0].placements as Placement1D[];
    expect(placements.map((p) => p.start)).toEqual([5, 808]);
    expect(Object.values(plan.seq).sort()).toEqual([1, 2]);
  });

  it("sheet を含む場合、面積下界一致なら proven になる", () => {
    const project = makeProject({
      stocks: [sheet("s", 1820, 910)],
      parts: [part("p", "s", 450, { qty: 4, width: 450 })],
    });
    const result = runExact(project);
    expect(result.ran).toBe(true);
    expect(result.proven).toBe(true);
    expect(result.plan!.units).toHaveLength(1);
  });

  it("予算超過時は打ち切り理由を返す", () => {
    const project = makeProject({
      stocks: [bar("b", 1820)],
      parts: [
        part("p1", "b", 500),
        part("p2", "b", 400, { qty: 2 }),
        part("p3", "b", 300),
        part("p4", "b", 200, { qty: 2 }),
      ],
      kerf: 0,
      edgeTrim: 410, // usable 1000 → FFD 3本・最適2本の探索が発生する。
    });
    const result = runExact(project, { nodeBudget: 1 });
    expect(result.ran).toBe(true);
    expect(result.proven).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.reason).toContain("打ち切り");
  });
});
