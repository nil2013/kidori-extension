/**
 * 割付結果の共通データ型と、kerf/edgeTrim 消費モデルのヘルパ関数。
 *
 * 全割付トラック（pack1d.ts / pack2d.ts / exact/*）・metrics.ts・render 系が
 * 共有する契約。kerf/edgeTrim に関する計算はすべてここを経由する。
 *
 * ## kerf・edgeTrim 消費モデル
 *
 * - edgeTrim = 「生端から edgeTrim mm 以内の材は不健全（荒れ・割れ）」の深さ。
 *   部材の実体はこの不健全域に一切かかってはならない。
 * - 使用可能窓: [edgeTrim, L − edgeTrim]、有効長 U = L − 2・edgeTrim（usableLength）。
 * - 配置: o_1 = edgeTrim、o_{i+1} = o_i + len_i + kerf。
 * - 充填可否: Σlen_i + (n−1)・kerf ≤ U（等号成立を許容。fits1d）。
 * - カット回数（1本あたり）:
 *   (edgeTrim>0 ? 1 : 0) + (n−1) + (edgeTrim==0 かつ E==L でなければ 1)
 *   （cutCount1d）。E は最後の部材の右端座標。
 *
 * 浮動小数の等号成立判定は EPS = 1e-9 で許容する。
 */

import type { Part, Settings, Stock } from "../types";

/**
 * 浮動小数比較の許容誤差。境界値（等号成立）判定に用いる。
 * 全モジュールはこの定数を import して使用し、独自の epsilon を定義しない。
 */
export const EPS = 1e-9;

/**
 * qty 展開後の部材1個。
 * parts[].qty > 1 の場合、同一 Part から qty 個の PartInstance が
 * index=1..qty で生成される。
 */
export interface PartInstance {
  /** 元となる Part 定義。 */
  part: Part;
  /** 同一 Part 内の通し番号（1始まり）。 */
  index: number;
}

/** `{part.id}#{index}` 形式の一意な識別子を返す。 */
export function instanceId(instance: PartInstance): string {
  return `${instance.part.id}#${instance.index}`;
}

/** 1D割付における1個の部材の配置。 */
export interface Placement1D {
  /** 配置される部材インスタンス。 */
  instance: PartInstance;
  /** 原材の生端（x=0）から部材の左端までの距離（mm）。 */
  start: number;
}

/** 2D割付における1個の部材の配置。 */
export interface Placement2D {
  /** 配置される部材インスタンス。 */
  instance: PartInstance;
  /** 原材の生端左下を原点とした、部材左下角の X 座標（mm、実座標）。 */
  x: number;
  /** 原材の生端左下を原点とした、部材左下角の Y 座標（mm、実座標）。 */
  y: number;
  /** 90°回転して配置されたか（true の場合、実寸は width×length になる）。 */
  rotated: boolean;
}

export type Placement = Placement1D | Placement2D;

/** Placement が 2D かどうかの型ガード。 */
export function isPlacement2D(p: Placement): p is Placement2D {
  return "x" in p;
}

/** 割付に使われた原材1本（1D）または1枚（2D）。 */
export interface StockUnit {
  /** 使用する原材の定義。 */
  stock: Stock;
  /** 同一原材 id 内での通し番号（1始まり）。 */
  index: number;
  /**
   * この原材上の配置一覧。stock.kind==="bar" なら Placement1D[]、
   * "sheet" なら Placement2D[]。
   */
  placements: Placement[];
}

/** 1D 割付方式。"exact" は厳密探索（分枝限定）による案 X。 */
export type Method1D = "ffd" | "bfd" | "grouped" | "exact";

/** 2D 割付方式。"exact" は厳密探索（分枝限定）による案 X。 */
export type Method2D = "bssf" | "baf" | "bl" | "exact";

/** 1つの割付案（A/B/C または厳密探索の X）。 */
export interface Plan {
  /** 案 ID（"A"/"B"/"C"/"X"）。 */
  id: string;
  /** 適用した1D割付方式。 */
  method1d: Method1D;
  /** 適用した2D割付方式。 */
  method2d: Method2D;
  /** この案で使用する StockUnit の一覧（bar/sheet 混在可）。 */
  units: StockUnit[];
  /**
   * instanceId → 配置番号（①②③…に対応する 1始まりの整数）の対応表。
   * units→placements の順（1D は start 昇順、2D は (y, x) 昇順）で通し採番される。
   * 木取り図・加工指示図の連動に使う。
   */
  seq: Record<string, number>;
}

/** 1D割付の有効長 U = L − 2・edgeTrim を返す。 */
export function usableLength(stockLength: number, edgeTrim: number): number {
  return stockLength - 2.0 * edgeTrim;
}

/**
 * 指定の部材が原材内の残り容量に収まるかを判定する。
 *
 * 充填可否条件: `usedLen + (count > 0 ? kerf : 0) + partLen <= usable`。
 * 浮動小数の等号成立は EPS で許容する（境界値は「収まる」側に倒す）。
 *
 * @param usedLen これまでにこの原材へ配置した部材長の合計（kerf を含む）。
 * @param count これまでにこの原材へ配置した部材の個数。0 の場合は先頭配置のため kerf を消費しない。
 * @param partLen 新たに配置しようとする部材の長さ（mm）。
 * @param kerf 鋸刃厚（mm）。
 * @param usable 有効長 U（mm、usableLength の戻り値）。
 */
export function fits1d(
  usedLen: number,
  count: number,
  partLen: number,
  kerf: number,
  usable: number,
): boolean {
  const needed = usedLen + (count > 0 ? kerf : 0.0) + partLen;
  return needed <= usable + EPS;
}

/**
 * 1本の原材に対する1D割付のカット回数を返す。
 *
 * 式: (edgeTrim>0 ? 1 : 0) + (n−1) + (edgeTrim==0 かつ E==L でなければ 1)。
 * E は最後（start が最大）の部材の右端座標 `start + part.length`、L は stock.length。
 * edgeTrim==0 の判定・E==L の判定はいずれも EPS で許容する。
 *
 * @param placements この原材上の1D配置一覧（順不同で渡してよい）。
 * @returns カット回数。placements が空の場合は 0。
 */
export function cutCount1d(
  placements: Placement1D[],
  stock: Stock,
  settings: Settings,
): number {
  const n = placements.length;
  if (n === 0) {
    return 0;
  }

  const edgeTrim = settings.edgeTrim;
  let last = placements[0];
  for (const p of placements) {
    if (p.start > last.start) {
      last = p;
    }
  }
  const endEdge = last.start + last.instance.part.length;

  const leading = edgeTrim <= EPS ? 0 : 1;
  const interior = n - 1;
  const trailingOmit = edgeTrim <= EPS && Math.abs(endEdge - stock.length) <= EPS;
  const trailing = trailingOmit ? 0 : 1;

  return leading + interior + trailing;
}
