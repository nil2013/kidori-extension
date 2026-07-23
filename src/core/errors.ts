/**
 * kidori のエラー型定義。
 *
 * Issue はスキーマ検証・意味検証で検出された問題1件を表す不変値である。
 * ProjectError は検証エラー（severity="error"）が1件以上存在する場合に
 * loader が投げる例外で、検出された Issue 一覧を保持する
 * （warning のみの場合は例外を投げず、呼び出し側に Issue 一覧を返す）。
 */

/** 検証で検出された1件の問題。 */
export interface Issue {
  /** 問題箇所を指す表記のパス（例: "parts[2].features[0].pos"）。 */
  path: string;
  /** 日本語のエラー・警告メッセージ。 */
  message: string;
  /** "error"（build を停止させる）または "warning"（継続可能）。 */
  severity: "error" | "warning";
}

/** kidori 固有の例外の基底クラス。 */
export class KidoriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 正本データ（project.yaml / project.json）の検証エラー。 */
export class ProjectError extends KidoriError {
  readonly issues: Issue[];

  constructor(issues: Issue[]) {
    const errorCount = issues.filter((i) => i.severity === "error").length;
    super(`project の検証に失敗しました（error ${errorCount} 件）`);
    this.issues = issues;
  }
}
