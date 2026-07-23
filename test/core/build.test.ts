import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { build, exactPlanStrictlyBetter } from "../../src/core/build";
import { KidoriError, ProjectError } from "../../src/core/errors";
import type { PlanSummary, Summary } from "../../src/core/metrics";
import * as png from "../../src/core/png";

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
    // selectedPlan: X 経路でも証明状態が summary に載る（表示の出し分けに使う）。
    expect(summary.plans[0].exactProven).toBe(true);
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

describe("build（厳密探索の証明状態と表示ゲート）", () => {
  it("proven=false のとき exactMatch / matchesPlan が立たない", () => {
    // 幅 2^0..2^12 の13部材: 2D 候補集合が PATTERN_CAP を超え、貪欲解＋未証明になる。
    // 部材幅 60 は原材幅 100 に2段積みできず、総長 8191 > 5000 のため2枚以上
    //（面積下界1と一致しない → 下界一致の証明も成立しない）。
    const partsYaml = Array.from({ length: 13 }, (_, i) => 2 ** i)
      .map(
        (len, i) =>
          `  - { id: p${i}, label: p${i}, qty: 1, stock: s1, length: ${len}, width: 60, rot: false }`,
      )
      .join("\n");
    const p = writeProject(`
meta: { project: テスト, units: mm, schemaVersion: "0.2" }
settings: { kerf: 0, edgeTrim: 0, candidates: 3, selectedPlan: null }
stocks:
  - { id: s1, label: 板, kind: sheet, length: 5000, width: 100, thickness: 18 }
parts:
${partsYaml}
`);
    const result = build(p, { png: false, log: silent });
    const summary = readSummary(result.outDir);

    expect(summary.exact.ran).toBe(true);
    expect(summary.exact.proven).toBe(false);
    expect(summary.exact.matchesPlan).toBeNull();
    expect(summary.exact.reason).toContain("候補集合");
    // 未証明のため、必要枚数が一致してもどの案にも exactMatch は立たない。
    expect(summary.plans.every((pl) => pl.exactMatch !== true)).toBe(true);
    // 案 X が候補に含まれる場合は必ず未証明表示（exactProven: false）になる。
    const planX = summary.plans.find((pl) => pl.id === "X");
    if (planX) {
      expect(planX.exactProven).toBe(false);
    }
  });

  it("S-04: 必要本数もカット回数もタイのとき案 X は破棄され、一致案に exactMatch が立つ", () => {
    // FFD 自体が最適（2本・下界一致）の組合せ: 厳密探索は FFD と同一構成を返し、
    // rank 全基準でタイ → タイブレークでヒューリスティック上位 → X 破棄。
    const p = writeProject(`
meta: { project: テスト, units: mm, schemaVersion: "0.2" }
settings: { kerf: 0, edgeTrim: 0, candidates: 3, selectedPlan: null }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1000, width: 89, thickness: 19 }
parts:
  - { id: p600, label: a, qty: 1, stock: b1, length: 600 }
  - { id: p500, label: b, qty: 1, stock: b1, length: 500 }
  - { id: p400, label: c, qty: 1, stock: b1, length: 400 }
  - { id: p300, label: d, qty: 1, stock: b1, length: 300 }
  - { id: p200, label: e, qty: 1, stock: b1, length: 200 }
`);
    const result = build(p, { png: false, log: silent });
    const summary = readSummary(result.outDir);

    expect(summary.exact.ran).toBe(true);
    expect(summary.exact.proven).toBe(true);
    expect(result.planIds).toEqual(["A", "B", "C"]); // X は破棄
    expect(summary.exact.matchesPlan).not.toBeNull();
    expect(summary.plans.some((pl) => pl.exactMatch === true)).toBe(true);
  });

  it("S-04: 本数タイでも案 X のカット回数が厳密に少なければ候補保持判定が真になる", () => {
    const base: Omit<PlanSummary, "id" | "totals"> = {
      method: { "1d": "ffd", "2d": "maxrects-bssf" },
      stocks: [],
    };
    const mk = (id: string, cutCount: number): PlanSummary => ({
      ...base,
      id,
      totals: {
        cost: null,
        costComplete: false,
        yield: 0.8,
        cutCount,
        stockCounts: { b1: 2 },
      },
    });
    const rank: ("cost" | "waste" | "cuts")[] = ["cost", "waste", "cuts"];

    // X のカット回数が全一致案より少ない → 候補保持。
    expect(exactPlanStrictlyBetter(mk("X", 3), [mk("A", 4), mk("B", 5)], rank)).toBe(
      true,
    );
    // 1案とでもタイ（全基準同値）→ タイブレークでヒューリスティック上位 → 破棄。
    expect(exactPlanStrictlyBetter(mk("X", 4), [mk("A", 4), mk("B", 5)], rank)).toBe(
      false,
    );
  });

  it("S-13: selectedPlan: X × exact: auto × 部材数16 でビルドが成功する", () => {
    const p = writeProject(`
meta: { project: テスト, units: mm, schemaVersion: "0.2" }
settings: { kerf: 3, edgeTrim: 5, candidates: 3, exact: auto, selectedPlan: X }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - { id: p1, label: 部材, qty: 16, stock: b1, length: 300 }
`);
    const result = build(p, { png: false, log: silent });
    expect(result.planIds).toEqual(["X"]);
    const summary = readSummary(result.outDir);
    expect(summary.exact.ran).toBe(true);
    expect(summary.plans[0].id).toBe("X");
    expect(fs.existsSync(path.join(result.outDir, "plan-X.svg"))).toBe(true);
  });
});

