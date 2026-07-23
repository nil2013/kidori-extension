/**
 * 加工指示図 SVG 生成（Python 版 src/kidori/render/partcard.py の移植）。
 *
 * 1つの部材定義（Part）を1つの SVG 文書として描画する（qty 展開はしない。
 * 同一形状のため1ファイルで足りる）。
 *
 * チェーン寸法線は render/dimension.ts の renderPartDimensions に委譲する
 * （本モジュールは寸法線の計算ロジックを持たない）。
 */

import type { Groove, Hole, Part, Stock } from "../types";
import { effectiveWidth } from "../types";
import { circledNumber } from "./cutplan";
import {
  DEFAULT_DIMENSION_STYLE,
  estimatedLabelWidth,
  formatDimensionValue as fmt,
  renderPartDimensions,
} from "./dimension";
import {
  CoordTransform,
  Element,
  SvgDocument,
  circle,
  g,
  line,
  rect,
  text,
} from "./svgdoc";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const SCALE_BASE_PX = 900.0;
const SCALE_MIN = 0.2;
const SCALE_MAX = 4.0;

const FONT_SIZE_HEADER = 13.0;
const FONT_SIZE_ANNOTATION = 10.0;
const STROKE_WIDTH = 1.2;

const GROOVE_FRONT_FILL = "#f4c98a";
const GROOVE_FRONT_OPACITY = 0.55;
const FEATURE_STROKE = "#333333";

const HEADER_TOP_PAD = 8.0;
const HEADER_LINE_HEIGHT = 16.0;
const HEADER_BOTTOM_PAD = 16.0;

/**
 * 部材輪郭から寸法チェーン（最大2段: 中間＋全長）までの余白。
 * dimension.DEFAULT_DIMENSION_STYLE の firstGap(10) + lineGap(14) を包含できる大きさにする。
 */
const BOTTOM_MARGIN = 60.0;
const LEFT_MARGIN = 70.0;
/** 注記の右側退避リスト用の余白。 */
const RIGHT_MARGIN = 240.0;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** 矩形バウンディングボックス (x0, y0, x1, y1)。 */
type BBox = [number, number, number, number];

function bboxOverlap(a: BBox, b: BBox): boolean {
  return !(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]);
}

// ---------------------------------------------------------------------------
// ヘッダ
// ---------------------------------------------------------------------------

