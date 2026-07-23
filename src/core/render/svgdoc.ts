/**
 * 依存ゼロの SVG 文字列ビルダ（Python 版 src/kidori/render/svgdoc.py の移植）。
 *
 * SPECS.md §6 の木取り図（plan-X.svg）・加工指示図（parts/<id>.svg）が共通で使う
 * 下地を提供する。外部ライブラリには依存しない（文字列組み立てのみ）。
 *
 * 提供するもの:
 *   - 要素ツリー（Element）と要素生成関数（rect/line/circle/text/path/pattern/g/defs）
 *   - 属性値・テキストのエスケープ（escapeAttr/escapeText）
 *   - 部材ローカル座標系（左下原点・Y上向き）→ SVG 座標系（左上原点・Y下向き）の
 *     変換ヘルパ（CoordTransform）
 *   - viewBox/width/height を備えた文書の組み立て（SvgDocument）
 */

/** 属性値として受け付ける型。null/undefined の属性は描画時にスキップされる。 */
export type AttrValue = string | number | boolean | null | undefined;

/** 要素の属性集合。キーはアンダースコア区切り（描画時にハイフンへ変換）でもよい。 */
export type Attrs = Record<string, AttrValue>;

/**
 * 文書ルートに付与するデフォルトの font-family。
 * 日本語（ヘッダ・注記・ラベル）を含む出力のため、CJK グリフを持つフォントへの
 * フォールバック連鎖を macOS（Hiragino Sans）・Linux（Noto Sans CJK JP）の
 * 両対応で指定する。これが無いと PNG 変換時に日本語が豆腐（□）化する
 * （SPECS §6: PNG は印刷・スマホでの現場参照用のため判読必須）。
 */
export const DEFAULT_FONT_FAMILY = "Hiragino Sans, Noto Sans CJK JP, sans-serif";

// ---------------------------------------------------------------------------
// エスケープ・数値整形
// ---------------------------------------------------------------------------

/** 属性値（ダブルクォートで囲む前提）のエスケープを行う。 */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** テキストノードのエスケープを行う（属性値と異なり引用符は不要）。 */
export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 数値を SVG 属性向けの文字列に整形する。
 *
 * 整数値（またはそれと等価な float）は整数表記、それ以外は小数第3位までに丸めて
 * 末尾の 0 を削る（浮動小数演算の丸め誤差で `1.2000000000000002` のような
 * 冗長な表記になることを防ぐ）。
 */
function formatNumber(value: number | boolean): string {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  const text = value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return text === "" || text === "-" ? "0" : text;
}

function formatAttrValue(value: string | number | boolean): string {
  if (typeof value === "string") {
    return escapeAttr(value);
  }
  return escapeAttr(formatNumber(value));
}

/**
 * 属性キー名（アンダースコア区切り）を SVG 属性名（ハイフン区切り）に変換する。
 *
 * 既にハイフンを含むキー（"stroke-width" のように直接渡した場合）はそのまま使う。
 * 末尾アンダースコア（class_ のような予約語回避）は除去する。
 */
function attrName(key: string): string {
  if (key.includes("-")) {
    return key;
  }
  const trimmed = key.endsWith("_") ? key.slice(0, -1) : key;
  return trimmed.replace(/_/g, "-");
}

// ---------------------------------------------------------------------------
// 要素ツリー
// ---------------------------------------------------------------------------

/**
 * SVG 要素1個を表す木構造ノード。
 *
 * children が非空ならコンテナ要素として、空で text が指定されていれば
 * テキストノードを持つ要素として、どちらでもなければ自己終端タグとして描画する。
 */
export class Element {
  tag: string;
  attrs: Attrs;
  children: Element[];
  text: string | null;

  constructor(
    tag: string,
    attrs: Attrs = {},
    children: Element[] = [],
    text: string | null = null,
  ) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = children;
    this.text = text;
  }

  /** インデント整形した SVG 文字列を返す。 */
  render(indent = 0, indentSize = 2): string {
    const pad = " ".repeat(indent * indentSize);
    let attrsStr = "";
    for (const [key, value] of Object.entries(this.attrs)) {
      if (value === null || value === undefined) {
        continue;
      }
      attrsStr += ` ${attrName(key)}="${formatAttrValue(value)}"`;
    }
    if (this.children.length > 0) {
      const inner = this.children
        .map((child) => child.render(indent + 1, indentSize))
        .join("\n");
      return `${pad}<${this.tag}${attrsStr}>\n${inner}\n${pad}</${this.tag}>`;
    }
    if (this.text !== null) {
      return `${pad}<${this.tag}${attrsStr}>${escapeText(this.text)}</${this.tag}>`;
    }
    return `${pad}<${this.tag}${attrsStr}/>`;
  }
}

/** 任意タグの要素を生成する汎用ビルダ。個別ヘルパで表現できない要素に使う。 */
export function element(
  tag: string,
  attrs: Attrs = {},
  children: Element[] | null = null,
  text: string | null = null,
): Element {
  return new Element(tag, { ...attrs }, [...(children ?? [])], text);
}

/** `<rect>` 要素を生成する（SVG 座標系・左上原点）。 */
export function rect(
  x: number,
  y: number,
  width: number,
  height: number,
  attrs: Attrs = {},
): Element {
  return element("rect", { x, y, width, height, ...attrs });
}

/** `<line>` 要素を生成する。 */
export function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  attrs: Attrs = {},
): Element {
  return element("line", { x1, y1, x2, y2, ...attrs });
}

/** `<circle>` 要素を生成する。 */
export function circle(cx: number, cy: number, r: number, attrs: Attrs = {}): Element {
  return element("circle", { cx, cy, r, ...attrs });
}

