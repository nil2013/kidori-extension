/**
 * `stocksFile:` 外部 stocks 参照のテスト（SPECS.md §4）。
 *
 * 仕様上の要点:
 * - 参照先はトップレベル `stocks:` リストを持つファイル。**単段のみ**。
 * - 相対パス限定（絶対パスは error）。`..` は許可、`~` は展開しない。
 * - 不在・パース不能・検証エラー・多段参照はすべて error（ビルド失敗）。
 *   欠落を warning で流すと stocks 集合が静かに変わり、異なる木取り図が
 *   黙って生成されてしまうため。
 * - インラインの `stocks` と id が衝突したらインラインが勝ち、warning で通知する。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectError } from "../../src/core/errors";
import { loadProject, loadProjectFromRaw, loadStocksFile } from "../../src/core/loader";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-stocksfile-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const BAR = "{ id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }";
const SHEET =
  "{ id: s1, label: 板, kind: sheet, length: 1820, width: 910, thickness: 18 }";

/** stocksFile を参照する正本を書き出す。 */
function writeProject(body: string, name = "project.yaml"): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

function write(rel: string, body: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

function loadError(p: string): ProjectError {
  try {
    loadProject(p);
  } catch (e) {
    if (e instanceof ProjectError) {
      return e;
    }
    throw e;
  }
  throw new Error("ProjectError が送出されませんでした");
}

// ---------------------------------------------------------------------------
// 正常系
// ---------------------------------------------------------------------------

describe("stocksFile: 正常系", () => {
  it("参照先の stocks を取り込み、parts から参照できる", () => {
    write("stocks.yaml", `stocks:\n  - ${BAR}\n  - ${SHEET}\n`);
    const p = writeProject(`
stocksFile: ./stocks.yaml
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
stocks: []
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`);
    const { project, warnings } = loadProject(p);

    expect(project.stocks.map((s) => s.id)).toEqual(["b1", "s1"]);
    expect(project.stocks[0].price).toBe(382);
    expect(warnings).toEqual([]);
  });

  it("`..` を含む相対パスは許可する（兄弟ディレクトリ共有）", () => {
    write("shared/stocks.yaml", `stocks:\n  - ${BAR}\n`);
    fs.mkdirSync(path.join(dir, "proj"), { recursive: true });
    const p = writeProject(
      `
stocksFile: ../shared/stocks.yaml
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
stocks: []
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`,
      path.join("proj", "project.yaml"),
    );
    const { project } = loadProject(p);
    expect(project.stocks.map((s) => s.id)).toEqual(["b1"]);
  });

  it("JSON の参照先も受理する", () => {
    write(
      "stocks.json",
      JSON.stringify({
        stocks: [
          { id: "b1", label: "棒", kind: "bar", length: 1820, width: 89, thickness: 19 },
        ],
      }),
    );
    const p = writeProject(`
stocksFile: ./stocks.json
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
stocks: []
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`);
    expect(loadProject(p).project.stocks.map((s) => s.id)).toEqual(["b1"]);
  });

  it("参照先エントリの preset も素通しする", () => {
    write(
      "stocks.yaml",
      "stocks:\n  - { id: b1, preset: spf/1x4/6f, label: 棒, kind: bar," +
        " length: 1820, width: 89, thickness: 19 }\n",
    );
    const p = writeProject(`
stocksFile: ./stocks.yaml
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
stocks: []
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`);
    expect(loadProject(p).project.stocks[0].preset).toBe("spf/1x4/6f");
  });
});

// ---------------------------------------------------------------------------
// インライン優先（近い方が勝つ）
// ---------------------------------------------------------------------------

describe("stocksFile: id 衝突", () => {
  it("インラインが勝ち、warning で通知する", () => {
    write(
      "stocks.yaml",
      "stocks:\n  - { id: b1, label: 共有の棒, kind: bar, length: 999," +
        " width: 89, thickness: 19 }\n",
    );
    const p = writeProject(`
stocksFile: ./stocks.yaml
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
stocks:
  - { id: b1, label: 手元の棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`);
    const { project, warnings } = loadProject(p);

    expect(project.stocks).toHaveLength(1);
    expect(project.stocks[0].label).toBe("手元の棒");
    expect(project.stocks[0].length).toBe(1820);

    const w = warnings.find((i) => i.path === "stocks[0].id");
    expect(w).toBeDefined();
    expect(w!.severity).toBe("warning");
    expect(w!.message).toContain("インラインの定義が優先");
  });
});

// ---------------------------------------------------------------------------
// error 経路
// ---------------------------------------------------------------------------

describe("stocksFile: error 経路", () => {
  const projectBody = (ref: string): string => `
stocksFile: ${ref}
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
stocks:
  - ${BAR}
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`;

  it("参照先が存在しなければ error（warning で流さない）", () => {
    const p = writeProject(projectBody("./missing.yaml"));
    const err = loadError(p);
    const issue = err.issues.find((i) => i.path === "stocksFile");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("error");
    expect(issue!.message).toContain("読み込めませんでした");
  });

  it("参照先がパース不能なら error", () => {
    write("stocks.yaml", "stocks:\n  - { id: b1,\n");
    const p = writeProject(projectBody("./stocks.yaml"));
    const issue = loadError(p).issues.find((i) => i.path === "stocksFile");
    expect(issue!.severity).toBe("error");
    expect(issue!.message).toContain("解析できませんでした");
  });

  it("参照先の検証エラーは error（内側のパスをメッセージに含める）", () => {
    write("stocks.yaml", "stocks:\n  - { id: b9, label: 棒, kind: bar, length: -1 }\n");
    const p = writeProject(projectBody("./stocks.yaml"));
    const issue = loadError(p).issues.find((i) => i.path === "stocksFile");
    expect(issue!.severity).toBe("error");
    expect(issue!.message).toContain("stocks[0]");
  });

  it("参照先に stocks が無ければ error", () => {
    write("stocks.yaml", "foo: 1\n");
    const p = writeProject(projectBody("./stocks.yaml"));
    expect(loadError(p).issues.some((i) => i.path === "stocksFile")).toBe(true);
  });

  it("多段参照（参照先の stocksFile）は error", () => {
    write("stocks.yaml", `stocksFile: ./more.yaml\nstocks:\n  - ${SHEET}\n`);
    write("more.yaml", "stocks: []\n");
    const p = writeProject(projectBody("./stocks.yaml"));
    const issue = loadError(p).issues.find((i) => i.path === "stocksFile");
    expect(issue!.severity).toBe("error");
    expect(issue!.message).toContain("多段参照");
  });

  it("絶対パスは error（相対パス限定の文字通りの施行）", () => {
    const abs = write("stocks.yaml", `stocks:\n  - ${SHEET}\n`);
    const p = writeProject(projectBody(JSON.stringify(abs)));
    const issue = loadError(p).issues.find((i) => i.path === "stocksFile");
    expect(issue!.severity).toBe("error");
    expect(issue!.message).toContain("相対パス");
  });

  it("`~` は展開しない（相対名として解決され、通常は不在 error になる）", () => {
    const p = writeProject(projectBody('"~/stocks.yaml"'));
    const issue = loadError(p).issues.find((i) => i.path === "stocksFile");
    expect(issue!.severity).toBe("error");
    expect(issue!.message).toContain("読み込めませんでした");
  });

  it("stocksFile の型が不正ならスキーマ層が error にする", () => {
    const p = writeProject(projectBody("42"));
    expect(loadError(p).issues.some((i) => i.path === "stocksFile")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 参照先エントリへの意味検証の適用
// ---------------------------------------------------------------------------

describe("stocksFile: 意味検証の適用", () => {
  it("参照先エントリの ID 安全性も検証される", () => {
    write(
      "stocks.yaml",
      "stocks:\n  - { id: CON, label: 棒, kind: bar, length: 1820," +
        " width: 89, thickness: 19 }\n",
    );
    const p = writeProject(`
stocksFile: ./stocks.yaml
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
stocks: []
parts:
  - { id: p1, label: 部材, qty: 1, stock: CON, length: 500 }
`);
    const err = loadError(p);
    expect(err.issues.some((i) => i.message.includes("予約デバイス名"))).toBe(true);
  });

  it("参照先エントリに対する物理的事前チェックも効く", () => {
    write("stocks.yaml", `stocks:\n  - ${BAR}\n`);
    const p = writeProject(`
stocksFile: ./stocks.yaml
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
stocks: []
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 9999 }
`);
    expect(loadError(p).issues.some((i) => i.path === "parts[0].length")).toBe(true);
  });

  it("参照先の id 同士が重複していれば error", () => {
    write("stocks.yaml", `stocks:\n  - ${BAR}\n  - ${BAR}\n`);
    const p = writeProject(`
stocksFile: ./stocks.yaml
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
stocks: []
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`);
    expect(loadError(p).issues.some((i) => i.message.includes("重複"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D0/D4: 式解決後の値への制約再適用（stage 8 の generic 検査）は、正本インライン
// の stocks だけでなく stocksFile 参照先の stocks にも及ぶ（対称性）。
//
// 受入ゲートのブリーフ（D1 の11フィールド一覧）は stocksFile 経由かどうかを
// 明示的に区別していないが、`resolveStock` は正本インライン・stocksFile 参照先の
// 両方から同じ関数を通る（このファイル冒頭の「正常系」テスト群が示すとおり）。
// generic 検査を正本側にしか実装しないと、この関数を経由する同型の穴が
// stocksFile 側にだけ残ってしまうため、`loadStocksFile`（src/core/loader.ts）内で
// スコープを閉じた形で同じ検査を実行するよう実装した（詳細は報告参照）。
// ---------------------------------------------------------------------------
describe("D0/D4: stocksFile 参照先の length/width/thickness も式経由の負値を検出する（正本側との対称性）", () => {
  it("参照先 stocks[].length を式（負値）にすると error になる", () => {
    write(
      "stocks.yaml",
      '  stocks:\n    - { id: s1, label: 板, kind: sheet, length: "5 - 100", width: 910, thickness: 18 }\n',
    );
    const p = writeProject(`
stocksFile: ./stocks.yaml
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
stocks: []
parts:
  - { id: p1, label: 部材, qty: 1, stock: s1, length: 100, width: 100 }
`);
    const err = loadError(p);
    expect(
      err.issues.some(
        (i) => i.path === "stocksFile" && i.message.includes("より大きい必要があります"),
      ),
      JSON.stringify(err.issues),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 直接 API
// ---------------------------------------------------------------------------

describe("loadStocksFile / baseDir 未指定", () => {
  it("loadStocksFile は stocks と解決先パスを返す", () => {
    write("stocks.yaml", `stocks:\n  - ${BAR}\n`);
    const result = loadStocksFile(dir, "./stocks.yaml");

    expect(result.issues).toEqual([]);
    expect(result.stocks.map((s) => s.id)).toEqual(["b1"]);
    expect(result.resolvedPath).toBe(path.join(dir, "stocks.yaml"));
  });

  it("U-PIPE: 参照先の length 等にも文脈非依存式（vars 不使用）を書ける", () => {
    write(
      "stocks.yaml",
      'stocks:\n  - { id: b1, label: 棒, kind: bar, length: "1800 + 20", width: 89, thickness: 19 }\n',
    );
    const p = writeProject(`
stocksFile: ./stocks.yaml
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
stocks: []
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`);
    const { project } = loadProject(p);
    expect(project.stocks[0].length).toBe(1820);
  });

  it("U-PIPE: 参照先は vars 区画を持てないため $var 参照は未定義エラーになる（env は常に空）", () => {
    write(
      "stocks.yaml",
      'stocks:\n  - { id: b1, label: 棒, kind: bar, length: "$foo", width: 89, thickness: 19 }\n',
    );
    const p = writeProject(`
stocksFile: ./stocks.yaml
meta: { project: テスト, units: mm, schemaVersion: "0.5" }
stocks: []
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`);
    const err = loadError(p);
    const issue = err.issues.find((i) => i.path === "stocksFile");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("error");
    expect(issue!.message).toContain("未定義の変数です");
    expect(issue!.message).toContain("stocks[0].length");
  });

  it("baseDir 未指定の loadProjectFromRaw は warning を出して参照を無視する", () => {
    const { project, issues } = loadProjectFromRaw({
      stocksFile: "./stocks.yaml",
      meta: { project: "テスト", units: "mm", schemaVersion: "0.5" },
      stocks: [
        { id: "b1", label: "棒", kind: "bar", length: 1820, width: 89, thickness: 19 },
      ],
      parts: [{ id: "p1", label: "部材", qty: 1, stock: "b1", length: 500 }],
    });

    expect(project).not.toBeNull();
    const w = issues.find((i) => i.path === "stocksFile");
    expect(w!.severity).toBe("warning");
  });
});
