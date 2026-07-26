/**
 * `kidori check --resolved` のテスト（SPECS.md §3b:100・§4d:274。U-RESOLVED）。
 *
 * `--resolved` 指定時のみ `resolvedValues`（`path`・`expression`・`value`・
 * `unit: "mm"`）を JSON に併記する契約と、既存の出力契約（`--resolved` 非指定時は
 * `resolvedValues` を出さない）を壊していないことを検証する。式解決の意味論
 * そのもの（vars の循環検出・未定義参照等）は test/core/expr.test.ts・
 * test/core/loader.test.ts の責務であり、ここでは検証しない（設計裁定 D4 と
 * 同じ理由。test/cli/check.test.ts の冒頭コメント参照）。
 *
 * fixture は SPECS.md §4d:238 の例（`vars.inset` + `vars.matingAllowance`
 * → 88 mm）と §4c のウマの例（`ref: leg` で木口寸法を導出する `marks`）を
 * 組み合わせたもの。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SUPPORTED_SCHEMA_VERSION } from "../../src/core/loader";
import { runCheck } from "../../src/cli/agentCommands";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-cli-check-resolved-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

/** `--resolved` の出力を含む可能性がある check の JSON 出力の型（本テスト用の最小定義）。 */
interface CheckOutput {
  file: string;
  errorCount: number;
  warningCount: number;
  hintCount: number;
  diagnostics: Array<{ path: string; line: number | null; severity: string; message: string }>;
  resolvedValues?: Array<{ path: string; expression: string; value: number; unit: "mm" }>;
}

function runCheckJson(args: string[]): { exitCode: number; out: CheckOutput } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = runCheck(
    args,
    (s) => stdout.push(s),
    (s) => stderr.push(s),
  );
  expect(stdout).toHaveLength(1);
  return { exitCode, out: JSON.parse(stdout[0]) as CheckOutput };
}

/**
 * SPECS.md §4d:238 の例（`vars.inset: 50` + `vars.matingAllowance: 38` →
 * `"$inset + $matingAllowance"` = 88）と §4c の `ref: leg` 導出＋裸のエイリアス
 * `y: top` を組み合わせた、診断ゼロの正本。
 */
function umaBody(): string {
  return `meta: { project: t, units: mm, schemaVersion: "${SUPPORTED_SCHEMA_VERSION}" }

vars:
  inset: 50
  matingAllowance: 38

stocks:
  - { id: 2x4-6f, label: "2x4材", kind: bar, length: 1820, width: 89, thickness: 38 }

parts:
  - { id: leg,      label: 足,   stock: 2x4-6f, length: 800 }
  - { id: beam-top, label: 天板, stock: 2x4-6f, length: 850 }

assemblies:
  - id: uma-1
    label: ウマ
    contains: { leg: 2, beam-top: 1 }
    marks:
      - { on: beam-top, face: front, ref: leg, x: "$inset + $matingAllowance", y: top, note: 足当たり面 }
`;
}

