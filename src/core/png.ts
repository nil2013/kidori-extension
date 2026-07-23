/**
 * SVG → PNG 変換（@resvg/resvg-js）。
 *
 * resvg-js はネイティブモジュールのため、環境によっては読み込めない可能性がある。
 * PNG 有効時に読み込めない場合の扱いは呼び出し側（build.ts）が決める
 * （現行仕様では PNG は確定要件のため、build は KidoriError にする。S-09）。
 * 本モジュールは変換不能を null で返すだけに留め、成否判断は行わない。
 */

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
 * SVG 文字列を PNG バイト列へ変換する（ファイルへは書き込まない）。
 *
 * ファイル書き込みを分離するのは、build.ts が全成果物をメモリ上に用意して
 * から一括コミットする2相方式（S-12）を採るため。
 *
 * @param svgText SVG 文字列。
 * @param scale 拡大率（SVG の width/height に乗じる）。
 * @returns PNG バイト列。resvg-js が利用不可なら null（変換自体の失敗は伝播）。
 */
export function svgToPngBuffer(svgText: string, scale: number): Uint8Array | null {
  const mod = loadResvg();
  if (mod === null) {
    return null;
  }
  const resvg = new mod.Resvg(svgText, {
    fitTo: { mode: "zoom", value: scale },
    font: {
      loadSystemFonts: true,
    },
  });
  return resvg.render().asPng();
}
