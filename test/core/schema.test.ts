/**
 * schema.ts のテスト（Python 版 tests/test_schema.py の移植 ＋ v0.4 追加要件）。
 *
 * 対象: 生成スキーマの構造、SPECS §4 の例 YAML が（スキーマ層としては）pass
 * すること、未知キー・不正 stock 参照（enum）・負の寸法が fail すること、
 * stocks 空のとき enum が無いこと、v0.4 追加（rank / exact / selectedPlan "X" /
 * id pattern）。
 *
 * スキーマ検証の実行には loader.ts の validateAgainstSchema を使う
 * （Python 版が jsonschema の Draft202012Validator を直接使っていた箇所に対応。
 * 層1バリデータとスキーマの単一ソース性をそのまま検証できる）。
 *
 * 注意: 「SPECS 例 YAML の pass」はスキーマ層（形式検証）のみを指す。
 * side-0 の物理的な詰め込み可否（意味検証層）は loader.test.ts 側で扱う。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateAgainstSchema } from "../../src/core/loader";
import {
  DESCRIPTIONS,
  DRAFT_2020_12,
  ID_PATTERN,
  baseSchemaJson,
  buildSchema,
  buildStocksFileSchema,
  schemaJson,
  writeBaseSchema,
} from "../../src/core/schema";

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

/** conftest.py の minimal_project 相当（スキーマ層の検証対象として使う）。 */
function minimalProject(): any {
  return {
    meta: { project: "テスト棚", units: "mm", schemaVersion: "0.4" },
    settings: { kerf: 3, edgeTrim: 5, candidates: 3, selectedPlan: null },
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
      { id: "shelf-0", label: "棚板0", qty: 2, stock: "1x4-6f", length: 600 },
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
          { type: "hole", face: "front", x: 100, y: 150, dia: 4, depth: 8 },
        ],
      },
    ],
  };
}

function stockIdsOf(data: any): string[] {
  return data.stocks.map((s: any) => s.id);
}

function validate(data: any): ReturnType<typeof validateAgainstSchema> {
  return validateAgainstSchema(data, buildSchema(stockIdsOf(data)));
}

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kidori-schema-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// スキーマの構造
// ---------------------------------------------------------------------------

