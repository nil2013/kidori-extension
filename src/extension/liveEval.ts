/**
 * 編集時の再評価（SPECS.md §4b:188「vars 変更時の再評価」、設計裁定 D2）。
 *
 * D2（Fable-tier Supervisor 裁定・再検討禁止）: プレビュー（Webview の木取り図・
 * 加工指示図）は保存駆動のまま（SPECS.md §3:51-53「保存 → ビルド → Webview
 * 即時更新」は仕様として固定）。ただし**診断・ホバー・補完**は編集時更新が
 * 要求される。本モジュールは「診断」側の実質的な新規部分 — debounce 付きの
 * メモリ上 `loadProjectFromRaw` 実行 — を、vscode に一切依存しない純関数として
 * 提供する（D3 と同じテスト可能性のモチベーション。debounce タイマー管理と
 * vscode.Diagnostic への変換は呼び出し側 `extension.ts` が担う）。
 *
 * パース不能（構文エラー・`uniqueKeys: true` による重複キー等）時は `null` を
 * 返す。呼び出し側はこれを「前回の診断を維持する」（D2 の要求。上書きせず
 * 何もしない）というシグナルとして扱う。`schemaContributor.ts` の
 * `SchemaContributor.update`（編集途中の不正 YAML/JSON では直前の stockIds を
 * 維持する）と同型の防御である。
 */

import { parse as parseYaml } from "yaml";

import { Issue } from "../core/errors";
import { loadProjectFromRaw } from "../core/loader";

/**
 * ドキュメントの現在のテキスト（保存前のバッファでもよい）から意味診断を
 * メモリ上で再計算する。
 *
 * @param documentText 現在のバッファ内容（未保存でもよい。D2 の核心）。
 * @param fsPath ドキュメントのファイルパス（`.json` 拡張子判定にのみ使う。
 *   ディスクは読まない）。
 * @param baseDir `stocksFile:` の相対パス解決基準（通常は `path.dirname(fsPath)`）。
 * @returns 診断一覧。パース不能なら `null`（前回診断を維持せよ、のシグナル）。
 */
export function reevaluateInMemory(
  documentText: string,
  fsPath: string,
  baseDir: string,
): Issue[] | null {
  let raw: unknown;
  try {
    raw = fsPath.endsWith(".json") ? JSON.parse(documentText) : parseYaml(documentText);
  } catch {
    return null;
  }
  const { issues } = loadProjectFromRaw(raw, { baseDir });
  return issues;
}
