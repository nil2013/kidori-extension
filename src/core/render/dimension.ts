/**
 * チェーン寸法エンジン（Python 版 src/kidori/render/dimension.py の移植）。
 *
 * 加工指示図（parts/<部材ID>.svg、render/partcard.ts）が使う、部材の
 * チェーン寸法線（手描き図面互換の 248/486/724 式表記）を計算・描画する。
 *
 * モジュールは2層に分離する:
 *   - 純粋計算部（外部依存なし、単体テスト対象）:
 *     extractChainPoints、dedupeSorted、buildChainSegments、
 *     formatDimensionValue、estimatedLabelWidth、computeLabelPlacement
 *   - SVG 描画部（render/svgdoc.ts に依存）:
 *     renderAxisChain、renderPartDimensions、DimensionStyle
 *
 * 設計正本 §6 の要点:
 *   1. 対象点抽出: X軸 = {0, L} ∪ {across溝の中心 pos} ∪ {穴のx}。
 *      Y軸 = {0, W} ∪ {along溝の中心 pos} ∪ {穴のy}（溝は中心基準）。
 *      S-08 是正: end="stopped" の溝は、走行方向の軸（dir=across なら Y 軸、
 *      dir=along なら X 軸）に from/to も対象点として追加する（end="through" は
 *      走行方向端まで達し {0,L}/{0,W} で既に表現されているため対象外）。
 *   2. 許容差 0.01mm でデデュープ → 昇順ソート → 隣接差分を区間値としてチェーン化。
 *      区間値は整数なら整数表記、小数は1桁。
 *   3. Xチェーンは部材下側第1段、全長寸法は第2段（さらに外側）。Yチェーンは左側に
 *      同様の2段。対象点が {0, L} のみの軸は全長寸法1段だけ。累進寸法はv1では描かない。
 *   4. 文字被り回避: 推定文字幅（0.62×fontSize×文字数）が区間描画幅を超えるとき、
 *      その区間ラベルは寸法線の反対側にずらす。隣接する狭区間が連続する場合は交互スタガ。
 *   5. 端点は寸法補助線＋45°ティック。
 *   6. 不変条件: 各チェーンの区間合計 == 全長。
 */

import type { Part, ResolvedMark, Stock } from "../types";
import { effectiveWidth } from "../types";
import { CoordTransform, Element, g, line, text } from "./svgdoc";

/** 対象点デデュープの許容差（mm）。設計正本 §6-2。 */
export const DEDUPE_TOLERANCE = 0.01;

/**
 * 区間値が「整数とみなせる」ための許容差（mm）。浮動小数演算の丸め誤差を吸収する。
 * DEDUPE_TOLERANCE より1桁小さく取り、意図的な 0.x mm 端数（デデュープを免れた値）を
 * 誤って整数表記に丸めないようにする。
 */
export const INT_LABEL_TOLERANCE = 1e-6;

/** 推定文字幅の係数（設計正本 §6-4: 0.62 × fontSize × 文字数）。 */
export const CHAR_WIDTH_RATIO = 0.62;

// ---------------------------------------------------------------------------
// 純粋計算部
// ---------------------------------------------------------------------------

/**
 * 非切削マーク（marks）由来の対象点を、部材面の内側に収まるものだけ追加する。
 *
 * SPECS.md §4c は marks の座標が部材面をはみ出す場合の扱いを規定していないため、
 * 意味検証層も診断を出さない（描画側は忠実にはみ出して描く）。しかし寸法線側で
 * 範囲外の点をそのまま拾うと、チェーンの両端が部材の 0/全長からずれ、
 * 「全長寸法」が部材長でなくなる（本モジュール §6-6 の不変条件が破れる）。
 * 図面の全長表記の正しさを優先し、範囲外の点は寸法チェーンから落とす。
 */
function pushMarkPoints(
  target: number[],
  candidates: readonly number[],
  span: number,
): void {
  for (const value of candidates) {
    if (value >= -DEDUPE_TOLERANCE && value <= span + DEDUPE_TOLERANCE) {
      target.push(value);
    }
  }
}

