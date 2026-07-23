/**
 * 木取り図 SVG 生成（Python 版 src/kidori/render/cutplan.py の移植）。
 *
 * 1つの割付案（Plan）を1つの SVG 文書として描画する。案内の全 StockUnit
 * （bar/sheet 混在可）を縦積みし、原材 1 本／1 枚ごとに 1 パネルを描く。
 *
 * ヘッダの歩留まり・費用・必要本数・カット回数は、呼び出し側が渡す planSummary
 * （metrics.summarize の戻り値。v0.4 で rank / recommended / exactMatch が付く）
 * から読むだけに留める。パネル単体の歩留まり・端材長・kerf 帯は Plan/StockUnit の
 * 実配置（実座標）から本モジュールが直接計算する（summary の集計粒度はスキーマ単位
 * であり、パネル単位の値ではないため）。
 *
 * v0.4 追加（Python 版には無い）:
 *   - planSummary.recommended === true のとき、案タイトルに「★ 推奨案」を追加。
 *     planSummary.exactMatch === true のときはさらに
 *     「（最小必要本数が厳密解と一致）」を付記（exactMatch は最適性証明済みの
 *     場合にのみ立つ。配置同一性は含意しない）。
 *   - plan.id === "X" の案は planSummary.exactProven で表記を出し分ける:
 *     true なら「候補X（厳密解）」、それ以外は「探索案X（最適性未証明）」
 *     （A/B/C は従来表記）。
 *   - planSummary.stocks[].kind に sheet が含まれる案は「カット回数（概算）」表記。
 */

import type { Part, Project, Stock } from "../types";
import { effectiveWidth } from "../types";
import type { Placement1D, Placement2D, Plan, StockUnit } from "../packing/common";
import { instanceId } from "../packing/common";
import type { PlanSummary, PlanTotals } from "../metrics";
import { formatDimensionValue as fmt } from "./dimension";
import {
  CoordTransform,
  Element,
  SvgDocument,
  defs,
  g,
  line,
  pattern,
  rect,
  text,
} from "./svgdoc";

// ---------------------------------------------------------------------------
// 定数（設計正本 §5）
// ---------------------------------------------------------------------------

/** スケール算出の基準 px（案内で統一。scale = SCALE_BASE_PX / 全StockUnit中の最大 length）。 */
const SCALE_BASE_PX = 1200.0;
const SCALE_MIN = 0.2;
const SCALE_MAX = 4.0;

const FONT_SIZE_BODY = 12.0;
const FONT_SIZE_HEADER = 16.0;
const STROKE_WIDTH = 1.0;

const PART_FILL = "#e8d9b5";
const KERF_FILL = "#d9534f";
const KERF_OPACITY = 0.45;
const REMNANT_FILL = "#dcdcdc";
const EDGE_TRIM_HATCH_ID = "kidori-edge-trim-hatch";

const MARGIN = 20.0;
const HEADER_HEIGHT = 26.0;
const PANEL_TITLE_HEIGHT = 20.0;
const PANEL_GAP = 24.0;

/** 部材矩形内に「①id（＋label）」＋寸法の2行を収められる最小 px（幅・高さ）。 */
const LABEL_FULL_MIN_W = 60.0;
const LABEL_FULL_MIN_H = 28.0;
/** 1行目ラベルの推定文字幅係数（ASCII。dimension.CHAR_WIDTH_RATIO と同じ 0.62）。 */
const LABEL_CHAR_RATIO_ASCII = 0.62;
/** 全角文字（CJK 等）の推定文字幅係数。全角はほぼ 1em とみなす。 */
const LABEL_CHAR_RATIO_WIDE = 1.0;
/** 番号のみなら収められる最小 px。これ未満は矩形外に引出線で退避する。 */
const LABEL_NUMBER_MIN_W = 18.0;
const LABEL_NUMBER_MIN_H = 14.0;

/** 端材（残長）ラベルの表示に必要な最小 px 幅。 */
const REMNANT_LABEL_MIN_W = 24.0;

/** 丸数字（①〜⑳ = U+2460〜U+2473）。21 以上は "(21)" 形式にフォールバック。 */
const CIRCLED_BASE = 0x2460;
const CIRCLED_MAX = 20;

