/**
 * ホバー本体（`src/extension/exprHover.ts`）の純関数テスト（U-EXT、設計裁定 D3・D4）。
 *
 * 対象: vscode に一切依存しない2本の純関数。
 *   - `pathAtDocumentPosition`（本エンゲージメント唯一の先例なし機構: 位置 → path
 *     写像。`yaml` の CST を根から辿る）。ネストした配列・複数の式・同じ行に
 *     複数フィールドがあるケースを重点的に検証する（ブリーフの D4 要求）。
 *   - `resolveHoverText`（「ドキュメントのテキスト＋位置 → 表示文字列 | null」。
 *     実 YAML テキストで値まで直接テストする。SPECS.md §4d:274 の例
 *     `"$inset + $matingAllowance" → 88 mm` に対する回帰）。
 *
 * vscode モック経由の smoke（provider 登録・実際に Hover が返ること）は
 * hover.test.ts が別途担う。
 */

import { describe, expect, it } from "vitest";

import { pathAtDocumentPosition, resolveHoverText } from "../../src/extension/exprHover";

/** `text` 内で `needle` が最初に現れる位置（0-indexed 行・文字）。 */
function positionOf(text: string, needle: string): { line: number; character: number } {
  const idx = text.indexOf(needle);
  if (idx < 0) {
    throw new Error(`'${needle}' が見つかりません`);
  }
  const before = text.slice(0, idx);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

// ---------------------------------------------------------------------------
// pathAtDocumentPosition（位置 → path 写像。本エンゲージメント唯一の先例なし機構）
// ---------------------------------------------------------------------------

describe("pathAtDocumentPosition: 位置 → path 写像", () => {
  it("トップレベルの単純なキー", () => {
    const text = "settings:\n  kerf: 3\n";
    const pos = positionOf(text, "3");
    expect(pathAtDocumentPosition(text, pos)).toBe("settings.kerf");
  });

  it("配列内のオブジェクトのフィールド（parts[0].length）", () => {
    const text = "parts:\n  - id: a\n    length: 600\n";
    const pos = positionOf(text, "600");
    expect(pathAtDocumentPosition(text, pos)).toBe("parts[0].length");
  });

  it("2番目の配列要素を正しく指す（parts[1].length）", () => {
    const text = "parts:\n  - id: a\n    length: 600\n  - id: b\n    length: 800\n";
    const pos = positionOf(text, "800");
    expect(pathAtDocumentPosition(text, pos)).toBe("parts[1].length");
  });

  it("ネストした配列（parts[].features[].pos）", () => {
    const text =
      "parts:\n" +
      "  - id: a\n" +
      "    features:\n" +
      "      - type: groove\n" +
      "        pos: 248\n" +
      "      - type: hole\n" +
      "        x: 100\n";
    expect(pathAtDocumentPosition(text, positionOf(text, "248"))).toBe(
      "parts[0].features[0].pos",
    );
    expect(pathAtDocumentPosition(text, positionOf(text, "100"))).toBe(
      "parts[0].features[1].x",
    );
  });

  it("2重にネストした配列（assemblies[].marks[].x）", () => {
    const text =
      "assemblies:\n" +
      "  - id: uma-1\n" +
      "    marks:\n" +
      "      - on: beam-top\n" +
      '        x: "$inset + $matingAllowance"\n';
    const pos = positionOf(text, "$inset");
    expect(pathAtDocumentPosition(text, pos)).toBe("assemblies[0].marks[0].x");
  });

  it("同じ行に複数フィールドがあるフロー形式（{ id, length, width }）でも列位置で判別する", () => {
    const text = "parts:\n  - { id: a, length: 600, width: 300 }\n";
    const lengthPos = positionOf(text, "600");
    const widthPos = positionOf(text, "300");
    expect(pathAtDocumentPosition(text, lengthPos)).toBe("parts[0].length");
    expect(pathAtDocumentPosition(text, widthPos)).toBe("parts[0].width");
  });

  it("フロー形式の配列2要素目でも正しい添字を返す", () => {
    const text = "stocks:\n  - { id: a, length: 1820 }\n  - { id: b, length: 2440 }\n";
    expect(pathAtDocumentPosition(text, positionOf(text, "1820"))).toBe("stocks[0].length");
    expect(pathAtDocumentPosition(text, positionOf(text, "2440"))).toBe("stocks[1].length");
  });

  it("vars 区画の変数名は vars.<名前> になる", () => {
    const text = 'vars:\n  inset: "40 + 10"\n';
    const pos = positionOf(text, "40 + 10");
    expect(pathAtDocumentPosition(text, pos)).toBe("vars.inset");
  });

  it("キー名の上（値ではない位置）では null を返す", () => {
    const text = "settings:\n  kerf: 3\n";
    const pos = positionOf(text, "kerf");
    expect(pathAtDocumentPosition(text, pos)).toBeNull();
  });

  it("行末・ファイル末尾を超える位置では null を返す", () => {
    const text = "settings:\n  kerf: 3\n";
    expect(pathAtDocumentPosition(text, { line: 99, character: 0 })).toBeNull();
    expect(pathAtDocumentPosition(text, { line: 0, character: 0 })).toBeNull(); // "settings:" のキー行
  });

  it("構文エラーのある YAML では null を返す（パース不能）", () => {
    const text = "settings: [unterminated\n  kerf: 3\n";
    expect(pathAtDocumentPosition(text, { line: 1, character: 8 })).toBeNull();
  });

  it("空ドキュメントでは null を返す", () => {
    expect(pathAtDocumentPosition("", { line: 0, character: 0 })).toBeNull();
  });

  it("JSON テキストでも同じ path 文法で解決できる（yaml パッケージが JSON も読めるため）", () => {
    const text = '{\n  "parts": [\n    { "id": "a", "length": 600 }\n  ]\n}\n';
    const pos = positionOf(text, "600");
    expect(pathAtDocumentPosition(text, pos)).toBe("parts[0].length");
  });
});

// ---------------------------------------------------------------------------
// resolveHoverText（本丸: 実 YAML テキストで値まで検証）
// ---------------------------------------------------------------------------

/** SPECS.md §4d の例（ウマ）に vars を足した最小プロジェクト。 */
function specsExampleYaml(xExpr: string): string {
  return (
    "meta: { project: ウマ, units: mm, schemaVersion: \"0.5\" }\n" +
    "\n" +
    "vars:\n" +
    "  inset: 50\n" +
    "  matingAllowance: 38\n" +
    "\n" +
    "stocks:\n" +
    "  - { id: 2x4-6f, label: 2x4材, kind: bar, length: 1820, width: 89, thickness: 38 }\n" +
    "\n" +
    "parts:\n" +
    "  - { id: leg,      label: 足,   stock: 2x4-6f, length: 800 }\n" +
    "  - { id: beam-top, label: 天板, stock: 2x4-6f, length: 850 }\n" +
    "\n" +
    "assemblies:\n" +
    "  - id: uma-1\n" +
    "    contains: { leg: 2, beam-top: 1 }\n" +
    "    marks:\n" +
    `      - { on: beam-top, face: front, ref: leg, x: "${xExpr}" }\n`
  );
}

describe("resolveHoverText: ドキュメントのテキスト＋位置 → 表示文字列 | null", () => {
  it("SPECS.md §4d:274 の例どおりの表示（式の位置で解決値を示す）", () => {
    const text = specsExampleYaml("$inset + $matingAllowance");
    const pos = positionOf(text, "$inset");
    expect(resolveHoverText(text, pos)).toBe('"$inset + $matingAllowance" → 88 mm');
  });

  it("vars 自身の値（文字列式）にもホバーが効く", () => {
    const text =
      "meta: { project: t, units: mm, schemaVersion: \"0.5\" }\n" +
      "vars:\n" +
      '  base: "10 + 5"\n' +
      "settings: { kerf: 3, edgeTrim: 5 }\n" +
      "stocks:\n" +
      "  - { id: s, label: s, kind: bar, length: 1820, width: 89, thickness: 19 }\n" +
      "parts:\n" +
      "  - { id: p, label: p, stock: s, length: 600 }\n";
    const pos = positionOf(text, "10 + 5");
    expect(resolveHoverText(text, pos)).toBe('"10 + 5" → 15 mm');
  });

  it("式でない位置（リテラル数値の length）では null を返す", () => {
    const text = specsExampleYaml("$inset + $matingAllowance");
    const pos = positionOf(text, "800"); // parts[0].length（数値リテラル）
    expect(resolveHoverText(text, pos)).toBeNull();
  });

  it("範囲外の位置では null を返す", () => {
    const text = specsExampleYaml("$inset + $matingAllowance");
    expect(resolveHoverText(text, { line: 999, character: 0 })).toBeNull();
  });

  it("減算・複数変数を含む式でも正しい解決値を示す", () => {
    const text =
      "meta: { project: t, units: mm, schemaVersion: \"0.5\" }\n" +
      "vars:\n" +
      "  a: 100\n" +
      "  b: 30\n" +
      "settings: { kerf: 3, edgeTrim: 5 }\n" +
      "stocks:\n" +
      "  - { id: s, label: s, kind: bar, length: 1820, width: 89, thickness: 19 }\n" +
      "parts:\n" +
      '  - { id: p, label: p, stock: s, length: "$a - $b" }\n';
    const pos = positionOf(text, "$a - $b");
    expect(resolveHoverText(text, pos)).toBe('"$a - $b" → 70 mm');
  });

  it("パース不能な YAML では null を返す", () => {
    const text = "meta: [unterminated\n";
    expect(resolveHoverText(text, { line: 0, character: 10 })).toBeNull();
  });

  it("解決フェーズより前の error（参照フェーズ）があると null になる", () => {
    // 解決前に中断する早期 return では resolved が空になる。これは制約ではなく、
    // そもそも式の解決が走っていないため空であることが正しい（空虚な真）。
    // 解決フェーズより後の error については下のテストを参照。
    const text = specsExampleYaml("$inset + $matingAllowance").replace(
      "stock: 2x4-6f, length: 800",
      "stock: 存在しない材, length: 800", // 参照フェーズの error を1件混入
    );
    const pos = positionOf(text, "$inset");
    expect(resolveHoverText(text, pos)).toBeNull();
  });

  it("解決フェーズより後の無関係な error があっても、解決済みの式はホバーできる", () => {
    // loadProjectFromRaw は解決を終えた後の error 分岐でも trace を保持する
    // （SPECS §3b:100「正常な式を含めて」の要求。ホバーと kidori check --resolved は
    // 同一の trace を供給源とするため、無関係な error 1件でホバーが全滅しては
    // ならない —— 編集中はほぼ常に何らかの error がある）。
    const text = specsExampleYaml("$inset + $matingAllowance").replace(
      "stock: 2x4-6f, length: 800",
      "stock: 2x4-6f, length: 99999", // 幾何フェーズ（解決後）の error を1件混入
    );
    const pos = positionOf(text, "$inset");
    expect(resolveHoverText(text, pos)).toBe('"$inset + $matingAllowance" → 88 mm');
  });
});
