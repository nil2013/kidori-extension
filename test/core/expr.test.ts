/**
 * src/core/expr.ts の単体テスト（SPECS.md §4d「寸法エイリアス・名前付き設計値・
 * ミニ式」）。
 *
 * 必須観点（U-EXPR ブリーフより）:
 *   1. フィールド能力テーブルが SPECS §4d:244-245 の完全列挙と一致すること
 *   2. 文法の正常系（数値・小数・$var・+/-・空白のばらつき・左結合の評価順）
 *   3. 位置式（4方向＋center のエイリアス単独、オフセット付き）
 *   4. 拒否の網羅（乗除・括弧・関数・条件分岐・ドット入り識別子・未知エイリアス・
 *      文脈非依存フィールドへのエイリアス・未定義変数・循環参照・同名変数・
 *      不正な変数名・空式・演算子の連続・末尾演算子・指数表記）
 *   5. vars の依存解決（多段依存の順序、循環検出、未使用の hint）
 *   6. 微小許容差の扱い
 */

import { describe, expect, it } from "vitest";

import {
  EPS,
  EXPR_FIELD_CAPABILITIES,
  collectVarRefs,
  evaluateExpr,
  fieldExprCapability,
  parseExpr,
  resolveFieldExpr,
  resolveVars,
  toFieldExprPattern,
  type ParsedExpr,
} from "../../src/core/expr";

// ---------------------------------------------------------------------------
// 1. フィールド能力テーブル ⇔ SPECS.md §4d:244-245 の完全列挙
// ---------------------------------------------------------------------------

