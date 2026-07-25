/**
 * カスケードのエントリを正本 stocks エントリへ実体化する（SPECS.md §4b）。
 * エディタ非依存（SPECS.md §3）。
 *
 * 「カスケードは補完候補の供給構造であって、ビルドの解決機構ではない」
 * （§4b）を成立させる要。補完確定時（拡張の completion.ts）と雛形生成時
 * （CLI の `kidori new --preset <キー>`）が**同一の実体化コードを共有**し、
 * 実値と `preset:` 来歴キーが正本ファイルに書き出される。
 *
 * ここが出すのは**プレースホルダを含まないプレーンな YAML** であり、
 * エディタ固有のスニペット構文（`${1:…}` 等）は一切含まない。
 * tabstop の付与は拡張側の薄いラッパの責務（src/extension/completion.ts）。
 */

import { ResolvedStock } from "./cascade";

/** 実体化された1フィールド（value は YAML トークンとして完成済み）。 */
export interface MaterializedField {
  key: string;
  /** YAML の値表現（label は引用符込み、数値・id は素の字面）。 */
  value: string;
}

/**
 * YAML の二重引用符スカラーとしてのエスケープ。
 * `\` と `"` を落とすと正本が壊れる（フロー表記1行の中に埋めるため
 * 改行類も明示的にエスケープする）。
 */
export function escapeYamlDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * マスタキーから正本 id の既定値を作る（マスタ側に id が無い場合の fallback）。
 * stocks[].id は `^[A-Za-z0-9][A-Za-z0-9._-]*$`（core/schema.ts の ID_PATTERN）。
 */
export function defaultStockId(stock: ResolvedStock): string {
  if (stock.entry.id) {
    return stock.entry.id;
  }
  return stock.key
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "");
}

/** 実体化に足るだけの実値が揃っているか（欠けた材は候補・雛形に出さない）。 */
export function isInsertable(stock: ResolvedStock): boolean {
  const e = stock.entry;
  return (
    e.kind !== undefined &&
    e.length !== undefined &&
    e.width !== undefined &&
    e.thickness !== undefined
  );
}

/**
 * 正本へ書き出すフィールド列（順序込み）。
 *
 * - `preset` は `id` の直後（SPECS.md §4 の例と同順）。値はマスタキーそのもの
 *   （来歴メタデータ。ビルドは解決しない）。
 * - `price` は**マスタエントリに実在する場合のみ**書き出す（S-06 の精密化）。
 *   S-06 の趣旨は「実勢価格を知らないユーザーの入力に `price: 0` が紛れ込み、
 *   未入力が『実価格ゼロ』として費用計算・推奨順位を汚染する」ゼロ既定値の
 *   捏造への防御であって、実在する価格の抑制ではない。ビルトイン層は price を
 *   持たない（assets/stock-presets.json）ため既定挙動は price なし。ユーザー層・
 *   ディレクトリ層に利用者自身が書いた価格は本人の入力データそのものであり、
 *   そのまま流し込む（SPECS.md §7 の資材価格ログ連携とも整合）。
 */
export function materializeFields(stock: ResolvedStock): MaterializedField[] {
  const e = stock.entry;
  const fields: MaterializedField[] = [
    { key: "id", value: defaultStockId(stock) },
    { key: "preset", value: stock.key },
    { key: "label", value: `"${escapeYamlDoubleQuoted(e.label ?? stock.key)}"` },
    { key: "kind", value: String(e.kind) },
    { key: "length", value: String(e.length) },
    { key: "width", value: String(e.width) },
    { key: "thickness", value: String(e.thickness) },
  ];
  if (e.price !== undefined) {
    fields.push({ key: "price", value: String(e.price) });
  }
  return fields;
}

/**
 * 正本 stocks エントリ1件の YAML フロー表記（プレーンテキスト）。
 * 例: `{ id: 1x4-6f, preset: spf/1x4/6f, label: "1×4材 6F", kind: bar, … }`
 */
export function materializeEntry(stock: ResolvedStock): string {
  return formatFields(materializeFields(stock));
}

/** フィールド列を `{ k: v, … }` に組む（tabstop 付与後の再組立にも使う）。 */
export function formatFields(fields: MaterializedField[]): string {
  return `{ ${fields.map((f) => `${f.key}: ${f.value}`).join(", ")} }`;
}