/** 1始まりの整数を丸数字1文字（①〜⑳）に変換する。21以上は "(21)" 形式。 */
export function circledNumber(n: number): string {
  if (n >= 1 && n <= CIRCLED_MAX) {
    return String.fromCharCode(CIRCLED_BASE + n - 1);
  }
  return `(${n})`;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

// ---------------------------------------------------------------------------
// ヘッダ
// ---------------------------------------------------------------------------

/** Plan.method1d / method2d を設計正本 §5 のヘッダ表記に変換する。 */
function methodDisplay(method1d: string, method2d: string): string {
  const map1d: Record<string, string> = {
    ffd: "FFD",
    bfd: "BFD",
    grouped: "同種グループ化",
  };
  const map2d: Record<string, string> = {
    bssf: "MaxRects-BSSF",
    baf: "MaxRects-BAF",
    bl: "MaxRects-BL",
  };
  const disp1d = map1d[method1d] ?? method1d.toUpperCase();
  const disp2d = map2d[method2d] ?? method2d.toUpperCase();
  return `${disp1d} / ${disp2d}`;
}

function costDisplay(totals: PlanTotals): string {
  const cost = totals.cost;
  if (cost === null || cost === undefined) {
    return "概算費用 算出不可";
  }
  return `概算費用 ¥${Math.round(cost).toLocaleString("en-US")}`;
}

function countsDisplay(totals: PlanTotals): string {
  const counts = totals.stockCounts ?? {};
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return "必要本数: -";
  }
  const parts = entries.map(([stockId, count]) => `${stockId}×${count}`).join(", ");
  return `必要本数: ${parts}`;
}

/**
 * 案タイトルを組み立てる（v0.4）。
 *
 * - plan.id === "X" は最適性の証明状態（planSummary.exactProven）で出し分ける:
 *   true なら「候補X（厳密解）」、それ以外は「探索案X（最適性未証明）」。
 *   それ以外（A/B/C）は「案A」等の従来表記。
 * - planSummary.recommended === true のとき「★ 推奨案」を追加する。
 * - planSummary.exactMatch === true のときはさらに
 *   「（最小必要本数が厳密解と一致）」を付記する（配置同一性は含意しない）。
 */
function planTitle(plan: Plan, planSummary: PlanSummary): string {
  let title: string;
  if (plan.id === "X") {
    title =
      planSummary.exactProven === true
        ? "候補X（厳密解）"
        : "探索案X（最適性未証明）";
  } else {
    title = `案${plan.id}`;
  }
  if (planSummary.recommended === true) {
    title += " ★ 推奨案";
  }
  if (planSummary.exactMatch === true) {
    title += "（最小必要本数が厳密解と一致）";
  }
  return title;
}

function buildHeaderText(plan: Plan, project: Project, planSummary: PlanSummary): string {
  const totals = planSummary.totals;
  const yieldStr = `${(totals.yield * 100).toFixed(1)}%`;
  const cutCount = totals.cutCount;

  // v0.4: 2D（sheet）を含む案のカット回数は概算値のため「（概算）」を付記する。
  const hasSheet = planSummary.stocks.some((s) => s.kind === "sheet");
  const cutLabel = hasSheet ? "カット回数（概算）" : "カット回数";

  const segments = [
    planTitle(plan, planSummary),
    `方式: ${methodDisplay(plan.method1d, plan.method2d)}`,
    `歩留まり(全体) ${yieldStr}`,
    costDisplay(totals),
    countsDisplay(totals),
    `${cutLabel} ${cutCount}`,
  ];
  let header = segments.join(" ｜ ");
  if (project.settings.selectedPlan === plan.id) {
    header += " 【採用】";
  }
  return header;
}

// ---------------------------------------------------------------------------
// defs（edgeTrim ハッチパターン）
// ---------------------------------------------------------------------------

function edgeTrimDefs(): Element {
  const hatch = pattern(
    EDGE_TRIM_HATCH_ID,
    6,
    6,
    [
      rect(0, 0, 6, 6, { fill: "#f2f2f2" }),
      line(0, 0, 0, 6, { stroke: "#999999", stroke_width: 2 }),
    ],
    {
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)",
    },
  );
  return defs([hatch]);
}

// ---------------------------------------------------------------------------
// ラベル配置（部材矩形内 or 引出線退避）
// ---------------------------------------------------------------------------

/** ラベル文字列の推定描画幅（px）を返す（ASCII は 0.62em、全角は 1em とみなす）。 */
function estimatedTextWidth(content: string, fontSize: number): number {
  let width = 0.0;
  for (const ch of content) {
    const ratio =
      ch.codePointAt(0)! < 0x0100 ? LABEL_CHAR_RATIO_ASCII : LABEL_CHAR_RATIO_WIDE;
    width += ratio * fontSize;
  }
  return width;
}

