/**
 * 「kidori: 構成を挿入（parts＋assembly の雛形）」コマンド（`kidori.insertAssembly`）が
 * 挿入するスニペット本文（SPECS.md §4c「一括挿入」）。
 *
 * SPECS.md §4c は component（パラメトリックな部品定義）を将来構想（§7）に留める
 * 根拠として「現時点ではスニペット一括挿入（§4c）で足りる想定」と明記しており
 * （SPECS.md:271）、本モジュールがその支え木にあたる。
 *
 * 設計判断（§4c の実例との対応関係）:
 *   - §4c の実例（足 leg・天板 beam-top・接地面 beam-foot の3形状＋assembly
 *     「ウマ1号機」＋mark 1件）をほぼそのまま踏襲する。実例は2つの assembly
 *     （uma-1/uma-2）を並べて「assembly ごとに mark 位置が変わりうる」ことを
 *     示しているが、雛形としては1組で足りる（2組目が要る場合は VS Code の
 *     行複製で足りる操作であり、雛形に固定して増やす理由がない）。
 *   - `parts[].qty` は書かない。assemblies を使う場合は省略でき、全 assembly の
 *     `contains` 合計から導出される（SPECS.md:81 `parts.qty` の説明、§4c の
 *     実例も qty を書いていない）。雛形が qty を書いてしまうと、後で
 *     `contains` の数値だけ変えたときに qty との食い違い warning を生みやすく、
 *     「1箇所を直せば揃う」という assemblies の利点を雛形自身が損なう。
 *   - `marks` の領域寸法は `ref`（相手形状の断面寸法から導出）を既定にする。
 *     `w`/`h` 直接指定と排他だが、`ref` は「参照先の寸法変更に自動追従する」
 *     利点があり（SPECS.md §4c）、component 構想の前駆（導出マークの
 *     置き場を保つ）という設計上の位置づけにも合う。
 *   - id を tabstop 番号で共有する（$1=leg・$5=beam-top・$8=beam-foot）。
 *     `contains` のキーと `marks[].on`/`ref` を同じ tabstop 参照にすることで、
 *     id を書き換えると連動箇所も追随する（VS Code のミラー編集）。
 *   - `stock` は3形状で共通の1 tabstop（$3）にまとめる（§4c の実例も3形状とも
 *     `2x4-6f` で揃えている）。
 *
 * `marks[].x`/`y` は領域の**左下角基準**（`hole` の `x`/`y` は中心基準）。この基準は
 * SPECS が規定しておらず、v0.7 追随時の設計判断として決めたもの
 * （権威は DESCRIPTIONS["marks.x"] のスキーマ description）。同名で意味が異なるため
 * 雛形を書き換える際は取り違えに注意すること。
 */

/**
 * 挿入する雛形の生テキスト（VS Code スニペット構文の tabstop 込み）。
 *
 * vscode 非依存の純粋関数（テストで tabstop を既定値へ解決し、
 * `loadProjectFromRaw` に通せるようにするため）。
 */
export function assemblyTemplateBody(): string {
  return [
    "parts:",
    "  - { id: ${1:leg}, label: ${2:足}, stock: ${3:2x4-6f}, length: ${4:800} }",
    "  - { id: ${5:beam-top}, label: ${6:天板}, stock: $3, length: ${7:850} }",
    "  - { id: ${8:beam-foot}, label: ${9:接地面}, stock: $3, length: ${10:900} }",
    "",
    "assemblies:",
    "  - id: ${11:assembly-1}",
    "    label: ${12:構成1}",
    "    contains: { $1: ${13:2}, $5: ${14:1}, $8: ${15:1} }",
    "    marks:",
    "      - { on: $5, face: front, ref: $1, x: ${16:50}, note: ${17:足当たり面} }$0",
  ].join("\n");
}