describe("スキーマの構造", () => {
  it("トップレベルの形（$schema / required / additionalProperties）", () => {
    const schema = buildSchema(["a", "b"]) as any;

    expect(schema.$schema).toBe(DRAFT_2020_12);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["meta", "stocks", "parts"]);
  });

  it("v0.7: assemblies は任意区画（required に入らない）", () => {
    const schema = buildSchema([]) as any;
    const assemblies = schema.properties.assemblies;

    expect(schema.required).not.toContain("assemblies");
    expect(assemblies.type).toBe("array");
    expect(assemblies.items.required).toEqual(["id", "contains"]);
    expect(assemblies.items.additionalProperties).toBe(false);
  });

  it("v0.7: contains の値は 1 以上の整数（自由キーのマップ）", () => {
    const schema = buildSchema([]) as any;
    const contains = schema.properties.assemblies.items.properties.contains;

    expect(contains.type).toBe("object");
    expect(contains.additionalProperties).toEqual({ type: "integer", minimum: 1 });
  });

  it("v0.7: marks は ref 形式と w/h 形式の oneOf（併記を弾く）", () => {
    const schema = buildSchema([]) as any;
    const marks = schema.properties.assemblies.items.properties.marks;
    const branches = marks.items.oneOf as any[];

    expect(branches).toHaveLength(2);
    expect(Object.keys(branches[0].properties)).toContain("ref");
    expect(Object.keys(branches[0].properties)).not.toContain("w");
    expect(Object.keys(branches[1].properties)).toContain("w");
    expect(Object.keys(branches[1].properties)).not.toContain("ref");
    for (const branch of branches) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required).toContain("on");
      expect(branch.required).toContain("face");
      // x/y は省略可（既定 0）。
      expect(branch.required).not.toContain("x");
      expect(branch.properties.x.default).toBe(0);
      expect(branch.properties.y.default).toBe(0);
    }
  });

  it("v0.7: parts[].qty は必須ではない（assemblies から導出できるため）", () => {
    const schema = buildSchema([]) as any;

    expect(schema.properties.parts.items.required).toEqual([
      "id",
      "label",
      "stock",
      "length",
    ]);
  });

  it("stocks が空のとき parts[].stock に enum が無い", () => {
    const schema = buildSchema([]) as any;
    const stockProp = schema.properties.parts.items.properties.stock;

    expect("enum" in stockProp).toBe(false);
    expect(stockProp.type).toBe("string");
  });

  it("stocks が非空のとき parts[].stock に enum が注入される", () => {
    const schema = buildSchema(["1x4-6f", "pine-18"]) as any;
    const stockProp = schema.properties.parts.items.properties.stock;

    expect(stockProp.enum).toEqual(["1x4-6f", "pine-18"]);
  });

  it("v0.4: settings.rank は items enum ＋ uniqueItems: true", () => {
    const schema = buildSchema([]) as any;
    const rank = schema.properties.settings.properties.rank;

    expect(rank.type).toBe("array");
    expect(rank.items.enum).toEqual(["cost", "waste", "cuts"]);
    expect(rank.uniqueItems).toBe(true);
    expect(rank.default).toEqual(["cost", "waste", "cuts"]);
  });

  it("v0.4: settings.exact は enum auto/on/off", () => {
    const schema = buildSchema([]) as any;
    const exact = schema.properties.settings.properties.exact;

    expect(exact.enum).toEqual(["auto", "on", "off"]);
    expect(exact.default).toBe("auto");
  });

  it("v0.4: selectedPlan の enum は A/B/C/X ＋ null", () => {
    const schema = buildSchema([]) as any;
    const sp = schema.properties.settings.properties.selectedPlan;

    expect(sp.anyOf).toEqual([{ type: "null" }, { enum: ["A", "B", "C", "X"] }]);
  });

  it("v0.4: stocks[].id / parts[].id に pattern がある", () => {
    const schema = buildSchema([]) as any;

    expect(schema.properties.stocks.items.properties.id.pattern).toBe(ID_PATTERN);
    expect(schema.properties.parts.items.properties.id.pattern).toBe(ID_PATTERN);
    expect(ID_PATTERN).toBe("^[A-Za-z0-9][A-Za-z0-9._-]*$");
  });
});

// ---------------------------------------------------------------------------
// スキーマ検証（validateAgainstSchema 経由）
// ---------------------------------------------------------------------------