/**
 * 部材矩形の中央（または矩形外・引出線付き）にラベルを配置する。
 *
 * 縮退規則（SPECS §6「部材 ID・ラベル・寸法を記入」＋設計正本 §5 の実装者判断）:
 *   1. 矩形が十分大きい: 1行目「① id label」＋2行目に寸法。
 *      1行目の推定幅が矩形幅を超える場合は label を落とし「① id」に縮退。
 *   2. 番号のみ収まる大きさ: 「①」のみ。
 *   3. それ未満: 矩形外へ番号を引出線付きで退避。
 */
function partLabelElements(args: {
  seqNum: number;
  partId: string;
  partLabel: string;
  dimsText: string;
  rectX: number;
  rectY: number;
  rectW: number;
  rectH: number;
}): Element[] {
  const { seqNum, partId, partLabel, dimsText, rectX, rectY, rectW, rectH } = args;
  const cx = rectX + rectW / 2;
  const cy = rectY + rectH / 2;
  const seqLabel = circledNumber(seqNum);
  const elements: Element[] = [];

  if (rectW >= LABEL_FULL_MIN_W && rectH >= LABEL_FULL_MIN_H) {
    let fullLine = partLabel
      ? `${seqLabel} ${partId} ${partLabel}`
      : `${seqLabel} ${partId}`;
    if (estimatedTextWidth(fullLine, FONT_SIZE_BODY) > rectW) {
      fullLine = `${seqLabel} ${partId}`;
    }
    elements.push(
      text(cx, cy - 2, fullLine, {
        font_size: FONT_SIZE_BODY,
        text_anchor: "middle",
        data_role: "seq-label",
      }),
    );
    elements.push(
      text(cx, cy + FONT_SIZE_BODY + 1, dimsText, {
        font_size: FONT_SIZE_BODY,
        text_anchor: "middle",
        data_role: "part-dims",
      }),
    );
    return elements;
  }

  if (rectW >= LABEL_NUMBER_MIN_W && rectH >= LABEL_NUMBER_MIN_H) {
    elements.push(
      text(cx, cy + FONT_SIZE_BODY / 3, seqLabel, {
        font_size: FONT_SIZE_BODY,
        text_anchor: "middle",
        data_role: "seq-label",
      }),
    );
    return elements;
  }

  // 矩形が小さすぎる: 矩形外（右上）へ引出線付きで退避する。
  const labelX = rectX + rectW + 14;
  const labelY = rectY - 4;
  elements.push(
    line(cx, cy, labelX - 2, labelY + 2, {
      stroke: "#666666",
      stroke_width: 0.5,
      data_role: "leader-line",
    }),
  );
  elements.push(
    text(labelX, labelY, seqLabel, {
      font_size: FONT_SIZE_BODY,
      text_anchor: "start",
      data_role: "seq-label",
    }),
  );
  return elements;
}

// ---------------------------------------------------------------------------
// パネル本体（1D / 2D）
// ---------------------------------------------------------------------------

function renderBarUnit(
  unit: StockUnit,
  plan: Plan,
  project: Project,
  transform: CoordTransform,
): [Element[], number] {
  const stock = unit.stock;
  const placements = [...(unit.placements as Placement1D[])].sort(
    (a, b) => a.start - b.start,
  );
  const elements: Element[] = [];
  let totalLen = 0.0;

  for (let i = 0; i < placements.length; i++) {
    const placement = placements[i];
    const part: Part = placement.instance.part;
    const length = part.length;
    const width = effectiveWidth(part, stock);
    totalLen += length;

    const [sx, sy, sw, sh] = transform.rect(placement.start, 0.0, length, width);
    elements.push(
      rect(sx, sy, sw, sh, {
        fill: PART_FILL,
        stroke: "black",
        stroke_width: STROKE_WIDTH,
        data_role: "part-rect",
      }),
    );
    const seqNum = plan.seq[instanceId(placement.instance)] ?? 0;
    elements.push(
      ...partLabelElements({
        seqNum,
        partId: part.id,
        partLabel: part.label,
        dimsText: fmt(length),
        rectX: sx,
        rectY: sy,
        rectW: sw,
        rectH: sh,
      }),
    );

    if (i + 1 < placements.length) {
      const nxt = placements[i + 1];
      const gapStart = placement.start + length;
      const gapEnd = nxt.start;
      if (gapEnd - gapStart > 1e-6) {
        const [kx, ky, kw, kh] = transform.rect(gapStart, 0.0, gapEnd - gapStart, width);
        elements.push(
          rect(kx, ky, kw, kh, {
            fill: KERF_FILL,
            fill_opacity: KERF_OPACITY,
            stroke: "none",
            data_role: "kerf-band",
          }),
        );
      }
    }
  }

  if (placements.length > 0) {
    const last = placements[placements.length - 1];
    const endEdge = last.start + last.instance.part.length;
    const remnantEnd = stock.length - project.settings.edgeTrim;
    const remnantLen = remnantEnd - endEdge;
    if (remnantLen > 1e-6) {
      const [rx, ry, rw, rh] = transform.rect(endEdge, 0.0, remnantLen, stock.width);
      elements.push(
        rect(rx, ry, rw, rh, {
          fill: REMNANT_FILL,
          stroke: "none",
          data_role: "remnant",
        }),
      );
      if (rw >= REMNANT_LABEL_MIN_W) {
        elements.push(
          text(rx + rw / 2, ry + rh / 2, fmt(remnantLen), {
            font_size: FONT_SIZE_BODY,
            text_anchor: "middle",
            dominant_baseline: "middle",
            fill: "#666666",
            data_role: "remnant-label",
          }),
        );
      }
    }
  }

  const yieldFrac = stock.length > 0 ? totalLen / stock.length : 0.0;
  return [elements, yieldFrac];
}

