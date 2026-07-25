/**
 * 規格材マスタのカスケードと実体化（SPECS.md §4・§4b）。
 *
 * エディタ非依存（SPECS.md §3 の「コアエンジン」）であり、拡張（補完・
 * シャドウ診断）と CLI（`kidori new --preset <キー>`）の双方から使う。
 * `vscode` に依存するのは拡張側のラッパのみ:
 *   - src/extension/presets.ts   … StockShadowReporter / loadStockMaster
 *   - src/extension/completion.ts … スニペット（tabstop）への包み込み
 *
 * ビルド経路（core/build.ts・core/loader.ts）はここを import しない
 * （SPECS.md §4b「カスケードは補完候補の供給構造であり、ビルドの解決機構
 * ではない」＝正本の自己完結性。test/core/stocks.test.ts で固定）。
 */

export * from "./cascade";
export * from "./materialize";
