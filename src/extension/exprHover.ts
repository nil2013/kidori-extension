/**
 * ホバーの本体（SPECS.md §4d:274「解決値の可視化」、設計裁定 D1・D3）。
 *
 * D1（Fable-tier Supervisor 裁定）: インレイヒントではなくホバーを選ぶ。ホバーは
 * pull 型（要求時に現在のバッファから計算）であり、refresh 配管なしに
 * 「変数変更が全依存箇所へ即時反映」が自明に成立する。
 *
 * D3: テスト可能性のため「ドキュメントのテキスト＋位置 → 表示文字列 | null」を
 * vscode に一切依存しない純関数として切り出す（{@link resolveHoverText}）。
 * `src/core/loader.ts`・`src/core/expr.ts` は変更しない（U-EXPR/U-PIPE の
 * 単一実装をそのまま利用する。D1 の「解決の原則: 上記パイプラインをコアの
 * 単一実装として拡張・CLI・ビルドで共有する」に従う）。
 *
 * --- 位置 → path 写像（このユニット唯一の先例なし機構） ---
 *
 * `src/cli/positions.ts` は `Issue.path`（`ident(.ident|[int])*`）→ YAML/JSON
 * ノードの行番号、という**逆方向**の写像であり（同ファイル冒頭コメント参照）、
 * カーソル位置から出発する本用途にはそのまま使えない。ここでは `yaml` パッケージの
 * CST（`parseDocument` が返す `Document.contents` の `YAMLMap`/`YAMLSeq`/`Pair`/
 * `Scalar` ノード木）を根から辿り、各ノードの `range`（文字オフセット区間）に
 * 対象オフセットが収まる枝だけを降りていくことで、最終的に触れた **値スカラー**
 * までの path（`formatJsonPath` と同じ `ident(.ident|[int])*` 文法）を組み立てる
 * （{@link pathAtOffset}）。
 *
 * 設計上の要点:
 *   - 降りるのは **Pair の value 側の range** のみ（key 側の range は見ない）。
 *     フィールド名の上にカーソルがあっても式ホバーは出さない（式が書かれているのは
 *     値の位置であり、キー名はリテラルなので）。
 *   - 判定はスカラーの `range[0]`（開始）〜`range[1]`（`valueEnd`。閉じ引用符の
 *     直後まで）を包含区間として使う。`range[2]`（末尾コメント等まで含む
 *     `nodeEnd`）は使わない。コメント領域まで拾ってしまうと式でない位置で
 *     ホバーが出てしまう（実機確認: `parseDocument` は引用符付き文字列で
 *     `range = [開始, 閉じ引用符の直後, 末尾]` を返す）。
 *   - `yaml` の `parseDocument` は YAML はもちろん、JSON テキストも
 *     （JSON は YAML 1.2 コアスキーマのフロー構文の部分集合であるため）
 *     同じ CST 表現でパースできる（実機確認）。そのため YAML/JSON 両対応の
 *     kidori ファイルに対して本モジュール1本で対応できる。
 */

import {
  Document,
  LineCounter,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
} from "yaml";

import { loadProjectFromRaw } from "../core/loader";

/** vscode.Position 相当（0-indexed の行・文字位置）。vscode 型に依存しないための最小面。 */
export interface DocPosition {
  line: number;
  character: number;
}

type PathSegment = string | number;

/**
 * path セグメント列を `formatJsonPath`（`src/core/loader.ts:166-176`）と同じ
 * `ident(.ident|[int])*` 文法の文字列にする。
 *
 * `ResolutionTrace`（`src/core/expr.ts`）のキー文法と一致させるための単一の
 * 変換ロジック。`formatJsonPath` 自体は loader.ts 内部関数で export されておらず
 * （かつ loader.ts は変更禁止のファイル所有権外）、アルゴリズムは3行程度と
 * 軽微なので、コメントで単一ソースの所在を明示した上で独立に再実装する。
 */
function formatPath(segments: readonly PathSegment[]): string {
  let out = "";
  for (const seg of segments) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else {
      out += out ? `.${seg}` : seg;
    }
  }
  return out;
}

/**
 * offset の位置にある YAML/JSON の**値スカラー**の path を返す
 * （`ResolutionTrace` のキー文法と同じ形式）。見つからなければ `null`。
 *
 * @param root `Document.contents`（`YAMLMap` | `YAMLSeq` | `Scalar` | `null`）。
 * @param offset 0-indexed の文字オフセット。
 */