/** `<text>` 要素を生成する。content はテキストノードとしてエスケープされる。 */
export function text(x: number, y: number, content: string, attrs: Attrs = {}): Element {
  return element("text", { x, y, ...attrs }, null, content);
}

/** `<path>` 要素を生成する。d はパスデータ文字列。 */
export function path(d: string, attrs: Attrs = {}): Element {
  return element("path", { d, ...attrs });
}

/** `<pattern>` 要素を生成する（edgeTrim のハッチング等、defs 内で再利用する定義用）。 */
export function pattern(
  id: string,
  width: number,
  height: number,
  children: Element[] | null = null,
  attrs: Attrs = {},
): Element {
  return element("pattern", { id, width, height, ...attrs }, children);
}

/** `<g>` 要素（グループ）を生成する。 */
export function g(children: Element[] | null = null, attrs: Attrs = {}): Element {
  return element("g", attrs, children);
}

/** `<defs>` 要素を生成する（pattern 等の再利用定義をまとめる）。 */
export function defs(children: Element[] | null = null): Element {
  return element("defs", {}, children);
}

// ---------------------------------------------------------------------------
// 座標変換
// ---------------------------------------------------------------------------

/**
 * 部材ローカル座標系（左下原点・Y 上向き、mm）を SVG 座標系（左上原点・Y 下向き、px）
 * へ変換する。
 *
 * SPECS.md §4a: 部材ローカル座標系は左下原点・X 右・Y 上。
 * SVG は左上原点・Y 下向きのため、変換にはローカル座標系の高さ（localHeight）を
 * 基準にした Y 反転が必要になる（例: bar 部材／sheet 部材なら stock.width、
 * 加工指示図の部材単体なら effectiveWidth(part, stock)）。
 */
export class CoordTransform {
  /** mm から px への倍率。 */
  readonly scale: number;
  /** Y 反転の基準となるローカル座標系の高さ（mm）。 */
  readonly localHeight: number;
  /** SVG 文書内でのパネル配置オフセット（px、X 方向）。 */
  readonly offsetX: number;
  /** SVG 文書内でのパネル配置オフセット（px、Y 方向）。 */
  readonly offsetY: number;

  constructor(options: {
    scale: number;
    localHeight: number;
    offsetX?: number;
    offsetY?: number;
  }) {
    this.scale = options.scale;
    this.localHeight = options.localHeight;
    this.offsetX = options.offsetX ?? 0.0;
    this.offsetY = options.offsetY ?? 0.0;
  }

  /** ローカル座標 (x, y)（mm）を SVG 座標 (px) に変換する。 */
  point(x: number, y: number): [number, number] {
    const sx = this.offsetX + x * this.scale;
    const sy = this.offsetY + (this.localHeight - y) * this.scale;
    return [sx, sy];
  }

  /** 長さ（スカラー、mm）を px に変換する（オフセット・反転は適用しない）。 */
  length(value: number): number {
    return value * this.scale;
  }

  /**
   * ローカル矩形（左下原点 (x, y)、幅 width・高さ height、mm）を SVG の `<rect>` 用
   * 引数 (x, y, width, height)（px、左上原点）に変換する。
   *
   * SVG の rect は左上原点で幅・高さを右下方向に取るため、ローカル矩形の
   * 左上角 (x, y + height) を基準点として変換する。
   */
  rect(
    x: number,
    y: number,
    width: number,
    height: number,
  ): [number, number, number, number] {
    const [sx, sy] = this.point(x, y + height);
    return [sx, sy, this.length(width), this.length(height)];
  }
}

// ---------------------------------------------------------------------------
// 文書組み立て
// ---------------------------------------------------------------------------

/** viewBox・width・height を備えた SVG 文書を組み立てる。 */
export class SvgDocument {
  /** 文書の width 属性値（px）。 */
  width: number;
  /** 文書の height 属性値（px）。 */
  height: number;
  /** (minX, minY, width, height)。省略時は (0, 0, width, height)。 */
  viewBox: [number, number, number, number] | null;
  children: Element[];
  /**
   * ルート `<svg>` に付与する font-family（子要素へ継承される）。
   * デフォルトは DEFAULT_FONT_FAMILY（CJK 対応フォールバック連鎖）。
   * null を指定すると属性を付与しない。
   */
  fontFamily: string | null;

  constructor(
    width: number,
    height: number,
    options?: {
      viewBox?: [number, number, number, number] | null;
      fontFamily?: string | null;
    },
  ) {
    this.width = width;
    this.height = height;
    this.viewBox = options?.viewBox ?? null;
    this.fontFamily =
      options === undefined || options.fontFamily === undefined
        ? DEFAULT_FONT_FAMILY
        : options.fontFamily;
    this.children = [];
  }

  /** 子要素を末尾に追加する（メソッドチェーン用に this を返す）。 */
  add(...elements: Element[]): this {
    this.children.push(...elements);
    return this;
  }

  /** ルートの `<svg>` 要素を組み立てて返す。 */
  toElement(): Element {
    const vb = this.viewBox ?? [0, 0, this.width, this.height];
    const viewBoxStr = vb.map((v) => formatNumber(v)).join(" ");
    const attrs: Attrs = {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: viewBoxStr,
      width: this.width,
      height: this.height,
    };
    if (this.fontFamily !== null) {
      attrs["font-family"] = this.fontFamily;
    }
    return new Element("svg", attrs, [...this.children]);
  }

  /** XML 宣言付きの SVG 文字列を返す（ファイルにそのまま書き出せる）。 */
  render(): string {
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + this.toElement().render();
  }
}
