/**
 * loader.ts のテスト（Python 版 tests/test_loader.py の移植 ＋ v0.4 追加要件）。
 *
 * 構成:
 * - 基本の読込（YAML/JSON、raw 読込の型エラー）
 * - SPECS §4 の例 YAML が意味検証層で物理的事前チェック（項目3）に引っかかること
 * - §10 項目2: 詰め込み可否境界（bar の length == L-2e / +0.1、sheet の
 *   「回転すれば入る」部材の rot:false/true）
 * - 意味検証9項目（設計正本 §2 層2）それぞれに対応するテスト
 * - v0.4 追加: settings.rank / settings.exact / selectedPlan "X" / ID 安全性
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stringify } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectError } from "../../src/core/errors";
import { layoutFingerprint } from "../../src/core/fingerprint";
import {
  SUPPORTED_SCHEMA_VERSION,
  extractStockIds,
  loadProject,
  loadProjectFromRaw,
  readRaw,
} from "../../src/core/loader";
import { resolveMarks } from "../../src/core/marks";
import { DEFAULT_RANK, Groove } from "../../src/core/types";

const EDGE_TRIM = 5;
const BAR_LENGTH = 1820; // minimalProject の "1x4-6f" stock
const BAR_LIMIT = BAR_LENGTH - 2 * EDGE_TRIM; // 1810

/**
 * SPECS.md §4a に掲載されている例 YAML（verbatim、改変なし）。
 *
 * 注意: この例は JSON Schema（形式）検証は通るが、side-0（stock: pine-18,
 * length: 1985）は pine-18 の length（1820）を超えており、かつ rot: false の
 * ため回転による救済もできない。物理的事前チェック（項目3）により
 * loadProject は ProjectError を送出する（意図した挙動）。
 */
const SPECS_EXAMPLE_YAML = `\
# yaml-language-server: $schema=./kidori.schema.json
meta: { project: 書棚, units: mm, schemaVersion: "0.5" }

settings:
  kerf: 3            # 鋸刃厚（mm）
  edgeTrim: 5        # 木口の捨て代（mm）
  candidates: 3
  rank: [cost, waste, cuts]   # 推奨案の評価優先順
  exact: auto        # 小規模時は厳密探索（auto/on/off）
  selectedPlan: null

stocks:
  # preset: 補完確定時に挿入される規格材マスタの来歴キー（ビルドは読まない。§4b）
  - { id: 1x4-6f,  preset: spf/1x4/6f, label: "1×4材 6F", kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }
  - { id: pine-18, label: "パイン集成材18mm", kind: sheet, length: 1820, width: 910, thickness: 18, price: 6356 }

parts:
  - id: side-0
    label: 側板0
    qty: 1
    stock: pine-18   # ← stocks の id が補完候補になる（§4b）
    length: 1985
    width: 200
    rot: false
    features:
      - { type: groove, face: front, dir: across, pos: 248, width: 7, depth: 6, end: through }
      - { type: hole,   face: front, x: 100, y: 320, dia: 4, depth: 8 }
`;

/** 物理的に整合する最小の正当プロジェクト（conftest.py の minimal_project 相当）。 */
function minimalProject(): any {
  return {
    meta: { project: "テスト棚", units: "mm", schemaVersion: "0.5" },
    settings: {
      kerf: 3,
      edgeTrim: 5,
      candidates: 3,
      selectedPlan: null,
    },
    stocks: [
      {
        id: "1x4-6f",
        label: "1×4材 6F",
        kind: "bar",
        length: 1820,
        width: 89,
        thickness: 19,
        price: 382,
      },
      {
        id: "ply-12",
        label: "合板12mm",
        kind: "sheet",
        length: 1820,
        width: 910,
        thickness: 12,
        price: 3000,
      },
    ],
    parts: [
      {
        id: "shelf-0",
        label: "棚板0",
        qty: 2,
        stock: "1x4-6f",
        length: 600,
      },
      {
        id: "side-0",
        label: "側板0",
        qty: 1,
        stock: "ply-12",
        length: 800,
        width: 300,
        rot: true,
        features: [
          {
            type: "groove",
            face: "front",
            dir: "across",
            pos: 248,
            width: 7,
            depth: 6,
            end: "through",
          },
          {
            type: "hole",
            face: "front",
            x: 100,
            y: 150,
            dia: 4,
            depth: 8,
          },
        ],
      },
    ],
  };
}

let tmpDir: string;
let fileCounter = 0;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kidori-loader-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeYaml(data: unknown): string {
  const path = join(tmpDir, `project-${fileCounter++}.yaml`);
  writeFileSync(path, stringify(data), "utf-8");
  return path;
}