export function pathAtOffset(root: unknown, offset: number): string | null {
  function inRange(node: unknown): boolean {
    const range = (node as { range?: [number, number, number] | null } | null | undefined)
      ?.range;
    if (!range) {
      return false;
    }
    return range[0] <= offset && offset <= range[1];
  }

  function walk(node: unknown, path: readonly PathSegment[]): string | null {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isPair(pair)) {
          continue;
        }
        const key = pair.key;
        const keyName = isScalar(key) && typeof key.value === "string" ? key.value : null;
        if (keyName === null) {
          continue;
        }
        const value = pair.value;
        if (value === null || value === undefined || !inRange(value)) {
          continue;
        }
        const childPath = [...path, keyName];
        if (isScalar(value)) {
          return formatPath(childPath);
        }
        return walk(value, childPath);
      }
      return null;
    }
    if (isSeq(node)) {
      const items = node.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item === null || item === undefined || !inRange(item)) {
          continue;
        }
        const childPath = [...path, i];
        if (isScalar(item)) {
          return formatPath(childPath);
        }
        return walk(item, childPath);
      }
      return null;
    }
    return null;
  }

  return walk(root, []);
}

/** `DocPosition`（0-indexed 行・文字）を文字オフセットへ変換する。 */
function offsetAtPosition(lineCounter: LineCounter, position: DocPosition): number {
  const starts = lineCounter.lineStarts;
  if (starts.length === 0) {
    return position.character;
  }
  const line = Math.max(0, Math.min(position.line, starts.length - 1));
  return starts[line] + position.character;
}

/**
 * ドキュメントテキスト中の position が指す path を返す（YAML/JSON 共通）。
 *
 * `parseDocument` に構文エラーがある場合（編集途中の壊れた YAML/JSON）は
 * `null` を返す（D2「パース不能時は前回診断を維持する」と同型の防御。
 * ここでは「維持」ではなく「ホバーを出さない」という形で現れる）。
 */
export function pathAtDocumentPosition(documentText: string, position: DocPosition): string | null {
  const lineCounter = new LineCounter();
  let doc: Document;
  try {
    doc = parseDocument(documentText, { lineCounter });
  } catch {
    return null;
  }
  if (doc.errors.length > 0 || doc.contents === null || doc.contents === undefined) {
    return null;
  }
  const offset = offsetAtPosition(lineCounter, position);
  return pathAtOffset(doc.contents, offset);
}

/**
 * mm 値の表示整形。浮動小数の誤差（例: `87.99999999999999`）を丸めて除去する
 * （加減算のみの式でも二進浮動小数の丸め誤差が乗ることがあるため。
 * `src/core/expr.ts` の `EPS = 1e-9` より緩い 1e-6 で丸め、整数値は
 * 小数点なしで表示する。SPECS.md §4d:274 の例 `88 mm` に合わせる）。
 */
function formatMm(value: number): string {
  const rounded = Number(value.toFixed(6));
  return String(rounded);
}

/**
 * ホバー本文を組み立てる（SPECS.md §4d:274 の例 `"$inset + $matingAllowance" → 88 mm`
 * に合わせた表示形式）。
 */
function formatHoverText(expression: string, value: number): string {
  return `"${expression}" → ${formatMm(value)} mm`;
}

/**
 * ドキュメントのテキスト＋位置 → 表示文字列 | null（D3 の純関数）。
 *
 * 手順:
 *   1. position → path（{@link pathAtDocumentPosition}）。式でない位置・
 *      パース不能な位置では `null`。
 *   2. テキストを値としてパースし（YAML/JSON 共通。JSON も `yaml` の
 *      `parseDocument` で読める）、`loadProjectFromRaw` を**メモリ上で**実行する
 *      （ディスクへは一切書かない。D1「pull 型」の核心）。
 *   3. `resolved`（`ResolutionTrace`）に path の解決結果が無ければ `null`
 *      （リテラル値・未解決式・エラーで trace が空になったケースを区別しない。
 *      いずれも「今このバッファでは確信を持って表示できる解決値が無い」ため
 *      無表示にするのが安全側。詳細は報告の「疑わしい点」参照）。
 *
 * @param options.baseDir `stocksFile:` の相対パス解決基準（省略時は
 *   `stocksFile:` があれば loader が warning を出して無視する。build.ts と
 *   同じ既存契約）。
 */
export function resolveHoverText(
  documentText: string,
  position: DocPosition,
  options?: { baseDir?: string },
): string | null {
  const path = pathAtDocumentPosition(documentText, position);
  if (path === null) {
    return null;
  }

  let raw: unknown;
  try {
    const doc = parseDocument(documentText);
    if (doc.errors.length > 0) {
      return null;
    }
    raw = doc.toJSON();
  } catch {
    return null;
  }

  const { resolved } = loadProjectFromRaw(
    raw,
    options?.baseDir !== undefined ? { baseDir: options.baseDir } : {},
  );
  const entry = resolved?.[path];
  if (!entry) {
    return null;
  }
  return formatHoverText(entry.expression, entry.value);
}
