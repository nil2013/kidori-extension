/**
 * `issueSeverityToDiagnosticSeverity`（src/extension/extension.ts）のテスト（U-HINT）。
 *
 * `applyDiagnostics` が `Issue.severity` を VS Code の `DiagnosticSeverity` へ
 * 対応づける部分だけを切り出した純粋関数。fixture ファイルの保存・ビルドを
 * 経由する結合テストにせず、対応表そのものを直接検証する。
 *
 * 検証する契約:
 *   - "error" → DiagnosticSeverity.Error（既存の対応。回帰防止）
 *   - "warning" → DiagnosticSeverity.Warning（既存の対応。回帰防止）
 *   - "hint" → DiagnosticSeverity.Hint（新設）
 *   - 規格材シャドウ通知（presets.ts）が使う Information とは異なる値であること
 *     （両者を診断コレクション上で区別できることの確認）
 */

import { describe, expect, it } from "vitest";

import { issueSeverityToDiagnosticSeverity } from "../../src/extension/extension";
import { DiagnosticSeverity } from "./vscode-mock";

describe("issueSeverityToDiagnosticSeverity: Issue.severity → DiagnosticSeverity", () => {
  it("error → DiagnosticSeverity.Error（既存の対応）", () => {
    expect(issueSeverityToDiagnosticSeverity("error")).toBe(DiagnosticSeverity.Error);
  });

  it("warning → DiagnosticSeverity.Warning（既存の対応）", () => {
    expect(issueSeverityToDiagnosticSeverity("warning")).toBe(DiagnosticSeverity.Warning);
  });

  it("hint → DiagnosticSeverity.Hint（新設。U-HINT）", () => {
    expect(issueSeverityToDiagnosticSeverity("hint")).toBe(DiagnosticSeverity.Hint);
  });

  it("hint は規格材シャドウ通知の Information とは異なる値（presets.ts と区別できる）", () => {
    expect(issueSeverityToDiagnosticSeverity("hint")).not.toBe(DiagnosticSeverity.Information);
  });
});