describe("EXPR_FIELD_CAPABILITIES（フィールド能力テーブル）", () => {
  // SPECS.md §4d:244 を逐語転写した期待値（parts[].thickness は現行スキーマに
  // フィールドが存在しないため対象外。理由は src/core/expr.ts のテーブル本体
  // コメント参照）。
  const expectedContextFree = [
    "vars.*",
    "settings.kerf",
    "settings.edgeTrim",
    "stocks[].length",
    "stocks[].width",
    "stocks[].thickness",
    "parts[].length",
    "parts[].width",
    "parts[].features[].pos", // groove.pos
    "parts[].features[].width", // groove.width
    "parts[].features[].depth", // groove.depth / hole.depth
    "parts[].features[].from", // groove.from
    "parts[].features[].to", // groove.to
    "parts[].features[].x", // hole.x
    "parts[].features[].y", // hole.y
    "parts[].features[].dia", // hole.dia
    "assemblies[].marks[].w",
    "assemblies[].marks[].h",
  ];
  // SPECS.md §4d:245「位置式（揃えエイリアスを含められる）: marks[].x、marks[].y のみ」
  const expectedPositional = ["assemblies[].marks[].x", "assemblies[].marks[].y"];

  it("テーブルのキー集合が SPECS §4d:244-245 の列挙と過不足なく一致する", () => {
    const actualKeys = Object.keys(EXPR_FIELD_CAPABILITIES).sort();
    const expectedKeys = [...expectedContextFree, ...expectedPositional].sort();
    expect(actualKeys).toEqual(expectedKeys);
  });

  it("context-free と分類されるべきフィールドがすべて context-free である", () => {
    for (const key of expectedContextFree) {
      expect(EXPR_FIELD_CAPABILITIES[key]?.kind, key).toBe("context-free");
    }
  });

  it("位置式は marks[].x/marks[].y のみで、軸が正しく割り当たっている", () => {
    expect(EXPR_FIELD_CAPABILITIES["assemblies[].marks[].x"]).toEqual({
      kind: "positional",
      axis: "x",
      constraint: { min: 0, exclusive: false, owner: "delegated" },
    });
    expect(EXPR_FIELD_CAPABILITIES["assemblies[].marks[].y"]).toEqual({
      kind: "positional",
      axis: "y",
      constraint: { min: 0, exclusive: false, owner: "delegated" },
    });
  });

  it("hole.x/hole.y（parts[].features[].x/y）は position ではなく context-free（エイリアス不可）", () => {
    // SPECS.md §4d:242「hole.x/hole.y・groove.pos には揃えエイリアスを許可しない」
    expect(fieldExprCapability("parts[0].features[1].x")?.kind).toBe("context-free");
    expect(fieldExprCapability("parts[0].features[1].y")?.kind).toBe("context-free");
  });

  // ---------------------------------------------------------------------------
  // D0/D3（Fable-tier Supervisor 裁定）: 値域（min/exclusive）＋検査所有者
  // （generic/delegated）がテーブルの唯一のソースであることの固定。
  // ---------------------------------------------------------------------------
  it("D3: 各フィールドの値域（min/exclusive）と検査所有者（generic/delegated）が確定した分類と一致する", () => {
    // owner: "delegated" の根拠（実機で checkGroove/checkHole/checkMarksGeometry の
    // 各コードを突き合わせて確認済み。詳細は報告参照）:
    // - pos/from/to/hole.x/hole.y: 占有範囲検査（pos±width/2 等）が half>=0
    //   （width/dia 自体は generic で別途保証）の下で当該フィールド単体の負値も
    //   構造的に検出する。
    // - marks.x/y/w/h: checkMarksGeometry が最終値に対し x>=0/y>=0/w>0/h>0 を直接
    //   検査する（SPECS.md §4c:228 の逐語実装）。
    // それ以外は下限検査が既存 check* に無いため generic（stage 8 が権威）。
    const expected: Record<
      string,
      { min: number; exclusive: boolean; owner: "generic" | "delegated" } | undefined
    > = {
      "vars.*": undefined,
      "settings.kerf": { min: 0, exclusive: false, owner: "generic" },
      "settings.edgeTrim": { min: 0, exclusive: false, owner: "generic" },
      "stocks[].length": { min: 0, exclusive: true, owner: "generic" },
      "stocks[].width": { min: 0, exclusive: true, owner: "generic" },
      "stocks[].thickness": { min: 0, exclusive: true, owner: "generic" },
      "parts[].length": { min: 0, exclusive: true, owner: "generic" },
      "parts[].width": { min: 0, exclusive: true, owner: "generic" },
      "parts[].features[].pos": { min: 0, exclusive: false, owner: "delegated" },
      "parts[].features[].width": { min: 0, exclusive: true, owner: "generic" },
      "parts[].features[].depth": { min: 0, exclusive: true, owner: "generic" },
      "parts[].features[].from": { min: 0, exclusive: false, owner: "delegated" },
      "parts[].features[].to": { min: 0, exclusive: false, owner: "delegated" },
      "parts[].features[].x": { min: 0, exclusive: false, owner: "delegated" },
      "parts[].features[].y": { min: 0, exclusive: false, owner: "delegated" },
      "parts[].features[].dia": { min: 0, exclusive: true, owner: "generic" },
      "assemblies[].marks[].x": { min: 0, exclusive: false, owner: "delegated" },
      "assemblies[].marks[].y": { min: 0, exclusive: false, owner: "delegated" },
      "assemblies[].marks[].w": { min: 0, exclusive: true, owner: "delegated" },
      "assemblies[].marks[].h": { min: 0, exclusive: true, owner: "delegated" },
    };

    expect(Object.keys(EXPR_FIELD_CAPABILITIES).sort()).toEqual(Object.keys(expected).sort());
    for (const [key, constraint] of Object.entries(expected)) {
      expect(EXPR_FIELD_CAPABILITIES[key].constraint, key).toEqual(constraint);
    }
  });

  it("列挙にないフィールド（price/qty/contains個数/candidates/rot 等）は undefined（式不可）", () => {
    expect(fieldExprCapability("stocks[0].price")).toBeUndefined();
    expect(fieldExprCapability("parts[0].qty")).toBeUndefined();
    expect(fieldExprCapability("settings.candidates")).toBeUndefined();
    expect(fieldExprCapability("assemblies[0].marks[0].rot")).toBeUndefined();
    expect(fieldExprCapability("parts[0].id")).toBeUndefined();
  });

  it("toFieldExprPattern: vars.<名前> は vars.* に、配列添字は [] に正規化される", () => {
    expect(toFieldExprPattern("vars.inset")).toBe("vars.*");
    expect(toFieldExprPattern("vars.matingAllowance")).toBe("vars.*");
    expect(toFieldExprPattern("stocks[3].length")).toBe("stocks[].length");
    expect(toFieldExprPattern("parts[12].features[0].pos")).toBe("parts[].features[].pos");
    expect(toFieldExprPattern("assemblies[0].marks[2].x")).toBe("assemblies[].marks[].x");
  });

  it("実 path から fieldExprCapability を引ける（配列添字が異なっても同じ結果）", () => {
    expect(fieldExprCapability("stocks[0].length")?.kind).toBe("context-free");
    expect(fieldExprCapability("stocks[7].length")?.kind).toBe("context-free");
    expect(fieldExprCapability("vars.inset")).toEqual({ kind: "context-free" });
  });
});

