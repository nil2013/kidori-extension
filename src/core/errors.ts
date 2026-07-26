/**
 * kidori のエラー型定義。
 *
 * Issue はスキーマ検証・意味検証で検出された問題1件を表す不変値である。
 * ProjectError は検証エラー（severity="error"）が1件以上存在する場合に
 * loader が投げる例外で、検出された Issue 一覧を保持する
 * （warning・hint のみの場合は例外を投げず、呼び出し側に Issue 一覧を返す）。
 */

import type { ExprDiagnostic } from "./expr";

/** 検証で検出された1件の問題。 */
export interface Issue {
  /** 問題箇所を指す表記のパス（例: "parts[2].features[0].pos"）。 */
  path: string;
  /** 日本語のエラー・警告メッセージ。 */
  message: string;
  /**
   * "error"（build を停止させる） / "warning"（継続可能） / "hint"（warning より
   * さらに弱い情報。例: 未使用変数。SPECS.md §4d:259「同名変数はエラー、未使用変数は
   * hint」・U-HINT）。exit code 上は warning・hint いずれも error 扱いにしない
   * （src/cli/agentCommands.ts の runCheck 参照）。
   */
  severity: "error" | "warning" | "hint";
}

/**
 * 式解決器（src/core/expr.ts）の {@link ExprDiagnostic} を {@link Issue} へ変換する。
 *
 * ExprDiagnostic.severity（"error"|"hint"）は Issue.severity の値集合の真部分集合
 * なので、値そのものの変換は不要（構造的に代入可能）。それでも独立した変換関数を
 * 用意するのは、呼び出し側（意味検証層に式解決の結果を統合する側。設計上は
 * U-PIPE が担う）に「ExprDiagnostic → Issue の変換はここを通す」という単一の窓口を
 * 与えるためである（expr.ts 自身は Issue／errors.ts に一切依存しない設計を保つ。
 * expr.ts 冒頭コメント参照）。
 */
export function issueFromExprDiagnostic(d: ExprDiagnostic): Issue {
  return { path: d.path, message: d.message, severity: d.severity };
}

/** kidori 固有の例外の基底クラス。 */
export class KidoriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 正本データ（kidori ファイル）の検証エラー。 */
export class ProjectError extends KidoriError {
  readonly issues: Issue[];

  constructor(issues: Issue[]) {
    const errorCount = issues.filter((i) => i.severity === "error").length;
    super(`project の検証に失敗しました（error ${errorCount} 件）`);
    this.issues = issues;
  }
}
