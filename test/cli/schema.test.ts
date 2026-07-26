/**
 * `kidori schema <ファイル>` のテスト（SPECS.md §3b）。
 *
 * 合成ロジック自体（`buildSchema`/`schemaJson`）は core 側の責務であり、
 * ここで再検証はしない。検証するのは本コマンドが**薄いラッパとして正しく
 * 配線されているか**（設計裁定 D5）: stdout に出た JSON が
 * `schemaJson(extractStockIds(raw))` と一致すること、stocks[].id の変化に
 * enum が追随すること、stocksFile 参照先の id も合成に含まれること、
 * baseDir の解決が `loadProject`/schemaContributor と同一であること。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSchema } from "../../src/cli/agentCommands";
import { extractStockIds, readRaw } from "../../src/core/loader";
import { schemaJson } from "../../src/core/schema";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-cli-schema-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, body: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

/** runSchema を呼び、stdout に書かれた内容をまとめて返す。 */
function runSchemaOut(args: string[]): { exitCode: number; stdout: string; stderr: string[] } {
  const chunks: string[] = [];
  const stderr: string[] = [];
  const exitCode = runSchema(
    args,
    (s) => chunks.push(s),
    (s) => stderr.push(s),
  );
  return { exitCode, stdout: chunks.join(""), stderr };
}

describe("kidori schema: 出力契約", () => {
  it("stdout は schemaJson(extractStockIds(raw)) と一致する", () => {
    const body = `meta: { project: t, units: mm, schemaVersion: "0.5" }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
  - { id: s1, label: 板, kind: sheet, length: 1820, width: 910, thickness: 18 }
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`;
    const p = write("project.kidori.yaml", body);
    const { exitCode, stdout } = runSchemaOut([p]);

    expect(exitCode).toBe(0);
    const raw = readRaw(p);
    expect(stdout).toBe(schemaJson(extractStockIds(raw)));

    const parsed = JSON.parse(stdout) as {
      properties: { parts: { items: { properties: { stock: { enum?: string[] } } } } };
    };
    expect(parsed.properties.parts.items.properties.stock.enum).toEqual(["b1", "s1"]);
  });

  it("stocks[].id を変えると parts[].stock の enum が追随する", () => {
    const before = write(
      "a.kidori.yaml",
      `meta: { project: t, units: mm, schemaVersion: "0.5" }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts: []
`,
    );
    const after = write(
      "b.kidori.yaml",
      `meta: { project: t, units: mm, schemaVersion: "0.5" }
stocks:
  - { id: b1-renamed, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
  - { id: b2, label: 棒2, kind: bar, length: 2440, width: 89, thickness: 19 }
parts: []
`,
    );

    const outBefore = JSON.parse(runSchemaOut([before]).stdout) as {
      properties: { parts: { items: { properties: { stock: { enum?: string[] } } } } };
    };
    const outAfter = JSON.parse(runSchemaOut([after]).stdout) as {
      properties: { parts: { items: { properties: { stock: { enum?: string[] } } } } };
    };

    expect(outBefore.properties.parts.items.properties.stock.enum).toEqual(["b1"]);
    expect(outAfter.properties.parts.items.properties.stock.enum).toEqual([
      "b1-renamed",
      "b2",
    ]);
  });

  it("stocksFile: 参照がある場合、外部 stocks の id も enum に含める", () => {
    write(
      "stocks.yaml",
      "stocks:\n" +
        "  - { id: shared-1, label: 共有棒, kind: bar, length: 1820, width: 89, thickness: 19 }\n",
    );
    const p = write(
      "project.kidori.yaml",
      `stocksFile: ./stocks.yaml
meta: { project: t, units: mm, schemaVersion: "0.5" }
stocks:
  - { id: local-1, label: 手元棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts: []
`,
    );

    const { exitCode, stdout } = runSchemaOut([p]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as {
      properties: { parts: { items: { properties: { stock: { enum?: string[] } } } } };
    };
    expect(parsed.properties.parts.items.properties.stock.enum).toEqual([
      "local-1",
      "shared-1",
    ]);
  });

  it("stocksFile の baseDir 解決は dirname(resolve(filePath)) と同一（相対パス起動でも解決できる）", () => {
    // stocksfile.test.ts と同じ「兄弟ディレクトリ共有」構成を再現する。
    write(
      "shared/stocks.yaml",
      "stocks:\n  - { id: shared-2, label: 共有棒, kind: bar, length: 1820, width: 89, thickness: 19 }\n",
    );
    write(
      path.join("proj", "project.kidori.yaml"),
      `stocksFile: ../shared/stocks.yaml
meta: { project: t, units: mm, schemaVersion: "0.5" }
stocks: []
parts: []
`,
    );

    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      // 相対パスで起動しても baseDir は resolve 後のディレクトリになる（D5 条件）。
      const { exitCode, stdout } = runSchemaOut([path.join("proj", "project.kidori.yaml")]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as {
        properties: { parts: { items: { properties: { stock: { enum?: string[] } } } } };
      };
      expect(parsed.properties.parts.items.properties.stock.enum).toEqual(["shared-2"]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("stocksFile 参照先が壊れていても schema コマンド自体は失敗させず、インラインのみに縮退する", () => {
    const p = write(
      "project.kidori.yaml",
      `stocksFile: ./missing.yaml
meta: { project: t, units: mm, schemaVersion: "0.5" }
stocks:
  - { id: local-1, label: 手元棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts: []
`,
    );

    const { exitCode, stdout } = runSchemaOut([p]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as {
      properties: { parts: { items: { properties: { stock: { enum?: string[] } } } } };
    };
    expect(parsed.properties.parts.items.properties.stock.enum).toEqual(["local-1"]);
  });

  it("JSON 入力（*.kidori.json）でも動く", () => {
    const body = JSON.stringify({
      meta: { project: "t", units: "mm", schemaVersion: "0.5" },
      stocks: [
        { id: "b1", label: "棒", kind: "bar", length: 1820, width: 89, thickness: 19 },
      ],
      parts: [],
    });
    const p = write("project.kidori.json", body);
    const { exitCode, stdout } = runSchemaOut([p]);

    expect(exitCode).toBe(0);
    const raw = readRaw(p);
    expect(stdout).toBe(schemaJson(extractStockIds(raw)));
  });
});

describe("kidori schema: エラー系", () => {
  it("ファイルが存在しない場合は exit 2、stdout は空", () => {
    const missing = path.join(dir, "does-not-exist.kidori.yaml");
    const { exitCode, stdout, stderr } = runSchemaOut([missing]);
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.some((s) => s.includes("読み込めません"))).toBe(true);
  });

  it("構文エラーのファイルは exit 1（IO エラーではない）", () => {
    const p = write("broken.kidori.yaml", "meta: { project: t\nstocks: [\n");
    const { exitCode, stdout } = runSchemaOut([p]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
  });

  it("引数省略は UsageError", () => {
    expect(() => runSchema([])).toThrowError(/対象ファイルを指定/);
  });
});
