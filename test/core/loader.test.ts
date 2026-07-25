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
import {
  SUPPORTED_SCHEMA_VERSION,
  extractStockIds,
  loadProject,
  loadProjectFromRaw,
  readRaw,
} from "../../src/core/loader";
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
meta: { project: 書棚, units: mm, schemaVersion: "0.4" }

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
    meta: { project: "テスト棚", units: "mm", schemaVersion: "0.4" },
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
  it("想定バージョンは 0.4（SPECS.md v0.7）", () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe("0.4");
  });

  it("0.4 は warning を出さない", () => {
    const data = minimalProject();
    data.meta.schemaVersion = "0.4";

    const { issues } = loadProjectFromRaw(data);
    expect(issues.some((i) => i.path === "meta.schemaVersion")).toBe(false);
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