describe("build（現行正本反映保証: S-11 / S-12 / S-09）", () => {
  const validYaml = (partId = "p1"): string => `
meta: { project: テスト, units: mm, schemaVersion: "0.2" }
settings: { kerf: 3, edgeTrim: 5, candidates: 3, selectedPlan: null }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }
parts:
  - { id: ${partId}, label: 部材, qty: 2, stock: b1, length: 800 }
`;

  const invalidYaml = `
meta: { project: テスト, units: mm, schemaVersion: "0.2" }
settings: { kerf: 3, edgeTrim: 5 }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - { id: p1, label: 部材, qty: 1, stock: 存在しない, length: 500 }
`;

  const markerPath = (outDir: string): string =>
    path.join(outDir, "BUILD-FAILED.txt");

  it("成功ビルドは summary.sourceSha256 が実ファイルと一致し、マーカーが無い", () => {
    const text = validYaml();
    const p = writeProject(text);
    const result = build(p, { png: false, log: silent });
    const summary = readSummary(result.outDir);

    const expected = createHash("sha256")
      .update(fs.readFileSync(p))
      .digest("hex");
    expect(summary.sourceSha256).toBe(expected);
    expect(summary.sourceFile).toBe("project.yaml");
    expect(fs.existsSync(markerPath(result.outDir))).toBe(false);
  });

  it("検証エラーで BUILD-FAILED.txt を生成し、sourceSha256 と reason を記録する", () => {
    const p = writeProject(invalidYaml);
    const outDir = path.join(dir, "out");
    expect(() => build(p, { png: false, log: silent })).toThrow(ProjectError);

    const marker = markerPath(outDir);
    expect(fs.existsSync(marker)).toBe(true);
    const content = fs.readFileSync(marker, "utf-8");
    const expected = createHash("sha256")
      .update(fs.readFileSync(p))
      .digest("hex");
    expect(content).toContain(`sourceSha256: ${expected}`);
    expect(content).toContain("reason:");
    expect(content).toContain("最新の正本を反映していません");
    // 検証エラーでは図面は生成されない。
    expect(fs.existsSync(path.join(outDir, "summary.json"))).toBe(false);
  });

  it("失敗の後に成功するとマーカーが消える", () => {
    const p = writeProject(invalidYaml);
    const outDir = path.join(dir, "out");
    expect(() => build(p, { png: false, log: silent })).toThrow(ProjectError);
    expect(fs.existsSync(markerPath(outDir))).toBe(true);

    writeProject(validYaml());
    const result = build(p, { png: false, log: silent });
    expect(fs.existsSync(markerPath(result.outDir))).toBe(false);
  });

  it("成功→検証エラーで旧 plan-*.svg は残るがマーカーで stale 判定できる", () => {
    const p = writeProject(validYaml());
    const r1 = build(p, { png: false, log: silent });
    expect(fs.existsSync(path.join(r1.outDir, "plan-A.svg"))).toBe(true);

    writeProject(invalidYaml);
    expect(() => build(p, { png: false, log: silent })).toThrow(ProjectError);
    // 旧図面は残る（削除まで到達しない）が、マーカーで最新でないと判定できる。
    expect(fs.existsSync(path.join(r1.outDir, "plan-A.svg"))).toBe(true);
    expect(fs.existsSync(markerPath(r1.outDir))).toBe(true);
    // マーカーの sourceSha256 は新しい（無効な）正本のもの。
    const content = fs.readFileSync(markerPath(r1.outDir), "utf-8");
    const newSha = createHash("sha256")
      .update(fs.readFileSync(p))
      .digest("hex");
    expect(content).toContain(`sourceSha256: ${newSha}`);
  });

  it("コミット後に *.kidori-tmp 残骸が残らない", () => {
    const p = writeProject(validYaml());
    const result = build(p, { png: false, log: silent });
    const leftovers = [
      ...fs.readdirSync(result.outDir),
      ...fs.readdirSync(result.partsDir),
    ].filter((n) => n.endsWith(".kidori-tmp"));
    expect(leftovers).toEqual([]);
  });

  it("管理外ファイル（out/memo.txt）はビルドで保全される", () => {
    const p = writeProject(validYaml());
    const outDir = path.join(dir, "out");
    fs.mkdirSync(outDir, { recursive: true });
    const memo = path.join(outDir, "memo.txt");
    fs.writeFileSync(memo, "手書きメモ", "utf-8");

    build(p, { png: false, log: silent });
    expect(fs.existsSync(memo)).toBe(true);
    expect(fs.readFileSync(memo, "utf-8")).toBe("手書きメモ");
  });

  it("S-09: PNG 有効かつ resvg 利用不可なら KidoriError にしマーカーを残す", () => {
    const spyAvail = vi.spyOn(png, "pngAvailable").mockReturnValue(false);
    try {
      const p = writeProject(validYaml());
      const outDir = path.join(dir, "out");
      expect(() => build(p, { png: true, log: silent })).toThrow(KidoriError);
      // マーカーは残り、図面は生成されない。
      expect(fs.existsSync(markerPath(outDir))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "summary.json"))).toBe(false);
      const content = fs.readFileSync(markerPath(outDir), "utf-8");
      expect(content).toContain("reason:");
    } finally {
      spyAvail.mockRestore();
    }
  });

  it("S-09: resvg 利用可能なら PNG が生成される（既存挙動の維持）", () => {
    // 実行環境に resvg-js が導入されている前提（未導入ならスキップ）。
    if (!png.pngAvailable()) {
      return;
    }
    const p = writeProject(validYaml());
    const result = build(p, { png: true, log: silent });
    expect(result.pngPaths.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(result.outDir, "plan-A.png"))).toBe(true);
  });
});
