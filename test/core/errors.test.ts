/**
 * src/core/errors.ts のテスト（U-HINT）。
 *
 * 検証する契約:
 *   1. `Issue.severity` が "hint" を型・実行時の両方で受け付けること
 *   2. `ProjectError` の error 件数集計（既存の `errorCount` の意味）が
 *      hint 追加後も変わらないこと（回帰防止。hint を error として数えない）
 *   3. `issueFromExprDiagnostic`（式解決器 src/core/expr.ts の ExprDiagnostic →
 *      Issue への橋渡し）が実際の resolveVars の出力に対して正しく変換すること
 *
 * expr.ts 自体は本ユニットの担当外（読むのみ）なので、ここでは実装済みの
 * `resolveVars`（test/core/expr.test.ts が既に検証済みの未使用変数 hint の実例）を
 * そのまま使い、変換の入出力の対応だけを見る。
 */

import { describe, expect, it } from "vitest";

import { resolveVars } from "../../src/core/expr";
import { Issue, ProjectError, issueFromExprDiagnostic } from "../../src/core/errors";

describe("Issue.severity: hint を含む3値", () => {
  it("hint を持つ Issue を型・実行時ともに構築できる", () => {
    const issue: Issue = {
      path: "vars.unused",
      message: "変数 '$unused' はどこからも参照されていません",
      severity: "hint",
    };
    expect(issue.severity).toBe("hint");
  });

  it("error/warning の既存の値も引き続き受け付ける（回帰防止）", () => {
    const error: Issue = { path: "p", message: "m", severity: "error" };
    const warning: Issue = { path: "p", message: "m", severity: "warning" };
    expect(error.severity).toBe("error");
    expect(warning.severity).toBe("warning");
  });
});

describe("ProjectError: errorCount は severity===\"error\" のみを数える（hint 追加後の回帰防止）", () => {
  it("hint のみでは errorCount が 0 のまま（メッセージにも 0 件と出る）", () => {
    const issues: Issue[] = [
      { path: "vars.unused", message: "未使用です", severity: "hint" },
    ];
    const err = new ProjectError(issues);
    expect(err.message).toContain("error 0 件");
    expect(err.issues).toEqual(issues);
  });

  it("error と hint が混在すると error 件数だけを数える", () => {
    const issues: Issue[] = [
      { path: "a", message: "エラーです", severity: "error" },
      { path: "vars.unused", message: "未使用です", severity: "hint" },
      { path: "b", message: "警告です", severity: "warning" },
    ];
    const err = new ProjectError(issues);
    expect(err.message).toContain("error 1 件");
  });
});

describe("issueFromExprDiagnostic: ExprDiagnostic → Issue の橋渡し", () => {
  it("resolveVars が返す実際の hint 診断を Issue に変換できる", () => {
    const resolution = resolveVars(
      { used: 10, unused: 20, total: "$used + 5" },
      { usedElsewhere: new Set(["total"]) },
    );
    const hintDiagnostics = resolution.diagnostics.filter((d) => d.severity === "hint");
    expect(hintDiagnostics).toHaveLength(1);

    const issues = hintDiagnostics.map(issueFromExprDiagnostic);
    expect(issues).toEqual([
      {
        path: "vars.unused",
        message: "変数 '$unused' はどこからも参照されていません",
        severity: "hint",
      },
    ]);
    // 変換後も Issue として扱える（型上の検算）。
    const issue: Issue = issues[0];
    expect(issue.severity).toBe("hint");
  });

  it("resolveVars が返す error 診断（循環参照）も severity を保ったまま変換できる", () => {
    const resolution = resolveVars({ a: "$b", b: "$a" });
    const errorDiagnostics = resolution.diagnostics.filter((d) => d.severity === "error");
    expect(errorDiagnostics.length).toBeGreaterThan(0);

    const issues = errorDiagnostics.map(issueFromExprDiagnostic);
    expect(issues.every((i) => i.severity === "error")).toBe(true);
    expect(issues.map((i) => i.path)).toEqual(errorDiagnostics.map((d) => d.path));
    expect(issues.map((i) => i.message)).toEqual(errorDiagnostics.map((d) => d.message));
  });
});
