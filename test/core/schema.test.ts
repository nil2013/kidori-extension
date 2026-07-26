/**
 * schema.ts のテスト（Python 版 tests/test_schema.py の移植 ＋ v0.4 追加要件 ＋
 * U-SCHEMA: SPECS §4d ミニ式のスキーマ受理）。
 *
 * 対象: 生成スキーマの構造、SPECS §4 の例 YAML が（スキーマ層としては）pass
 * すること、未知キー・不正 stock 参照（enum）・負の寸法が fail すること、
 * stocks 空のとき enum が無いこと、v0.4 追加（rank / exact / selectedPlan "X" /
 * id pattern）、U-SCHEMA 追加（トップレベル vars 区画、式許可フィールドの
 * number|string union、リテラル限定フィールドの維持、層1/層2の責務境界）。
 *
 * スキーマ検証の実行には loader.ts の validateAgainstSchema を使う
 * （Python 版が jsonschema の Draft202012Validator を直接使っていた箇所に対応。
 * 層1バリデータとスキーマの単一ソース性をそのまま検証できる）。
 *
 * 注意: 「SPECS 例 YAML の pass」はスキーマ層（形式検証）のみを指す。
 * side-0 の物理的な詰め込み可否（意味検証層）は loader.test.ts 側で扱う。
 *
 * U-SCHEMA の層境界について（重要・報告参照）: 本ユニット時点で loader.ts の
 * 層2（意味検証）は `src/core/expr.ts` をまだ呼び出していない（U-PIPE 未着手。
 * `a83858b` のコミットメッセージ「loader への統合は行っていない（後続）」の通り）。
 * そのため、式の文法違反・未知エイリアス・文脈不適合エイリアス・vars の未定義/
 * 循環参照は、現時点では**層1でも層2でも検出されない**（layer2 に到達する前に
 * `Number(文字列)` が `NaN` になり、多くの意味検証チェックが NaN 比較で
 * silently false になるため）。このファイルの「層1/層2の責務分担」節はこの
 * 現状を実機で確認した上で明示的にロックしており、U-PIPE 実装後にこれらの
 * テストが失敗し始めることを意図した検知シグナルとして残す。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadProjectFromRaw, validateAgainstSchema } from "../../src/core/loader";
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
import { EXPR_FIELD_CAPABILITIES } from "../../src/core/expr";

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

  it("U-SCHEMA: marks の x/y は number|string の2分岐 oneOf に緩む（専用エイリアス enum ブランチは廃止）", () => {
    // SPECS §4d:245 により marks[].x/y は位置式（揃えエイリアス＋ミニ式）を受け付ける。
    // 以前の3値限定 enum ブランチ（["left","right","center"] 等）は廃止し、
    // 汎用 string ブランチに統合した。理由（D3 実機確認。下の「D3」セクション参照）:
    // enum ブランチと汎用 string ブランチを両方 oneOf に残すと、エイリアス文字列
    // （例: "center"）が両方に一致してしまい oneOf の「ちょうど1件」制約に反して
    // 逆に弾かれてしまうため。
    const schema = buildSchema([]) as any;
    const branches = schema.properties.assemblies.items.properties.marks.items.oneOf as any[];

    for (const branch of branches) {
      for (const key of ["x", "y"] as const) {
        const prop = branch.properties[key];
        expect(prop.oneOf, key).toHaveLength(2);
        expect(prop.oneOf[0].type, key).toBe("number");
        expect(prop.oneOf[0].minimum, key).toBe(0);
        expect(prop.oneOf[1].type, key).toBe("string");
        expect(prop.oneOf[1].minLength, key).toBe(1);
        expect("enum" in prop.oneOf[1], key).toBe(false);
      }
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

  it("U-SCHEMA: トップレベル vars 区画は pass する（SPECS §4d。値は number または非空文字列）", () => {
    const data = minimalProject();
    data.vars = { inset: 50, matingAllowance: "$inset + 10" };

    expect(validate(data)).toEqual([]);
  });

  it("U-SCHEMA: vars の値が number/string 以外なら層1で fail する（型のみ層1が縛る。名前の妥当性・循環・未定義参照は層2＝U-PIPE の担当）", () => {
    for (const badValue of [true, null, [1, 2], { nested: 1 }]) {
      const data = minimalProject();
      data.vars = { inset: badValue };
      expect(validate(data), JSON.stringify(badValue)).not.toEqual([]);
    }
  });

  it("U-SCHEMA: marks.x/y は center 等のエイリアス文字列を pass する（今回追加したエイリアス）", () => {
    const data = minimalProject();
    data.assemblies = [
      {
        id: "asm",
        contains: { "shelf-0": 1 },
        marks: [{ on: "shelf-0", face: "front", w: 10, h: 10, x: "center", y: "center" }],
      },
    ];
    expect(validate(data)).toEqual([]);
  });

  it("U-SCHEMA: marks.x に演算子入り文字列（ミニ式）を指定すると pass する（SPECS §4d。文法の権威は層2）", () => {
    const data = minimalProject();
    data.assemblies = [
      {
        id: "asm",
        contains: { "shelf-0": 1 },
        marks: [{ on: "shelf-0", face: "front", w: 10, h: 10, x: "right - 40", y: 0 }],
      },
    ];

    expect(validate(data)).toEqual([]);
  });

  it("U-SCHEMA: marks.x に $ 変数参照を指定すると pass する（SPECS §4d。vars 参照の解決は層2＝U-PIPE の担当）", () => {
    const data = minimalProject();
    data.assemblies = [
      {
        id: "asm",
        contains: { "shelf-0": 1 },
        marks: [{ on: "shelf-0", face: "front", w: 10, h: 10, x: "$inset", y: 0 }],
      },
    ];

    expect(validate(data)).toEqual([]);
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
// U-SCHEMA: 式許可フィールド（SPECS §4d:244-245。EXPR_FIELD_CAPABILITIES が単一ソース）
// ---------------------------------------------------------------------------

describe("U-SCHEMA: 式許可フィールドは number|string の oneOf に緩む（D1: 数値ブランチの制約は維持）", () => {
  // minimalProject().parts[1]（side-0）は sheet 部材で width・groove・hole を
  // 持つため、これを使い回して各フィールドへ値を設定する。
  const cases: { label: string; set: (data: any, value: unknown) => void }[] = [
    { label: "settings.kerf", set: (d, v) => (d.settings.kerf = v) },
    { label: "settings.edgeTrim", set: (d, v) => (d.settings.edgeTrim = v) },
    { label: "stocks[].length", set: (d, v) => (d.stocks[0].length = v) },
    { label: "stocks[].width", set: (d, v) => (d.stocks[0].width = v) },
    { label: "stocks[].thickness", set: (d, v) => (d.stocks[0].thickness = v) },
    { label: "parts[].length", set: (d, v) => (d.parts[1].length = v) },
    { label: "parts[].width", set: (d, v) => (d.parts[1].width = v) },
    { label: "groove.pos", set: (d, v) => (d.parts[1].features[0].pos = v) },
    { label: "groove.width", set: (d, v) => (d.parts[1].features[0].width = v) },
    { label: "groove.depth", set: (d, v) => (d.parts[1].features[0].depth = v) },
    { label: "groove.from", set: (d, v) => (d.parts[1].features[0].from = v) },
    { label: "groove.to", set: (d, v) => (d.parts[1].features[0].to = v) },
    { label: "hole.x", set: (d, v) => (d.parts[1].features[1].x = v) },
    { label: "hole.y", set: (d, v) => (d.parts[1].features[1].y = v) },
    { label: "hole.dia", set: (d, v) => (d.parts[1].features[1].dia = v) },
  ];

  for (const { label, set } of cases) {
    it(`${label}: 数値のほか文字列式（"$a + $b"）を pass する`, () => {
      const data = minimalProject();
      set(data, "$a + $b");
      expect(validate(data), label).toEqual([]);
    });

    it(`${label}: 負の数値リテラルは引き続き fail する（D1）`, () => {
      const data = minimalProject();
      set(data, -100);
      expect(validate(data), label).not.toEqual([]);
    });
  }

  it("marks[].w / marks[].h: 数値のほか文字列式を pass し、負のリテラルは引き続き fail する", () => {
    function withMark(w: unknown, h: unknown): any {
      const data = minimalProject();
      data.assemblies = [
        {
          id: "asm",
          contains: { "shelf-0": 1 },
          marks: [{ on: "shelf-0", face: "front", w, h, x: 0, y: 0 }],
        },
      ];
      return data;
    }

    expect(validate(withMark("$a + $b", "$c - 1"))).toEqual([]);
    expect(validate(withMark(-1, 10))).not.toEqual([]);
    expect(validate(withMark(10, -1))).not.toEqual([]);
  });

  it("hole.depth: null（省略時の意味）・数値・文字列式のいずれも pass し、負のリテラルは fail する", () => {
    const okNull = minimalProject();
    okNull.parts[1].features[1].depth = null;
    expect(validate(okNull)).toEqual([]);

    const okExpr = minimalProject();
    okExpr.parts[1].features[1].depth = "$a + $b";
    expect(validate(okExpr)).toEqual([]);

    const bad = minimalProject();
    bad.parts[1].features[1].depth = -5;
    expect(validate(bad)).not.toEqual([]);
  });
});

describe("U-SCHEMA: D3（oneOf と既存の最小バリデータの相互作用。実機確認）", () => {
  it("stocks[].length: 負のリテラルは0件一致で oneOf の1エラーのみになる（exclusiveMinimum の個別メッセージと重複しない）", () => {
    const data = minimalProject();
    data.stocks[0].length = -5;
    const issues = validate(data);
    const forThisPath = issues.filter((i) => i.path === "stocks[0].length");

    expect(forThisPath).toHaveLength(1);
    expect(forThisPath[0].message).toContain("排他的な形式のいずれにも一致しません");
  });

  it("stocks[].length: 有効な文字列式は数値ブランチの exclusiveMinimum を経由せず素通りする（二重診断なし）", () => {
    const data = minimalProject();
    data.stocks[0].length = "$a + $b";
    expect(validate(data)).toEqual([]);
  });

  it("stocks[].length: 数値でも文字列でもない値（boolean）は0件一致で fail する", () => {
    const data = minimalProject();
    data.stocks[0].length = true;
    expect(validate(data).some((i) => i.path === "stocks[0].length")).toBe(true);
  });

  it('marks.x: エイリアス文字列 "center" は number ブランチにも string ブランチにも同時一致しない（2ブランチ oneOf でちょうど1件）', () => {
    // 3ブランチ構成（number / 専用 enum / 汎用 string）だと "center" が
    // enum ブランチと string ブランチの両方に一致し oneOf の「ちょうど1件」制約
    // に反して逆に fail していた（この事故を防ぐために2ブランチへ統合した。
    // 上の「マークの x/y は number|string の2分岐 oneOf」テストと対）。
    const data = minimalProject();
    data.assemblies = [
      {
        id: "asm",
        contains: { "shelf-0": 1 },
        marks: [{ on: "shelf-0", face: "front", w: 10, h: 10, x: "center", y: 0 }],
      },
    ];
    expect(validate(data)).toEqual([]);
  });

  it('空文字列は層1で fail する（string ブランチの minLength: 1 により、空の式は最初の文字すら無いため両ブランチ0件一致になる）', () => {
    const data = minimalProject();
    data.stocks[0].length = "";
    expect(validate(data).some((i) => i.path === "stocks[0].length")).toBe(true);
  });
});

describe("U-SCHEMA: リテラル限定フィールドは式（文字列）を層1で fail する（SPECS §4d:246）", () => {
  it("stocks[].price に式文字列を指定すると fail する", () => {
    const data = minimalProject();
    data.stocks[0].price = "$a + $b";
    expect(validate(data).some((i) => i.path === "stocks[0].price")).toBe(true);
  });

  it("parts[].qty に式文字列を指定すると fail する", () => {
    const data = minimalProject();
    data.parts[0].qty = "$a + $b";
    expect(validate(data).some((i) => i.path === "parts[0].qty")).toBe(true);
  });

  it("assemblies[].contains の個数に式文字列を指定すると fail する", () => {
    const data = minimalProject();
    data.assemblies = [{ id: "asm", contains: { "shelf-0": "$a" } }];
    expect(validate(data).some((i) => i.path === "assemblies[0].contains")).toBe(true);
  });

  it("settings.candidates に式文字列を指定すると fail する", () => {
    const data = minimalProject();
    data.settings.candidates = "$a + $b";
    expect(validate(data).some((i) => i.path === "settings.candidates")).toBe(true);
  });

  it("parts[].rot に式文字列を指定すると fail する（boolean 限定）", () => {
    const data = minimalProject();
    data.parts[1].rot = "$a";
    expect(validate(data).some((i) => i.path === "parts[1].rot")).toBe(true);
  });

  it("settings.selectedPlan に式文字列を指定すると fail する（A/B/C/X/null の enum 限定）", () => {
    const data = minimalProject();
    data.settings.selectedPlan = "$a + $b";
    expect(validate(data).some((i) => i.path === "settings.selectedPlan")).toBe(true);
  });
});

describe("U-SCHEMA: EXPR_FIELD_CAPABILITIES（expr.ts）とスキーマの union 化フィールドの対応（単一ソース照合）", () => {
  function isExprOneOf(prop: any): boolean {
    return (
      Array.isArray(prop?.oneOf) &&
      prop.oneOf.length === 2 &&
      prop.oneOf[0]?.type === "number" &&
      prop.oneOf[1]?.type === "string"
    );
  }

  it("スキーマで number|string の oneOf に緩めたフィールド集合は EXPR_FIELD_CAPABILITIES の完全列挙（vars.* を除く）と過不足なく一致する", () => {
    const schema = buildSchema([]) as any;
    const settings = schema.properties.settings.properties;
    const stock = schema.properties.stocks.items.properties;
    const part = schema.properties.parts.items.properties;
    const groove = schema.properties.parts.items.properties.features.items.oneOf[0].properties;
    const hole = schema.properties.parts.items.properties.features.items.oneOf[1].properties;
    const markRef = schema.properties.assemblies.items.properties.marks.items.oneOf[0].properties;
    const markWH = schema.properties.assemblies.items.properties.marks.items.oneOf[1].properties;

    const actual: Record<string, boolean> = {
      "settings.kerf": isExprOneOf(settings.kerf),
      "settings.edgeTrim": isExprOneOf(settings.edgeTrim),
      "stocks[].length": isExprOneOf(stock.length),
      "stocks[].width": isExprOneOf(stock.width),
      "stocks[].thickness": isExprOneOf(stock.thickness),
      "parts[].length": isExprOneOf(part.length),
      "parts[].width": isExprOneOf(part.width),
      "parts[].features[].pos": isExprOneOf(groove.pos),
      "parts[].features[].width": isExprOneOf(groove.width),
      // groove.depth 側を代表として確認する（hole.depth は null 分岐を含む特殊形
      // のため isExprOneOf の単純形にそぐわず、別テストで個別に確認済み）。
      "parts[].features[].depth": isExprOneOf(groove.depth),
      "parts[].features[].from": isExprOneOf(groove.from),
      "parts[].features[].to": isExprOneOf(groove.to),
      "parts[].features[].x": isExprOneOf(hole.x),
      "parts[].features[].y": isExprOneOf(hole.y),
      "parts[].features[].dia": isExprOneOf(hole.dia),
      "assemblies[].marks[].x": isExprOneOf(markRef.x),
      "assemblies[].marks[].y": isExprOneOf(markRef.y),
      "assemblies[].marks[].w": isExprOneOf(markWH.w),
      "assemblies[].marks[].h": isExprOneOf(markWH.h),
    };

    for (const [path, isExpr] of Object.entries(actual)) {
      expect(isExpr, path).toBe(true);
    }

    const expectedKeys = new Set(Object.keys(EXPR_FIELD_CAPABILITIES));
    expectedKeys.delete("vars.*"); // additionalProperties 側で別途表現。次のテストで確認する。
    expect(new Set(Object.keys(actual))).toEqual(expectedKeys);
  });

  it("vars.* は additionalProperties の number|string oneOf として表現されている", () => {
    const schema = buildSchema([]) as any;
    const varsValueSchema = schema.properties.vars.additionalProperties as any;

    expect(varsValueSchema.oneOf).toHaveLength(2);
    expect(varsValueSchema.oneOf[0].type).toBe("number");
    expect(varsValueSchema.oneOf[1].type).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// U-SCHEMA: 層1／層2の責務分担（現状の実装境界。報告参照）
//
// U-PIPE（loader への式解決器統合）は本ユニット時点では未着手であり、
// `src/core/expr.ts` は loader.ts から一切呼ばれていない
// （`a83858b` のコミットメッセージ「loader への統合は行っていない（後続）」）。
// そのため、以下のケースはいずれも「層1は文字列として pass させる（D2）」
// ところまでは意図どおりだが、「現状の層2（loadProjectFromRaw のフル
// パイプライン）でも検出されない」。多くの場合 `Number(文字列)` が `NaN` に
// なり、既存の意味検証チェック（`checkGroove`/`checkHole` 等）の比較が
// NaN によって静かに false になるため（NaN との比較は常に false）。
//
// これは「層2が拒否する」という当初の想定に反する実機確認済みの既知の
// ギャップであり、U-PIPE 実装によって埋まる想定である。U-PIPE 実装後は
// このブロックのテストが失敗し始めることを意図した検知シグナルとして残す
// （失敗したら、このブロックを「層2で正しく error になる」テストへ更新する）。
//
// 式のパース自体の拒否（乗除・括弧・関数・条件分岐・ドット参照・未知
// エイリアス・vars の未定義/循環参照・空式・演算子連続・末尾演算子・指数
// 表記）は `src/core/expr.ts` 単体では既に test/core/expr.test.ts（U-EXPR）が
// 固定済み。ここでの主眼は「schema/loader 境界を実際に通したときに何が
// 起きるか」であり、パーサの網羅テストを重複させることではない。
// ---------------------------------------------------------------------------

describe("U-SCHEMA: 層1／層2の責務分担（現状の実装境界。U-PIPE 未着手）", () => {
  function expectPassesLayer1AndCurrentlyUncaughtByLayer2(mutate: (data: any) => void): void {
    const data = minimalProject();
    mutate(data);

    expect(validate(data), "層1").toEqual([]);

    const { project, issues } = loadProjectFromRaw(data, {});
    expect(project, `層2（現状。issues=${JSON.stringify(issues)}）`).not.toBeNull();
  }

  it("乗算 $a * 2（SPECS §4d が明示的に禁じる構文）", () => {
    expectPassesLayer1AndCurrentlyUncaughtByLayer2((d) => (d.stocks[0].length = "$a * 2"));
  });

  it("除算 $a / 2", () => {
    expectPassesLayer1AndCurrentlyUncaughtByLayer2((d) => (d.stocks[0].length = "$a / 2"));
  });

  it("括弧 ($a + $b)", () => {
    expectPassesLayer1AndCurrentlyUncaughtByLayer2((d) => (d.stocks[0].length = "($a + $b)"));
  });

  it("関数呼び出し max($a, $b)", () => {
    expectPassesLayer1AndCurrentlyUncaughtByLayer2((d) => (d.stocks[0].length = "max($a, $b)"));
  });

  it("条件分岐（三項演算子）", () => {
    expectPassesLayer1AndCurrentlyUncaughtByLayer2(
      (d) => (d.stocks[0].length = "$a > 0 ? $a : 0"),
    );
  });

  it("ドット入り識別子（他部材フィールドの直接参照）$parts.leg.length", () => {
    // parts[1]（side-0。sheet 部材）の length に設定すると、NaN が
    // checkPhysicalFit の fits 判定（`<=` 比較。NaN は常に false）を通じて
    // 「収まらない」という**別の理由**でたまたま error になってしまい、
    // 「現状の層2は式を検出しない」という本テストの主張とは無関係の error で
    // 汚染される（実機確認済み。bar 部材の checkPhysicalFit は逆に NaN を
    // 素通りする。層により NaN の伝播先が異なり挙動が非対称なため、
    // stocks[].length を使う）。
    expectPassesLayer1AndCurrentlyUncaughtByLayer2(
      (d) => (d.stocks[0].length = "$parts.leg.length"),
    );
  });

  it('未知エイリアス "middle"（marks.x）', () => {
    expectPassesLayer1AndCurrentlyUncaughtByLayer2((d) => {
      d.assemblies = [
        {
          id: "asm",
          contains: { "shelf-0": 1 },
          marks: [{ on: "shelf-0", face: "front", w: 10, h: 10, x: "middle", y: 0 }],
        },
      ];
    });
  });

  it('文脈非依存フィールド（hole.x）へのエイリアス "center"（marks 専用のエイリアスは hole では無効）', () => {
    expectPassesLayer1AndCurrentlyUncaughtByLayer2((d) => (d.parts[1].features[1].x = "center"));
  });

  it('文脈非依存フィールド（groove.pos）へのエイリアス "left"', () => {
    expectPassesLayer1AndCurrentlyUncaughtByLayer2((d) => (d.parts[1].features[0].pos = "left"));
  });

  it('vars 内のエイリアス "right"（vars は文脈非依存式のみを許し位置エイリアス不可。かつ現状の層2は vars を一切読まない）', () => {
    expectPassesLayer1AndCurrentlyUncaughtByLayer2((d) => (d.vars = { a: "right" }));
  });

  it("未定義変数 $doesNotExist", () => {
    expectPassesLayer1AndCurrentlyUncaughtByLayer2((d) => (d.stocks[0].length = "$doesNotExist"));
  });

  it("演算子の連続 $a + + $b", () => {
    expectPassesLayer1AndCurrentlyUncaughtByLayer2((d) => (d.stocks[0].length = "$a + + $b"));
  });

  it("末尾演算子 $a +", () => {
    expectPassesLayer1AndCurrentlyUncaughtByLayer2((d) => (d.stocks[0].length = "$a +"));
  });

  it('指数表記 "1e3"（D4: expr.ts が明示的に拒否する構文）', () => {
    expectPassesLayer1AndCurrentlyUncaughtByLayer2((d) => (d.stocks[0].length = "1e3"));
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
    // 回転接触は rot: 90 で表す（v0.7 で仕様化。w/h 直接指定に頼る記述は残さない）。
    expect(desc).toContain("90°");
    expect(desc).toContain("rot: 90");
    for (const key of ["marks.w", "marks.h"]) {
      expect(DESCRIPTIONS[key], key).toContain("排他");
    }
  });

  it("marks.rot は解決順序（ref → rot → エイリアス）と rot 適用後の w/h を明記する（v0.7）", () => {
    const desc = DESCRIPTIONS["marks.rot"];
    expect(desc).toContain("0");
    expect(desc).toContain("90");
    expect(desc).toContain("ref 導出");
    expect(desc).toContain("rot 適用");
    expect(desc).toContain("エイリアス解決");
    expect(desc).toContain("入れ替わる");
  });

  it("marks.x/y は端揃えエイリアス（left/right/bottom/top）と rot 適用後の w/h 依存を明記する（v0.7）", () => {
    const descX = DESCRIPTIONS["marks.x"];
    expect(descX).toContain("left");
    expect(descX).toContain("right");
    expect(descX).toContain("rot 適用後");

    const descY = DESCRIPTIONS["marks.y"];
    expect(descY).toContain("bottom");
    expect(descY).toContain("top");
    expect(descY).toContain("rot 適用後");
  });

  it("marks.x/y は center の解決規則（矩形領域では (軸長 − w/h) / 2、軸長の 1/2 ではない）を明記する（v0.7d）", () => {
    for (const key of ["marks.x", "marks.y"]) {
      const desc = DESCRIPTIONS[key];
      expect(desc, key).toContain("center");
      // SPECS.md §4d の揃えエイリアスは marks の x/y に限定される
      // （hole.x/y・groove.pos では許可されない）。marks（矩形領域）の
      // center 解決規則が軸長の単純な 1/2 ではないことを明記する。
      expect(desc, key).toContain("矩形領域");
      expect(desc, key).toContain("/ 2");
      expect(desc, key).toContain("軸長の 1/2 ではない");
    }
  });

  it("v0.7 追加フィールドの説明がある", () => {
    expect(DESCRIPTIONS["assemblies.id"]).toContain("ファイル名");
    expect(DESCRIPTIONS["assemblies.contains"]).toContain("導出");
    expect(DESCRIPTIONS["assemblies.marks"]).toContain("加工指示図");
    expect(DESCRIPTIONS["marks.on"]).toContain("contains");
    expect(DESCRIPTIONS["parts.qty"]).toContain("contains");
  });

  it("groove.from/to は止め溝の座標規約（走行軸上の絶対座標、across=Y／along=X）を明記する（U-DOCSYNC）", () => {
    for (const key of ["groove.from", "groove.to"]) {
      const desc = DESCRIPTIONS[key];
      expect(desc, key).toContain("走行軸上の絶対座標");
      expect(desc, key).toContain("下端からの Y 座標");
      expect(desc, key).toContain("左端からの X 座標");
      expect(desc, key).toContain("0 ≤ from < to");
      expect(desc, key).toContain("走行軸の面寸法");
      // through への from/to 併記がエラーであることも落とさない。
      expect(desc, key).toContain("through");
      expect(desc, key).toContain("エラー");
    }
  });

  it("groove.face/marks.face/hole.face は SPECS §4a の front 定義（幅広の加工基準面。木表そのものではない）を明記する（U-DOCSYNC ＋ U-SCHEMA でhole.faceを追随）", () => {
    for (const key of ["groove.face", "marks.face", "hole.face"]) {
      const desc = DESCRIPTIONS[key];
      expect(desc, key).toContain("幅広の加工基準面");
      expect(desc, key).toContain("length × width");
      expect(desc, key).toContain("木表そのものではない");
      expect(desc, key).toContain("左下原点");
      // back のサポート削除・非推奨を示唆する記述を書かないこと（Supervisor 裁定済み）。
      expect(desc, key).not.toMatch(/非推奨|廃止|サポートしない|対象外/);
    }
    // 3フィールドとも既存の描画規約（front=実線、back=隠れ線の破線）を落としていない。
    expect(DESCRIPTIONS["groove.face"]).toContain("隠れ線規約");
    expect(DESCRIPTIONS["marks.face"]).toContain("隠れ線規約");
    expect(DESCRIPTIONS["hole.face"]).toContain("隠れ線規約");
    // hole.face は marks.face と同じ粒度（groove.face の「実線＋薄塗り」ではなく
    // 「実線」のみ）で揃える（U-SCHEMA タスク(4)。git show a736b21 で groove/marks
    // に付けた書きぶりのうち、marks.face 側の粒度に合わせた）。
    expect(DESCRIPTIONS["hole.face"]).toBe(DESCRIPTIONS["marks.face"]);
  });

  it("marks.ref は「木口寸法」に追随し、w/h の実際の割り当ては変えていない（U-DOCSYNC）", () => {
    const desc = DESCRIPTIONS["marks.ref"];
    expect(desc).toContain("木口寸法");
    expect(desc).toContain("width × thickness");
    // 旧用語「断面寸法」への言及は残さない。
    expect(desc).not.toContain("断面寸法");
    // w/h の割り当て（rot: 0 は thickness/width）自体は変更しない。
    expect(desc).toContain("thickness");
    expect(desc).toContain("実効幅");
    expect(desc).toContain("38×89");
  });

  it("U-SCHEMA: 式許可フィールドの description は式が使えることを明記する（SPECS §4b:189 の機械可読な足場）", () => {
    const contextFreeKeys = [
      "settings.kerf",
      "settings.edgeTrim",
      "stocks.length",
      "stocks.width",
      "stocks.thickness",
      "parts.length",
      "parts.width",
      "groove.pos",
      "groove.width",
      "groove.depth",
      "groove.from",
      "groove.to",
      "hole.x",
      "hole.y",
      "hole.dia",
      "hole.depth",
      "marks.w",
      "marks.h",
    ];
    for (const key of contextFreeKeys) {
      const desc = DESCRIPTIONS[key];
      expect(desc, key).toContain("$vars");
      expect(desc, key).toContain("SPECS §4d");
    }
    // marks.x/y は位置式（揃えエイリアス＋ミニ式）。既存のエイリアス説明に加え、
    // $vars・ミニ式が使えることも明記する。
    for (const key of ["marks.x", "marks.y"]) {
      const desc = DESCRIPTIONS[key];
      expect(desc, key).toContain("$vars");
      expect(desc, key).toContain("SPECS §4d");
    }
  });

  it("U-SCHEMA: vars の description は SPECS §4:156・§4d:257 の内容（共有設計値・$参照・同一ファイル内限定・位置エイリアス不可・循環/未定義エラー）を反映する", () => {
    const desc = DESCRIPTIONS["vars"];
    expect(desc).toContain("名前付き設計値");
    expect(desc).toContain("$変数名");
    expect(desc).toContain("同一ファイル内");
    expect(desc).toContain("位置エイリアス");
    expect(desc).toContain("循環参照");
    expect(desc).toContain("未定義参照");
  });
});
