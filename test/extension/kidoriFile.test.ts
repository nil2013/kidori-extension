/**
 * 拡張層の kidori ファイル判定とスキーマ供給の**配線**（SPECS.md §3・§4b）。
 *
 * ここで固定する契約:
 *   1. core の判定関数へは **fsPath** を渡す（URI 文字列ではない）。
 *      Red Hat YAML から来る `resource`（`file:///…`、非 ASCII は
 *      パーセントエンコード）を fsPath に変換してからキャッシュを引くこと。
 *      変換を忘れるとキャッシュが引けず、スキーマ供給が丸ごと沈黙する。
 *   2. 編集途中のパース失敗（`"unknown"`）では**直前の判定を維持**する
 *      （維持しないと編集のたびに補完・検証が明滅する）。
 *   3. 未判定の URI には state を作らない（`requestSchema` が undefined を返す）。
 *   4. 動的 enum には `stocksFile:` 参照先の id も含める（§4b の明示要求）。
 *   5. 旧実装のアンカー無し正規表現 `/project\.(ya?ml|json)$/` による誤判定
 *      （`myproject.yaml` を巻き込む・`*.kidori.yaml` を拾わない）の回帰検知。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SchemaContributor, resourceToFsPath } from "../../src/extension/schemaContributor";

/** vscode.TextDocument の最小面（SchemaContributor は構造的に受ける）。 */
function doc(fsPath: string, text: string) {
  return { uri: { fsPath }, getText: () => text };
}

const VALID = `meta: { project: 書棚, units: mm, schemaVersion: "0.3" }
stocks:
  - { id: 1x4-6f, label: "1×4材 6F", kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - { id: side, label: 側板, qty: 1, stock: 1x4-6f, length: 300, width: 89 }
`;

/** 編集途中の壊れた YAML（パース不能 → detectKidoriContent は "unknown"）。 */
const BROKEN = `meta: { project: 書棚, units: mm, schemaVersion: "0.3"
stocks: [ {`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-file-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resourceToFsPath", () => {
  it("file: URI をパーセントデコード済みの fsPath に戻す", () => {
    const p = path.join(tmpDir, "書棚.kidori.yaml");
    const uri = pathToFileURL(p).toString();
    expect(uri).toContain("%"); // 非 ASCII がエンコードされていることを前提にする
    expect(resourceToFsPath(uri)).toBe(p);
  });

  it("file 以外のスキーム（untitled: 等）は対象外", () => {
    expect(resourceToFsPath("untitled:Untitled-1")).toBeNull();
  });

  it("スキーム無し（すでに fsPath）はそのまま通す", () => {
    expect(resourceToFsPath("/tmp/a/plan.kidori.yaml")).toBe("/tmp/a/plan.kidori.yaml");
  });
});