function renderSheetUnit(
  unit: StockUnit,
  plan: Plan,
  project: Project,
  transform: CoordTransform,
): [Element[], number] {
  const stock = unit.stock;
  const kerf = project.settings.kerf;
  const placements = unit.placements as Placement2D[];
  const elements: Element[] = [];
  let totalArea = 0.0;

  for (const placement of placements) {
    const part: Part = placement.instance.part;
    const plen = part.length;
    const pwid = effectiveWidth(part, stock);
    totalArea += plen * pwid;

    const extentX = placement.rotated ? pwid : plen;
    const extentY = placement.rotated ? plen : pwid;

    const [sx, sy, sw, sh] = transform.rect(placement.x, placement.y, extentX, extentY);
    elements.push(
      rect(sx, sy, sw, sh, {
        fill: PART_FILL,
        stroke: "black",
        stroke_width: STROKE_WIDTH,
        data_role: "part-rect",
      }),
    );
    const seqNum = plan.seq[instanceId(placement.instance)] ?? 0;
    elements.push(
      ...partLabelElements({
        seqNum,
        partId: part.id,
        partLabel: part.label,
        dimsText: `${fmt(plen)}×${fmt(pwid)}`,
        rectX: sx,
        rectY: sy,
        rectW: sw,
        rectH: sh,
      }),
    );

    if (kerf > 1e-9) {
      // 右帯
      const [rkx, rky, rkw, rkh] = transform.rect(
        placement.x + extentX,
        placement.y,
        kerf,
        extentY,
      );
      elements.push(
        rect(rkx, rky, rkw, rkh, {
          fill: KERF_FILL,
          fill_opacity: KERF_OPACITY,
          stroke: "none",
          data_role: "kerf-band",
        }),
      );
      // 上帯（角を含めるため幅を kerf 分広げる）
      const [tkx, tky, tkw, tkh] = transform.rect(
        placement.x,
        placement.y + extentY,
        extentX + kerf,
        kerf,
      );
      elements.push(
        rect(tkx, tky, tkw, tkh, {
          fill: KERF_FILL,
          fill_opacity: KERF_OPACITY,
          stroke: "none",
          data_role: "kerf-band",
        }),
      );
    }
  }

  const areaTotal = stock.length * stock.width;
  const yieldFrac = areaTotal > 0 ? totalArea / areaTotal : 0.0;
  return [elements, yieldFrac];
}

// ---------------------------------------------------------------------------
// パネル（原材1本/1枚）
// ---------------------------------------------------------------------------

