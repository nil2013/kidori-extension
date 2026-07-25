/**
 * ドメイン値補完（規格材マスタの4層カスケード駆動。SPECS.md §4b）。
 *
 * JSON Schema の enum では表現できない補完を拡張自身の
 * CompletionItemProvider で提供する:
 *   - stocks 区画: カスケード（ビルトイン → ユーザー → ディレクトリ →
 *     ファイル内）が供給する規格材を候補に出し、確定と同時に実値一式と
 *     `preset:` 来歴キーを正本へ実体化する（スニペット展開）。
 *   - length / width の値位置: 定尺候補（910 / 1820 / 2440 …）を提示。
 *
 * 「カスケードは補完候補の供給構造であって、ビルドの解決機構ではない」
 * （SPECS.md §4b）。実体化そのものは `core/stocks/materialize.ts` が担い、
 * 本モジュールはそれを VS Code のスニペット（`id` を tabstop に包む）へ
 * 変換する薄いラッパに徹する。同じ実体化コードを CLI の `kidori new` も使う。
 *
 * キー名補完・enum 補完・型検証は Red Hat YAML 拡張＋動的スキーマ
 * （schemaContributor.ts）が担うため、ここでは扱わない。
 *
 * 登録対象は YAML のみ。ドメイン値補完は手書き YAML 経路の支援であり、
 * JSON は機械生成・他ツール連携用途（SPECS.md §4a）のため対象外とする。
 * コンテキスト判定（topLevelSection）も YAML の行頭キー（`key:`）を
 * 前提としており、JSON の構文では機能しない。
 */

import * as vscode from "vscode";

import {
  ResolvedStock,
  StockMaster,
  defaultStockId,
  formatFields,
  isInsertable,
  materializeEntry,
  materializeFields,
  resolveCascade,
} from "../core/stocks";

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

/** スニペット構文の予約文字（`$` `}` `\`）をエスケープする。 */
export function escapeSnippet(value: string): string {
  return value.replace(/[\\$}]/g, (c) => `\\${c}`);
}

/**
 * 挿入候補として提示してよい層か。
 *
 * 層4（編集中ファイルのインライン定義）は除外する。自分のファイルの既存
 * エントリを再挿入すると、`preset:` が同一ファイル内の別エントリの id を
 * 指す複製が生まれ、来歴として無意味なうえ id 衝突の入口になるため。
 * 層4 をカスケードから外すわけではない（シャドウ判定と、schemaContributor
 * が担う `parts[].stock` の enum 供給には引き続き効く。SPECS.md §4b）。
 */
export function isOfferable(stock: ResolvedStock): boolean {
  return stock.layer !== "file";
}

/**
 * 補完確定時に正本へ実体化されるスニペット本文。
 *
 * 実体化の中身（フィールドの順序・`preset` の位置・`price` の条件付き出力・
 * YAML エスケープ）は core の `materializeFields` が単一ソース。ここでは
 * それを VS Code スニペットに載せるだけ:
 *   - 値をスニペット予約文字についてエスケープする
 *   - `id` の値だけを tabstop `${1:…}` に包む（確定直後に id を編集できる）
 */
export function stockSnippetBody(stock: ResolvedStock, needsDash: boolean): string {
  const fields = materializeFields(stock).map((field) => ({
    key: field.key,
    value:
      field.key === "id"
        ? `\${1:${escapeSnippet(field.value)}}`
        : escapeSnippet(field.value),
  }));
  return `${needsDash ? "- " : ""}${formatFields(fields)}`;
}

function stockSnippet(stock: ResolvedStock, needsDash: boolean): vscode.SnippetString {
  return new vscode.SnippetString(stockSnippetBody(stock, needsDash));
}

export function createCompletionProvider(
  getMaster: () => StockMaster,
): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document, position) {
      const lineText = document.lineAt(position.line).text;
      const beforeCursor = lineText.slice(0, position.character);
      const section = topLevelSection(document, position.line);
      const items: vscode.CompletionItem[] = [];

      // 4層カスケードをその場で解決する（層3・4 は編集中ファイル依存）。
      const cascade = resolveCascade(getMaster(), {
        documentPath: document.uri.fsPath,
        documentText: document.getText(),
      });

      // length / width の値位置: 定尺候補。
      const dimMatch = /(length|width):\s*([0-9]*)$/.exec(beforeCursor);
      if (dimMatch) {
        const key = dimMatch[1] as "length" | "width";
        const values = key === "length" ? cascade.lengths : cascade.widths;
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

      // stocks 区画: 規格材の一括挿入（実値＋preset の実体化）。
      if (section === "stocks") {
        const trimmed = beforeCursor.trim();
        // 新しい配列要素の書き始め（空行・"-" のみ・"- " まで）に限る。
        const isNewEntry = trimmed === "" || trimmed === "-";
        if (isNewEntry) {
          const needsDash = !trimmed.startsWith("-");
          for (const stock of cascade.entries) {
            if (!isInsertable(stock) || !isOfferable(stock)) {
              continue;
            }
            const e = stock.entry;
            const kindLabel = e.kind === "bar" ? "長尺材" : "板材";
            const layerLabel =
              stock.layer === "builtin" ? "" : `［${LAYER_SUFFIX[stock.layer]}］`;
            const item = new vscode.CompletionItem(
              `${e.label ?? stock.key}（${e.length}×${e.width}×${e.thickness}）`,
              vscode.CompletionItemKind.Struct,
            );
            item.detail = `${kindLabel} — ${stock.key} の実値一式を挿入${layerLabel}`;
            item.documentation = new vscode.MarkdownString(
              `\`${materializeEntry(stock)}\` を挿入します。`,
            );
            item.insertText = stockSnippet(stock, needsDash);
            item.filterText = `${e.label ?? ""} ${stock.key} ${defaultStockId(stock)}`;
            if (trimmed === "-") {
              // "-" 直後の場合は "- " ごと置き換える。
              const dashIndex = lineText.indexOf("-");
              item.range = new vscode.Range(
                position.line,
                dashIndex,
                position.line,
                position.character,
              );
              item.insertText = stockSnippet(stock, true);
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

/** 候補の由来層の表示（ビルトイン以外は由来を明示する）。 */
const LAYER_SUFFIX: Record<string, string> = {
  user: "ユーザー",
  directory: "ディレクトリ",
  file: "ファイル内",
};
