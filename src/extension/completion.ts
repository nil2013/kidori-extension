/**
 * ドメイン値補完（規格材マスタ駆動。SPECS.md §4b）。
 *
 * JSON Schema の enum では表現できない補完を拡張自身の
 * CompletionItemProvider で提供する:
 *   - stocks 区画: 規格材の種別名を候補に出し、確定と同時に
 *     label・kind・length・width・thickness の定型値一式をスニペット挿入。
 *   - length / width の値位置: 定尺候補（910 / 1820 / 2440 …）を提示。
 *
 * キー名補完・enum 補完・型検証は Red Hat YAML 拡張＋動的スキーマ
 * （schemaContributor.ts）が担うため、ここでは扱わない。
 */

import * as vscode from "vscode";
import { Presets, StockPreset } from "./presets";

/** カーソル位置が属するトップレベル区画（stocks / parts / …）を求める。 */
function topLevelSection(
  document: vscode.TextDocument,
  line: number,
): string | null {
  for (let i = line; i >= 0; i--) {
    const text = document.lineAt(i).text;
    const m = /^([A-Za-z][A-Za-z0-9]*):/.exec(text);
    if (m) {
      return m[1];
    }
  }
  return null;
}

function stockSnippet(preset: StockPreset, needsDash: boolean): vscode.SnippetString {
  const prefix = needsDash ? "- " : "";
  const body =
    `${prefix}{ id: \${1:${preset.id}}, label: "${preset.name}", ` +
    `kind: ${preset.kind}, length: ${preset.length}, width: ${preset.width}, ` +
    `thickness: ${preset.thickness}, price: \${2:0} }`;
  return new vscode.SnippetString(body);
}

export function createCompletionProvider(
  getPresets: () => Presets,
): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document, position) {
      const lineText = document.lineAt(position.line).text;
      const beforeCursor = lineText.slice(0, position.character);
      const section = topLevelSection(document, position.line);
      const presets = getPresets();
      const items: vscode.CompletionItem[] = [];

      // length / width の値位置: 定尺候補。
      const dimMatch = /(length|width):\s*([0-9]*)$/.exec(beforeCursor);
      if (dimMatch) {
        const key = dimMatch[1] as "length" | "width";
        const values = key === "length" ? presets.lengths : presets.widths;
        for (const v of values) {
          const item = new vscode.CompletionItem(
            String(v),
            vscode.CompletionItemKind.Value,
          );
          item.detail = `定尺 ${v} mm`;
          item.sortText = String(v).padStart(6, "0");
          if (dimMatch[2].length > 0) {
            item.range = new vscode.Range(
              position.line,
              position.character - dimMatch[2].length,
              position.line,
              position.character,
            );
          }
          items.push(item);
        }
        return items;
      }

      // stocks 区画: 規格材プリセットの一括挿入。
      if (section === "stocks") {
        const trimmed = beforeCursor.trim();
        // 新しい配列要素の書き始め（空行・"-" のみ・"- " まで）に限る。
        const isNewEntry = trimmed === "" || trimmed === "-";
        if (isNewEntry) {
          const needsDash = !trimmed.startsWith("-");
          for (const preset of presets.stocks) {
            const kindLabel = preset.kind === "bar" ? "長尺材" : "板材";
            const item = new vscode.CompletionItem(
              `${preset.name}（${preset.length}×${preset.width}×${preset.thickness}）`,
              vscode.CompletionItemKind.Struct,
            );
            item.detail = `${kindLabel} — 寸法一式を挿入`;
            item.documentation = new vscode.MarkdownString(
              `\`{ id: ${preset.id}, kind: ${preset.kind}, length: ${preset.length}, width: ${preset.width}, thickness: ${preset.thickness} }\` を挿入します。`,
            );
            item.insertText = stockSnippet(preset, needsDash);
            item.filterText = `${preset.name} ${preset.id}`;
            if (trimmed === "-") {
              // "-" 直後の場合は "- " ごと置き換える。
              const dashIndex = lineText.indexOf("-");
              item.range = new vscode.Range(
                position.line,
                dashIndex,
                position.line,
                position.character,
              );
              item.insertText = stockSnippet(preset, true);
            }
            items.push(item);
          }
        }
        return items;
      }

      return items;
    },
  };
}
