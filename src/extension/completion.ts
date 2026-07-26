/**
 * ドメイン値補完（規格材マスタの4層カスケード駆動。SPECS.md §4b、寸法エイリアス・
 * ミニ式の `$vars`／揃えエイリアス補完。SPECS.md §4b:189・§4d）。
 *
 * JSON Schema の enum では表現できない補完を拡張自身の
 * CompletionItemProvider で提供する:
 *   - stocks 区画: カスケード（ビルトイン → ユーザー → ディレクトリ →
 *     ファイル内）が供給する規格材を候補に出し、確定と同時に実値一式と
 *     `preset:` 来歴キーを正本へ実体化する（スニペット展開）。
 *   - length / width の値位置: 定尺候補（910 / 1820 / 2440 …）を提示。
 *   - 式を受け付けるフィールド（`src/core/expr.ts` の `EXPR_FIELD_CAPABILITIES`
 *     が単一ソース）の値位置: ファイル内 `vars` で宣言された名前を `$名前` の
 *     形で候補に出す。`assemblies[].marks[].x`/`.y` はさらに軸別の揃えエイリアス
 *     （X: left/center/right、Y: bottom/center/top）も候補に加える（D3。
 *     揃えエイリアスは `hole.x`/`hole.y`・`groove.pos` 等の文脈非依存式フィールド
 *     には出さない — `fieldExprCapability` の `kind: "positional"` のときのみ）。
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
import { parseDocument } from "yaml";

import { fieldExprCapability } from "../core/expr";
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

/**
 * `line` から上方向に走査し、`keyNames` に含まれる（インデント任意の）キー行の
 * うち最も近いものの名前を返す（SPECS.md §4d の `marks`/`features` 判別用）。
 *
 * `topLevelSection` と同じ「最も近い一致を単純に優先する」後方走査の簡易さを
 * 踏襲する（YAML の入れ子構造を厳密には解析しない。既存の簡易さの水準に揃える。
 * 詳細は報告「決めた事項と理由」参照）。
 */
function nearestEnclosingKey(
  document: vscode.TextDocument,
  line: number,
  keyNames: readonly string[],
): string | null {
  for (let i = line; i >= 0; i--) {
    const text = document.lineAt(i).text;
    const m = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:/.exec(text);
    if (m && keyNames.includes(m[1])) {
      return m[1];
    }
  }
  return null;
}

/**
 * カーソル位置のフィールドが式を受け付けるか判定するための path パターンを、
 * `EXPR_FIELD_CAPABILITIES`（`src/core/expr.ts`。単一ソース）の
 * キー文法（`ident(.ident|[])*`、`vars.*` は特別扱い）に合わせて組み立てる。
 *
 * `topLevelSection` から得た区画名と、`fieldName`（直近のキー名）だけでは
 * `marks[].x`/`marks[].y`（揃えエイリアス可）と `hole.x`/`hole.y`（不可）の
 * 区別がつかない（どちらもフィールド名は `x`/`y`）ため、`parts`/`assemblies`
 * 区画では {@link nearestEnclosingKey} で `features`/`marks` の入れ子を
 * 追加判別する。
 *
 * 判定できない・式対象外の区画・フィールドの場合は `null`
 * （`fieldExprCapability` に投げても必ず `undefined` になるが、区画によっては
 * パターンの組み立てようがないため早期に `null` で返す）。
 */
function exprFieldPattern(
  document: vscode.TextDocument,
  line: number,
  section: string | null,
  fieldName: string,
): string | null {
  switch (section) {
    case "vars":
      return "vars.*";
    case "settings":
      return `settings.${fieldName}`;
    case "stocks":
      return `stocks[].${fieldName}`;
    case "parts":
      return nearestEnclosingKey(document, line, ["features"]) === "features"
        ? `parts[].features[].${fieldName}`
        : `parts[].${fieldName}`;
    case "assemblies":
      return nearestEnclosingKey(document, line, ["marks"]) === "marks"
        ? `assemblies[].marks[].${fieldName}`
        : null;
    default:
      return null;
  }
}

