/**
 * ホバー本文（SPECS.md §4d:274）を VS Code の `HoverProvider` へ接続する薄い層。
 *
 * 判定・計算そのものは `exprHover.ts` の {@link resolveHoverText}（vscode 非依存の
 * 純関数。D3）が単一の実装を持つ。本モジュールは vscode 依存の型変換
 * （`vscode.TextDocument`/`vscode.Position` → `resolveHoverText` の引数、
 * 戻り値の文字列 → `vscode.Hover`）だけを行う。
 *
 * kidori ファイル以外での発動を止めるゲートは `extension.ts` 側
 * （`contributor.isKidoriDocument`）が担う（`completion.ts` の
 * `gatedCompletion` と同じ配線パターン）。本モジュール自身は「vscode ホスト非依存の
 * 場でも動く最小面」を保つため、判定を持たない。
 */

import * as path from "node:path";
import * as vscode from "vscode";

import { resolveHoverText } from "./exprHover";

export function createHoverProvider(): vscode.HoverProvider {
  return {
    provideHover(document, position) {
      const text = resolveHoverText(
        document.getText(),
        { line: position.line, character: position.character },
        { baseDir: path.dirname(document.uri.fsPath) },
      );
      if (text === null) {
        return undefined;
      }
      return new vscode.Hover(text);
    },
  };
}