describe("kidori check --resolved: 出力契約（既存契約の保存）", () => {
  it("--resolved を指定しない場合、resolvedValues 自体が JSON に出ない", () => {
    const p = write("uma.kidori.yaml", umaBody());
    const { exitCode, out } = runCheckJson([p]);

    expect(exitCode).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(out, "resolvedValues")).toBe(false);
  });

  it("--resolved を指定した場合、式を含む正本で resolvedValues が正しい値を持つ（SPECS.md §4d:238 の例の再現）", () => {
    const p = write("uma.kidori.yaml", umaBody());
    const { exitCode, out } = runCheckJson(["--resolved", p]);

    expect(exitCode).toBe(0);
    expect(out.errorCount).toBe(0);
    expect(out.resolvedValues).toBeDefined();

    const xEntry = out.resolvedValues!.find((r) => r.path === "assemblies[0].marks[0].x");
    expect(xEntry).toEqual({
      path: "assemblies[0].marks[0].x",
      expression: "$inset + $matingAllowance",
      value: 88,
      unit: "mm",
    });
  });

  it("裸のエイリアス（marks[].y: top）も resolvedValues に含まれる（位置式は非自明なので価値がある）", () => {
    const p = write("uma.kidori.yaml", umaBody());
    const { out } = runCheckJson(["--resolved", p]);

    const yEntry = out.resolvedValues!.find((r) => r.path === "assemblies[0].marks[0].y");
    expect(yEntry).toBeDefined();
    expect(yEntry!.expression).toBe("top");
    expect(typeof yEntry!.value).toBe("number");
    expect(yEntry!.unit).toBe("mm");
  });

  it("診断が0件でも resolvedValues が出る（SPECS.md §3b:100「診断が0件でも」）", () => {
    const p = write("uma.kidori.yaml", umaBody());
    const { out } = runCheckJson(["--resolved", p]);

    expect(out.diagnostics).toEqual([]);
    expect(out.resolvedValues!.length).toBeGreaterThan(0);
  });

  it("式を使っていない正本では resolvedValues が空配列になる（対象は式が書かれたフィールドのみ）", () => {
    const body = `meta: { project: t, units: mm, schemaVersion: "${SUPPORTED_SCHEMA_VERSION}" }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`;
    const p = write("literal.kidori.yaml", body);
    const { out } = runCheckJson(["--resolved", p]);

    expect(out.resolvedValues).toEqual([]);
  });

  it("resolvedValues は path の辞書順（string 昇順）に並ぶ", () => {
    const p = write("uma.kidori.yaml", umaBody());
    const { out } = runCheckJson(["--resolved", p]);

    const paths = out.resolvedValues!.map((r) => r.path);
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
  });

  it("JSON 入力（*.kidori.json）でも --resolved が動く", () => {
    const body = JSON.stringify(
      {
        meta: { project: "t", units: "mm", schemaVersion: SUPPORTED_SCHEMA_VERSION },
        vars: { inset: 50, matingAllowance: 38 },
        stocks: [
          { id: "2x4-6f", label: "2x4材", kind: "bar", length: 1820, width: 89, thickness: 38 },
        ],
        parts: [
          { id: "leg", label: "足", stock: "2x4-6f", length: 800 },
          { id: "beam-top", label: "天板", stock: "2x4-6f", length: 850 },
        ],
        assemblies: [
          {
            id: "uma-1",
            label: "ウマ",
            contains: { leg: 2, "beam-top": 1 },
            marks: [
              {
                on: "beam-top",
                face: "front",
                ref: "leg",
                x: "$inset + $matingAllowance",
                y: "top",
                note: "足当たり面",
              },
            ],
          },
        ],
      },
      null,
      2,
    );
    const p = write("uma.kidori.json", body);
    const { exitCode, out } = runCheckJson(["--resolved", p]);

    expect(exitCode).toBe(0);
    const xEntry = out.resolvedValues!.find((r) => r.path === "assemblies[0].marks[0].x");
    expect(xEntry?.value).toBe(88);
  });
});