/**
 * 部材の寸法チェーン対象点を軸ごとに抽出する（設計正本 §6-1）。
 *
 * - X軸: {0, part.length} ∪ {dir="across" の groove.pos} ∪ {hole.x}
 *   ∪ {dir="along" かつ end="stopped" の groove.from/to}
 *   ∪ {mark の x, x+w/2, x+w}
 * - Y軸: {0, effectiveWidth(part, stock)} ∪ {dir="along" の groove.pos} ∪ {hole.y}
 *   ∪ {dir="across" かつ end="stopped" の groove.from/to}
 *   ∪ {mark の y, y+h/2, y+h}
 *
 * 溝は幅方向・長さ方向とも中心（pos）を対象点とする。正本の pos 定義が
 * 溝中心であるため、手描き図面の 248/486/724 のような中心基準の表記と一致する。
 * S-08 是正: 止め溝（end="stopped"）は、pos に加えて走行方向の軸の from/to も
 * 対象点に含める。これにより止め溝の開始・終了位置が寸法線上で読み取れるようになる。
 * 通し溝（end="through"）は走行方向端まで達するため、対象点は {0,L}/{0,W} で
 * 既に表現されており from/to は追加しない（そもそも through では from/to は null）。
 *
 * marks（SPECS.md §4c「マークの端・中心はチェーン寸法線の対象に含める」）は
 * 軸ごとに**端と中心の両方**、すなわち {x, x+w/2, x+w} / {y, y+h/2, y+h} を拾う。
 * 「端・中心」は列挙であって選択ではない。
 *
 * 戻り値は軸ごとに 0.01mm 許容差でデデュープ・昇順ソート済み（dedupeSorted 適用済み）。
 *
 * @param marks この面に描く解決済みマーク（省略時は無し＝従来どおりの挙動）。
 * @returns [xs, ys]: X軸・Y軸それぞれの対象点リスト（mm、昇順・デデュープ済み）。
 */
export function extractChainPoints(
  part: Part,
  stock: Stock,
  marks: readonly ResolvedMark[] = [],
): [number[], number[]] {
  const width = effectiveWidth(part, stock);
  const xs: number[] = [0.0, part.length];
  const ys: number[] = [0.0, width];

  for (const mark of marks) {
    pushMarkPoints(xs, [mark.x, mark.x + mark.w / 2, mark.x + mark.w], part.length);
    pushMarkPoints(ys, [mark.y, mark.y + mark.h / 2, mark.y + mark.h], width);
  }

  for (const feature of part.features) {
    if (feature.type === "groove") {
      if (feature.dir === "across") {
        xs.push(feature.pos);
        // S-08: 走行方向（Y軸）の止め位置を寸法対象点に追加する。
        if (feature.end === "stopped") {
          ys.push(feature.from!, feature.to!);
        }
      } else {
        // "along"
        ys.push(feature.pos);
        // S-08: 走行方向（X軸）の止め位置を寸法対象点に追加する。
        if (feature.end === "stopped") {
          xs.push(feature.from!, feature.to!);
        }
      }
    } else {
      // "hole"
      xs.push(feature.x);
      ys.push(feature.y);
    }
  }

  return [dedupeSorted(xs), dedupeSorted(ys)];
}

/**
 * 点列を昇順ソートし、隣接差分が tolerance 以下の点を1点に統合する。
 *
 * @param points 対象点（mm）。順不同・重複可。
 * @param tolerance デデュープ許容差（mm）。設計正本 §6-2 の 0.01mm。
 */
export function dedupeSorted(
  points: number[],
  tolerance: number = DEDUPE_TOLERANCE,
): number[] {
  const ordered = [...points].sort((a, b) => a - b);
  const result: number[] = [];
  for (const p of ordered) {
    if (result.length > 0 && Math.abs(p - result[result.length - 1]) <= tolerance) {
      continue;
    }
    result.push(p);
  }
  return result;
}

/** チェーン寸法の1区間。 */
export interface ChainSegment {
  /** 区間始点（mm、対象点の値）。 */
  start: number;
  /** 区間終点（mm、対象点の値）。 */
  end: number;
  /** 区間値 end - start（mm）。 */
  value: number;
  /** 表示用文字列（formatDimensionValue 適用済み）。 */
  label: string;
}

/**
 * 昇順ソート・デデュープ済みの点列から、隣接差分によるチェーン区間列を作る。
 *
 * `sum(seg.value) == points[points.length-1] - points[0]` が常に成り立つ
 * （設計正本 §6-6 の不変条件）。
 */
export function buildChainSegments(points: number[]): ChainSegment[] {
  const segments: ChainSegment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const value = b - a;
    segments.push({ start: a, end: b, value, label: formatDimensionValue(value) });
  }
  return segments;
}

/**
 * 寸法値を表示用文字列に整形する（設計正本 §6-2: 整数は整数表記、小数は1桁）。
 *
 * @param value 区間値（mm）。
 * @param intTolerance 整数とみなす許容差（mm）。
 * @returns 整形済み文字列（例: "600"、"248.5"）。
 */
