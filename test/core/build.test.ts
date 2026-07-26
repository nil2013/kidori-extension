import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSchema } from "../../src/cli/agentCommands";
import { build, exactPlanStrictlyBetter, planPartFaces } from "../../src/core/build";
import { KidoriError, ProjectError } from "../../src/core/errors";
import { loadProject } from "../../src/core/loader";
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

/** 既定の出力先（正本 project.yaml → project.out/。SPECS §3）。 */
function defaultOut(): string {
  return path.join(dir, "project.out");
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
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
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
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
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
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
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
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
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
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
settings: { kerf: 3, edgeTrim: 5 }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - { id: p1, label: 部材, qty: 1, stock: 存在しない, length: 500 }
`);
    expect(() => build(p, { png: false, log: silent })).toThrow(ProjectError);
    expect(fs.existsSync(path.join(defaultOut(), "summary.json"))).toBe(false);
    // v0.6: スキーマファイルのディスク再生成は廃止されたため、正本の隣に
    // スキーマは書かれない（SPECS §4b）。
    expect(fs.existsSync(path.join(dir, "project.schema.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "kidori.schema.json"))).toBe(false);
  });

  it("再ビルドで陳腐化した加工指示図を削除する", () => {
    const yaml = (partId: string): string => `
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
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
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
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
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
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
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
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
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
settings: { kerf: 3, edgeTrim: 5, candidates: 3, selectedPlan: null }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }
parts:
  - { id: ${partId}, label: 部材, qty: 2, stock: b1, length: 800 }
`;

  const invalidYaml = `
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
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
    const outDir = defaultOut();
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
    const outDir = defaultOut();
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
    const outDir = defaultOut();
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
      const outDir = defaultOut();
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

// ---------------------------------------------------------------------------
// v0.6: 出力先の導出とスキーマ再生成の廃止（SPECS §3・§4b）
// ---------------------------------------------------------------------------

