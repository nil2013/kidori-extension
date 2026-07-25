/**
 * kidorifile.ts のテスト（SPECS.md §3）。
 *
 * - kidori ファイル判定（命名規約・内容判定・判定不能）
 * - 出力先 `<stem>.out/` の導出規則
 *
 * 回帰の要点: 判定の正規表現をフルパスに当てると `myproject.yaml` のような
 * 無関係なファイルが誤マッチする（v0.4 実装の schemaContributor.ts:22 の
 * バグ）。判定は必ず `path.basename` に対して行う。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyKidoriFile,
  classifyKidoriPath,
  defaultOutDir,
  detectKidoriContent,
  hasKidoriSuffix,
  modelineSchemaRef,
  projectStem,
} from "../../src/core/kidorifile";

// ---------------------------------------------------------------------------
// 命名規約による判定
// ---------------------------------------------------------------------------

describe("hasKidoriSuffix（命名規約）", () => {
  // 必須3ケースのうち2件（否定・肯定）。
  it("myproject.yaml は kidori ファイルではない", () => {
    expect(hasKidoriSuffix("myproject.yaml")).toBe(false);
    expect(hasKidoriSuffix("/home/me/diy/myproject.yaml")).toBe(false);
    expect(classifyKidoriFile("/home/me/diy/myproject.yaml", "foo: 1\n")).toBe("no");
  });

  it("foo.kidori.yaml は kidori ファイルである", () => {
    expect(hasKidoriSuffix("foo.kidori.yaml")).toBe(true);
    expect(hasKidoriSuffix("/home/me/diy/foo.kidori.yaml")).toBe(true);
    // 内容が空でも命名規約だけで確定する。
    expect(classifyKidoriFile("/home/me/diy/foo.kidori.yaml", "")).toBe("yes");
  });

  it(".yml / .json の別綴りも受理する", () => {
    expect(hasKidoriSuffix("desk.kidori.yml")).toBe(true);
    expect(hasKidoriSuffix("desk.kidori.json")).toBe(true);
  });

  it("正規表現をフルパスに当てた場合の誤マッチを起こさない", () => {
    // ディレクトリ名に .kidori.yaml を含むだけのパスは非該当。
    expect(hasKidoriSuffix("/home/me/foo.kidori.yaml/notes.txt")).toBe(false);
    // 「project.yaml で終わるフルパス」では判定しない（旧実装の誤マッチ源）。
    expect(hasKidoriSuffix("/home/me/kidori.yaml")).toBe(false);
  });

  it("ステムの無い .kidori.yaml は命名規約に一致しない", () => {
    expect(hasKidoriSuffix(".kidori.yaml")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 内容判定（素の *.yaml / *.json の救済）
// ---------------------------------------------------------------------------

describe("detectKidoriContent（内容判定）", () => {
  // 必須3ケースの残り1件。
  it("meta.schemaVersion があれば素の *.yaml でも肯定する", () => {
    const text = 'meta: { project: 書棚, units: mm, schemaVersion: "0.3" }\n';
    expect(detectKidoriContent(text)).toBe("yes");
    expect(classifyKidoriFile("/home/me/diy/myproject.yaml", text)).toBe("yes");
  });

  it("モードラインの $schema が kidori.schema.json を指していれば肯定する", () => {
    const text = "# yaml-language-server: $schema=./kidori.schema.json\nfoo: 1\n";
    expect(detectKidoriContent(text)).toBe("yes");
  });

  it("相対階層・絶対 URI のモードラインでも基底名で判定する", () => {
    expect(
      detectKidoriContent(
        "# yaml-language-server: $schema=../shared/kidori.schema.json\nfoo: 1\n",
      ),
    ).toBe("yes");
    expect(
      detectKidoriContent(
        "# yaml-language-server: $schema=file:///abs/kidori.schema.json\nfoo: 1\n",
      ),
    ).toBe("yes");
  });

  it("無条件のモードライン判定にはしない（無関係なスキーマは否定）", () => {
    const text =
      "# yaml-language-server: $schema=./docker-compose.schema.json\nservices: {}\n";
    expect(detectKidoriContent(text)).toBe("no");
  });

  it("meta はあっても schemaVersion が無ければ否定する", () => {
    expect(detectKidoriContent("meta: { project: 書棚 }\n")).toBe("no");
  });

  it("トップレベルが非オブジェクトなら否定する", () => {
    expect(detectKidoriContent("- 1\n- 2\n")).toBe("no");
    expect(detectKidoriContent("")).toBe("no");
  });

  it("パース不能なら例外を投げず unknown を返す", () => {
    // 拡張層が「直前の判定結果を維持」できるようにするための戻り値。
    expect(detectKidoriContent("meta: {\n  broken: [\n")).toBe("unknown");
    expect(detectKidoriContent('{"meta": ', "a.json")).toBe("unknown");
  });

  it("パース不能でもモードラインが一致していれば肯定する", () => {
    const text = "# yaml-language-server: $schema=./kidori.schema.json\nmeta: {\n";
    expect(detectKidoriContent(text)).toBe("yes");
  });

  it("JSON 入力は .json 拡張子で JSON として解釈する", () => {
    expect(detectKidoriContent('{"meta": {"schemaVersion": "0.3"}}', "a.json")).toBe(
      "yes",
    );
  });
});

describe("modelineSchemaRef", () => {
  it("モードラインの $schema 値を取り出す", () => {
    expect(
      modelineSchemaRef("# yaml-language-server: $schema=./kidori.schema.json\n"),
    ).toBe("./kidori.schema.json");
  });

  it("モードラインでなければ null", () => {
    expect(modelineSchemaRef("meta: {}\n")).toBeNull();
    // 2行目以降のモードラインは対象外（先頭行のみ）。
    expect(
      modelineSchemaRef("meta: {}\n# yaml-language-server: $schema=./kidori.schema.json"),
    ).toBeNull();
  });
});

describe("classifyKidoriFile / classifyKidoriPath", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-file-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("内容が読めない（null）と命名規約にも一致しなければ unknown", () => {
    expect(classifyKidoriFile("/home/me/diy/myproject.yaml", null)).toBe("unknown");
    expect(classifyKidoriFile("/home/me/diy/foo.kidori.yaml", null)).toBe("yes");
  });

  it("classifyKidoriPath はディスクを読んで判定する", () => {
    const named = path.join(dir, "bookshelf.kidori.yaml");
    fs.writeFileSync(named, "", "utf-8");
    expect(classifyKidoriPath(named)).toBe("yes");

    const plain = path.join(dir, "myproject.yaml");
    fs.writeFileSync(plain, 'meta: { schemaVersion: "0.3" }\n', "utf-8");
    expect(classifyKidoriPath(plain)).toBe("yes");

    const other = path.join(dir, "other.yaml");
    fs.writeFileSync(other, "services: {}\n", "utf-8");
    expect(classifyKidoriPath(other)).toBe("no");

    expect(classifyKidoriPath(path.join(dir, "missing.yaml"))).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 出力先の導出（CORE-2 / SPECS §3 ディレクトリ構成例）
// ---------------------------------------------------------------------------

describe("projectStem / defaultOutDir", () => {
  it(".kidori.{yaml,yml,json} はサフィックスを丸ごと落とす", () => {
    expect(projectStem("bookshelf.kidori.yaml")).toBe("bookshelf");
    expect(projectStem("desk.kidori.yml")).toBe("desk");
    expect(projectStem("gen.kidori.json")).toBe("gen");
  });

  it("それ以外は最終拡張子のみ落とす", () => {
    expect(projectStem("foo.yaml")).toBe("foo");
    expect(projectStem("foo.bar.yaml")).toBe("foo.bar");
    expect(projectStem("noext")).toBe("noext");
  });

  it("bookshelf.kidori.yaml → bookshelf.out/（SPECS §3 の構成例）", () => {
    expect(defaultOutDir("/home/me/diy/bookshelf.kidori.yaml")).toBe(
      path.join("/home/me/diy", "bookshelf.out"),
    );
  });

  it("foo.yaml → foo.out/", () => {
    expect(defaultOutDir("/home/me/diy/foo.yaml")).toBe(
      path.join("/home/me/diy", "foo.out"),
    );
  });

  it("同一ディレクトリの複数プロジェクトは出力先が衝突しない", () => {
    const a = defaultOutDir("/home/me/diy/bookshelf.kidori.yaml");
    const b = defaultOutDir("/home/me/diy/desk.kidori.yaml");
    expect(a).not.toBe(b);
  });

  it("相対パスでも絶対パスを返す", () => {
    expect(path.isAbsolute(defaultOutDir("foo.kidori.yaml"))).toBe(true);
  });
});