/**
 * ドキュメント内の `vars` で宣言された変数名一覧を返す（同一ファイル内に閉じる。
 * SPECS.md §4d「参照は同一ファイル内に閉じる」）。
 *
 * 補完は typing の途中（例: `stocks:\n  - { id: a, length: `。フロー map が
 * 閉じていない）で呼ばれるのが常態であり、`yaml` の厳格な `parse()` は
 * そのような入力全体を例外で拒否してしまう（`stocks/cascade.ts` の
 * `parseStocksText` が同じ理由で `parseDocument` を使っているのと同型の
 * 問題）。`parseDocument` は壊れた末尾があっても手前の `vars:` 区画を
 * 読める範囲で返す（実機確認）ため、`parse` ではなく `parseDocument` +
 * `toJSON()` を使う。それでも読めない場合は空配列（他の補完と同様、静かに諦める）。
 */
function extractVarNames(documentText: string): string[] {
  try {
    const raw = parseDocument(documentText).toJSON() as { vars?: unknown } | null;
    const vars = raw && typeof raw === "object" ? raw.vars : undefined;
    if (vars && typeof vars === "object" && !Array.isArray(vars)) {
      return Object.keys(vars as Record<string, unknown>);
    }
  } catch {
    // 編集途中のパース不能な YAML: vars 補完を出さない。
  }
  return [];
}

/** X 軸の揃えエイリアス（SPECS.md §4d:254）。 */
const X_ALIAS_WORDS = ["left", "center", "right"] as const;
/** Y 軸の揃えエイリアス（SPECS.md §4d:255）。 */
const Y_ALIAS_WORDS = ["bottom", "center", "top"] as const;

/**
 * `document` の `vars` 宣言を `$名前` の形の候補として `items` に追加する
 * （`vars` が1つも無ければ何もしない）。
 */
function pushVarCompletions(
  items: vscode.CompletionItem[],
  document: vscode.TextDocument,
  position: vscode.Position,
  partial: string,
): void {
  const varNames = extractVarNames(document.getText());
  if (varNames.length === 0) {
    return;
  }
  const range =
    partial.length > 0
      ? new vscode.Range(
          position.line,
          position.character - partial.length,
          position.line,
          position.character,
        )
      : undefined;
  for (const name of varNames) {
    const item = new vscode.CompletionItem(`$${name}`, vscode.CompletionItemKind.Variable);
    item.detail = "vars で宣言された名前付き設計値";
    item.insertText = `$${name}`;
    if (range) {
      item.range = range;
    }
    items.push(item);
  }
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
        // length/width も式受け入れフィールド（EXPR_FIELD_CAPABILITIES）なので、
        // 定尺候補に加えて `$vars` 名も候補に出す（SPECS.md §4b:189）。
        pushVarCompletions(items, document, position, dimMatch[2]);
        return items;
      }

      // 式を受け付けるフィールドの値位置: `$vars` 名（＋ marks.x/y の揃えエイリアス）。
      // stocks 区画の新規エントリ判定より前に見る必要がある
      // （`stocks[].thickness` のように stocks 区画の既存フィールドとして
      // 式を受け付けるものがあり、下の stocks ブロックは新規エントリ以外では
      // 無条件に空配列を返してしまうため。SPECS.md §4b:189）。
      const exprMatch = /([A-Za-z_][A-Za-z0-9_]*):\s*([$A-Za-z0-9_]*)$/.exec(beforeCursor);
      if (exprMatch) {
        const fieldName = exprMatch[1];
        const partial = exprMatch[2];
        const pattern = exprFieldPattern(document, position.line, section, fieldName);
        const capability = pattern ? fieldExprCapability(pattern) : undefined;
        if (capability) {
          pushVarCompletions(items, document, position, partial);
          if (capability.kind === "positional") {
            const words = capability.axis === "x" ? X_ALIAS_WORDS : Y_ALIAS_WORDS;
            const range =
              partial.length > 0
                ? new vscode.Range(
                    position.line,
                    position.character - partial.length,
                    position.line,
                    position.character,
                  )
                : undefined;
            for (const word of words) {
              const item = new vscode.CompletionItem(
                word,
                vscode.CompletionItemKind.EnumMember,
              );
              item.detail = `${capability.axis === "x" ? "X" : "Y"} 軸の揃えエイリアス`;
              if (range) {
                item.range = range;
              }
              items.push(item);
            }
          }
          return items;
        }
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
