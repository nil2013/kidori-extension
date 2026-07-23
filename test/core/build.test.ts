import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { build } from "../../src/core/build";
import { ProjectError } from "../../src/core/errors";
import type { Summary } from "../../src/core/metrics";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-build-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeProject(yamlText: string): string {
  const p = path.join(dir, "project.yaml");
  fs.writeFileSync(p, yamlText, "utf-8");
  return p;
}

function readSummary(outDir: string): Summary {
  return JSON.parse(
    fs.readFileSync(path.join(outDir, "summary.json"), "utf-8"),
  ) as Summary;
}

const silent = (): void => {};

describe("build（統合）", () => {
  it("A/B/C を生成し、推奨案と厳密解一致を summary に記録する", () => {
    const p = writeProject(`
meta: { project: テスト, units: mm, schemaVersion: "0.2" }
settings: { kerf: 3, edgeTrim: 5, candidates: 3, selectedPlan: null }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }
parts:
  - { id: p1, label: 部材, qty: 2, stock: b1, length: 800 }
`);
    const result = build(p, { png: false, log: silent });
    expect(result.planIds).toEqual(["A", "B", "C"]);
    expect(fs.existsSync(path.join(result.outDir, "plan-A.svg"))).toBe(true);
    expect(fs.existsSync(path.join(result.partsDir, "p1.svg"))).toBe(true);

    const summary = readSummary(result.outDir);
    expect(summary.recommendedPlan).not.toBeNull();
    expect(summary.rankedPlans).toHaveLength(3);
    expect(summary.rank).toEqual(["cost", "waste", "cuts"]);
    // 2本が1本に収まる自明ケース: 全ヒューリスティックが最適一致する。
    expect(summary.exact.ran).toBe(true);
    expect(summary.exact.proven).toBe(true);
    expect(summary.exact.matchesPlan).toBe(summary.recommendedPlan);
    expect(summary.plans.every((pl) => pl.id !== "X")).toBe(true);
    expect(
      summary.plans.find((pl) => pl.id === summary.recommendedPlan)?.recommended,
    ).toBe(true);
  });

  it("厳密解がヒューリスティックより少ない本数のとき案 X を候補に加える", () => {
    // FFD/BFD/grouped はいずれも3本、最適は2本になる古典的な組合せ。
    const p = writeProject(`
meta: { project: テスト, units: mm, schemaVersion: "0.2" }
settings: { kerf: 0, edgeTrim: 0, candidates: 3, selectedPlan: null }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1000, width: 89, thickness: 19 }
parts:
  - { id: p500, label: a, qty: 1, stock: b1, length: 500 }
  - { id: p400, label: b, qty: 2, stock: b1, length: 400 }
  - { id: p300, label: c, qty: 1, stock: b1, length: 300 }
  - { id: p200, label: d, qty: 2, stock: b1, length: 200 }
`);
    const result = build(p, { png: false, log: silent });
    const summary = readSummary(result.outDir);

    const planX = summary.plans.find((pl) => pl.id === "X");
    expect(planX).toBeDefined();
    expect(planX!.totals.stockCounts.b1).toBe(2);
    expect(summary.exact.matchesPlan).toBeNull();
    // price 無し → cost は全案 null → waste（歩留まり）で X が最上位になる。
    expect(summary.recommendedPlan).toBe("X");
    expect(fs.existsSync(path.join(result.outDir, "plan-X.svg"))).toBe(true);
  });

  it("selectedPlan 設定時は採用案のみ生成し、厳密探索と推奨★を省略する", () => {
    const p = writeProject(`
meta: { project: テスト, units: mm, schemaVersion: "0.2" }
settings: { kerf: 3, edgeTrim: 5, candidates: 3, selectedPlan: B }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - { id: p1, label: 部材, qty: 3, stock: b1, length: 500 }
`);
    const result = build(p, { png: false, log: silent });
    expect(result.planIds).toEqual(["B"]);
    const summary = readSummary(result.outDir);
    expect(summary.selectedPlan).toBe("B");
    expect(summary.exact.ran).toBe(false);
    expect(summary.exact.reason).toContain("省略");
    expect(summary.recommendedPlan).toBeNull();
    expect(summary.plans[0].recommended).toBe(false);
    // 陳腐化ファイル削除: plan-A/C は存在しない。
    expect(fs.existsSync(path.join(result.outDir, "plan-A.svg"))).toBe(false);
  });

  it("selectedPlan: X で厳密解のみ再生成できる", () => {
    const p = writeProject(`
meta: { project: テスト, units: mm, schemaVersion: "0.2" }
settings: { kerf: 0, edgeTrim: 0, candidates: 3, exact: on, selectedPlan: X }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1000, width: 89, thickness: 19 }
parts:
  - { id: p500, label: a, qty: 1, stock: b1, length: 500 }
  - { id: p400, label: b, qty: 2, stock: b1, length: 400 }
  - { id: p300, label: c, qty: 1, stock: b1, length: 300 }
  - { id: p200, label: d, qty: 2, stock: b1, length: 200 }
`);
    const result = build(p, { png: false, log: silent });
    expect(result.planIds).toEqual(["X"]);
    const summary = readSummary(result.outDir);
    expect(summary.plans[0].method["1d"]).toBe("exact");
    expect(fs.existsSync(path.join(result.outDir, "plan-X.svg"))).toBe(true);
  });

  it("検証エラーで ProjectError を投げ、出力を生成しない", () => {
    const p = writeProject(`
meta: { project: テスト, units: mm, schemaVersion: "0.2" }
settings: { kerf: 3, edgeTrim: 5 }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - { id: p1, label: 部材, qty: 1, stock: 存在しない, length: 500 }
`);
    expect(() => build(p, { png: false, log: silent })).toThrow(ProjectError);
    expect(fs.existsSync(path.join(dir, "out", "summary.json"))).toBe(false);
    // スキーマは検証より先に書き出される。
    expect(fs.existsSync(path.join(dir, "project.schema.json"))).toBe(true);
  });

  it("再ビルドで陳腐化した加工指示図を削除する", () => {
    const yaml = (partId: string): string => `
meta: { project: テスト, units: mm, schemaVersion: "0.2" }
settings: { kerf: 3, edgeTrim: 5 }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - { id: ${partId}, label: 部材, qty: 1, stock: b1, length: 500 }
`;
    const p = writeProject(yaml("old-part"));
    const r1 = build(p, { png: false, log: silent });
    expect(fs.existsSync(path.join(r1.partsDir, "old-part.svg"))).toBe(true);

    writeProject(yaml("new-part"));
    const r2 = build(p, { png: false, log: silent });
    expect(fs.existsSync(path.join(r2.partsDir, "new-part.svg"))).toBe(true);
    expect(fs.existsSync(path.join(r2.partsDir, "old-part.svg"))).toBe(false);
  });
});
