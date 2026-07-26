/**
 * `kidori check` の hint 診断の扱い（U-HINT）のテスト。
 *
 * loader.ts はまだ hint を発行しない（発行するのは後続ユニット U-PIPE。
 * src/core/expr.ts の ExprDiagnostic を Issue へ統合する配線がまだ無い）ため、
 * ここでは `loadProjectFromRaw` をモックして hint を含む Issue[] を注入し、
 * runCheck 側の集計・exit code ロジックだけを検証する。
 *
 * 検証する契約（設計裁定 D3 の拡張）:
 *   - hint のみ: exit 0、JSON に hintCount として計上され、warningCount/errorCount
 *     は 0 のまま（hint を warning に混ぜない）
 *   - error と hint が混在: exit 1（error の有無だけで決まる）
 *   - warning と hint が混在（error なし）: exit 0
 *
 * vi.mock は本ファイルにのみ適用され、他のテストファイル（test/cli/check.test.ts 等）
 * には影響しない（vitest の vi.mock はファイルスコープ）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/loader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/loader")>();
  return {
    ...actual,
    loadProjectFromRaw: vi.fn(),
  };
});

import { loadProjectFromRaw } from "../../src/core/loader";
import { runCheck } from "../../src/cli/agentCommands";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-cli-check-hint-"));
  vi.mocked(loadProjectFromRaw).mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

interface CheckOutput {
  file: string;
  errorCount: number;
  warningCount: number;
  hintCount: number;
  diagnostics: Array<{
    path: string;
    line: number | null;
    severity: "error" | "warning" | "hint";
    message: string;
  }>;
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

describe("kidori check: hint 診断の扱い（U-HINT）", () => {
  it("hint のみの場合: exit 0、hintCount に計上され errorCount/warningCount は 0", () => {
    const p = write("project.kidori.yaml", "meta: {}\n");
    vi.mocked(loadProjectFromRaw).mockReturnValueOnce({
      project: null,
      issues: [
        { path: "vars.unused", message: "変数 '$unused' はどこからも参照されていません", severity: "hint" },
      ],
    });

    const { exitCode, out } = runCheckJson([p]);

    expect(exitCode).toBe(0);
    expect(out.errorCount).toBe(0);
    expect(out.warningCount).toBe(0);
    expect(out.hintCount).toBe(1);
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics[0].severity).toBe("hint");
  });

  it("error と hint が混在する場合: exit 1、両方が正しく集計される", () => {
    const p = write("project.kidori.yaml", "meta: {}\n");
    vi.mocked(loadProjectFromRaw).mockReturnValueOnce({
      project: null,
      issues: [
        { path: "parts[0].length", message: "規格材の長さを超過しています", severity: "error" },
        { path: "vars.unused", message: "変数 '$unused' はどこからも参照されていません", severity: "hint" },
      ],
    });

    const { exitCode, out } = runCheckJson([p]);

    expect(exitCode).toBe(1);
    expect(out.errorCount).toBe(1);
    expect(out.hintCount).toBe(1);
    expect(out.warningCount).toBe(0);
  });

  it("warning と hint が混在する場合（error なし）: exit 0、warningCount と hintCount がそれぞれ独立して計上される", () => {
    const p = write("project.kidori.yaml", "meta: {}\n");
    vi.mocked(loadProjectFromRaw).mockReturnValueOnce({
      project: null,
      issues: [
        { path: "meta.schemaVersion", message: "非対応のスキーマバージョンです", severity: "warning" },
        { path: "vars.unused", message: "変数 '$unused' はどこからも参照されていません", severity: "hint" },
      ],
    });

    const { exitCode, out } = runCheckJson([p]);

    expect(exitCode).toBe(0);
    expect(out.errorCount).toBe(0);
    expect(out.warningCount).toBe(1);
    expect(out.hintCount).toBe(1);
  });

  it("診断ゼロの場合は hintCount も 0（既存の空診断の挙動を維持）", () => {
    const p = write("project.kidori.yaml", "meta: {}\n");
    vi.mocked(loadProjectFromRaw).mockReturnValueOnce({ project: null, issues: [] });

    const { exitCode, out } = runCheckJson([p]);

    expect(exitCode).toBe(0);
    expect(out.errorCount).toBe(0);
    expect(out.warningCount).toBe(0);
    expect(out.hintCount).toBe(0);
    expect(out.diagnostics).toEqual([]);
  });
});
