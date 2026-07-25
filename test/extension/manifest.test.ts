/**
 * 拡張マニフェスト（package.json）と同梱アセットの契約（SPECS.md §3・§3a・§4b）。
 *
 * 固定する点:
 *   - 基底スキーマ `assets/kidori.schema.json` は `src/core/schema.ts` の
 *     `baseSchemaJson()` と**一致する**（esbuild が生成する。手書きコピーを
 *     置かないための drift 検知。ズレたら `npm run build` を実行すること）。
 *   - `contributes.jsonValidation` が `*.kidori.json` を同梱スキーマに結ぶ
 *     （settings 書き換え不要・アンインストールで消える宣言的登録）。
 *   - `activationEvents` が新しい命名規約（`*.kidori.{yaml,yml,json}`）を拾い、
 *     内容判定の救済経路のために `onLanguage:yaml` / `onLanguage:json` を残す。
 *   - `.vscodeignore` が `assets/` を除外していない（vsix にスキーマが同梱される）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { baseSchemaJson } from "../../src/core/schema";

const repoRoot = path.resolve(__dirname, "../..");

function readManifest(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
}

describe("同梱する基底スキーマ", () => {
  it("assets/kidori.schema.json が core の baseSchemaJson() と一致する", () => {
    const assetPath = path.join(repoRoot, "assets", "kidori.schema.json");
    expect(
      fs.existsSync(assetPath),
      "assets/kidori.schema.json がありません（`npm run build` で生成されます）",
    ).toBe(true);
    expect(
      fs.readFileSync(assetPath, "utf-8"),
      "同梱スキーマが src/core/schema.ts とズレています（`npm run build` を実行してください）",
    ).toBe(baseSchemaJson());
  });

  it("基底スキーマは動的 enum を含まない（ファイルごとの合成はメモリ上で行う）", () => {
    const schema = JSON.parse(baseSchemaJson());
    expect(schema.properties.parts.items.properties.stock.enum).toBeUndefined();
  });

  it(".vscodeignore が assets/ を除外していない", () => {
    const lines = fs
      .readFileSync(path.join(repoRoot, ".vscodeignore"), "utf-8")
      .split(/\r?\n/)
      .map((l) => l.trim());
    expect(lines.some((l) => l.startsWith("assets"))).toBe(false);
  });
});

describe("package.json の contributes / activationEvents", () => {
  it("*.kidori.json に同梱スキーマを宣言登録する", () => {
    const manifest = readManifest();
    const validations = manifest.contributes.jsonValidation as {
      fileMatch: string | string[];
      url: string;
    }[];
    expect(validations).toBeDefined();
    const entry = validations.find((v) =>
      (Array.isArray(v.fileMatch) ? v.fileMatch : [v.fileMatch]).includes("*.kidori.json"),
    );
    expect(entry, "*.kidori.json の jsonValidation エントリがありません").toBeDefined();
    expect(entry!.url).toBe("./assets/kidori.schema.json");
    expect(fs.existsSync(path.join(repoRoot, entry!.url))).toBe(true);
  });

  it("activationEvents が命名規約と内容判定の双方を拾う", () => {
    const events = readManifest().activationEvents as string[];
    for (const suffix of ["yaml", "yml", "json"]) {
      expect(events).toContain(`workspaceContains:**/*.kidori.${suffix}`);
    }
    // 内容判定（素の *.yaml / *.json）はグロブで表現できないため言語で拾う。
    expect(events).toContain("onLanguage:yaml");
    expect(events).toContain("onLanguage:json");
    // 旧規約（1ディレクトリ=1プロジェクト）は残さない。
    expect(events).not.toContain("workspaceContains:**/project.yaml");
  });

  it("kidori.new / kidori.init のコマンドが定義されている", () => {
    const commandIds = (readManifest().contributes.commands as { command: string }[]).map(
      (c) => c.command,
    );
    expect(commandIds).toContain("kidori.new");
    expect(commandIds).toContain("kidori.init");
    expect(commandIds).toContain("kidori.build");
    expect(commandIds).toContain("kidori.openPreview");
    expect(commandIds).toContain("kidori.selectPlan");
  });
});