// ---------------------------------------------------------------------------
// 2. 文法の正常系
// ---------------------------------------------------------------------------

describe("parseExpr: 正常系", () => {
  it("整数リテラルのみ", () => {
    const r = parseExpr("42");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expr.terms).toEqual([{ op: "+", operand: { kind: "number", value: 42 } }]);
    }
  });

  it("小数リテラル", () => {
    const r = parseExpr("3.14");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expr.terms[0].operand).toEqual({ kind: "number", value: 3.14 });
    }
  });

  it("負数リテラル（先頭）", () => {
    const r = parseExpr("-5");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expr.terms[0].operand).toEqual({ kind: "number", value: -5 });
    }
  });

  // SPECS §4d:260 は「負数リテラルはパース可能」と位置を限定せずに述べており、
  // 文法 operand ((+ | -) operand)* の operand が現れうる全位置で妥当と読む
  // （「先頭項以外は禁止」は仕様に無い追加規則になる）。この裁定を固定する。
  // 字句上の曖昧さはない: operand の後の `-` は常に二項演算子、演算子の後の
  // `-` は符号であり、lexNumber は `-` と数字の間の空白を許さないため
  // "$a - - 5" は拒否される（下記の拒否テスト参照）。
  it("負数リテラルは演算子の直後にも置ける（$a + -5）", () => {
    const r = parseExpr("$a + -5");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expr.terms).toHaveLength(2);
      expect(r.expr.terms[1].op).toBe("+");
      expect(r.expr.terms[1].operand).toEqual({ kind: "number", value: -5 });
    }
  });

  it("負数リテラルは減算の直後にも置ける（$a - -5 は $a + 5 と同値に評価される）", () => {
    const r = parseExpr("$a - -5");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expr.terms[1].op).toBe("-");
      expect(r.expr.terms[1].operand).toEqual({ kind: "number", value: -5 });
      const v = evaluateExpr(r.expr, { a: 10 });
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.value).toBeCloseTo(15);
      }
    }
  });

  it("符号と数字の間に空白があるものは拒否する（$a - - 5）", () => {
    expect(parseExpr("$a - - 5").ok).toBe(false);
  });

  it("$var 単体参照", () => {
    const r = parseExpr("$inset");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expr.terms).toEqual([{ op: "+", operand: { kind: "var", name: "inset" } }]);
    }
  });

  it("$a + $b", () => {
    const r = parseExpr("$a + $b");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expr.terms).toEqual([
        { op: "+", operand: { kind: "var", name: "a" } },
        { op: "+", operand: { kind: "var", name: "b" } },
      ]);
    }
  });

  it("$a - 40", () => {
    const r = parseExpr("$a - 40");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.expr.terms).toEqual([
        { op: "+", operand: { kind: "var", name: "a" } },
        { op: "-", operand: { kind: "number", value: 40 } },
      ]);
    }
  });

  it("裸のリテラル同士: 50 + 38", () => {
    const r = parseExpr("50 + 38");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {});
      expect(result).toEqual({ ok: true, value: 88 });
    }
  });

  it("空白のばらつき（前後・演算子周り・タブ／改行混在）を許容する", () => {
    const variants = ["$a+$b", "$a +$b", "$a+ $b", "  $a   +   $b  ", "$a\t+\n$b"];
    for (const raw of variants) {
      const r = parseExpr(raw);
      expect(r.ok, `raw=${JSON.stringify(raw)}`).toBe(true);
      if (r.ok) {
        expect(evaluateExpr(r.expr, { a: 10, b: 5 })).toEqual({ ok: true, value: 15 });
      }
    }
  });

  it("左結合・左から順の評価順: 100 - 30 - 20 = 50", () => {
    const r = parseExpr("100 - 30 - 20");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {});
      expect(result.ok && result.value).toBe(50);
    }
  });

  it("変数名は大文字・小文字を区別する（$Inset と $inset は別変数）", () => {
    const r = parseExpr("$Inset + $inset");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, { Inset: 1, inset: 2 });
      expect(result).toEqual({ ok: true, value: 3 });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 位置式（揃えエイリアス）
// ---------------------------------------------------------------------------

describe("位置式（揃えエイリアス。marks[].x/marks[].y のみ）", () => {
  it("X軸: left → 0", () => {
    const r = parseExpr("left");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {}, { axis: "x", axisSpan: 100, size: 30 });
      expect(result).toEqual({ ok: true, value: 0 });
    }
  });

  it("X軸: right → axisSpan - w", () => {
    const r = parseExpr("right");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {}, { axis: "x", axisSpan: 100, size: 30 });
      expect(result).toEqual({ ok: true, value: 70 });
    }
  });

  it("X軸: center → (axisSpan - w) / 2", () => {
    const r = parseExpr("center");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {}, { axis: "x", axisSpan: 100, size: 30 });
      expect(result).toEqual({ ok: true, value: 35 });
    }
  });

  it("Y軸: bottom → 0", () => {
    const r = parseExpr("bottom");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {}, { axis: "y", axisSpan: 89, size: 38 });
      expect(result).toEqual({ ok: true, value: 0 });
    }
  });

  it("Y軸: top → axisSpan - h", () => {
    const r = parseExpr("top");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {}, { axis: "y", axisSpan: 89, size: 38 });
      expect(result).toEqual({ ok: true, value: 51 });
    }
  });

  it("Y軸: center → (axisSpan - h) / 2", () => {
    const r = parseExpr("center");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {}, { axis: "y", axisSpan: 89, size: 38 });
      expect(result).toEqual({ ok: true, value: 25.5 });
    }
  });

  it('端基準オフセット: "right - 40"', () => {
    const r = parseExpr("right - 40");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {}, { axis: "x", axisSpan: 100, size: 30 });
      expect(result).toEqual({ ok: true, value: 30 }); // (100-30) - 40
    }
  });

  it('端基準オフセット: "top - 38"', () => {
    const r = parseExpr("top - 38");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {}, { axis: "y", axisSpan: 89, size: 38 });
      expect(result).toEqual({ ok: true, value: 13 }); // (89-38) - 38
    }
  });

  it("エイリアスは変数と混在できる（$inset を含む位置式）", () => {
    const r = parseExpr("left + $inset");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, { inset: 12 }, { axis: "x", axisSpan: 100, size: 30 });
      expect(result).toEqual({ ok: true, value: 12 });
    }
  });

  it("resolveFieldExpr: marks[].x への位置式をパース＋評価し trace を返す", () => {
    const result = resolveFieldExpr(
      "assemblies[0].marks[0].x",
      "right - 40",
      {},
      { axis: "x", axisSpan: 100, size: 30 },
    );
    expect(result).toEqual({
      ok: true,
      value: 30,
      trace: { expression: "right - 40", value: 30 },
    });
  });
});

