/**
 * `Issue.path`（loader.ts の `formatJsonPath`。例: `"parts[2].features[0].pos"`、
 * ルートは `"<root>"`）を、YAML/JSON ドキュメントのノード位置（行番号）へ写像する層。
 *
 * `kidori check` 専用の CLI 側写像層であり、**`src/core/loader.ts` は一切改造しない**
 * （SPECS.md §3b「拡張内の検証と同一実装」を最も強く担保する設計裁定。
 * 検証本体は `loadProjectFromRaw` をそのまま呼び、ここでは path → line の変換だけを行う）。
 *
 * `formatJsonPath` が生成する path の文法は `ident(.ident|[int])*`（ルートは `"<root>"`）に
 * 固定されている（stocks[].id / parts[].id 等のユーザー制御文字列は path に入らない）。
 * とはいえ、将来 path に id が入る変更が入っても壊れないよう、ドットで単純分割せず
 * `ident` と `[int]` を区別するセグメント文法としてトークン化する。
 */

import type { Document, LineCounter } from "yaml";

/** path のセグメント（オブジェクトキー、または配列インデックス）。 */
export type PathSegment = string | number;

/** `ident` または `[int]` のトークンに一致する（区切りの `.` は捨てる）。 */
const TOKEN_RE = /[^.[\]]+|\[\d+\]/g;

/**
 * `Issue.path` をセグメント列にパースする。
 *
 * `"<root>"` は空セグメント列（ドキュメント全体）を表す特殊値として扱う
 * （`<`/`.`/`[`/`]` のいずれでもない通常の ident と紛れないよう、文字列全体一致で判定する）。
 */
export function parseIssuePath(issuePath: string): PathSegment[] {
  if (issuePath === "<root>") {
    return [];
  }
  const tokens = issuePath.match(TOKEN_RE) ?? [];
  return tokens.map((t): PathSegment => {
    if (t.startsWith("[") && t.endsWith("]")) {
      return Number(t.slice(1, -1));
    }
    return t;
  });
}

/** `yaml` の Node が持つ `range: [start, valueEnd, nodeEnd]`（value 開始位置のみ使う）。 */
interface RangedNode {
  range?: [number, number, number] | null;
}

/**
 * `Issue.path` が指す YAML/JSON ノードの行番号（1-indexed）を返す。
 *
 * 解決できない場合（ノードが存在しない、range が取れない等）は **推測せず** `null` を返す
 * （D2: 行番号のでっち上げ禁止）。`stocksFile:` 由来の issue（path は常に `"stocksFile"`）も
 * 特別扱いは不要で、この汎用ロジックがそのまま「stocksFile キーの行」に写像する
 * （path が単一セグメント `["stocksFile"]` になり、doc 上の該当ノードへ辿り着くため）。
 *
 * @param doc `parseDocument` の戻り値。
 * @param lineCounter `doc` と同じ呼び出しで渡した `LineCounter`（offset → line 変換用）。
 * @param issuePath `Issue.path`。
 */
export function resolveIssueLine(
  doc: Document,
  lineCounter: LineCounter,
  issuePath: string,
): number | null {
  const segments = parseIssuePath(issuePath);
  let node: unknown;
  try {
    // keepScalar: true でスカラー値もノードのまま返す（collections は常にノードで返る）。
    node = doc.getIn(segments, true);
  } catch {
    return null;
  }
  const range = (node as RangedNode | undefined)?.range;
  if (!range) {
    return null;
  }
  const { line } = lineCounter.linePos(range[0]);
  // line === 0 は「一度も改行を跨いでいない」を意味するのではなく、
  // LineCounter の仕様上「addNewLine が呼ばれていない/offset がその手前」を表す
  // （常に改行走査済みの parseDocument 経由なら通常起こらないが、念のため防御する）。
  return line > 0 ? line : null;
}