export function formatDimensionValue(
  value: number,
  intTolerance: number = INT_LABEL_TOLERANCE,
): string {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) <= intTolerance) {
    return String(rounded);
  }
  return value.toFixed(1);
}

/** ラベルの推定描画幅（px）を返す（設計正本 §6-4: 0.62 × fontSize × 文字数）。 */
export function estimatedLabelWidth(
  label: string,
  fontSize: number,
  ratio: number = CHAR_WIDTH_RATIO,
): number {
  return ratio * fontSize * label.length;
}

/**
 * 各区間のラベル配置レベルを決定する（設計正本 §6-4 の最低限規則）。
 *
 * - 区間の描画幅（value * scale）が推定文字幅以上の「通常区間」は 0（寸法線上）。
 * - 推定文字幅が描画幅を超える「狭区間」は寸法線の反対側へ逃がす（1）。
 * - 狭区間が連続する場合は、さらに反対側の中で交互にスタガする（1 と 2 を交互）。
 *
 * 戻り値のレベルの意味づけ（描画側で使用）:
 *   0 = 通常位置（寸法線のすぐ内側）
 *   1 = 反対側・スタガA
 *   2 = 反対側・スタガB
 *
 * @param segments buildChainSegments の戻り値。
 * @param scale mm から px への倍率（区間描画幅の算出に使う）。
 * @param fontSize フォントサイズ（px）。
 * @returns segments と同じ長さの配置レベル列。
 */
export function computeLabelPlacement(
  segments: ChainSegment[],
  scale: number,
  fontSize: number,
): number[] {
  const placements: number[] = [];
  let prevNarrow = false;
  let stagger = 0;
  for (const seg of segments) {
    const drawnWidth = seg.value * scale;
    const narrow = estimatedLabelWidth(seg.label, fontSize) > drawnWidth;
    if (!narrow) {
      placements.push(0);
      prevNarrow = false;
      stagger = 0;
      continue;
    }
    if (prevNarrow) {
      stagger = stagger === 1 ? 2 : 1;
    } else {
      stagger = 1;
    }
    placements.push(stagger);
    prevNarrow = true;
  }
  return placements;
}

// ---------------------------------------------------------------------------
// SVG 描画部
// ---------------------------------------------------------------------------

/** チェーン寸法線の描画スタイル定数。 */
export interface DimensionStyle {
  /** ラベルのフォントサイズ（px）。 */
  fontSize: number;
  /** 部材輪郭から第1段の寸法線までの距離（px）。 */
  firstGap: number;
  /** 段と段の間隔（px）。 */
  lineGap: number;
  /** 45°ティックの一辺相当の長さ（px）。 */
  tickSize: number;
  /** 寸法線・ティックの色。 */
  stroke: string;
  /** 寸法補助線（引出線）の色。 */
  extStroke: string;
  /** 寸法線の線幅（px）。 */
  strokeWidth: number;
}

/** DimensionStyle のデフォルト値（Python 版 DimensionStyle() 相当）。 */
export const DEFAULT_DIMENSION_STYLE: DimensionStyle = {
  fontSize: 10.0,
  firstGap: 10.0,
  lineGap: 14.0,
  tickSize: 4.0,
  stroke: "#333333",
  extStroke: "#999999",
  strokeWidth: 1.0,
};

/** 45°ティックマーク（寸法線端点の短い斜線）を生成する。 */
function tick(x: number, y: number, size: number, stroke: string): Element {
  const half = size / 2;
  return line(x - half, y + half, x + half, y - half, {
    stroke,
    stroke_width: 1,
  });
}

/**
 * 1軸・1段分のチェーン寸法（寸法線・ティック・ラベル・補助線）を `<g>` として描画する。
 *
 * @param points この段で連結する対象点列（昇順・デデュープ済み。2点なら区間1個＝全長寸法）。
 * @param transform 部材ローカル座標 → SVG 座標の変換。
 * @param options.axis "x" は部材下側（Y方向に補助線を伸ばす）、"y" は部材左側
 *     （X方向に補助線を伸ばす）に描画する。
 * @param options.levelIndex 段番号（0始まり）。0 が部材輪郭に最も近い段。
 * @param options.style 描画スタイル。
 * @returns 寸法線一式をまとめた `<g>` 要素。
 */