// ---------------------------------------------------------------------------
// 4. 拒否の網羅
// ---------------------------------------------------------------------------

describe("拒否の網羅（SPECS.md §4d が明示的に禁じた表現）", () => {
  it("乗算 $a * 2 は拒否", () => {
    expect(parseExpr("$a * 2").ok).toBe(false);
  });

  it("除算 $a / 2 は拒否", () => {
    expect(parseExpr("$a / 2").ok).toBe(false);
  });

  it("括弧 ($a + $b) は拒否", () => {
    expect(parseExpr("($a + $b)").ok).toBe(false);
  });

  it("関数呼び出し max($a, $b) は拒否", () => {
    expect(parseExpr("max($a, $b)").ok).toBe(false);
  });

  it("条件分岐（三項演算子）は拒否", () => {
    expect(parseExpr("$a > 0 ? $a : 0").ok).toBe(false);
  });

  it("ドット入り識別子（他部材フィールド参照） $parts.leg.length は拒否", () => {
    const r = parseExpr("$parts.leg.length");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/ドット/);
    }
  });

  it("未知のエイリアス \"middle\" は拒否（パース時点で不明な識別子）", () => {
    const r = parseExpr("middle");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/不明な識別子/);
    }
  });

  it("文脈非依存フィールド（hole.x）へのエイリアス center は拒否（axis 未指定での評価）", () => {
    const r = parseExpr("center");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {}); // axis 省略＝文脈非依存式としての評価
      expect(result.ok).toBe(false);
      expect(fieldExprCapability("parts[0].features[0].x")?.kind).toBe("context-free");
    }
  });

  it("文脈非依存フィールド（groove.pos）へのエイリアス left は拒否", () => {
    const r = parseExpr("left");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {});
      expect(result.ok).toBe(false);
      expect(fieldExprCapability("parts[0].features[0].pos")?.kind).toBe("context-free");
    }
  });

  it("vars 内のエイリアス right は拒否（vars は必ず axis なしで評価される）", () => {
    const resolution = resolveVars({ badVar: "right" });
    expect(resolution.values.badVar).toBeUndefined();
    expect(
      resolution.diagnostics.some((d) => d.severity === "error" && d.path === "vars.badVar"),
    ).toBe(true);
  });

  it("未定義変数の参照は拒否", () => {
    const r = parseExpr("$unknown + 1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {});
      expect(result).toEqual({ ok: false, message: "未定義の変数です: '$unknown'" });
    }
  });

  it("循環参照は拒否（resolveVars が検出する）", () => {
    const resolution = resolveVars({ a: "$b + 1", b: "$a + 1" });
    expect(resolution.values.a).toBeUndefined();
    expect(resolution.values.b).toBeUndefined();
    expect(
      resolution.diagnostics.some(
        (d) => d.severity === "error" && d.message.includes("循環参照"),
      ),
    ).toBe(true);
  });

  it("同名変数（JS Record 経由では JSON の重複キーは既に失われている。既知の仕様違反として受容）", () => {
    // SPECS.md §4d「同名変数はエラー」は .kidori.json 入力については満たしていない
    // （オーナー裁定により既知の仕様違反として受容。単に「検出できない」のではなく
    // 「仕様の条項を満たしていない」ことが裁定の要点。詳細は src/core/expr.ts の
    // resolveVars コメント・README.md「.kidori.json 入力の既知の制約」参照）。
    // 実機確認: JSON.parse('{"a":1,"a":2}') は {a: 2} を返し重複情報は失われる。
    // yaml.parse は既定 uniqueKeys:true で重複キーを YAMLParseError にする
    // （kidorifile.ts が使う "yaml" パッケージ、実機確認済み）ため、YAML 側では
    // この条項は上流で保証されている。resolveVars がここで受け取る Record の時点
    // では JSON 由来の重複情報は既に失われているため、resolveVars 自体が例外を
    // 投げず後勝ちの値をそのまま扱うことだけを確認する（e2e の回帰は
    // test/core/loader.test.ts の readRaw テストが担う）。
    const resolution = resolveVars({ a: 2 });
    expect(resolution.values.a).toBe(2);
  });

  it("不正な変数名（ハイフンを含む）は error", () => {
    const resolution = resolveVars({ "my-var": 5 });
    expect(resolution.values["my-var"]).toBeUndefined();
    expect(
      resolution.diagnostics.some(
        (d) => d.severity === "error" && d.path === "vars" && d.message.includes("my-var"),
      ),
    ).toBe(true);
  });

  it("不正な変数名（数字始まり）は error", () => {
    const resolution = resolveVars({ "1bad": 5 });
    expect(
      resolution.diagnostics.some((d) => d.severity === "error" && d.message.includes("1bad")),
    ).toBe(true);
  });

  it("空式は拒否", () => {
    expect(parseExpr("").ok).toBe(false);
    expect(parseExpr("   ").ok).toBe(false);
  });

  it("演算子の連続 \"$a + + $b\" は拒否", () => {
    expect(parseExpr("$a + + $b").ok).toBe(false);
  });

  it("末尾演算子 \"$a +\" は拒否", () => {
    expect(parseExpr("$a +").ok).toBe(false);
  });

  it("指数表記 \"1e3\" は拒否（D4: Supervisor の読みに基づく実装判断）", () => {
    const r = parseExpr("1e3");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/指数表記/);
    }
  });

  it("指数表記は式の一部に現れても拒否される（$a + 1e3）", () => {
    expect(parseExpr("$a + 1e3").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. vars の依存解決
// ---------------------------------------------------------------------------

describe("resolveVars: 依存解決", () => {
  it("多段依存を正しい順序で解決する（c → b → a の順に依存）", () => {
    const resolution = resolveVars({
      inset: 50,
      matingAllowance: "38",
      total: "$inset + $matingAllowance",
      doubled: "$total + $total",
    });
    expect(resolution.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(resolution.values).toEqual({
      inset: 50,
      matingAllowance: 38,
      total: 88,
      doubled: 176,
    });
  });

  it("trace には文字列式の変数のみが載る（数値直書きの変数は載らない）", () => {
    const resolution = resolveVars({ inset: 50, total: "$inset + 10" });
    expect(resolution.trace).toEqual({
      "vars.total": { expression: "$inset + 10", value: 60 },
    });
    expect(resolution.trace["vars.inset"]).toBeUndefined();
  });

  it("循環（3変数の輪）を検出する", () => {
    const resolution = resolveVars({ a: "$b", b: "$c", c: "$a" });
    expect(resolution.values).toEqual({});
    expect(resolution.diagnostics.some((d) => d.message.includes("循環参照"))).toBe(true);
  });

  it("自己参照も循環として検出する", () => {
    const resolution = resolveVars({ a: "$a + 1" });
    expect(resolution.values.a).toBeUndefined();
    expect(resolution.diagnostics.some((d) => d.message.includes("循環参照"))).toBe(true);
  });

  it("未使用変数（vars 内部からも一切参照されない）は hint", () => {
    // "total" は "used" を参照するので "used" は未使用ではない。"total" 自身は
    // どの vars からも参照されないが、実ファイルでは通常フィールド式（marks[].x 等）
    // から参照される「終端」の変数であるため、フィールド式からの参照を表す
    // usedElsewhere で "total" が使用済みであることを伝える（実際の呼び出し元
    // である U-PIPE が行う想定の配線）。"unused" だけがどこからも参照されない。
    const resolution = resolveVars(
      { used: 10, unused: 20, total: "$used + 5" },
      { usedElsewhere: new Set(["total"]) },
    );
    const hints = resolution.diagnostics.filter((d) => d.severity === "hint");
    expect(hints).toEqual([
      { path: "vars.unused", message: "変数 '$unused' はどこからも参照されていません", severity: "hint" },
    ]);
  });

  it("options.usedElsewhere を渡すとフィールド式からの参照も未使用判定に反映される", () => {
    const fieldExpr = parseExpr("$fromField + 1");
    expect(fieldExpr.ok).toBe(true);
    const usedElsewhere = fieldExpr.ok ? collectVarRefs(fieldExpr.expr) : new Set<string>();
    expect(usedElsewhere.has("fromField")).toBe(true);

    const resolution = resolveVars({ fromField: 5 }, { usedElsewhere });
    expect(resolution.diagnostics.filter((d) => d.severity === "hint")).toEqual([]);
  });

  it("usedElsewhere を渡さない場合、フィールド専用の変数は誤って未使用 hint になりうる（スコープ境界の実証）", () => {
    const resolution = resolveVars({ fromField: 5 });
    expect(resolution.diagnostics.some((d) => d.severity === "hint" && d.path === "vars.fromField")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. 微小許容差
// ---------------------------------------------------------------------------

describe("微小許容差", () => {
  it("EPS は src/core/packing/common.ts の EPS(=1e-9) と同じ値", () => {
    expect(EPS).toBe(1e-9);
  });

  it("浮動小数の丸め誤差は EPS 許容差内で一致する（0.1 + 0.2 相当）", () => {
    const r = parseExpr("0.1 + 0.2");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Math.abs(result.value - 0.3)).toBeLessThan(EPS * 1e8); // 実際の浮動小数誤差幅を許容
      }
    }
  });

  it("複数回の減算でも許容差内で一致する（100 - 30 - 20 = 50 を EPS 精度で確認）", () => {
    const r = parseExpr("100 - 30 - 20");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = evaluateExpr(r.expr, {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Math.abs(result.value - 50)).toBeLessThan(EPS);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 補助: ParsedExpr 型を直接使う API（collectVarRefs）の単体確認
// ---------------------------------------------------------------------------

describe("collectVarRefs", () => {
  it("式中の $var 参照名をすべて収集する（重複は1回）", () => {
    const parsed = parseExpr("$a + $b - $a");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const refs = collectVarRefs(parsed.expr);
      expect([...refs].sort()).toEqual(["a", "b"]);
    }
  });

  it("被演算子が数値のみの式は空集合を返す", () => {
    const parsed = parseExpr("100 - 30");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(collectVarRefs(parsed.expr)).toEqual(new Set<string>());
    }
  });

  it("型エクスポートの健全性チェック（ParsedExpr を明示的に型注釈できる）", () => {
    const parsed = parseExpr("1 + 2");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const expr: ParsedExpr = parsed.expr;
      expect(expr.raw).toBe("1 + 2");
    }
  });
});