describe("build（v0.6: 出力先とスキーマ）", () => {
  const validYaml = `
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
settings: { kerf: 3, edgeTrim: 5, candidates: 3, exact: off, selectedPlan: null }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }
parts:
  - { id: p1, label: 部材, qty: 2, stock: b1, length: 800 }
`;

  function writeNamed(name: string): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, validYaml, "utf-8");
    return p;
  }

  it("bookshelf.kidori.yaml → bookshelf.out/（サフィックスを丸ごと落とす）", () => {
    const p = writeNamed("bookshelf.kidori.yaml");
    const result = build(p, { png: false, log: silent });

    expect(result.outDir).toBe(path.join(dir, "bookshelf.out"));
    expect(fs.existsSync(path.join(result.outDir, "plan-A.svg"))).toBe(true);
    expect(result.summary.sourceFile).toBe("bookshelf.kidori.yaml");
  });

  it("foo.yaml → foo.out/（最終拡張子のみ落とす）", () => {
    const p = writeNamed("foo.yaml");
    expect(build(p, { png: false, log: silent }).outDir).toBe(
      path.join(dir, "foo.out"),
    );
  });

  it("同一ディレクトリの複数プロジェクトが出力先で衝突しない", () => {
    const a = build(writeNamed("bookshelf.kidori.yaml"), { png: false, log: silent });
    const b = build(writeNamed("desk.kidori.yaml"), { png: false, log: silent });

    expect(a.outDir).not.toBe(b.outDir);
    expect(fs.existsSync(path.join(a.outDir, "plan-A.svg"))).toBe(true);
    expect(fs.existsSync(path.join(b.outDir, "plan-A.svg"))).toBe(true);
  });

  it("BuildOptions.outDir による明示上書きは維持され、正本の隣には何も書かれない", () => {
    const p = writeNamed("bookshelf.kidori.yaml");
    const explicit = path.join(dir, "sandbox");
    const result = build(p, { png: false, outDir: explicit, log: silent });

    expect(result.outDir).toBe(explicit);
    expect(fs.existsSync(path.join(explicit, "summary.json"))).toBe(true);
    // v0.6: --out がサンドボックスとして機能する（正本の隣に副作用を残さない）。
    expect(fs.readdirSync(dir).sort()).toEqual(["bookshelf.kidori.yaml", "sandbox"]);
  });

  it("成功ビルドでもスキーマファイルはディスクに書かれない（SPECS §4b）", () => {
    const p = writeNamed("bookshelf.kidori.yaml");
    build(p, { png: false, log: silent });

    expect(fs.existsSync(path.join(dir, "project.schema.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "kidori.schema.json"))).toBe(false);
  });

  it("<ファイル名>.out/schema.json が生成され、kidori schema の出力と一致する", () => {
    const p = writeNamed("bookshelf.kidori.yaml");
    const result = build(p, { png: false, log: silent });

    // SPECS §3b:101 — 出力ディレクトリ側にだけ書き出す（正本の隣には書かない）。
    expect(result.schemaPath).toBe(path.join(result.outDir, "schema.json"));
    const written = fs.readFileSync(result.schemaPath, "utf-8");

    const chunks: string[] = [];
    expect(runSchema([p], (s) => chunks.push(s), silent)).toBe(0);
    expect(written).toBe(chunks.join(""));

    // 正本ディレクトリには依然として何も書かない（v0.6 の廃止と両立する）。
    expect(fs.existsSync(path.join(dir, "schema.json"))).toBe(false);
  });

  it("schema.json は stocks[].id の変化に追随して再生成される", () => {
    const p = path.join(dir, "project.kidori.yaml");
    const yaml = (stockId: string): string => `
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
settings: { exact: off }
stocks:
  - { id: ${stockId}, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - { id: p1, label: 部材, qty: 1, stock: ${stockId}, length: 500 }
`;
    fs.writeFileSync(p, yaml("b1"), "utf-8");
    const r1 = build(p, { png: false, log: silent });
    expect(fs.readFileSync(r1.schemaPath, "utf-8")).toContain('"b1"');

    fs.writeFileSync(p, yaml("b2"), "utf-8");
    const r2 = build(p, { png: false, log: silent });
    const after = fs.readFileSync(r2.schemaPath, "utf-8");
    expect(after).toContain('"b2"');
    expect(after).not.toContain('"b1"');
  });

  it("schema.json は管理対象のためビルドで残り、管理外ファイルは保全される", () => {
    const p = writeNamed("bookshelf.kidori.yaml");
    const r1 = build(p, { png: false, log: silent });
    fs.writeFileSync(path.join(r1.outDir, "memo.txt"), "手書きメモ", "utf-8");

    const r2 = build(p, { png: false, log: silent });
    // cleanupStale の管理対象に schema.json を加えたが、毎回生成されるので消えない。
    expect(fs.existsSync(r2.schemaPath)).toBe(true);
    // 管理外ファイルには触れない（既存規約の維持）。
    expect(fs.existsSync(path.join(r2.outDir, "memo.txt"))).toBe(true);
  });

  it("モードライン案内は ./kidori.schema.json を推奨する", () => {
    const p = writeNamed("bookshelf.kidori.yaml");
    const logs: string[] = [];
    build(p, { png: false, log: (m) => logs.push(m) });

    const guide = logs.find((m) => m.startsWith("[案内]"));
    expect(guide).toBeDefined();
    expect(guide!).toContain("./kidori.schema.json");
    expect(guide!).not.toContain("project.schema.json");
  });
});

// ---------------------------------------------------------------------------
// v0.7: assemblies / marks（SPECS.md §4c・§6）
// ---------------------------------------------------------------------------

/** SPECS.md §4c の例（ウマ2脚）に相当する正本を任意のサブディレクトリに書く。 */
function writeIn(subdir: string, body: string): string {
  const d = path.join(dir, subdir);
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, "uma.kidori.yaml");
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

const UMA_STOCKS = `
meta: { project: ウマ, units: mm, schemaVersion: "0.5" }
settings: { kerf: 3, edgeTrim: 5, exact: off, selectedPlan: null }
stocks:
  - { id: 2x4-6f, label: "2×4材 6F", kind: bar, length: 1820, width: 89, thickness: 38, price: 498 }
parts:
  - { id: leg,       label: 足,     stock: 2x4-6f, length: 800 }
  - { id: beam-top,  label: 天板,   stock: 2x4-6f, length: 850 }
  - { id: beam-foot, label: 接地面, stock: 2x4-6f, length: 900 }
`;

/** ウマ2脚（両方の assembly が beam-top にマークを持つ）。 */
const UMA_MARKED = `${UMA_STOCKS}
assemblies:
  - id: uma-1
    label: ウマ1号機（足が内側）
    contains: { leg: 2, beam-top: 1, beam-foot: 1 }
    marks:
      - { on: beam-top, face: front, ref: leg, x: 50, note: 足当たり面 }
  - id: uma-2
    label: ウマ2号機（互い違いに噛み合う側）
    contains: { leg: 2, beam-top: 1, beam-foot: 1 }
    marks:
      - { on: beam-top, face: front, ref: leg, x: 120, note: 足当たり面 }
`;

/** 同じ構成だがマークを1つも持たない（割付不変の対照群）。 */
const UMA_UNMARKED = `${UMA_STOCKS}
assemblies:
  - id: uma-1
    label: ウマ1号機（足が内側）
    contains: { leg: 2, beam-top: 1, beam-foot: 1 }
  - id: uma-2
    label: ウマ2号機（互い違いに噛み合う側）
    contains: { leg: 2, beam-top: 1, beam-foot: 1 }
`;

function partsSvgNames(partsDir: string): string[] {
  return fs
    .readdirSync(partsDir)
    .filter((n) => n.endsWith(".svg"))
    .sort();
}

function readText(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

describe("build（v0.7: 変種面と基底面の出力集合）", () => {
  it("全 unit がマーク付き assembly に属する形状は基底面を出さない", () => {
    const p = writeIn("marked", UMA_MARKED);
    const result = build(p, { png: false, log: silent });

    // beam-top は qty 2（= uma-1 の1個 + uma-2 の1個）で、その2個とも
    // マーク付き assembly に属する → 基底面 beam-top.svg は出さない。
    expect(partsSvgNames(result.partsDir)).toEqual([
      "beam-foot.svg",
      "leg.svg",
      "uma-1-beam-top.svg",
      "uma-2-beam-top.svg",
    ]);
    expect(fs.existsSync(path.join(result.partsDir, "beam-top.svg"))).toBe(false);
  });

  it("マーク無し assembly の unit がある形状は基底面も出す", () => {
    // uma-3 は beam-top を1個使うがマークを持たない → その1個が図面を失わない
    // よう、変種面2枚に加えて基底面 beam-top.svg も出す。
    const p = writeIn("mixed", `${UMA_MARKED}
  - id: uma-3
    label: 予備の天板だけ
    contains: { beam-top: 1 }
`);
    const result = build(p, { png: false, log: silent });

    expect(partsSvgNames(result.partsDir)).toEqual([
      "beam-foot.svg",
      "beam-top.svg",
      "leg.svg",
      "uma-1-beam-top.svg",
      "uma-2-beam-top.svg",
    ]);
    // 基底面にはマークを描かない。
    expect(readText(path.join(result.partsDir, "beam-top.svg"))).not.toContain(
      "取り付け位置",
    );
  });

  it("planPartFaces は基底面→変種面の順で、形状は parts の宣言順に並ぶ", () => {
    const p = writeIn("order", UMA_MARKED);
    const { project } = loadProject(p);
    expect(planPartFaces(project).map((f) => f.stem)).toEqual([
      "leg",
      "uma-1-beam-top",
      "uma-2-beam-top",
      "beam-foot",
    ]);
  });

  it("変種面には構成ごとに異なるマーク位置が描かれる", () => {
    const p = writeIn("variants", UMA_MARKED);
    const result = build(p, { png: false, log: silent });

    const v1 = readText(path.join(result.partsDir, "uma-1-beam-top.svg"));
    const v2 = readText(path.join(result.partsDir, "uma-2-beam-top.svg"));

    for (const svg of [v1, v2]) {
      expect(svg).toContain('data-role="mark"');
      expect(svg).toContain("取り付け位置（切削なし）");
      expect(svg).toContain("足当たり面");
      // D2: 領域はハッチング（pattern を fill で参照する）。
      expect(svg).toContain("<pattern");
      expect(svg).toContain('fill="url(#kidori-mark-hatch)"');
    }
    // 構成名がヘッダに出るため、印刷しても取り違えない。
    expect(v1).toContain("ウマ1号機（足が内側）");
    expect(v2).toContain("ウマ2号機（互い違いに噛み合う側）");
    // x=50 と x=120 でマーク矩形の位置が異なる。
    expect(v1).not.toBe(v2);
  });

  it("BuildResult.partCards は変種面を stem で表し、SVG パスと対応する", () => {
    const p = writeIn("cards", UMA_MARKED);
    const result = build(p, { png: false, log: silent });

    expect(result.partCards.map((c) => c.id)).toEqual([
      "leg",
      "uma-1-beam-top",
      "uma-2-beam-top",
      "beam-foot",
    ]);
    for (const card of result.partCards) {
      expect(fs.existsSync(card.svgPath)).toBe(true);
      expect(path.basename(card.svgPath)).toBe(`${card.id}.svg`);
    }
  });

  it("変種面の陳腐化: assembly を消すと前回の変種面が削除される", () => {
    const p = writeIn("stale", UMA_MARKED);
    const r1 = build(p, { png: false, log: silent });
    expect(fs.existsSync(path.join(r1.partsDir, "uma-2-beam-top.svg"))).toBe(true);

    fs.writeFileSync(p, UMA_UNMARKED, "utf-8");
    const r2 = build(p, { png: false, log: silent });
    expect(partsSvgNames(r2.partsDir)).toEqual([
      "beam-foot.svg",
      "beam-top.svg",
      "leg.svg",
    ]);
  });
});

describe("build（v0.7: marks は加工指示図のみ・割付に不干渉）", () => {
  it("marks は木取り図 SVG には現れない（SPECS §4c:215）", () => {
    const p = writeIn("cutplan", UMA_MARKED);
    const result = build(p, { png: false, log: silent });

    for (const planId of result.planIds) {
      const svg = readText(path.join(result.outDir, `plan-${planId}.svg`));
      expect(svg).not.toContain("取り付け位置");
      expect(svg).not.toContain('data-role="mark"');
    }
    // 一方、加工指示図（変種面）には現れる。
    expect(readText(path.join(result.partsDir, "uma-1-beam-top.svg"))).toContain(
      "取り付け位置（切削なし）",
    );
  });

  it("marks の有無で割付結果（歩留まり・カット回数・必要本数）が変わらない", () => {
    const marked = build(writeIn("packA", UMA_MARKED), { png: false, log: silent });
    const plain = build(writeIn("packB", UMA_UNMARKED), { png: false, log: silent });

    expect(marked.planIds).toEqual(plain.planIds);
    expect(marked.summary.rankedPlans).toEqual(plain.summary.rankedPlans);
    expect(marked.summary.recommendedPlan).toBe(plain.summary.recommendedPlan);

    const totals = (s: Summary): unknown[] =>
      s.plans.map((ps) => [ps.id, ps.totals.yield, ps.totals.cutCount, ps.totals.stockCounts]);
    expect(totals(marked.summary)).toEqual(totals(plain.summary));

    // 木取り図そのものも1バイト違わない（配置・切断線が marks に依存しない）。
    for (const planId of marked.planIds) {
      expect(readText(path.join(marked.outDir, `plan-${planId}.svg`))).toBe(
        readText(path.join(plain.outDir, `plan-${planId}.svg`)),
      );
    }
  });

  it("マークを持たない形状の加工指示図は marks の有無で1バイトも変わらない", () => {
    const marked = build(writeIn("faceA", UMA_MARKED), { png: false, log: silent });
    const plain = build(writeIn("faceB", UMA_UNMARKED), { png: false, log: silent });

    for (const name of ["leg.svg", "beam-foot.svg"]) {
      expect(readText(path.join(marked.partsDir, name))).toBe(
        readText(path.join(plain.partsDir, name)),
      );
    }
  });
});

describe("build（v0.7: assemblies 不在時の回帰防止）", () => {
  const legacyYaml = `
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
settings: { kerf: 3, edgeTrim: 5, exact: off, selectedPlan: null }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }
parts:
  - { id: p1, label: 部材1, qty: 2, stock: b1, length: 800 }
  - { id: p2, label: 部材2, qty: 1, stock: b1, length: 400, features: [{ type: groove, face: front, dir: across, pos: 200, width: 7, depth: 6, end: through }] }
`;

  it("出力ファイル集合は plan-*.svg / parts/<形状id>.svg / summary.json / schema.json だけ", () => {
    const p = writeIn("legacy", legacyYaml);
    const result = build(p, { png: false, log: silent });

    expect(fs.readdirSync(result.outDir).sort()).toEqual([
      "parts",
      "plan-A.svg",
      "plan-B.svg",
      "plan-C.svg",
      "schema.json",
      "summary.json",
    ]);
    // 変種面は1枚も出ない（形状ごとに1面という従来規則のまま）。
    expect(partsSvgNames(result.partsDir)).toEqual(["p1.svg", "p2.svg"]);
  });

  it("summary.json に assemblies キーが現れない（空配列も出さない）", () => {
    const p = writeIn("legacy-summary", legacyYaml);
    const result = build(p, { png: false, log: silent });

    const raw = JSON.parse(readText(result.summaryPath)) as Record<string, unknown>;
    expect("assemblies" in raw).toBe(false);
    expect(result.summary.assemblies).toBeUndefined();
  });

  it("加工指示図 SVG に marks 由来の要素（pattern / defs / mark）が一切入らない", () => {
    const p = writeIn("legacy-svg", legacyYaml);
    const result = build(p, { png: false, log: silent });

    for (const name of partsSvgNames(result.partsDir)) {
      const svg = readText(path.join(result.partsDir, name));
      expect(svg).not.toContain("<defs");
      expect(svg).not.toContain("<pattern");
      expect(svg).not.toContain('data-role="mark"');
      expect(svg).not.toContain("取り付け位置");
    }
  });

  it("assemblies を足してもマークが無ければ加工指示図は1バイトも変わらない", () => {
    // 「assemblies の導入それ自体」が図面を動かさないことの担保
    // （SPECS §4c:211「構成の区別が木取り図・歩留まりに影響することはない」）。
    const withAssemblies = `
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
settings: { kerf: 3, edgeTrim: 5, exact: off, selectedPlan: null }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }
parts:
  - { id: p1, label: 部材1, stock: b1, length: 800 }
  - { id: p2, label: 部材2, stock: b1, length: 400, features: [{ type: groove, face: front, dir: across, pos: 200, width: 7, depth: 6, end: through }] }
assemblies:
  - { id: a1, label: 組1, contains: { p1: 2, p2: 1 } }
`;
    const legacy = build(writeIn("cmpA", legacyYaml), { png: false, log: silent });
    const modern = build(writeIn("cmpB", withAssemblies), { png: false, log: silent });

    expect(partsSvgNames(modern.partsDir)).toEqual(partsSvgNames(legacy.partsDir));
    for (const name of partsSvgNames(legacy.partsDir)) {
      expect(readText(path.join(modern.partsDir, name))).toBe(
        readText(path.join(legacy.partsDir, name)),
      );
    }
    expect(readText(path.join(modern.outDir, "plan-A.svg"))).toBe(
      readText(path.join(legacy.outDir, "plan-A.svg")),
    );
  });
});

describe("build（v0.7: summary.json の assembly 内訳）", () => {
  it("assemblies 使用時は id・label・部材内訳・マーク件数を併記する", () => {
    const p = writeIn("summary", UMA_MARKED);
    const result = build(p, { png: false, log: silent });
    const summary = JSON.parse(readText(result.summaryPath)) as Summary;

    expect(summary.assemblies).toEqual([
      {
        id: "uma-1",
        label: "ウマ1号機（足が内側）",
        parts: [
          { part: "leg", label: "足", qty: 2 },
          { part: "beam-top", label: "天板", qty: 1 },
          { part: "beam-foot", label: "接地面", qty: 1 },
        ],
        markCount: 1,
      },
      {
        id: "uma-2",
        label: "ウマ2号機（互い違いに噛み合う側）",
        parts: [
          { part: "leg", label: "足", qty: 2 },
          { part: "beam-top", label: "天板", qty: 1 },
          { part: "beam-foot", label: "接地面", qty: 1 },
        ],
        markCount: 1,
      },
    ]);
  });

  it("内訳の合計は導出された parts[].qty と一致する", () => {
    const p = writeIn("summary-total", UMA_MARKED);
    const summary = build(p, { png: false, log: silent }).summary;
    const total = (partId: string): number =>
      (summary.assemblies ?? []).reduce(
        (n, a) => n + (a.parts.find((x) => x.part === partId)?.qty ?? 0),
        0,
      );
    expect(total("leg")).toBe(4);
    expect(total("beam-top")).toBe(2);
    expect(total("beam-foot")).toBe(2);
  });

  it("部材内訳は parts[] の宣言順（contains のキー順に依存しない）", () => {
    const p = writeIn("summary-order", `${UMA_STOCKS}
assemblies:
  - id: a1
    label: 逆順で書いた構成
    contains: { beam-foot: 1, beam-top: 1, leg: 2 }
`);
    const summary = build(p, { png: false, log: silent }).summary;
    expect(summary.assemblies![0].parts.map((x) => x.part)).toEqual([
      "leg",
      "beam-top",
      "beam-foot",
    ]);
  });
});
