/**
 * `kidori check <ファイル>` のテスト（SPECS.md §3b）。
 *
 * 検証本体は `loadProjectFromRaw`（src/core/loader.ts）をそのまま呼ぶため
 * （設計裁定 D4）、意味検証の網羅はここでは検証しない（loader.test.ts の責務）。
 * ここで検証するのは本ユニット固有の価値、すなわち:
 *   - JSON 出力の形（file/errorCount/warningCount/diagnostics、各診断の
 *     path/line/severity/message）と exit code の対応（設計裁定 D3）。
 *   - **行番号写像の正しさ**（設計裁定 D1・D2）。意図的に不正な値を仕込んだ
 *     YAML/JSON の「その行」を報告できているかを実際に数えて検証する。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SUPPORTED_SCHEMA_VERSION } from "../../src/core/loader";
import { runCheck } from "../../src/cli/agentCommands";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-cli-check-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

/** check の JSON 出力の型（本テストの検証用の最小定義。src 側 export とは独立）。 */
interface CheckOutput {
  file: string;
  errorCount: number;
  warningCount: number;
  diagnostics: Array<{
    path: string;
    line: number | null;
    severity: "error" | "warning";
    message: string;
  }>;
}

/** runCheck を呼び、stdout に出た1回分の JSON をパースして返す。 */
function runCheckJson(args: string[]): { exitCode: number; stderr: string[]; out: CheckOutput } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = runCheck(
    args,
    (s) => stdout.push(s),
    (s) => stderr.push(s),
  );
  expect(stdout).toHaveLength(1);
  return { exitCode, stderr, out: JSON.parse(stdout[0]) as CheckOutput };
}

/** 行番号を数え上げるための小道具（1-indexed。fixture の可読性のためテンプレートで組む）。 */
function lineOf(text: string, needle: string): number {
  const idx = text.split("\n").findIndex((l) => l.includes(needle));
  if (idx === -1) {
    throw new Error(`fixture に "${needle}" を含む行がありません`);
  }
  return idx + 1;
}

describe("kidori check: 出力契約と exit code", () => {
  it("error 診断がある場合: exit 1、diagnostics に path/line/severity/message を含む", () => {
    const body = `meta: { project: t, units: mm, schemaVersion: "${SUPPORTED_SCHEMA_VERSION}" }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - id: p1
    label: 部材
    qty: 1
    stock: b1
    length: 9999
`;
    const p = write("project.kidori.yaml", body);
    const { exitCode, out } = runCheckJson([p]);

    expect(exitCode).toBe(1);
    expect(out.file).toBe(path.resolve(p));
    expect(out.errorCount).toBeGreaterThan(0);
    expect(out.diagnostics.length).toBe(out.errorCount + out.warningCount);

    const lengthIssue = out.diagnostics.find((d) => d.path === "parts[0].length");
    expect(lengthIssue).toBeDefined();
    expect(lengthIssue!.severity).toBe("error");
    expect(lengthIssue!.message).toContain("超過");
    expect(lengthIssue!.line).toBe(lineOf(body, "length: 9999"));
  });

  it("warning のみの場合: exit 0、warning も JSON に報告される", () => {
    // schemaVersion をわざと想定外にして warning を1件だけ発生させる
    // （項目7。loader.test.ts の裏取り: 不一致は error ではなく warning）。
    const body = `meta: { project: t, units: mm, schemaVersion: "0.0-not-supported" }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`;
    const p = write("project.kidori.yaml", body);
    const { exitCode, out } = runCheckJson([p]);

    expect(exitCode).toBe(0);
    expect(out.errorCount).toBe(0);
    expect(out.warningCount).toBeGreaterThan(0);
    const w = out.diagnostics.find((d) => d.path === "meta.schemaVersion");
    expect(w).toBeDefined();
    expect(w!.severity).toBe("warning");
  });

  it("診断ゼロの場合: exit 0、diagnostics は空配列", () => {
    const body = `meta: { project: t, units: mm, schemaVersion: "${SUPPORTED_SCHEMA_VERSION}" }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`;
    const p = write("project.kidori.yaml", body);
    const { exitCode, out } = runCheckJson([p]);

    expect(exitCode).toBe(0);
    expect(out.errorCount).toBe(0);
    expect(out.warningCount).toBe(0);
    expect(out.diagnostics).toEqual([]);
  });
});

