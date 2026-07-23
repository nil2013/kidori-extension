/**
 * SVG → PNG 変換（@resvg/resvg-js）。
 *
 * resvg-js はネイティブモジュールのため、環境によっては読み込めない可能性がある。
 * その場合は false を返して PNG 生成をスキップする（build は成功扱い。
 * Python 版の cairosvg フォールバックと同じ契約）。
 */

import { writeFileSync } from "node:fs";

let resvgModule: typeof import("@resvg/resvg-js") | null | undefined;

function loadResvg(): typeof import("@resvg/resvg-js") | null {
  if (resvgModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      resvgModule = require("@resvg/resvg-js");
    } catch {
      resvgModule = null;
    }
  }
  return resvgModule ?? null;
}

/** PNG 変換が利用可能か（resvg-js が読み込めるか）。 */
export function pngAvailable(): boolean {
  return loadResvg() !== null;
}

/**
 * SVG 文字列を PNG ファイルへ変換する。
 *
 * @param svgText SVG 文字列。
 * @param outPath 出力先 PNG パス。
 * @param scale 拡大率（SVG の width/height に乗じる）。
 * @returns 変換して書き出したら true。resvg-js が利用不可なら false。
 */
export function svgToPng(svgText: string, outPath: string, scale: number): boolean {
  const mod = loadResvg();
  if (mod === null) {
    return false;
  }
  const resvg = new mod.Resvg(svgText, {
    fitTo: { mode: "zoom", value: scale },
    font: {
      loadSystemFonts: true,
    },
  });
  const png = resvg.render().asPng();
  writeFileSync(outPath, png);
  return true;
}
