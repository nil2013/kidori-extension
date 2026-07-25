/**
 * ファイルごとの合成済みスキーマ（動的 enum 込み）の組み立て（SPECS.md §3b・§4b）。
 *
 * 同じ正本に対しては、どの経路から引いても同一のスキーマが返らなければならない:
 *   - `kidori schema <ファイル>`（stdout。src/cli/agentCommands.ts の `runSchema`）
 *   - `kidori build` が書き出す `<ファイル名>.out/schema.json`（src/core/build.ts）
 *   - 拡張の schema contributor（src/extension/schemaContributor.ts）
 *
 * 経路ごとに合成手順を書き写すと、いずれ静かに食い違って「問い合わせた仕様」と
 * 「出力された仕様」が別物になる（§3b がスナップショット残骸を排除した動機と同型の
 * 事故）。CLI とビルドが共有する合成手順を、ここに単一実装として置く。
 *
 * 合成の内容はインラインの `stocks[].id` ＋ `stocksFile` 参照先の id を
 * `parts[].stock` の enum に注入することのみで、これは schemaContributor の
 * `collectStockIds` と同じ手順である。
 */

import { extractStockIds, extractStocksFileRef, loadStocksFile } from "./loader";
import { schemaJson } from "./schema";

/**
 * 正本の生データから、その正本用の stock id 一覧（重複排除済み・出現順）を返す。
 *
 * インライン定義を先に、`stocksFile` 参照先を後に並べる（衝突時はインラインが
 * 勝つという SPECS.md §4 の解決順と同じ向き）。
 *
 * @param raw `readRaw` が返した正本の生データ。
 * @param baseDir `stocksFile` の相対パス解決基準。`loadProject`・schemaContributor と
 *     同じく `dirname(resolve(<正本パス>))` を渡すこと（ここがずれると同じファイルに
 *     対して経路ごとに違うスキーマが返る）。
 */
export function collectSchemaStockIds(raw: unknown, baseDir: string): string[] {
  const ids = extractStockIds(raw);
  const ref = extractStocksFileRef(raw);
  if (ref !== null) {
    // schemaContributor と同じ縮退方針: 参照先が壊れていてもスキーマ合成自体は
    // 失敗させず、インラインの id だけで続行する（loadStocksFile は現状 throw
    // しない設計だが、念のため防御する）。
    try {
      for (const stock of loadStocksFile(baseDir, ref).stocks) {
        ids.push(stock.id);
      }
    } catch {
      // 縮退: インラインのみで続行。
    }
  }
  return [...new Set(ids)];
}

/**
 * 正本の生データから、合成済みスキーマの JSON テキストを返す。
 *
 * `runSchema` の stdout と `<ファイル名>.out/schema.json` の中身は、この関数を
 * 共有することで定義上一致する。
 */
export function composeSchemaJson(raw: unknown, baseDir: string): string {
  return schemaJson(collectSchemaStockIds(raw, baseDir));
}