describe("kidori check: 行番号写像（D1・D2）", () => {
  it("ネストした features[].pos の行を正確に指す（意図的に範囲外の値を仕込む）", () => {
    const body = `meta: { project: t, units: mm, schemaVersion: "${SUPPORTED_SCHEMA_VERSION}" }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - id: p1
    label: 部材
    qty: 1
    stock: b1
    length: 500
    features:
      - type: groove
        face: front
        dir: across
        pos: 99999
        width: 7
        depth: 6
        end: through
`;
    const p = write("project.kidori.yaml", body);
    const { out } = runCheckJson([p]);

    const issue = out.diagnostics.find((d) => d.path === "parts[0].features[0].pos");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("error");
    // pos の値そのものが書かれている行を実際に数えて突き合わせる
    // （line フィールドが「キーが存在する」以上の意味を持つことの証明）。
    expect(issue!.line).toBe(lineOf(body, "pos: 99999"));
  });

  it("配列要素側にも正しい行を割り当てる（stocks[1] が壊れている場合）", () => {
    const body = `meta: { project: t, units: mm, schemaVersion: "${SUPPORTED_SCHEMA_VERSION}" }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
  - id: b2
    label: 板
    kind: sheet
    length: 1820
    width: 910
    thickness: -5
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`;
    const p = write("project.kidori.yaml", body);
    const { out } = runCheckJson([p]);

    const issue = out.diagnostics.find((d) => d.path === "stocks[1].thickness");
    expect(issue).toBeDefined();
    expect(issue!.line).toBe(lineOf(body, "thickness: -5"));
  });

  it("JSON 入力（*.kidori.json）でも行番号を解決できる", () => {
    const body = JSON.stringify(
      {
        meta: { project: "t", units: "mm", schemaVersion: SUPPORTED_SCHEMA_VERSION },
        stocks: [
          { id: "b1", label: "棒", kind: "bar", length: 1820, width: 89, thickness: 19 },
        ],
        parts: [{ id: "p1", label: "部材", qty: 1, stock: "b1", length: 9999 }],
      },
      null,
      2,
    );
    const p = write("project.kidori.json", body);
    const { exitCode, out } = runCheckJson([p]);

    expect(exitCode).toBe(1);
    const issue = out.diagnostics.find((d) => d.path === "parts[0].length");
    expect(issue).toBeDefined();
    expect(issue!.line).toBe(lineOf(body, "9999"));
  });

  it("stocksFile 由来の issue（path: 'stocksFile'）を主ファイルの該当行に写像する", () => {
    const body = `stocksFile: ./missing-stocks.yaml
meta: { project: t, units: mm, schemaVersion: "${SUPPORTED_SCHEMA_VERSION}" }
stocks: []
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`;
    const p = write("project.kidori.yaml", body);
    const { exitCode, out } = runCheckJson([p]);

    expect(exitCode).toBe(1);
    const issue = out.diagnostics.find((d) => d.path === "stocksFile");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("error");
    expect(issue!.message).toContain("読み込めませんでした");
    expect(issue!.line).toBe(lineOf(body, "stocksFile: ./missing-stocks.yaml"));
  });

  it("トップレベルが配列など不正な形なら <root> を診断1件として報告する", () => {
    const body = `- 1\n- 2\n`;
    const p = write("project.kidori.yaml", body);
    const { exitCode, out } = runCheckJson([p]);

    expect(exitCode).toBe(1);
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics[0].path).toBe("<root>");
    expect(out.diagnostics[0].severity).toBe("error");
  });
});

describe("kidori check: 構文エラー・IO エラー", () => {
  it("YAML 構文エラーは診断1件（<root>、可能なら行番号つき）として exit 1", () => {
    const body = "meta: { project: t\nstocks: [\n";
    const p = write("broken.kidori.yaml", body);
    const { exitCode, out } = runCheckJson([p]);

    expect(exitCode).toBe(1);
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics[0].path).toBe("<root>");
    expect(out.diagnostics[0].severity).toBe("error");
    expect(out.diagnostics[0].message).toContain("構文エラー");
    // yaml パッケージの YAMLParseError は linePos を持つため、null に縮退しない。
    expect(out.diagnostics[0].line).not.toBeNull();
  });

  it("ファイルが存在しない場合は exit 2（JSON は出さない）", () => {
    const missing = path.join(dir, "does-not-exist.kidori.yaml");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = runCheck(
      [missing],
      (s) => stdout.push(s),
      (s) => stderr.push(s),
    );

    expect(exitCode).toBe(2);
    expect(stdout).toHaveLength(0);
    expect(stderr.some((s) => s.includes("読み込めません"))).toBe(true);
  });
});

describe("kidori check: 引数エラー", () => {
  it("引数を省略すると UsageError を送出する（呼び出し側で exit 2 に変換される規約）", () => {
    expect(() => runCheck([])).toThrowError(/対象ファイルを指定/);
  });

  it("複数ファイルは拒否する", () => {
    const p1 = write("a.kidori.yaml", "meta: {}\n");
    const p2 = write("b.kidori.yaml", "meta: {}\n");
    expect(() => runCheck([p1, p2])).toThrowError(/1つだけ/);
  });
});