function buildHeaderLines(
  part: Part,
  stock: Stock,
  seqLabels: number[] | null,
  planId: string | null,
): string[] {
  const width = effectiveWidth(part, stock);
  const line1 =
    `${part.id}（${part.label}）｜qty ${part.qty}｜` +
    `原材: ${stock.id} (t${fmt(stock.thickness)})｜${fmt(part.length)} × ${fmt(width)}`;
  const lines = [line1];
  if (seqLabels && seqLabels.length > 0) {
    const labels = seqLabels.map((n) => circledNumber(n)).join("");
    lines.push(`配置: 案${planId} ${labels}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 注記の配置（自然位置 or 右側リスト退避）
// ---------------------------------------------------------------------------

/**
 * 注記1件を自然位置（引出点の右上）に置くか、被る場合は右側リストへ退避する。
 *
 * @returns [描画要素一覧, 更新後の rightListY]。placedBoxes はこの関数内で
 *     追加分を破壊的に push する（呼び出し側は同じ配列を使い回す）。
 */
function placeAnnotation(
  note: string,
  anchorX: number,
  anchorY: number,
  placedBoxes: BBox[],
  rightListX: number,
  rightListY: number,
): [Element[], number] {
  const labelW = estimatedLabelWidth(note, FONT_SIZE_ANNOTATION);
  const labelH = FONT_SIZE_ANNOTATION + 4.0;

  const natX = anchorX + 8.0;
  const natY = anchorY - 8.0;
  const naturalBbox: BBox = [natX, natY - labelH, natX + labelW, natY + 2.0];

  if (placedBoxes.some((b) => bboxOverlap(naturalBbox, b))) {
    const listY = rightListY + labelH;
    const elements = [
      line(anchorX, anchorY, rightListX - 6.0, listY - 4.0, {
        stroke: "#999999",
        stroke_width: 0.5,
        data_role: "leader-line",
      }),
      text(rightListX, listY, note, {
        font_size: FONT_SIZE_ANNOTATION,
        data_role: "annotation",
      }),
    ];
    placedBoxes.push([rightListX, listY - labelH, rightListX + labelW, listY + 2.0]);
    return [elements, listY];
  }

  const elements = [
    line(anchorX, anchorY, natX - 2.0, natY + 2.0, {
      stroke: "#999999",
      stroke_width: 0.5,
      data_role: "leader-line",
    }),
    text(natX, natY, note, {
      font_size: FONT_SIZE_ANNOTATION,
      data_role: "annotation",
    }),
  ];
  placedBoxes.push(naturalBbox);
  return [elements, rightListY];
}

// ---------------------------------------------------------------------------
// フィーチャ描画
// ---------------------------------------------------------------------------

/** 溝を部材ローカル座標の矩形 (x, y, w, h) に変換する（設計正本 §6-2 段落）。 */
function grooveLocalRect(
  feature: Groove,
  part: Part,
  stock: Stock,
): [number, number, number, number] {
  const half = feature.width / 2.0;
  let x0: number;
  let x1: number;
  let y0: number;
  let y1: number;
  if (feature.dir === "across") {
    x0 = feature.pos - half;
    x1 = feature.pos + half;
    if (feature.end === "through") {
      y0 = 0.0;
      y1 = effectiveWidth(part, stock);
    } else {
      y0 = feature.from!;
      y1 = feature.to!;
    }
  } else {
    // "along"
    y0 = feature.pos - half;
    y1 = feature.pos + half;
    if (feature.end === "through") {
      x0 = 0.0;
      x1 = part.length;
    } else {
      x0 = feature.from!;
      x1 = feature.to!;
    }
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

function grooveNote(feature: Groove): string {
  if (feature.end === "through") {
    return `溝 幅${fmt(feature.width)}×深${fmt(feature.depth)} 通し（${feature.face}）`;
  }
  return (
    `溝 幅${fmt(feature.width)}×深${fmt(feature.depth)} ` +
    `止め ${fmt(feature.from!)}–${fmt(feature.to!)}（${feature.face}）`
  );
}

function renderGroove(
  feature: Groove,
  part: Part,
  stock: Stock,
  transform: CoordTransform,
  placedBoxes: BBox[],
  rightListX: number,
  rightListY: number,
): [Element[], number] {
  const [x0, y0, w0, h0] = grooveLocalRect(feature, part, stock);
  const [gx, gy, gw, gh] = transform.rect(x0, y0, w0, h0);

  let shape: Element;
  if (feature.face === "front") {
    shape = rect(gx, gy, gw, gh, {
      fill: GROOVE_FRONT_FILL,
      fill_opacity: GROOVE_FRONT_OPACITY,
      stroke: FEATURE_STROKE,
      stroke_width: STROKE_WIDTH,
      data_role: "groove",
      data_face: "front",
    });
  } else {
    shape = rect(gx, gy, gw, gh, {
      fill: "none",
      stroke: FEATURE_STROKE,
      stroke_width: STROKE_WIDTH,
      stroke_dasharray: "5,3",
      data_role: "groove",
      data_face: "back",
    });
  }

  const anchorX = gx + gw / 2.0;
  const anchorY = gy;
  const [annElements, newRightListY] = placeAnnotation(
    grooveNote(feature),
    anchorX,
    anchorY,
    placedBoxes,
    rightListX,
    rightListY,
  );
  return [[shape, ...annElements], newRightListY];
}

function holeNote(feature: Hole): string {
  if (feature.depth === null) {
    return `Φ${fmt(feature.dia)} 貫通`;
  }
  return `Φ${fmt(feature.dia)} 深${fmt(feature.depth)}`;
}

function renderHole(
  feature: Hole,
  transform: CoordTransform,
  placedBoxes: BBox[],
  rightListX: number,
  rightListY: number,
): [Element[], number] {
  const [cx, cy] = transform.point(feature.x, feature.y);
  const r = transform.length(feature.dia) / 2.0;

  const elements: Element[] = [
    circle(cx, cy, r, {
      fill: "none",
      stroke: FEATURE_STROKE,
      stroke_width: STROKE_WIDTH,
      data_role: "hole",
    }),
  ];
  if (feature.depth === null) {
    const mark = Math.max(r * 0.8, 3.0);
    elements.push(
      line(cx - mark, cy, cx + mark, cy, {
        stroke: FEATURE_STROKE,
        stroke_width: 0.8,
        data_role: "hole-center-mark",
      }),
    );
    elements.push(
      line(cx, cy - mark, cx, cy + mark, {
        stroke: FEATURE_STROKE,
        stroke_width: 0.8,
        data_role: "hole-center-mark",
      }),
    );
  }

  const anchorX = cx + r;
  const anchorY = cy - r;
  const [annElements, newRightListY] = placeAnnotation(
    holeNote(feature),
    anchorX,
    anchorY,
    placedBoxes,
    rightListX,
    rightListY,
  );
  elements.push(...annElements);
  return [elements, newRightListY];
}

// ---------------------------------------------------------------------------
// 公開エントリ
// ---------------------------------------------------------------------------

/**
 * 1部材定義を1つの加工指示図 SVG 文書として描画する（設計正本 §6）。
 *
 * @param part 対象の部材定義。
 * @param stock part.stock が参照する原材。
 * @param options.seqLabels settings.selectedPlan が設定されている場合のみ渡す、
 *     この部材の全インスタンスの配置番号（Plan.seq 由来）リスト。
 *     null / 未指定の場合、ヘッダに配置番号行を出さない。
 * @param options.planId seqLabels 指定時に併記する採用案 ID（例: "A"）。
 * @returns SVG 文字列。
 */
export function renderPartcard(
  part: Part,
  stock: Stock,
  options?: { seqLabels?: number[] | null; planId?: string | null },
): string {
  const seqLabels = options?.seqLabels ?? null;
  const planId = options?.planId ?? null;

  const headerLines = buildHeaderLines(part, stock, seqLabels, planId);
  const topMargin =
    HEADER_TOP_PAD + headerLines.length * HEADER_LINE_HEIGHT + HEADER_BOTTOM_PAD;

  const widthMm = part.length;
  const heightMm = effectiveWidth(part, stock);
  const scale = clamp(SCALE_BASE_PX / widthMm, SCALE_MIN, SCALE_MAX);
  const lengthPx = scale * widthMm;
  const heightPx = scale * heightMm;

  const docWidth = LEFT_MARGIN + lengthPx + RIGHT_MARGIN;
  const docHeight = topMargin + heightPx + BOTTOM_MARGIN;

  const transform = new CoordTransform({
    scale,
    localHeight: heightMm,
    offsetX: LEFT_MARGIN,
    offsetY: topMargin,
  });

  const elements: Element[] = [];
  const [ox, oy, ow, oh] = transform.rect(0.0, 0.0, widthMm, heightMm);
  elements.push(
    rect(ox, oy, ow, oh, {
      fill: "none",
      stroke: "black",
      stroke_width: STROKE_WIDTH,
      data_role: "part-outline",
    }),
  );

  const placedBoxes: BBox[] = [];
  const rightListX = LEFT_MARGIN + lengthPx + 16.0;
  let rightListY = topMargin + 4.0;

  for (const feature of part.features) {
    let featureElements: Element[];
    if (feature.type === "groove") {
      [featureElements, rightListY] = renderGroove(
        feature,
        part,
        stock,
        transform,
        placedBoxes,
        rightListX,
        rightListY,
      );
    } else {
      [featureElements, rightListY] = renderHole(
        feature,
        transform,
        placedBoxes,
        rightListX,
        rightListY,
      );
    }
    elements.push(...featureElements);
  }

  elements.push(renderPartDimensions(part, stock, transform, DEFAULT_DIMENSION_STYLE));

  const doc = new SvgDocument(docWidth, docHeight);
  for (let i = 0; i < headerLines.length; i++) {
    doc.add(
      text(10.0, HEADER_TOP_PAD + (i + 1) * HEADER_LINE_HEIGHT, headerLines[i], {
        font_size: FONT_SIZE_HEADER,
        data_role: "header",
      }),
    );
  }
  doc.add(g(elements));

  return doc.render();
}