describe("スキーマ検証", () => {
  it("SPECS §4a の例 YAML はスキーマ層を pass する", () => {
    const raw = parse(SPECS_EXAMPLE_YAML);
    const stockIds = raw.stocks.map((s: any) => s.id);

    expect(validateAgainstSchema(raw, buildSchema(stockIds))).toEqual([]);
  });

  it("最小プロジェクトはスキーマ層を pass する", () => {
    expect(validate(minimalProject())).toEqual([]);
  });

  it("未知のトップレベルキーは fail する", () => {
    const data = minimalProject();
    data.unknownKey = "x";

    expect(validate(data)).not.toEqual([]);
  });

  it("未知の part キーは fail する", () => {
    const data = minimalProject();
    data.parts[0].extraField = 123;

    expect(validate(data)).not.toEqual([]);
  });

  it("存在しない stock 参照は enum で fail する", () => {
    const data = minimalProject();
    data.parts[0].stock = "not-a-real-stock";

    const issues = validate(data);
    expect(issues.some((i) => i.path === "parts[0].stock")).toBe(true);
  });

  it("負の部材長は fail する", () => {
    const data = minimalProject();
    data.parts[0].length = -100;

    expect(validate(data)).not.toEqual([]);
  });

  it("負の原材長は fail する", () => {
    const data = minimalProject();
    data.stocks[0].length = -1;

    expect(validate(data)).not.toEqual([]);
  });

  it("qty: 0 は fail する（exclusiveMinimum: 0）", () => {
    const data = minimalProject();
    data.parts[0].qty = 0;

    expect(validate(data)).not.toEqual([]);
  });

  it("groove/hole は各自の形にのみ一致する（oneOf）", () => {
    // groove 由来のプロパティで hole を作ると additionalProperties: false +
    // 必須不足の両方で oneOf のどちらにもマッチしないはず。
    const schema = buildSchema([]);
    const badFeature = {
      type: "hole",
      face: "front",
      dir: "across", // hole に無いキー（groove 由来）
      pos: 100,
      x: 10,
      y: 10,
      dia: 4,
    };
    const project = {
      meta: { project: "p", units: "mm", schemaVersion: "0.4" },
      stocks: [
        { id: "s1", label: "s1", kind: "sheet", length: 1000, width: 1000, thickness: 10 },
      ],
      parts: [
        {
          id: "p1",
          label: "p1",
          qty: 1,
          stock: "s1",
          length: 100,
          width: 100,
          features: [badFeature],
        },
      ],
    };

    const issues = validateAgainstSchema(project, schema);
    expect(issues.some((i) => i.path === "parts[0].features[0]")).toBe(true);
  });

  it("v0.4: rank の重複は uniqueItems で fail する", () => {
    const data = minimalProject();
    data.settings.rank = ["cost", "cost"];

    const issues = validate(data);
    expect(issues.some((i) => i.path === "settings.rank")).toBe(true);
  });

  it("v0.4: rank の許容値以外は fail する", () => {
    const data = minimalProject();
    data.settings.rank = ["speed"];

    const issues = validate(data);
    expect(issues.some((i) => i.path === "settings.rank[0]")).toBe(true);
  });

  it("v0.4: exact の許容値以外は fail する", () => {
    const data = minimalProject();
    data.settings.exact = "maybe";

    const issues = validate(data);
    expect(issues.some((i) => i.path === "settings.exact")).toBe(true);
  });

  it("v0.4: selectedPlan X はスキーマ層を pass、D は fail する", () => {
    const ok = minimalProject();
    ok.settings.selectedPlan = "X";
    expect(validate(ok)).toEqual([]);

    const bad = minimalProject();
    bad.settings.selectedPlan = "D";
    expect(validate(bad).some((i) => i.path === "settings.selectedPlan")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// schemaJson / writeSchema
// ---------------------------------------------------------------------------

describe("schemaJson / baseSchemaJson / writeBaseSchema", () => {
  it("schemaJson は末尾改行付きで buildSchema と一致する", () => {
    const text = schemaJson(["a"]);

    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(buildSchema(["a"]));
  });

  it("schemaJson は日本語をエスケープしない", () => {
    expect(schemaJson([])).toContain("鋸刃厚");
  });

  it("baseSchemaJson は動的 enum を含まない（stocks 空の buildSchema と一致）", () => {
    const parsed = JSON.parse(baseSchemaJson()) as any;

    expect(parsed).toEqual(buildSchema([]));
    expect(parsed.properties.parts.items.properties.stock.enum).toBeUndefined();
  });

  // v0.6: スキーマファイルのディスク再生成は廃止され（SPECS §4b）、書き出しは
  // `kidori init` が基底スキーマ kidori.schema.json を1回置くだけになった。
  it("writeBaseSchema は kidori.schema.json を書き出し基底スキーマと一致する", () => {
    const schemaPath = writeBaseSchema(tmpDir);

    expect(schemaPath).toBe(join(tmpDir, "kidori.schema.json"));
    expect(existsSync(schemaPath)).toBe(true);

    const written = JSON.parse(readFileSync(schemaPath, "utf-8"));
    expect(written).toEqual(buildSchema([]));
  });
});

// ---------------------------------------------------------------------------
// v0.6: stocks[].preset / stocksFile / stocksFile 参照先スキーマ
// ---------------------------------------------------------------------------

describe("v0.6: stocks[].preset", () => {
  it("preset 文字列を pass する", () => {
    const data = minimalProject();
    data.stocks[0].preset = "spf/1x4/6f";

    expect(validate(data)).toEqual([]);
  });

  it("preset にパターン制約は課さない（SPECS §8 でキーの命名体系が未確定）", () => {
    const schema = buildSchema([]) as any;
    const preset = schema.properties.stocks.items.properties.preset;

    expect(preset.type).toBe("string");
    expect(preset.minLength).toBe(1);
    expect(preset.pattern).toBeUndefined();
  });

  it("preset の空文字列は minLength で fail する", () => {
    const data = minimalProject();
    data.stocks[0].preset = "";

    expect(validate(data).some((i) => i.path === "stocks[0].preset")).toBe(true);
  });
});

describe("v0.6: stocksFile", () => {
  it("トップレベル stocksFile の文字列を pass する", () => {
    const data = minimalProject();
    data.stocksFile = "./stocks.yaml";

    expect(validate(data)).toEqual([]);
  });

  it("stocksFile が文字列でなければ fail する", () => {
    const data = minimalProject();
    data.stocksFile = 42;

    expect(validate(data).some((i) => i.path === "stocksFile")).toBe(true);
  });

  it("参照先スキーマはトップレベル stocks: リストのみを許す", () => {
    const schema = buildStocksFileSchema();

    expect(
      validateAgainstSchema(
        {
          stocks: [
            {
              id: "b1",
              label: "棒",
              kind: "bar",
              length: 1820,
              width: 89,
              thickness: 19,
            },
          ],
        },
        schema,
      ),
    ).toEqual([]);
    // stocks 欠落・多段参照（stocksFile）はいずれも構造的に弾かれる。
    expect(validateAgainstSchema({}, schema).length).toBeGreaterThan(0);
    expect(
      validateAgainstSchema({ stocks: [], stocksFile: "./more.yaml" }, schema).length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DESCRIPTIONS
// ---------------------------------------------------------------------------

describe("DESCRIPTIONS", () => {
  it("すべて非空の日本語文字列である", () => {
    expect(Object.keys(DESCRIPTIONS).length).toBeGreaterThan(0);
    for (const [key, desc] of Object.entries(DESCRIPTIONS)) {
      expect(typeof desc, key).toBe("string");
      expect(desc.trim().length, key).toBeGreaterThan(0);
      // 全角文字（日本語）を1文字以上含むことを軽く確認する。
      expect(
        [...desc].some((ch) => ch.codePointAt(0)! > 0x3000),
        `${key}: ${desc}`,
      ).toBe(true);
    }
  });

  it("v0.4 追加フィールドの説明がある", () => {
    expect(DESCRIPTIONS["settings.rank"]).toBeTruthy();
    expect(DESCRIPTIONS["settings.exact"]).toBeTruthy();
    expect(DESCRIPTIONS["settings.selectedPlan"]).toContain("X");
    expect(DESCRIPTIONS["parts.id"]).toContain("出力ファイル名");
  });

  it("groove.pos は SPECS.md の座標規約（基準端＝ローカル原点側、across=X／along=Y）を明記する", () => {
    const desc = DESCRIPTIONS["groove.pos"];
    expect(desc).toContain("部材ローカル原点側");
    expect(desc).toContain("左端からの X 座標");
    expect(desc).toContain("下端からの Y 座標");
    // 既存の情報（寸法線抽出での中心基準扱い）を落としていないこと。
    expect(desc).toContain("中心基準");
  });

  it("marks.x/y は座標規約（領域の左下角基準・省略時 0）を明記する", () => {
    for (const key of ["marks.x", "marks.y"]) {
      const desc = DESCRIPTIONS[key];
      expect(desc, key).toContain("左下角");
      expect(desc, key).toContain("部材ローカル原点側");
      expect(desc, key).toContain("省略時 0");
      // hole の x/y（中心基準）と同名で意味が異なることを警告している。
      expect(desc, key).toContain("中心基準");
    }
  });

  it("marks.ref は w/h との排他と導出規則を明記する", () => {
    const desc = DESCRIPTIONS["marks.ref"];
    expect(desc).toContain("thickness");
    expect(desc).toContain("実効幅");
    expect(desc).toContain("38×89");
    expect(desc).toContain("排他");
    // 回転接触は w/h の直接指定で書く（rotated 等の拡張は設けない）。
    expect(desc).toContain("90°");
    for (const key of ["marks.w", "marks.h"]) {
      expect(DESCRIPTIONS[key], key).toContain("排他");
    }
  });

  it("v0.7 追加フィールドの説明がある", () => {
    expect(DESCRIPTIONS["assemblies.id"]).toContain("ファイル名");
    expect(DESCRIPTIONS["assemblies.contains"]).toContain("導出");
    expect(DESCRIPTIONS["assemblies.marks"]).toContain("加工指示図");
    expect(DESCRIPTIONS["marks.on"]).toContain("contains");
    expect(DESCRIPTIONS["parts.qty"]).toContain("contains");
  });
});
