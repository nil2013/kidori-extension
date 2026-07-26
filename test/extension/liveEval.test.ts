/**
 * `src/extension/liveEval.ts`（編集時の再評価。D2）の純関数テスト。
 *
 * vscode に依存しない `reevaluateInMemory` そのものの契約を検証する:
 *   - 有効な YAML/JSON からは（build を経由せず）意味診断を返す
 *   - パース不能（構文エラー・YAML の重複キー）なら `null`
 *     （呼び出し側 extension.ts はこれを「前回診断を維持」のシグナルとして扱う。
 *     ここでは「null を返すこと」自体を検証する。維持の配線側は
 *     liveDiagnosticsWiring.test.ts が vscode モック経由で検証する）
 *   - baseDir が正しく `stocksFile:` 解決に使われる（既存の loadProjectFromRaw
 *     契約をそのまま辿るだけであることの回帰）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reevaluateInMemory } from "../../src/extension/liveEval";

const MINIMAL_YAML =
  'meta: { project: t, units: mm, schemaVersion: "0.5" }\n' +
  "settings: { kerf: 3, edgeTrim: 5 }\n" +
  "stocks:\n" +
  "  - { id: s, label: s, kind: bar, length: 1820, width: 89, thickness: 19 }\n" +
  "parts:\n" +
  "  - { id: p, label: p, qty: 1, stock: s, length: 600 }\n";

describe("reevaluateInMemory: 編集時の再評価（メモリ上）", () => {
  it("有効な YAML からは issues（空配列）を返す（error なし）", () => {
    const issues = reevaluateInMemory(MINIMAL_YAML, "/tmp/x.kidori.yaml", "/tmp");
    expect(issues).not.toBeNull();
    expect(issues!.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("意味検証エラー（未定義の $var 参照）を保存前のバッファから検出する", () => {
    const broken = MINIMAL_YAML.replace(
      "length: 600",
      'length: "$undefinedVar"',
    );
    const issues = reevaluateInMemory(broken, "/tmp/x.kidori.yaml", "/tmp");
    expect(issues).not.toBeNull();
    expect(issues!.some((i) => i.severity === "error" && i.message.includes("undefinedVar"))).toBe(
      true,
    );
  });

  it("構文エラーのある YAML では null を返す（パース不能）", () => {
    const broken = "meta: [unterminated\n  settings:\n";
    expect(reevaluateInMemory(broken, "/tmp/x.kidori.yaml", "/tmp")).toBeNull();
  });

  it("YAML の重複キーでは null を返す（yaml パッケージの uniqueKeys 既定により parse が例外を投げる）", () => {
    const dup = "vars:\n  a: 1\n  a: 2\n" + MINIMAL_YAML;
    expect(reevaluateInMemory(dup, "/tmp/x.kidori.yaml", "/tmp")).toBeNull();
  });

  it("不正な JSON では null を返す（.json 拡張子は JSON.parse を使う）", () => {
    expect(reevaluateInMemory("{ not valid json", "/tmp/x.kidori.json", "/tmp")).toBeNull();
  });

  it("有効な JSON からは issues を返す", () => {
    const json = JSON.stringify({
      meta: { project: "t", units: "mm", schemaVersion: "0.5" },
      settings: { kerf: 3, edgeTrim: 5 },
      stocks: [{ id: "s", label: "s", kind: "bar", length: 1820, width: 89, thickness: 19 }],
      parts: [{ id: "p", label: "p", qty: 1, stock: "s", length: 600 }],
    });
    const issues = reevaluateInMemory(json, "/tmp/x.kidori.json", "/tmp");
    expect(issues).not.toBeNull();
    expect(issues!.filter((i) => i.severity === "error")).toEqual([]);
  });

  describe("baseDir（stocksFile: の相対パス解決）", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-liveeval-"));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("baseDir を渡すと stocksFile: を相対解決して意味検証まで通る", () => {
      fs.writeFileSync(
        path.join(tmpDir, "stocks.yaml"),
        "stocks:\n  - { id: s, label: s, kind: bar, length: 1820, width: 89, thickness: 19 }\n",
        "utf-8",
      );
      const text =
        'meta: { project: t, units: mm, schemaVersion: "0.5" }\n' +
        "settings: { kerf: 3, edgeTrim: 5 }\n" +
        "stocksFile: stocks.yaml\n" +
        "stocks: []\n" +
        "parts:\n" +
        "  - { id: p, label: p, qty: 1, stock: s, length: 600 }\n";
      const issues = reevaluateInMemory(text, path.join(tmpDir, "x.kidori.yaml"), tmpDir);
      expect(issues).not.toBeNull();
      expect(issues!.filter((i) => i.severity === "error")).toEqual([]);
    });
  });
});