/** 1パネル（タイトル込み）を描画する。戻り値: [要素, パネル幅px, パネル高さpx]。 */
function renderPanel(
  unit: StockUnit,
  plan: Plan,
  project: Project,
  scale: number,
  offsetX: number,
  offsetY: number,
): [Element, number, number] {
  const stock: Stock = unit.stock;
  const transform = new CoordTransform({
    scale,
    localHeight: stock.width,
    offsetX,
    offsetY,
  });
  const lengthPx = transform.length(stock.length);
  const widthPx = transform.length(stock.width);

  const elements: Element[] = [];

  // 原材外形
  const [ox, oy, ow, oh] = transform.rect(0.0, 0.0, stock.length, stock.width);
  elements.push(
    rect(ox, oy, ow, oh, {
      fill: "none",
      stroke: "black",
      stroke_width: STROKE_WIDTH,
      data_role: "stock-outline",
    }),
  );

  // edgeTrim 域（1D は長さ方向の先端・末尾のみ。2D は §4 の Lu/Wu モデルに
  // 合わせ、長さ・幅の両軸の縁を対象とする）。
  const edgeTrim = project.settings.edgeTrim;
  if (edgeTrim > 1e-9) {
    for (const x0 of [0.0, stock.length - edgeTrim]) {
      const [ex, ey, ew, eh] = transform.rect(x0, 0.0, edgeTrim, stock.width);
      elements.push(
        rect(ex, ey, ew, eh, {
          fill: `url(#${EDGE_TRIM_HATCH_ID})`,
          stroke: "none",
          data_role: "edge-trim",
        }),
      );
    }
    if (stock.kind === "sheet") {
      for (const y0 of [0.0, stock.width - edgeTrim]) {
        const [ex, ey, ew, eh] = transform.rect(0.0, y0, stock.length, edgeTrim);
        elements.push(
          rect(ex, ey, ew, eh, {
            fill: `url(#${EDGE_TRIM_HATCH_ID})`,
            stroke: "none",
            data_role: "edge-trim",
          }),
        );
      }
    }
  }

  let unitElements: Element[];
  let unitYield: number;
  if (stock.kind === "bar") {
    [unitElements, unitYield] = renderBarUnit(unit, plan, project, transform);
  } else {
    [unitElements, unitYield] = renderSheetUnit(unit, plan, project, transform);
  }
  elements.push(...unitElements);

  const title =
    `${stock.id} #${unit.index}／${fmt(stock.length)}×${fmt(stock.width)}×` +
    `${fmt(stock.thickness)}｜歩留まり ${(unitYield * 100).toFixed(1)}%`;
  const titleElem = text(offsetX, offsetY - 6, title, {
    font_size: FONT_SIZE_BODY,
    data_role: "panel-title",
  });

  return [g([titleElem, ...elements]), lengthPx, widthPx];
}

// ---------------------------------------------------------------------------
// 公開エントリ
// ---------------------------------------------------------------------------

/**
 * 1つの割付案を1つの木取り図 SVG 文書として描画する（設計正本 §5）。
 *
 * @param plan 描画対象の割付案。
 * @param project 正本データ（settings.kerf/edgeTrim/selectedPlan の参照に使う）。
 * @param planSummary metrics.summarize の戻り値（rankPlans 適用後は
 *     rank / recommended / exactMatch を含む）。ヘッダの歩留まり(全体)・概算費用・
 *     必要本数・カット回数・推奨案表記の表示にのみ使う。
 * @returns SVG 文字列。
 */
export function renderCutplan(
  plan: Plan,
  project: Project,
  planSummary: PlanSummary,
): string {
  const units = plan.units;
  const maxLength =
    units.length > 0 ? Math.max(...units.map((u) => u.stock.length)) : 1.0;
  const scale = clamp(SCALE_BASE_PX / maxLength, SCALE_MIN, SCALE_MAX);

  const panels: Element[] = [];
  let docWidth = 0.0;
  let yCursor = MARGIN + HEADER_HEIGHT;

  for (const unit of units) {
    const panelOffsetY = yCursor + PANEL_TITLE_HEIGHT;
    const [panelElem, panelW, panelH] = renderPanel(
      unit,
      plan,
      project,
      scale,
      MARGIN,
      panelOffsetY,
    );
    panels.push(panelElem);
    docWidth = Math.max(docWidth, MARGIN + panelW + MARGIN);
    yCursor = panelOffsetY + panelH + PANEL_GAP;
  }

  const docHeight = yCursor + MARGIN;
  if (docWidth <= 0) {
    docWidth = MARGIN * 2 + SCALE_BASE_PX;
  }

  const doc = new SvgDocument(docWidth, docHeight);
  doc.add(edgeTrimDefs());
  doc.add(
    text(MARGIN, MARGIN + FONT_SIZE_HEADER, buildHeaderText(plan, project, planSummary), {
      font_size: FONT_SIZE_HEADER,
      data_role: "header",
    }),
  );
  for (const panel of panels) {
    doc.add(panel);
  }

  return doc.render();
}