describe("kidori check --resolved: error との関係（Supervisor 裁定 D1/D2。本丸）", () => {
  it("error がある場合でも、正常に解決された式は resolvedValues に残る（1件壊れ＋複数正常。§3b:100「正常な式を含めて」に error-free の前提条件は無い）", () => {
    const body = `meta: { project: t, units: mm, schemaVersion: "${SUPPORTED_SCHEMA_VERSION}" }
vars:
  inset: 50
  matingAllowance: 38
stocks:
  - { id: 2x4-6f, label: "2x4材", kind: bar, length: 1820, width: 89, thickness: 38 }
parts:
  - { id: leg,      label: 足,   stock: 2x4-6f, length: 800 }
  - { id: beam-top, label: 天板, stock: 2x4-6f, length: 9999 }
assemblies:
  - id: uma-1
    label: ウマ
    contains: { leg: 2, beam-top: 1 }
    marks:
      - { on: beam-top, face: front, ref: leg, x: "$inset + $matingAllowance", y: top, note: 足当たり面 }
`;
    // beam-top.length: 9999 は式ではないリテラル数値であり、原材 2x4-6f（1820mm）に
    // 収まらないため geometry フェーズで error になる（parts[1].length）。この error は
    // marks[0].x/y の式解決とは無関係であり、両方とも解決自体は成功している。
    const p = write("uma-error.kidori.yaml", body);
    const { exitCode, out } = runCheckJson(["--resolved", p]);

    expect(exitCode).toBe(1);
    expect(out.errorCount).toBeGreaterThan(0);
    expect(
      out.diagnostics.some((d) => d.severity === "error" && d.path === "parts[1].length"),
    ).toBe(true);

    // D1 適用前はここが常に [] だった（バグ）。正常に解決された式（複数）は残る。
    expect(out.resolvedValues).toBeDefined();
    const xEntry = out.resolvedValues!.find((r) => r.path === "assemblies[0].marks[0].x");
    expect(xEntry).toEqual({
      path: "assemblies[0].marks[0].x",
      expression: "$inset + $matingAllowance",
      value: 88,
      unit: "mm",
    });
    const yEntry = out.resolvedValues!.find((r) => r.path === "assemblies[0].marks[0].y");
    expect(yEntry).toBeDefined();
    expect(yEntry!.expression).toBe("top");
  });

  it("有限性ガード: 失敗フィールド由来の NaN が marks の位置式（揃えエイリアス）に伝播しても resolvedValues に載らず、value: null が JSON に一切現れない。かつ追加の診断は出ない（D3）", () => {
    const body = `meta: { project: t, units: mm, schemaVersion: "${SUPPORTED_SCHEMA_VERSION}" }
vars:
  inset: 50
stocks:
  - { id: 2x4-6f, label: "2x4材", kind: bar, length: 1820, width: 89, thickness: 38 }
parts:
  - { id: leg,      label: 足,   stock: 2x4-6f, length: 800 }
  - { id: beam-top, label: 天板, stock: 2x4-6f, length: "$missingVar + 100" }
assemblies:
  - id: uma-1
    label: ウマ
    contains: { leg: 2, beam-top: 1 }
    marks:
      - { on: beam-top, face: front, ref: leg, x: "right - 40", y: top, note: test }
`;
    // beam-top.length の式が未定義変数参照で解決失敗 → NaN。marks[0].x は
    // resolveMarkAxisSpans 経由でその NaN を axisSpan として使う揃えエイリアス
    // （right）を含むため、evaluateExpr 自体は成立（ok: true）するが値が NaN になる
    // （唯一の汚染経路）。marks[0].y（top）は effectiveWidth 由来で NaN と無関係。
    const p = write("uma-nan.kidori.yaml", body);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = runCheck(
      ["--resolved", p],
      (s) => stdout.push(s),
      (s) => stderr.push(s),
    );
    expect(stdout).toHaveLength(1);
    const rawJson = stdout[0];
    const out = JSON.parse(rawJson) as CheckOutput;

    expect(exitCode).toBe(1);
    // value: null は契約外の形（JSON.stringify(NaN) === "null"）。JSON 文字列上に
    // 一切現れないことを直接確認する（診断側の line: null は正当な既存契約なので
    // "value": null というキー付き部分文字列だけを狙う）。
    expect(rawJson.includes('"value": null')).toBe(false);

    // 根本原因（"$missingVar" 未定義）は parts[1].length に1件だけ報告される
    // （二重報告禁止。D3）。checkMarksGeometry が mark.x=NaN を独立に検出して
    // assemblies[0].marks[0].x に別文言（"0以上でなければ"・"面外"）の error を
    // 追加で出すのは、D1/D2 の変更前から存在する既存動作（test/core/loader.test.ts
    // の同名テストで git stash による実機比較済み）であり、ここでは検証対象にしない。
    const undefinedVarDiagnostics = out.diagnostics.filter(
      (d) => d.severity === "error" && d.message.includes("$missingVar"),
    );
    expect(undefinedVarDiagnostics).toHaveLength(1);
    expect(undefinedVarDiagnostics[0].path).toBe("parts[1].length");

    // NaN 汚染した x は resolvedValues に載らず、汚染していない y は載る。
    expect(
      out.resolvedValues!.some((r) => r.path === "assemblies[0].marks[0].x"),
    ).toBe(false);
    const yEntry = out.resolvedValues!.find((r) => r.path === "assemblies[0].marks[0].y");
    expect(yEntry).toBeDefined();
    expect(Number.isFinite(yEntry!.value)).toBe(true);
  });

  it("構文エラーの場合: resolvedValues は空配列（何も解決していないため）", () => {
    const body = "meta: { project: t\nstocks: [\n";
    const p = write("broken.kidori.yaml", body);
    const { exitCode, out } = runCheckJson(["--resolved", p]);

    expect(exitCode).toBe(1);
    expect(out.resolvedValues).toEqual([]);
  });

  it("解決フェーズに到達する前の error（層1の enum 違反）の場合: resolvedValues は空配列（何も解決していないため）", () => {
    const body = `meta: { project: t, units: mm, schemaVersion: "${SUPPORTED_SCHEMA_VERSION}" }
settings:
  selectedPlan: D
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19 }
parts:
  - { id: p1, label: 部材, qty: 1, stock: b1, length: 500 }
`;
    const p = write("bad-plan.kidori.yaml", body);
    const { exitCode, out } = runCheckJson(["--resolved", p]);

    expect(exitCode).toBe(1);
    expect(out.resolvedValues).toEqual([]);
  });
});

describe("kidori check --resolved: 引数エラー", () => {
  it("未知のオプション（--bogus）は UsageError を送出する（main.ts で exit 2 に変換される規約。check.test.ts の既存の引数エラーテストと同じ形）", () => {
    const p = write("uma.kidori.yaml", umaBody());
    expect(() => runCheck(["--bogus", p])).toThrowError(/不明なオプション/);
  });

  it("--resolved のみでファイル未指定は UsageError（呼び出し側で exit 2 に変換される規約）", () => {
    expect(() => runCheck(["--resolved"])).toThrowError(/対象ファイルを指定/);
  });
});