export function renderAxisChain(
  points: number[],
  transform: CoordTransform,
  options: {
    axis: "x" | "y";
    levelIndex: number;
    style?: DimensionStyle;
  },
): Element {
  const style = options.style ?? DEFAULT_DIMENSION_STYLE;
  const segments = buildChainSegments(points);
  const placements = computeLabelPlacement(segments, transform.scale, style.fontSize);
  const elements: Element[] = [];
  const offset = style.firstGap + options.levelIndex * style.lineGap;

  if (options.axis === "x") {
    // 部材下側: 寸法線は local y=0 の直下（SVG では下方向 = offsetY + localHeight*scale より下）。
    const [, baseY] = transform.point(0.0, 0.0);
    const yLine = baseY + offset;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const placement = placements[i];
      const [x1] = transform.point(seg.start, 0.0);
      const [x2] = transform.point(seg.end, 0.0);
      elements.push(
        line(x1, yLine, x2, yLine, {
          stroke: style.stroke,
          stroke_width: style.strokeWidth,
        }),
      );
      elements.push(tick(x1, yLine, style.tickSize, style.stroke));
      elements.push(tick(x2, yLine, style.tickSize, style.stroke));
      const midX = (x1 + x2) / 2;
      const labelY =
        placement === 0
          ? yLine - 3
          : yLine + style.fontSize + 2 + (placement === 2 ? 4 : 0);
      elements.push(
        text(midX, labelY, seg.label, {
          font_size: style.fontSize,
          text_anchor: "middle",
        }),
      );
    }
    for (const p of points) {
      const [px, py] = transform.point(p, 0.0);
      elements.push(
        line(px, py, px, yLine, { stroke: style.extStroke, stroke_width: 0.5 }),
      );
    }
  } else {
    // 部材左側: 寸法線は local x=0 の直左。
    const [baseX] = transform.point(0.0, 0.0);
    const xLine = baseX - offset;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const placement = placements[i];
      const [, y1] = transform.point(0.0, seg.start);
      const [, y2] = transform.point(0.0, seg.end);
      elements.push(
        line(xLine, y1, xLine, y2, {
          stroke: style.stroke,
          stroke_width: style.strokeWidth,
        }),
      );
      elements.push(tick(xLine, y1, style.tickSize, style.stroke));
      elements.push(tick(xLine, y2, style.tickSize, style.stroke));
      const midY = (y1 + y2) / 2;
      const labelX =
        placement === 0
          ? xLine - 3
          : xLine - style.fontSize - 2 - (placement === 2 ? 4 : 0);
      elements.push(
        text(labelX, midY, seg.label, {
          font_size: style.fontSize,
          text_anchor: "end",
          dominant_baseline: "middle",
        }),
      );
    }
    for (const p of points) {
      const [px, py] = transform.point(0.0, p);
      elements.push(
        line(px, py, xLine, py, { stroke: style.extStroke, stroke_width: 0.5 }),
      );
    }
  }

  return g(elements);
}

/**
 * 部材のX軸・Y軸チェーン寸法一式を `<g>` として描画する（render/partcard.ts から呼ぶ想定）。
 *
 * 設計正本 §6-3: Xチェーンは部材下側の第1段＋全長寸法の第2段（対象点が {0,L} のみなら
 * 全長寸法1段だけ）。Yチェーンは左側に同様の構成。
 *
 * @param part 対象の部材。
 * @param stock part.stock が参照する原材。
 * @param transform 部材ローカル座標 → SVG 座標の変換（localHeight は
 *     effectiveWidth(part, stock) と一致させること）。
 * @param style 描画スタイル。
 * @param marks この面に描く解決済みマーク（SPECS.md §4c。省略時は無し）。
 * @returns X軸・Y軸のチェーン寸法をまとめた `<g>` 要素。
 */
export function renderPartDimensions(
  part: Part,
  stock: Stock,
  transform: CoordTransform,
  style: DimensionStyle = DEFAULT_DIMENSION_STYLE,
  marks: readonly ResolvedMark[] = [],
): Element {
  const [xs, ys] = extractChainPoints(part, stock, marks);
  const group = g();
  group.children.push(renderOneAxis(xs, transform, "x", style));
  group.children.push(renderOneAxis(ys, transform, "y", style));
  return group;
}

/** 1軸分（内側チェーン + 全長）を組み立てる内部ヘルパ。 */
function renderOneAxis(
  points: number[],
  transform: CoordTransform,
  axis: "x" | "y",
  style: DimensionStyle,
): Element {
  const sub = g();
  const hasIntermediatePoints = points.length > 2;
  let totalLevel: number;
  if (hasIntermediatePoints) {
    sub.children.push(renderAxisChain(points, transform, { axis, levelIndex: 0, style }));
    totalLevel = 1;
  } else {
    totalLevel = 0;
  }

  const totalPoints = [points[0], points[points.length - 1]];
  sub.children.push(
    renderAxisChain(totalPoints, transform, { axis, levelIndex: totalLevel, style }),
  );
  return sub;
}