function writeJson(data: unknown): string {
  const path = join(tmpDir, `project-${fileCounter++}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  return path;
}

function writeText(text: string, ext = ".yaml"): string {
  const path = join(tmpDir, `project-${fileCounter++}${ext}`);
  writeFileSync(path, text, "utf-8");
  return path;
}

/** loadProject が ProjectError を投げることを確認し、その例外を返す。 */
function loadProjectError(path: string): ProjectError {
  try {
    loadProject(path);
  } catch (e) {
    if (e instanceof ProjectError) {
      return e;
    }
    throw e;
  }
  throw new Error("ProjectError が送出されませんでした");
}

// ---------------------------------------------------------------------------
// 基本の読込
// ---------------------------------------------------------------------------

describe("基本の読込", () => {
  it("最小プロジェクトが issue なしで読み込める", () => {
    const path = writeYaml(minimalProject());
    const { project, warnings } = loadProject(path);

    expect(warnings).toEqual([]);
    expect(project.meta.project).toBe("テスト棚");
    expect(project.stocks).toHaveLength(2);
    expect(project.parts).toHaveLength(2);
    expect(project.parts[0].id).toBe("shelf-0");
    expect(project.parts[0].qty).toBe(2);
    expect((project.parts[1].features[0] as Groove).pos).toBe(248);
  });

  it("JSON 入力も受理する", () => {
    const path = writeJson(minimalProject());
    const { project, warnings } = loadProject(path);

    expect(warnings).toEqual([]);
    expect(project.stocks).toHaveLength(2);
  });

  it("トップレベルが配列の場合は ProjectError", () => {
    const path = writeText("- 1\n- 2\n");
    expect(() => loadProject(path)).toThrow(ProjectError);
  });

  it("SPECS §4a の例 YAML は物理的事前チェック（項目3）で error になる", () => {
    const path = writeText(SPECS_EXAMPLE_YAML);
    const err = loadProjectError(path);

    expect(err.issues.some((i) => i.path === "parts[0].length")).toBe(true);
    expect(err.issues.some((i) => i.message.includes("収まりません"))).toBe(true);
  });

  it("readRaw は空ファイルを空オブジェクトとして返す", () => {
    const path = writeText("");
    expect(readRaw(path)).toEqual({});
  });

  it("readRaw は YAML 構文エラーをそのまま伝播する", () => {
    const path = writeText("meta: {project: [unclosed\n");
    expect(() => readRaw(path)).toThrow();
  });

  it("readRaw は JSON 構文エラーをそのまま伝播する", () => {
    const path = writeText("{ broken", ".json");
    expect(() => readRaw(path)).toThrow();
  });
});

describe("loadProjectFromRaw の契約", () => {
  it("error があれば project は null", () => {
    const data = minimalProject();
    data.meta.units = "cm";
    const { project, issues } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(issues.some((i) => i.severity === "error")).toBe(true);
  });

  it("warning のみなら project が返り issues に warning が含まれる", () => {
    const data = minimalProject();
    data.meta.schemaVersion = "0.1";
    const { project, issues } = loadProjectFromRaw(data);

    expect(project).not.toBeNull();
    expect(issues.some((i) => i.severity === "warning")).toBe(true);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
  });

  it("トップレベルが非オブジェクトなら <root> の error", () => {
    const { project, issues } = loadProjectFromRaw([1, 2]);

    expect(project).toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("<root>");
  });

  it("null は空オブジェクト扱い（必須キー不足の error になる）", () => {
    const { project, issues } = loadProjectFromRaw(null);

    expect(project).toBeNull();
    expect(issues.some((i) => i.message.includes("必須キー"))).toBe(true);
  });
});

describe("extractStockIds", () => {
  it("正常な raw から id を抽出する", () => {
    expect(extractStockIds(minimalProject())).toEqual(["1x4-6f", "ply-12"]);
  });

  it("stocks が配列でなければ空", () => {
    expect(extractStockIds({ stocks: "broken" })).toEqual([]);
    expect(extractStockIds(null)).toEqual([]);
    expect(extractStockIds("x")).toEqual([]);
  });

  it("型が不正な要素は無視して読み取れるものだけ集める", () => {
    const raw = { stocks: [{ id: "a" }, "junk", { id: 42 }, { label: "no-id" }, { id: "b" }] };
    expect(extractStockIds(raw)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// §10 項目2: 詰め込み可否境界
// ---------------------------------------------------------------------------

describe("詰め込み可否境界", () => {
  it("bar の length が L-2e ちょうどなら valid", () => {
    const data = minimalProject();
    data.parts[0].length = BAR_LIMIT; // 1810 == L - 2e ちょうど

    const path = writeYaml(data);
    const { project, warnings } = loadProject(path);

    expect(warnings).toEqual([]);
    expect(project.parts[0].length).toBe(BAR_LIMIT);
  });

  it("bar の length が 0.1mm 超過なら error", () => {
    const data = minimalProject();
    data.parts[0].length = BAR_LIMIT + 0.1;

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.path === "parts[0].length")).toBe(true);
  });

  it("回転すれば入る部材でも rot:false なら error", () => {
    // ply-12: length=1820, width=910, edgeTrim=5 → Lu=1810, Wu=900
    // length=850, width=950: 無回転では w(950) > Wu(900) で不可。
    // 回転すれば w(950) <= Lu(1810) かつ l(850) <= Wu(900) で可能。
    const data = minimalProject();
    data.parts = [
      {
        id: "rot-test",
        label: "回転テスト",
        qty: 1,
        stock: "ply-12",
        length: 850,
        width: 950,
        rot: false,
      },
    ];

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.path === "parts[0].length")).toBe(true);
  });

  it("回転すれば入る部材は rot:true なら valid", () => {
    const data = minimalProject();
    data.parts = [
      {
        id: "rot-test",
        label: "回転テスト",
        qty: 1,
        stock: "ply-12",
        length: 850,
        width: 950,
        rot: true,
      },
    ];

    const path = writeYaml(data);
    const { project, warnings } = loadProject(path);

    expect(warnings).toEqual([]);
    expect(project.parts[0].rot).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 意味検証9項目（設計正本 §2 層2）
// ---------------------------------------------------------------------------

describe("項目1: id の重複", () => {
  it("stocks[].id の重複は error", () => {
    const data = minimalProject();
    data.stocks[1].id = data.stocks[0].id;
    // stock 参照が壊れないよう parts 側も揃える
    for (const p of data.parts) {
      p.stock = data.stocks[0].id;
      delete p.width;
    }

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.message.includes("重複"))).toBe(true);
  });

  it("parts[].id の重複は error", () => {
    const data = minimalProject();
    data.parts[1].id = data.parts[0].id;

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.message.includes("重複"))).toBe(true);
  });
});

describe("項目2: parts[].stock の参照整合", () => {
  it("stocks が空のとき（enum なしスキーマ）でも意味検証層が参照エラーを出す", () => {
    // stocks: [] だと層1に enum が注入されないため、意味検証層（権威）の
    // チェックがそのまま観測できる（Python 版の _check_stock_references 直接
    // テストに対応する、パイプライン経由の確認）。
    const data = minimalProject();
    data.stocks = [];
    data.parts = [
      { id: "p1", label: "p1", qty: 1, stock: "does-not-exist", length: 100 },
    ];

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    const refIssues = issues.filter((i) => i.path === "parts[0].stock");
    expect(refIssues).toHaveLength(1);
    expect(refIssues[0].severity).toBe("error");
    expect(refIssues[0].message).toContain("存在しない原材 id");
  });

  it("存在しない stock 参照はフルパイプラインで ProjectError（層1の enum）", () => {
    const data = minimalProject();
    data.parts[0].stock = "does-not-exist";

    expect(() => loadProject(writeYaml(data))).toThrow(ProjectError);
  });
});

// 項目3: 物理的事前チェック → 「詰め込み可否境界」テスト群でカバー済み

describe("項目4: width の整合", () => {
  it("bar 部材の width が原材幅と異なるのは error", () => {
    const data = minimalProject();
    data.parts[0].width = data.stocks[0].width + 1;

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.path === "parts[0].width")).toBe(true);
  });

  it("sheet 部材の width 欠落は error", () => {
    const data = minimalProject();
    delete data.parts[1].width;

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.path === "parts[1].width")).toBe(true);
  });
});

describe("項目5: feature 境界", () => {
  it("groove の pos が範囲外なら error", () => {
    const data = minimalProject();
    data.parts[1].features[0].pos = 800; // part.length と同値 → はみ出す

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.path === "parts[1].features[0].pos")).toBe(true);
  });

  it("hole が範囲外なら error", () => {
    const data = minimalProject();
    data.parts[1].features[1].y = 310; // eff_width(300) を超える

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.path === "parts[1].features[1].y")).toBe(true);
  });

  it("groove の depth が原材厚みを超えるのは error", () => {
    const data = minimalProject();
    data.parts[1].features[0].depth = 15; // ply-12 の thickness(12) を超える

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.path === "parts[1].features[0].depth")).toBe(true);
  });

  it("groove の depth が原材厚みと同値なら warning のみ", () => {
    const data = minimalProject();
    data.parts[1].features[0].depth = 12; // ply-12 の thickness と同値

    const { project, warnings } = loadProject(writeYaml(data));

    expect(project).not.toBeNull();
    expect(
      warnings.some(
        (i) => i.path === "parts[1].features[0].depth" && i.severity === "warning",
      ),
    ).toBe(true);
  });
});

describe("項目6: groove の end/from/to 整合", () => {
  it("end: through に from を指定すると error", () => {
    const data = minimalProject();
    data.parts[1].features[0].from = 10;

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.path === "parts[1].features[0].end")).toBe(true);
  });

  it("end: stopped で from/to 欠落は error", () => {
    const data = minimalProject();
    data.parts[1].features[0].end = "stopped";

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.path === "parts[1].features[0].end")).toBe(true);
  });

  it("end: stopped で from >= to は error", () => {
    const data = minimalProject();
    data.parts[1].features[0].end = "stopped";
    data.parts[1].features[0].from = 500;
    data.parts[1].features[0].to = 100; // from >= to で不正

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.path === "parts[1].features[0].from")).toBe(true);
  });

  it("end: stopped で正当な範囲なら valid", () => {
    const data = minimalProject();
    data.parts[1].features[0].end = "stopped";
    data.parts[1].features[0].from = 100;
    data.parts[1].features[0].to = 250; // eff_width(300) 内

    const { project, warnings } = loadProject(writeYaml(data));

    expect(warnings).toEqual([]);
    const groove = project.parts[1].features[0] as Groove;
    expect(groove.from).toBe(100);
    expect(groove.to).toBe(250);
  });
});

describe("項目7: meta", () => {
  it("units が mm 以外なら error", () => {
    const data = minimalProject();
    data.meta.units = "cm";

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.path === "meta.units")).toBe(true);
  });

  it("schemaVersion 不一致は warning のみ", () => {
    const data = minimalProject();
    data.meta.schemaVersion = "0.1";

    const { project, warnings } = loadProject(writeYaml(data));

    expect(project).not.toBeNull();
    expect(
      warnings.some((i) => i.path === "meta.schemaVersion" && i.severity === "warning"),
    ).toBe(true);
  });
});

describe("項目8: selectedPlan と candidates", () => {
  it("selectedPlan が candidates 範囲外なら error", () => {
    const data = minimalProject();
    data.settings.candidates = 1;
    data.settings.selectedPlan = "B"; // candidates=1 なら "A" のみ有効

    const err = loadProjectError(writeYaml(data));
    expect(err.issues.some((i) => i.path === "settings.selectedPlan")).toBe(true);
  });

  it("candidates が範囲外なら warning のみ", () => {
    const data = minimalProject();
    data.settings.candidates = 5;

    const { project, warnings } = loadProject(writeYaml(data));

    expect(project).not.toBeNull();
    expect(
      warnings.some((i) => i.path === "settings.candidates" && i.severity === "warning"),
    ).toBe(true);
  });
});

describe("項目9: bar 部材への rot 指定", () => {
  it("bar 部材に rot を指定すると warning のみ", () => {
    const data = minimalProject();
    data.parts[0].rot = true; // shelf-0 は bar 部材

    const { project, warnings } = loadProject(writeYaml(data));

    expect(project).not.toBeNull();
    expect(
      warnings.some((i) => i.path === "parts[0].rot" && i.severity === "warning"),
    ).toBe(true);
  });

  it("rot 未指定の bar 部材に warning は出ない", () => {
    const { warnings } = loadProject(writeYaml(minimalProject()));
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v0.4 追加要件
// ---------------------------------------------------------------------------

describe("v0.4: settings.rank", () => {
  it("省略時は DEFAULT_RANK のコピーになる", () => {
    const { project } = loadProjectFromRaw(minimalProject());

    expect(project).not.toBeNull();
    expect(project!.settings.rank).toEqual(DEFAULT_RANK);
    expect(project!.settings.rank).not.toBe(DEFAULT_RANK); // 同一参照ではない
  });

  it("正当な部分配列・並べ替えを受理する", () => {
    const data = minimalProject();
    data.settings.rank = ["cuts", "cost"];

    const { project, issues } = loadProjectFromRaw(data);

    expect(issues).toEqual([]);
    expect(project!.settings.rank).toEqual(["cuts", "cost"]);
  });

  it("許容値以外は error", () => {
    const data = minimalProject();
    data.settings.rank = ["cost", "yield"];

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(issues.some((i) => i.path === "settings.rank[1]")).toBe(true);
  });

  it("重複は error", () => {
    const data = minimalProject();
    data.settings.rank = ["cost", "cost"];

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(issues.some((i) => i.path === "settings.rank")).toBe(true);
  });

  it("空配列は error", () => {
    const data = minimalProject();
    data.settings.rank = [];

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(
      issues.some((i) => i.path === "settings.rank" && i.message.includes("空配列")),
    ).toBe(true);
  });
});

describe("v0.4: settings.exact", () => {
  it("省略時は auto", () => {
    const { project } = loadProjectFromRaw(minimalProject());
    expect(project!.settings.exact).toBe("auto");
  });

  it("on / off を受理する", () => {
    for (const mode of ["on", "off"] as const) {
      const data = minimalProject();
      data.settings.exact = mode;

      const { project, issues } = loadProjectFromRaw(data);

      expect(issues).toEqual([]);
      expect(project!.settings.exact).toBe(mode);
    }
  });

  it("許容値以外は error", () => {
    const data = minimalProject();
    data.settings.exact = "always";

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(issues.some((i) => i.path === "settings.exact")).toBe(true);
  });
});

describe("v0.4: selectedPlan X", () => {
  it("exact: on で selectedPlan: X は valid", () => {
    const data = minimalProject();
    data.settings.exact = "on";
    data.settings.selectedPlan = "X";

    const { project, issues } = loadProjectFromRaw(data);

    expect(issues).toEqual([]);
    expect(project!.settings.selectedPlan).toBe("X");
  });

  it("exact: auto（省略時）でも selectedPlan: X は valid", () => {
    const data = minimalProject();
    data.settings.selectedPlan = "X";

    const { issues } = loadProjectFromRaw(data);
    expect(issues).toEqual([]);
  });

  it("exact: off で selectedPlan: X は error", () => {
    const data = minimalProject();
    data.settings.exact = "off";
    data.settings.selectedPlan = "X";

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(
      issues.some(
        (i) =>
          i.path === "settings.selectedPlan" &&
          i.message.includes("厳密探索案 X は生成されません"),
      ),
    ).toBe(true);
  });

  it("X は candidates 範囲検証の対象外", () => {
    const data = minimalProject();
    data.settings.candidates = 1;
    data.settings.exact = "on";
    data.settings.selectedPlan = "X";

    const { issues } = loadProjectFromRaw(data);
    expect(issues.filter((i) => i.path === "settings.selectedPlan")).toEqual([]);
  });

  it("A/B/C/X/null 以外の selectedPlan は error（層1の enum）", () => {
    const data = minimalProject();
    data.settings.selectedPlan = "D";

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(issues.some((i) => i.path === "settings.selectedPlan")).toBe(true);
  });
});

describe("v0.4: ID 安全性", () => {
  it("パストラバーサル形の parts[].id は error", () => {
    const data = minimalProject();
    data.parts[0].id = "../../evil";

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(
      issues.some(
        (i) => i.path === "parts[0].id" && i.message.includes("出力ファイル名"),
      ),
    ).toBe(true);
  });

  it("非 ASCII の stocks[].id は error", () => {
    const data = minimalProject();
    data.stocks[0].id = "側板";
    data.parts[0].stock = "側板";

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(
      issues.some(
        (i) => i.path === "stocks[0].id" && i.message.includes("出力ファイル名"),
      ),
    ).toBe(true);
  });

  it("先頭が記号の id は error", () => {
    const data = minimalProject();
    data.parts[0].id = "-shelf";

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(issues.some((i) => i.path === "parts[0].id")).toBe(true);
  });

  it("Windows 予約デバイス名は error（大文字小文字を区別しない）", () => {
    for (const id of ["con", "PRN", "aux", "NUL", "COM1", "com9", "LPT1", "lpt9"]) {
      const data = minimalProject();
      data.parts[0].id = id;

      const { project, issues } = loadProjectFromRaw(data);

      expect(project).toBeNull();
      expect(
        issues.some(
          (i) => i.path === "parts[0].id" && i.message.includes("予約デバイス名"),
        ),
      ).toBe(true);
    }
  });

  it("最初の . より前の部分で予約名を判定する", () => {
    const data = minimalProject();
    data.parts[0].id = "con.side";

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(issues.some((i) => i.path === "parts[0].id")).toBe(true);
  });

  it("予約名を接頭辞に含むだけの id は valid", () => {
    const data = minimalProject();
    data.parts[0].id = "constant";

    const { project, issues } = loadProjectFromRaw(data);

    expect(issues).toEqual([]);
    expect(project!.parts[0].id).toBe("constant");
  });

  it("英数字・ドット・ハイフン・アンダースコアの組み合わせは valid", () => {
    const data = minimalProject();
    data.parts[0].id = "a.b-c_d0";

    const { issues } = loadProjectFromRaw(data);
    expect(issues).toEqual([]);
  });
});

describe("v0.4: エラー時の警告保持", () => {
  it("ProjectError.issues には error と warning の双方を含む", () => {
    const data = minimalProject();
    data.meta.schemaVersion = "0.1"; // warning
    data.meta.units = "cm"; // error

    const err = loadProjectError(writeYaml(data));

    expect(err.issues.some((i) => i.severity === "error")).toBe(true);
    expect(err.issues.some((i) => i.severity === "warning")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v0.6: stocks[].preset / schemaVersion
// ---------------------------------------------------------------------------

describe("v0.6: stocks[].preset", () => {
  it("preset を受理して素通しする", () => {
    const data = minimalProject();
    data.stocks[0].preset = "spf/1x4/6f";

    const { project, issues } = loadProjectFromRaw(data);

    expect(issues).toEqual([]);
    expect(project!.stocks[0].preset).toBe("spf/1x4/6f");
  });

  it("preset が無ければ undefined のまま（キーを増やさない）", () => {
    const { project } = loadProjectFromRaw(minimalProject());
    expect(project!.stocks[0].preset).toBeUndefined();
  });

  it("preset があっても実値フィールドは必須のまま（ビルドは preset を解決しない）", () => {
    const data = minimalProject();
    data.stocks[0].preset = "spf/1x4/6f";
    delete data.stocks[0].length;

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(issues.some((i) => i.path === "stocks[0]" && i.severity === "error")).toBe(
      true,
    );
  });
});

describe("v0.7: SUPPORTED_SCHEMA_VERSION", () => {
  it("想定バージョンは 0.5（SPECS.md §4:123 の例／v0.7 改訂履歴。U-VER で 0.4 から引き上げ）", () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe("0.5");
  });

  it("0.5 は warning を出さない", () => {
    const data = minimalProject();
    data.meta.schemaVersion = "0.5";

    const { issues } = loadProjectFromRaw(data);
    expect(issues.some((i) => i.path === "meta.schemaVersion")).toBe(false);
  });

  it("旧版 0.4 の既存ファイルは warning 付きで読める（U-VER 後も救済経路が保たれていることの回帰確認）", () => {
    const data = minimalProject();
    data.meta.schemaVersion = "0.4";

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).not.toBeNull();
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
    expect(
      issues.some((i) => i.path === "meta.schemaVersion" && i.severity === "warning"),
    ).toBe(true);
  });

  it("旧版 0.3 の既存ファイルも warning のみでビルド可能（仕様自身の救済経路）", () => {
    const data = minimalProject();
    data.meta.schemaVersion = "0.3";

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).not.toBeNull();
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
    expect(issues.some((i) => i.path === "meta.schemaVersion")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// U-PIPE: 式解決器（src/core/expr.ts）の loader 統合
//
// test/core/expr.test.ts（U-EXPR）が保証する式パーサ・評価器単体の挙動
// （乗除・括弧・関数・条件分岐・vars の循環/未定義参照検出等）はここでは
// 再検証しない。ここでの主眼は「loader.ts が実際に expr.ts を正しく配線し、
// SPECS.md §4d:262-273 の解決順序どおりに動くか」という統合の観点。
// NaN 穴の閉鎖そのものの証拠は test/core/schema.test.ts の
// 「U-SCHEMA/U-PIPE: 層1／層2の責務分担」ブロックが担う。
// ---------------------------------------------------------------------------

describe("U-PIPE: settings/stocks/parts の式解決（既存挙動の保存つき）", () => {
  it("settings.kerf・stocks[].length・parts[].length に $vars を使った式を書ける", () => {
    const data = minimalProject();
    data.vars = { kerf: 2, barLen: 1800, shelfLen: 600 };
    data.settings.kerf = "$kerf + 1"; // 3（従来の既定値と同じにして他の検証への影響を避ける）
    data.stocks[0].length = "$barLen + 20"; // 1820（従来値と同じ）
    data.parts[0].length = "$shelfLen"; // 600（従来値と同じ）

    const { project, issues } = loadProjectFromRaw(data);

    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(project).not.toBeNull();
    expect(project!.settings.kerf).toBe(3);
    expect(project!.stocks[0].length).toBe(1820);
    expect(project!.parts[0].length).toBe(600);
  });

  it("式を一切使わない正本は従来と同一の結果になる（回帰確認）", () => {
    const { project, issues } = loadProjectFromRaw(minimalProject());

    expect(issues).toEqual([]);
    expect(project!.settings.kerf).toBe(3);
    expect(project!.settings.edgeTrim).toBe(5);
    expect(project!.stocks[0].length).toBe(1820);
    expect(project!.parts[0].length).toBe(600);
    expect(project!.parts[1].length).toBe(800);
  });

  it("loadProjectFromRaw は解決に成功した式を resolved（ResolutionTrace）として返す（D2）", () => {
    const data = minimalProject();
    data.vars = { extra: 50 };
    data.parts[0].length = "550 + $extra";

    const { project, resolved } = loadProjectFromRaw(data);

    expect(project).not.toBeNull();
    expect(resolved!["parts[0].length"]).toEqual({ expression: "550 + $extra", value: 600 });
    // vars.extra は数値直書き（文字列式ではない）なので trace には載らない
    // （resolveVars の既存契約。U-EXPR）。
    expect(resolved!["vars.extra"]).toBeUndefined();
  });

  it("loadProject も resolved を返す（ProjectError にならない正常系）", () => {
    const data = minimalProject();
    data.vars = { extra: 50 };
    data.parts[0].length = "550 + $extra";
    const path = writeYaml(data);

    const { project, resolved } = loadProject(path);

    expect(project.parts[0].length).toBe(600);
    expect(resolved["parts[0].length"]).toEqual({ expression: "550 + $extra", value: 600 });
  });
});

// ---------------------------------------------------------------------------
// U-RESOLVED-FIX: error があっても resolved を空にしない（Supervisor 裁定 D1/D2）。
//
// SPECS.md §3b:100「正常な式を含めて resolvedValues を JSON に併記する」に
// "error のないファイルに限る" という条件節は無い。従来の実装は
// `loadProjectFromRaw` の最終 return（error 分岐）が常に `resolved: {}` を
// 返していたため、error が1件でもあれば正常に解決済みの式まで全損していた
// （kidori check --resolved の主要な使用場面である「編集中＝error が常態」の
// ファイルでほぼ常に発生する）。
// ---------------------------------------------------------------------------

describe("U-PIPE D1: error（解決フェーズ到達後）があっても resolved には成功した式が残る", () => {
  it("1件の error（部材が原材に収まらない・式ではないフィールド由来）＋複数の正常な式がある場合、正常な式は trace に残る", () => {
    const data = minimalProject();
    data.settings.kerf = "1 + 2"; // 3（正常な式。従来の既定値と同じ値にして他の検証への影響を避ける）
    data.vars = { extra: 50 };
    data.parts[0].length = "550 + $extra"; // 600（正常な式。bar 1x4-6f の可用長 1810 に収まる）
    data.parts[1].length = 5000; // ply-12（1820mm）に収まらない = geometry error（式ではないので trace 対象外）

    const { project, issues, resolved } = loadProjectFromRaw(data);

    // project は従来通り null のまま（D1 は resolved の中身にだけ手を入れる。project の
    // null 化は変えない）。
    expect(project).toBeNull();
    expect(
      issues.some((i) => i.severity === "error" && i.path === "parts[1].length"),
    ).toBe(true);

    // D1 適用前はここが常に {} だった（バグ）。正常に解決された式は残るべき。
    expect(resolved!["parts[0].length"]).toEqual({ expression: "550 + $extra", value: 600 });
    expect(resolved!["settings.kerf"]).toEqual({ expression: "1 + 2", value: 3 });
  });
});

describe("U-PIPE D2: 有限性ガード（NaN の trace 漏れ防止）", () => {
  /**
   * marks[].x の位置式が、汚染経路（唯一。Supervisor のコード追跡で特定済み）を通って
   * NaN になるケース: `beam-top.length` の式解決が失敗 → `resolveMarkAxisSpans` が
   * その NaN を `xSpan` として返す → 揃えエイリアス `right`（`axisSpan - size`）が
   * NaN を計算する → `evaluateExpr` 自体は構造的に ok（alias/演算は成立している）
   * だが値が NaN。
   *
   * `y: top` は同じ mark でも `effectiveWidth`（`beam-top.length` に非依存）を軸長に
   * 使うため汚染されない対照として置く。
   */
  function markProjectWithBrokenLength(): any {
    return {
      meta: { project: "テスト治具", units: "mm", schemaVersion: SUPPORTED_SCHEMA_VERSION },
      vars: { inset: 50 },
      stocks: [
        { id: "2x4-6f", label: "2x4材", kind: "bar", length: 1820, width: 89, thickness: 38 },
      ],
      parts: [
        { id: "leg", label: "足", stock: "2x4-6f", length: 800 },
        // 根本原因: 未定義の変数参照。resolveRequiredNum は NaN を返し、issues に
        // error を1件積む（trace には載らない。既存の ok:false 分岐）。
        { id: "beam-top", label: "天板", stock: "2x4-6f", length: "$missingVar + 100" },
      ],
      assemblies: [
        {
          id: "uma-1",
          label: "ウマ",
          contains: { leg: 2, "beam-top": 1 },
          marks: [
            {
              on: "beam-top",
              face: "front",
              ref: "leg",
              x: "right - 40",
              y: "top",
              note: "test",
            },
          ],
        },
      ],
    };
  }

  it("NaN 汚染した位置式（x）は trace に載らず、汚染していない側（y）は載る", () => {
    const { project, resolved } = loadProjectFromRaw(markProjectWithBrokenLength());

    expect(project).toBeNull();
    expect(resolved!["assemblies[0].marks[0].x"]).toBeUndefined();
    expect(resolved!["assemblies[0].marks[0].y"]).toBeDefined();
    expect(Number.isFinite(resolved!["assemblies[0].marks[0].y"]!.value)).toBe(true);
  });

  it("ガードで trace をスキップしても根本原因（未定義の変数）を二重報告しない（D3）", () => {
    const { issues } = loadProjectFromRaw(markProjectWithBrokenLength());

    // 根本原因（"$missingVar" 未定義）は parts[1].length に1件だけ報告される。
    // D2 の有限性ガード（trace 書き込みの skip）自体は issues.push を一切行わない
    // （実装上、trace[path] = ... の代入を条件で囲んだだけであり、else 節に
    // issues.push は無い）ため、ここが2件以上になることはない。
    const undefinedVarErrors = issues.filter(
      (i) => i.severity === "error" && i.message.includes("$missingVar"),
    );
    expect(undefinedVarErrors).toEqual([
      {
        path: "parts[1].length",
        message: "未定義の変数です: '$missingVar'",
        severity: "error",
      },
    ]);

    // 注意（このテストではあえて検証しない既知の別経路）: 幾何フェーズの
    // checkMarksGeometry は mark.x が NaN であること自体を独立に検出し、
    // "assemblies[0].marks[0].x" に別文言（"0以上でなければ"・"面外"）の error を
    // 追加で出す。これは D1/D2 の変更前から存在する既存動作であり（git stash で
    // 変更前の loader.ts に対して同一 fixture を実行し、同じ2件が出ることを実機で
    // 確認済み）、D2 の有限性ガード（trace 書き込みの skip）が原因ではない。
    // D3 が禁じる「二重報告」は根本原因（"$missingVar" 未定義）の再報告であり、
    // 上のアサーションはそれを直接検証している。
  });
});

describe("U-PIPE D1: 解決フェーズに到達する前の早期 return では resolved は空のまま", () => {
  it("層1（JSON Schema）の enum 違反は resolved: {}（式解決フェーズに到達していない）", () => {
    const data = minimalProject();
    data.settings.selectedPlan = "D"; // 層1の enum 違反（既存テスト: 713行目付近と同じ fixture）

    const { project, resolved } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(resolved).toEqual({});
  });

  it("参照フェーズ（存在しない stock 参照）は resolved: {}（式解決フェーズに到達していない）", () => {
    const data = minimalProject();
    data.stocks = [];
    data.parts = [{ id: "p1", label: "p1", qty: 1, stock: "does-not-exist", length: 100 }];

    const { project, resolved } = loadProjectFromRaw(data);

    expect(project).toBeNull();
    expect(resolved).toEqual({});
  });
});

describe("U-PIPE D3: usedElsewhere の配線（フィールド式からのみ参照される変数）", () => {
  it("フィールド式（parts[].length）からのみ参照される変数は未使用 hint にならない", () => {
    const data = minimalProject();
    data.vars = { inset: 50 };
    data.parts[0].length = "$inset + 550"; // 600

    const { project, issues } = loadProjectFromRaw(data);

    expect(project).not.toBeNull();
    expect(
      issues.some((i) => i.severity === "hint" && i.path === "vars.inset"),
    ).toBe(false);
  });

  it("対照: フィールド式からもvars内部からも参照されない変数は hint になる", () => {
    const data = minimalProject();
    data.vars = { neverUsed: 999 };

    const { project, issues } = loadProjectFromRaw(data);

    // hint のみなので project は null にならない。
    expect(project).not.toBeNull();
    expect(
      issues.some(
        (i) =>
          i.severity === "hint" &&
          i.path === "vars.neverUsed" &&
          i.message.includes("どこからも参照されていません"),
      ),
    ).toBe(true);
  });
});

describe("U-PIPE D6: フィンガープリントは原式ではなく解決値に基づく", () => {
  it("原式を変えても解決値が同じならフィンガープリントは不変（回帰固定）", () => {
    const literal = minimalProject();
    literal.parts[0].length = 600;

    const exprVersion = minimalProject();
    exprVersion.vars = { base: 550, extra: 50 };
    exprVersion.parts[0].length = "$base + $extra"; // 600

    const { project: literalProject, issues: literalIssues } = loadProjectFromRaw(literal);
    const { project: exprProject, issues: exprIssues } = loadProjectFromRaw(exprVersion);

    expect(literalIssues.filter((i) => i.severity === "error")).toEqual([]);
    expect(exprIssues.filter((i) => i.severity === "error")).toEqual([]);
    expect(layoutFingerprint(exprProject!)).toBe(layoutFingerprint(literalProject!));
  });

  it("対照: 解決値そのものが変われば当然フィンガープリントも変わる", () => {
    const a = minimalProject();
    a.parts[0].length = 600;
    const b = minimalProject();
    b.parts[0].length = 610;

    const { project: pa } = loadProjectFromRaw(a);
    const { project: pb } = loadProjectFromRaw(b);

    expect(layoutFingerprint(pa!)).not.toBe(layoutFingerprint(pb!));
  });
});

// ---------------------------------------------------------------------------
// F1: SPECS.md §4c:228／§4d:270 の逐語条項「式の途中値が負でも最終値が有効なら
// 許可する」（幾何境界検査は最終解決値のみを判定対象とし、式の中間結果は判定
// しない）を固定する受理テスト。
//
// この条項が固定されていないと、たとえば `evaluateExpr` の各加減算ステップごと
// に「部分和が負にならないか」を検査するような誤実装（＝式評価と検査を同じ
// ループに混ぜてしまう実装）に退行しても、既存テストは気づけない。SPECS が
// わざわざ「途中値ではなく最終解決値を判定対象とする」と明記しているのは
// まさにこの誤実装を排除するためであり、受入ゲートの逆方向プローブ
// （「本当にこの逐語条項どおりに実装されているか」）に対して最も脆弱な箇所
// だった。
//
// 数値は自分で導出して確認した:
//   - "0 - 5 + 10" は文法上「同順位・左から順に評価」（SPECS.md §4d:260）なので
//     (0 - 5) + 10 = (-5) + 10 = 5。途中値 -5 は負だが最終値 5 は
//     x ≥ 0 を満たす。
//   - 対照として "0 - 5" は (0 - 5) = -5。途中値・最終値がともに -5 で、
//     最終値そのものが負のままなので error になるべき（この条項が「途中値が
//     負でも許可する」だけであって「最終値が負でも許可する」わけではないこと
//     の境界を確認する）。
// ---------------------------------------------------------------------------
describe("U-PIPE D4: marks の幾何境界検査は最終解決値のみを判定する（SPECS.md §4c:228・§4d:270 逐語）", () => {
  /** marks[].x に検査対象の式を1つだけ差し込んだ、物理的に整合する最小プロジェクト。 */
  function markGeometryProject(xExpr: string | number): any {
    return {
      meta: { project: "テスト治具", units: "mm", schemaVersion: SUPPORTED_SCHEMA_VERSION },
      stocks: [
        { id: "2x4-6f", label: "2x4材", kind: "bar", length: 1820, width: 89, thickness: 38 },
      ],
      parts: [
        { id: "leg", label: "足", stock: "2x4-6f", length: 800 },
        { id: "beam-top", label: "天板", stock: "2x4-6f", length: 850 },
      ],
      assemblies: [
        {
          id: "uma-1",
          label: "ウマ",
          contains: { leg: 2, "beam-top": 1 },
          // w/h は ref 導出を介さず直接指定し、x の解決だけに焦点を絞る。
          marks: [{ on: "beam-top", face: "front", w: 10, h: 10, x: xExpr, y: 0 }],
        },
      ],
    };
  }

  it("途中値が負でも最終値が有効（0 - 5 + 10 → 5）なら診断ゼロで受理される", () => {
    const { project, issues } = loadProjectFromRaw(markGeometryProject("0 - 5 + 10"));

    expect(issues).toEqual([]); // error/warning/hint とも0件（診断ゼロ）。
    expect(project).not.toBeNull();
    const mark = resolveMarks(project!, project!.assemblies[0])[0];
    expect(mark.x).toBe(5);
  });

  it("対照: 最終値が負（0 - 5 → -5）なら error（無条件の許可ではないことの境界確認）", () => {
    const { project, issues } = loadProjectFromRaw(markGeometryProject("0 - 5"));

    expect(project).toBeNull();
    expect(
      issues.some(
        (i) =>
          i.severity === "error" &&
          i.path === "assemblies[0].marks[0].x" &&
          i.message.includes("0以上"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D0/D4（Fable-tier Supervisor 裁定）: 式解決後の値への制約再適用（stage 8:
// checkExprFieldConstraints）。
//
// 背景（D0。最重要）: これは「負値検査」ではなく「制約の再適用＋有限性」である。
// 層1（schema.ts の数値ブランチ）は `minimum`/`exclusiveMinimum` を持つが、
// リテラルの型（number）にしか掛からない。式（string）で同じフィールドに
// 負値・ゼロ・Infinity を書くと、層1は「文字列である」ことしか見ないため素通り
// する。stage 8 はこの素通りを、式で指定されたフィールドに限って塞ぐ。
//
// テスト構成:
// - 「素通りしていた11フィールド」: EXPR_FIELD_CAPABILITIES の owner: "generic"
//   （既存 check* のいずれにも最終値の下限検査が無い）フィールド。式経由の負値が
//   本 PR で新設した checkExprFieldConstraints により error になることを確認する。
// - 「カナリア9本」: owner: "delegated"（groove.pos/from/to・hole.x/y・
//   marks[].x/y/w/h）フィールド。式経由の負値が **委譲先の既存 check 関数**
//   （checkGroove/checkHole/checkMarksGeometry）で error になることを確認し、
//   かつ checkExprFieldConstraints 側の generic メッセージが重複して出ないこと
//   も確認する（委譲が実効であることの証拠。二重診断が起きていないことの証拠）。
//
// 注意（ブリーフの前提との差分。報告で詳述）: ブリーフは D2 を「7件」としていたが、
// EXPR_FIELD_CAPABILITIES と各 check* 関数を実際に突き合わせた結果、委譲済み
// フィールドは marks[].w/h を含めて9件だった（brief の列挙自体は pos/from/to/
// hole.x/y/marks.x/y/w/h の9個を書いており、ヘッダーの「7件」という数字だけが
// 実体と一致していない）。テストは実体（9件）に合わせて9本用意する。
// ---------------------------------------------------------------------------
describe("D0/D4: 式解決後の値への制約再適用（stage 8: checkExprFieldConstraints）", () => {
  /** stage 8 の generic 検査が出すメッセージの目印（EPS 込みの境界値。D5）。 */
  const EXCLUSIVE_MARKER = "より大きい必要があります";
  const MINIMUM_MARKER = "を下回っています";
  const FINITE_MARKER = "有限の数値でなければなりません";

  function expectGenericError(
    issues: { path: string; message: string; severity: string }[],
    path: string,
    marker: string,
  ): void {
    expect(
      issues.some((i) => i.severity === "error" && i.path === path && i.message.includes(marker)),
      `path=${path} marker="${marker}" issues=${JSON.stringify(issues)}`,
    ).toBe(true);
  }

  // -------------------------------------------------------------------------
  // 素通りしていた11フィールド（D1）: 式経由の負値は stage 8 の generic 検査で
  // error になる。
  // -------------------------------------------------------------------------
  describe("素通りしていた11フィールド: 式経由の負値は error になる（D1）", () => {
    it("settings.kerf（minimum: 0）", () => {
      const data = minimalProject();
      data.settings.kerf = "0 - 5";
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expectGenericError(issues, "settings.kerf", MINIMUM_MARKER);
    });

    it("settings.edgeTrim（minimum: 0）", () => {
      const data = minimalProject();
      data.settings.edgeTrim = "0 - 5";
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expectGenericError(issues, "settings.edgeTrim", MINIMUM_MARKER);
    });

    it("stocks[].length（exclusiveMinimum: 0）", () => {
      const data = minimalProject();
      data.stocks[0].length = "5 - 100";
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expectGenericError(issues, "stocks[0].length", EXCLUSIVE_MARKER);
    });

    it("stocks[].width（exclusiveMinimum: 0）", () => {
      const data = minimalProject();
      data.stocks[0].width = "5 - 100";
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expectGenericError(issues, "stocks[0].width", EXCLUSIVE_MARKER);
    });

    it("stocks[].thickness（exclusiveMinimum: 0）", () => {
      const data = minimalProject();
      data.stocks[0].thickness = "5 - 100";
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expectGenericError(issues, "stocks[0].thickness", EXCLUSIVE_MARKER);
    });

    it("parts[].length（exclusiveMinimum: 0。ブリーフの最小再現例そのもの）", () => {
      const data = minimalProject();
      data.parts[0].length = "5 - 100";
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expectGenericError(issues, "parts[0].length", EXCLUSIVE_MARKER);
    });

    it("parts[].width（exclusiveMinimum: 0）", () => {
      const data = minimalProject();
      data.parts[1].width = "5 - 100";
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expectGenericError(issues, "parts[1].width", EXCLUSIVE_MARKER);
    });

    it("groove.width（exclusiveMinimum: 0）", () => {
      const data = minimalProject();
      data.parts[1].features[0].width = "5 - 100";
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expectGenericError(issues, "parts[1].features[0].width", EXCLUSIVE_MARKER);
    });

    it("groove.depth（exclusiveMinimum: 0。既存検査は厚み超過/同値のみで下限は無かった）", () => {
      const data = minimalProject();
      data.parts[1].features[0].depth = "5 - 100";
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expectGenericError(issues, "parts[1].features[0].depth", EXCLUSIVE_MARKER);
    });

    it("hole.dia（exclusiveMinimum: 0。負の dia は区間反転で既存境界検査をすり抜ける）", () => {
      const data = minimalProject();
      data.parts[1].features[1].dia = "5 - 100";
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expectGenericError(issues, "parts[1].features[1].dia", EXCLUSIVE_MARKER);
    });

    it("hole.depth（exclusiveMinimum: 0。既存検査は厚み超過/同値のみで下限は無かった）", () => {
      const data = minimalProject();
      data.parts[1].features[1].depth = "5 - 100";
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expectGenericError(issues, "parts[1].features[1].depth", EXCLUSIVE_MARKER);
    });
  });

  // -------------------------------------------------------------------------
  // カナリア9本（D2。実体はブリーフの「7件」ではなく9件。報告参照）: 既に委譲
  // 済みのフィールドは、式経由の負値も **委譲先の既存 check 関数**が検出する
  // （generic 側は owner: "delegated" のため何もしない＝二重診断が起きない）。
  // -------------------------------------------------------------------------
  describe("カナリア9本: 委譲済みフィールドは委譲先が検出し、generic 側は反応しない（D2）", () => {
    it("groove.pos: 占有範囲検査（checkGroove）が検出する", () => {
      const data = minimalProject();
      data.parts[1].features[0].pos = "0 - 50"; // width は既定の 7 のまま
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expect(
        issues.some(
          (i) =>
            i.severity === "error" &&
            i.path === "parts[1].features[0].pos" &&
            i.message.includes("部材範囲"),
        ),
      ).toBe(true);
      // generic 側の文言が重複していないこと。
      expect(issues.some((i) => i.message.includes(EXCLUSIVE_MARKER))).toBe(false);
    });

    it("groove.from: 止め溝の範囲検査（checkGroove）が検出する", () => {
      const data = minimalProject();
      data.parts[1].features[0].end = "stopped";
      data.parts[1].features[0].from = "0 - 10";
      data.parts[1].features[0].to = 50;
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expect(issues.some((i) => i.message.includes("止め溝の範囲"))).toBe(true);
      expect(issues.some((i) => i.message.includes(MINIMUM_MARKER))).toBe(false);
    });

    it("groove.to: 止め溝の範囲検査（checkGroove）が検出する（実装上 path は .from に載る既存の挙動）", () => {
      const data = minimalProject();
      data.parts[1].features[0].end = "stopped";
      data.parts[1].features[0].from = 0;
      data.parts[1].features[0].to = "0 - 5";
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expect(issues.some((i) => i.message.includes("止め溝の範囲"))).toBe(true);
      expect(issues.some((i) => i.message.includes(MINIMUM_MARKER))).toBe(false);
    });

    it("hole.x: 部材範囲検査（checkHole）が検出する", () => {
      const data = minimalProject();
      data.parts[1].features[1].x = "0 - 50"; // dia は既定の 4 のまま
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expect(
        issues.some(
          (i) =>
            i.severity === "error" &&
            i.path === "parts[1].features[1].x" &&
            i.message.includes("穴の位置"),
        ),
      ).toBe(true);
      expect(issues.some((i) => i.message.includes(MINIMUM_MARKER))).toBe(false);
    });

    it("hole.y: 部材範囲検査（checkHole）が検出する", () => {
      const data = minimalProject();
      data.parts[1].features[1].y = "0 - 50";
      const { project, issues } = loadProjectFromRaw(data);
      expect(project).toBeNull();
      expect(
        issues.some(
          (i) =>
            i.severity === "error" &&
            i.path === "parts[1].features[1].y" &&
            i.message.includes("穴の位置"),
        ),
      ).toBe(true);
      expect(issues.some((i) => i.message.includes(MINIMUM_MARKER))).toBe(false);
    });

    /** marks[].x/y/w/h の検査には assemblies が要る最小プロジェクト。 */
    function projectWithMark(overrides: Record<string, unknown>): any {
      const data = minimalProject();
      data.assemblies = [
        {
          id: "asm",
          contains: { "shelf-0": 1 },
          marks: [{ on: "shelf-0", face: "front", w: 10, h: 10, x: 0, y: 0, ...overrides }],
        },
      ];
      return data;
    }

    it("marks.x: 幾何境界検査（checkMarksGeometry）が検出する", () => {
      const { project, issues } = loadProjectFromRaw(projectWithMark({ x: "0 - 50" }));
      expect(project).toBeNull();
      expect(
        issues.some(
          (i) =>
            i.severity === "error" &&
            i.path === "assemblies[0].marks[0].x" &&
            i.message.includes("0以上でなければなりません"),
        ),
      ).toBe(true);
      expect(issues.some((i) => i.message.includes(MINIMUM_MARKER))).toBe(false);
    });

    it("marks.y: 幾何境界検査（checkMarksGeometry）が検出する", () => {
      const { project, issues } = loadProjectFromRaw(projectWithMark({ y: "0 - 50" }));
      expect(project).toBeNull();
      expect(
        issues.some(
          (i) =>
            i.severity === "error" &&
            i.path === "assemblies[0].marks[0].y" &&
            i.message.includes("0以上でなければなりません"),
        ),
      ).toBe(true);
      expect(issues.some((i) => i.message.includes(MINIMUM_MARKER))).toBe(false);
    });

    it("marks.w: 幾何境界検査（checkMarksGeometry）が検出する", () => {
      const { project, issues } = loadProjectFromRaw(projectWithMark({ w: "0 - 10" }));
      expect(project).toBeNull();
      expect(
        issues.some(
          (i) =>
            i.severity === "error" &&
            i.path === "assemblies[0].marks[0].w" &&
            i.message.includes("正でなければなりません"),
        ),
      ).toBe(true);
      expect(issues.some((i) => i.message.includes(EXCLUSIVE_MARKER))).toBe(false);
    });

    it("marks.h: 幾何境界検査（checkMarksGeometry）が検出する", () => {
      const { project, issues } = loadProjectFromRaw(projectWithMark({ h: "0 - 10" }));
      expect(project).toBeNull();
      expect(
        issues.some(
          (i) =>
            i.severity === "error" &&
            i.path === "assemblies[0].marks[0].h" &&
            i.message.includes("正でなければなりません"),
        ),
      ).toBe(true);
      expect(issues.some((i) => i.message.includes(EXCLUSIVE_MARKER))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 式経由のゼロ（D0 第2の穴）: exclusiveMinimum フィールドに $var（値0）を書くと
  // 従来は素通りしていた（リテラル 0 は層1が弾くが、式なら層1は文字列としてしか
  // 見ない）。
  // -------------------------------------------------------------------------
  it("式経由のゼロ: $a（vars: { a: 0 }）を exclusiveMinimum フィールドに書くと error になる", () => {
    const data = minimalProject();
    data.vars = { a: 0 };
    data.stocks[0].length = "$a";
    const { project, issues } = loadProjectFromRaw(data);
    expect(project).toBeNull();
    expectGenericError(issues, "stocks[0].length", EXCLUSIVE_MARKER);
  });

  // -------------------------------------------------------------------------
  // リテラル負値は層1で1回だけ報告される（二重診断が起きていないことの確認）。
  // 層1（schema.ts）でエラーになった場合、loadProjectFromRaw は式解決フェーズ
  // （exprFieldValues の記録・checkExprFieldConstraints の実行）に到達する前に
  // 早期リターンするため、構造的に stage 8 の generic 検査は実行されない。
  // -------------------------------------------------------------------------
  it("リテラル負値（stocks[].length = -100）は層1で1回だけ報告される", () => {
    const data = minimalProject();
    data.stocks[0].length = -100;
    const { project, issues } = loadProjectFromRaw(data);
    expect(project).toBeNull();
    const forThisPath = issues.filter((i) => i.path === "stocks[0].length");
    expect(forThisPath, JSON.stringify(issues)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Infinity（D0 第3の穴）: 巨大リテラルの和で到達可能。trace は D2 の有限性
  // ガードにより Infinity を記録しないため、対象パス収集は exprFieldValues
  // （D4）を使う必要がある。
  // -------------------------------------------------------------------------
  it("Infinity: 巨大リテラルの和が Infinity に到達すると error になる", () => {
    // Number.MAX_VALUE ≈ 1.7976931348623157e+308。1e308 単体は有限だが、
    // 1e308 + 1e308 = 2e308 は MAX_VALUE を超え、IEEE754 double では
    // Infinity に丸められる（実機確認）。指数表記 "1e308" は expr.ts の
    // lexNumber が明示的に拒否するため、10進展開した文字列で書く。
    const big = "1" + "0".repeat(308);
    expect(Number.isFinite(Number(big))).toBe(true); // 単体は有限（前提の確認）。
    expect(Number(big) + Number(big)).toBe(Infinity); // 和は Infinity（前提の確認）。

    const data = minimalProject();
    data.stocks[0].length = `${big} + ${big}`;
    const { project, issues } = loadProjectFromRaw(data);
    expect(project).toBeNull();
    expectGenericError(issues, "stocks[0].length", FINITE_MARKER);
  });
});