describe("SchemaContributor: 判定と供給の配線", () => {
  it("requestSchema は URI 文字列ではなく fsPath でキャッシュを引く（非 ASCII 名でも供給される）", () => {
    const c = new SchemaContributor();
    const p = path.join(tmpDir, "書棚.kidori.yaml");
    expect(c.update(doc(p, VALID))).toBe(true);

    const resource = pathToFileURL(p).toString();
    const schemaUri = c.requestSchema(resource);
    expect(schemaUri, "file:// URI を fsPath に変換していない").toBeDefined();

    const content = c.requestSchemaContent(schemaUri as string);
    expect(content).toBeDefined();
    expect(JSON.parse(content as string).properties.parts.items.properties.stock.enum).toEqual([
      "1x4-6f",
    ]);
  });

  it("URI 文字列をそのまま渡した場合は供給しない（キーは fsPath に統一されている）", () => {
    const c = new SchemaContributor();
    const p = path.join(tmpDir, "plan.kidori.yaml");
    c.update(doc(p, VALID));
    // resource として URI ではなく "file://" 抜きの別表記を渡しても、
    // 正規化された fsPath と一致する場合のみ供給される。
    expect(c.requestSchema("untitled:plan.kidori.yaml")).toBeUndefined();
  });

  it("パース不能（unknown）では直前の判定と stocks[].id を維持する", () => {
    const c = new SchemaContributor();
    // 命名規約に乗らない素の *.yaml（内容判定で kidori と判定される）。
    const p = path.join(tmpDir, "plan.yaml");
    expect(c.update(doc(p, VALID))).toBe(true);
    const before = c.requestSchema(pathToFileURL(p).toString());

    // 編集途中で壊れた → 判定は "unknown"。維持されなければ補完が消える。
    expect(c.update(doc(p, BROKEN))).toBe(true);
    expect(c.verdictFor(p)).toBe(true);
    const after = c.requestSchema(pathToFileURL(p).toString());
    expect(after).toBe(before); // 世代も進まない（enum は直前のまま）
    const content = JSON.parse(c.requestSchemaContent(after as string) as string);
    expect(content.properties.parts.items.properties.stock.enum).toEqual(["1x4-6f"]);
  });

  it("前歴の無い unknown では state を作らない（requestSchema は undefined）", () => {
    const c = new SchemaContributor();
    const p = path.join(tmpDir, "plan.yaml");
    expect(c.update(doc(p, BROKEN))).toBe(false);
    expect(c.verdictFor(p)).toBeUndefined();
    expect(c.requestSchema(pathToFileURL(p).toString())).toBeUndefined();
  });

  it("kidori でない YAML には供給しない", () => {
    const c = new SchemaContributor();
    const p = path.join(tmpDir, "docker-compose.yaml");
    expect(c.update(doc(p, "services:\n  web:\n    image: nginx\n"))).toBe(false);
    expect(c.requestSchema(pathToFileURL(p).toString())).toBeUndefined();
  });

  it("旧正規表現の誤判定を再現しない（myproject.yaml / project.yaml の内容判定）", () => {
    const c = new SchemaContributor();
    const decoy = path.join(tmpDir, "myproject.yaml");
    expect(c.update(doc(decoy, "a: 1\n"))).toBe(false);
    const legacy = path.join(tmpDir, "project.yaml");
    expect(c.update(doc(legacy, "a: 1\n"))).toBe(false);
    // 逆に、命名規約に従うファイルは中身が壊れていても kidori ファイル。
    const named = path.join(tmpDir, "bookshelf.kidori.yaml");
    expect(c.update(doc(named, BROKEN))).toBe(true);
  });

  it("stocksFile: 参照先の id も動的 enum に含める（SPECS.md §4b）", () => {
    const c = new SchemaContributor();
    fs.writeFileSync(
      path.join(tmpDir, "stocks.yaml"),
      `stocks:
  - { id: shared-ply, label: "サブロク合板", kind: sheet, length: 1820, width: 910, thickness: 12 }
`,
      "utf-8",
    );
    const p = path.join(tmpDir, "bookshelf.kidori.yaml");
    const text = `stocksFile: ./stocks.yaml
${VALID}`;
    expect(c.update(doc(p, text))).toBe(true);

    const schemaUri = c.requestSchema(pathToFileURL(p).toString()) as string;
    const content = JSON.parse(c.requestSchemaContent(schemaUri) as string);
    expect(content.properties.parts.items.properties.stock.enum).toEqual([
      "1x4-6f",
      "shared-ply",
    ]);
  });

  it("stocksFile: 参照先の変更でスキーマ世代が進む", () => {
    const c = new SchemaContributor();
    const stocksPath = path.join(tmpDir, "stocks.yaml");
    fs.writeFileSync(stocksPath, "stocks: []\n", "utf-8");
    const p = path.join(tmpDir, "bookshelf.kidori.yaml");
    const text = `stocksFile: ./stocks.yaml\n${VALID}`;
    c.update(doc(p, text));
    const first = c.requestSchema(pathToFileURL(p).toString());

    fs.writeFileSync(
      stocksPath,
      `stocks:
  - { id: added, label: "追加材", kind: bar, length: 910, width: 89, thickness: 19 }
`,
      "utf-8",
    );
    c.update(doc(p, text));
    const second = c.requestSchema(pathToFileURL(p).toString());
    expect(second).not.toBe(first);
  });

  it("isKidoriPath はディスク内容で判定し、判定不能時はキャッシュに落ちる", () => {
    const c = new SchemaContributor();
    const named = path.join(tmpDir, "a.kidori.yaml");
    // 命名規約はファイルが無くても真（グロブで即判定できるのが規約の利点）。
    expect(c.isKidoriPath(named)).toBe(true);

    const plain = path.join(tmpDir, "plan.yaml");
    fs.writeFileSync(plain, VALID, "utf-8");
    expect(c.isKidoriPath(plain)).toBe(true);

    const other = path.join(tmpDir, "notes.yaml");
    fs.writeFileSync(other, "a: 1\n", "utf-8");
    expect(c.isKidoriPath(other)).toBe(false);

    // YAML/JSON 以外は読まずに false。
    expect(c.isKidoriPath(path.join(tmpDir, "main.ts"))).toBe(false);

    // 存在しない *.yaml は "unknown" → キャッシュ済みの判定に従う。
    const ghost = path.join(tmpDir, "ghost.yaml");
    expect(c.isKidoriPath(ghost)).toBe(false);
    c.update(doc(ghost, VALID));
    expect(c.isKidoriPath(ghost)).toBe(true);
  });

  it("forget でキャッシュを破棄する（閉じたドキュメント）", () => {
    const c = new SchemaContributor();
    const p = path.join(tmpDir, "a.kidori.yaml");
    c.update(doc(p, VALID));
    expect(c.verdictFor(p)).toBe(true);
    c.forget(p);
    expect(c.verdictFor(p)).toBeUndefined();
  });
});
