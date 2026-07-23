/**
 * 2D（sheet）の厳密探索: normal patterns（正規パターン）候補による分枝限定。
 *
 * kerf は各部材の右・上に kerf を付加し、使用可能窓も右・上に kerf を
 * 拡張することで表現する（部材間隔 kerf の確保と等価）:
 *   窓 W' = (L − 2·edgeTrim) + kerf, H' = (W − 2·edgeTrim) + kerf
 *   部材 w' = len + kerf, h' = wid + kerf（rot 時は入替え）
 *
 * ## 完全性の保証（正規パターン）
 *
 * Herz / Christofides–Whitlock の正規化定理により、任意の実行可能配置は
 * left-bottom justified 形へ変形でき、各部材の左端・下端座標は部材寸法の
 * 部分集合和（normal pattern）に載る。本探索は入力全体から静的に構成した
 * X×Y の候補座標集合（部分集合和の上位集合）へ全部材を分枝するため、
 * 候補集合が上限（PATTERN_CAP）内に収まり予算内で探索が完走すれば、
 * 得られる必要枚数は真の最小である。
 *   - 候補は入力全体から静的に構成する（配置済み矩形に依存しない）。回転可部材は
 *     w か h のどちらか一方を高々1回寄与させる（真の集合の上位集合＝過剰近似で
 *     完全性は保たれ、余分な候補はノード増のみで見落としは生じない）。
 *   - 新規シートも原点に限定せず全候補へ分枝する（「新規シートは原点のみ」は
 *     風車型配置を見落とすため撤廃した）。開くのは末尾1枚のみ（空シートは交換可能）。
 *   - 各シートに最初に置かれる部材のみ、鏡映正準化で中心を左下 1/4 領域に限定する
 *     （各シートは独立に鏡映でき、健全な対称性削減となる）。
 *
 * ## 打ち切り時のフォールバック
 *
 * ノード予算超過・候補集合の上限（PATTERN_CAP）超過時は、その時点の incumbent
 * （貪欲解または探索中の最良解）を complete: false で返す（null は返さない）。
 * 分枝限定は常に実行可能解を保持しており、候補としての価値は最適性証明から独立である。
 * complete: false でも count === lowerBound なら（面積下界一致により）最適が証明される。
 */

import { EPS } from "../packing/common";
import { Budget, BudgetExceededError } from "./budget";

/** 各軸で許容する候補座標数の上限。超過時は完全な候補集合を構成できない。 */
const PATTERN_CAP = 4096;

export interface Exact2DItem {
  /** 呼び出し側のインデックス。 */
  idx: number;
  /** kerf 込みの X 方向サイズ（len + kerf）。 */
  w: number;
  /** kerf 込みの Y 方向サイズ（wid + kerf）。 */
  h: number;
  /** 90°回転を許すか。 */
  rot: boolean;
}

export interface Exact2DPlacement {
  idx: number;
  /** 窓左下原点のローカル X 座標（kerf 込み空間）。 */
  x: number;
  y: number;
  rotated: boolean;
}

export interface Exact2DResult {
  /** 必要枚数。 */
  count: number;
  /** 各シートの配置一覧。 */
  sheets: Exact2DPlacement[][];
  /** 面積下界。count === lowerBound なら真に最適。 */
  lowerBound: number;
  /**
   * 候補集合が完全（PATTERN_CAP 内）かつ予算内で探索が完走したか。
   * true なら count は真の最小である。false でも count === lowerBound なら最適。
   */
  complete: boolean;
  /** 候補集合が PATTERN_CAP を超えて完全に構成できなかったか（理由表示用）。 */
  capped: boolean;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  idx: number;
  rotated: boolean;
}

function overlaps(a: Rect, x: number, y: number, w: number, h: number): boolean {
  return (
    x < a.x + a.w - EPS &&
    a.x < x + w - EPS &&
    y < a.y + a.h - EPS &&
    a.y < y + h - EPS
  );
}

/** ソート済みの数列を EPS 幅で統合（重複除去）した新しい配列を返す。 */
function integrate(values: number[]): number[] {
  values.sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of values) {
    if (out.length === 0 || v - out[out.length - 1] > EPS) {
      out.push(v);
    }
  }
  return out;
}

/**
 * 正規パターン（部分集合和）の候補座標集合を静的に構成する。
 *
 * @param perItem 各部材が寄与しうる寸法の配列（非回転は [w]、回転可は [w, h]。
 *   回転可部材は w か h のどちらか一方が高々1回寄与する）。
 * @param cap 候補座標の上限（= 窓サイズ − 最小部材寸法）。これを超える座標には
 *   どの部材も置けないため枝刈りする（部分集合和は単調増加なので早期棄却は健全）。
 * @returns EPS 統合済みの昇順候補座標。要素数が PATTERN_CAP を超えたら null。
 */
export function normalPatterns(perItem: number[][], cap: number): number[] | null {
  let sums: number[] = [0];
  for (const opts of perItem) {
    const next: number[] = [];
    for (const s of sums) {
      next.push(s);
      for (const d of opts) {
        const v = s + d;
        if (v <= cap + EPS) {
          next.push(v);
        }
      }
    }
    sums = integrate(next);
    if (sums.length > PATTERN_CAP) {
      return null;
    }
  }
  return sums;
}

/** 部材が寄与しうる寸法の一覧（回転可かつ非正方なら [w, h]、それ以外は [w]）。 */
function extentOptions(w: number, h: number, rot: boolean): number[] {
  if (rot && Math.abs(w - h) > EPS) {
    return [w, h];
  }
  return [w];
}

/**
 * 分枝限定で最小枚数の 2D 割付を求める。
 *
 * @param items kerf 込みサイズの部材一覧。全部材が単体で窓に収まること
 *   （呼び出し側＝意味検証層で担保）。
 * @param winW 窓の X 方向サイズ（kerf 込み）。
 * @param winH 窓の Y 方向サイズ（kerf 込み）。
 * @param budget 候補位置の試行予算。stock 横断で共有され、枯渇後は探索を回さない。
 */
export function exactPack2d(
  items: Exact2DItem[],
  winW: number,
  winH: number,
  budget: Budget,
): Exact2DResult {
  const n = items.length;
  const sheetArea = winW * winH;
  if (n === 0) {
    return { count: 0, sheets: [], lowerBound: 0, complete: true, capped: false };
  }

  // 面積降順に並べる（静的候補なので順序固定でも完全性は保たれる）。
  const order = [...items].sort((a, b) => b.w * b.h - a.w * a.h || a.idx - b.idx);

  const totalArea = order.reduce((s, it) => s + it.w * it.h, 0);
  const suffixArea = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    suffixArea[i] = suffixArea[i + 1] + order[i].w * order[i].h;
  }
  const areaLB = Math.max(1, Math.ceil(totalArea / sheetArea - EPS));

  // 候補座標集合（正規パターン）を入力全体から静的に構成する。
  const minExtentX = Math.min(
    ...order.map((it) => (it.rot ? Math.min(it.w, it.h) : it.w)),
  );
  const minExtentY = Math.min(
    ...order.map((it) => (it.rot ? Math.min(it.w, it.h) : it.h)),
  );
  const xs = normalPatterns(
    order.map((it) => extentOptions(it.w, it.h, it.rot)),
    winW - minExtentX,
  );
  const ys = normalPatterns(
    order.map((it) => extentOptions(it.w, it.h, it.rot)),
    winH - minExtentY,
  );

  // 貪欲（コーナーポイント first-fit）で初期上界（incumbent）を得る。
  const greedySheets = greedyPack(order, winW, winH);
  let bestCount = greedySheets.length;
  let bestSheets: Rect[][] = greedySheets.map((s) => s.map((r) => ({ ...r })));

  // 候補集合の上限超過 → 完全な候補集合を構成できない（貪欲解＋未証明）。
  if (xs === null || ys === null) {
    return {
      count: bestCount,
      sheets: toPlacements(bestSheets),
      lowerBound: areaLB,
      complete: false,
      capped: true,
    };
  }
  // 直前の stock で予算枯渇済み → 探索せず貪欲解を返す（未証明）。
  if (budget.exhausted) {
    return {
      count: bestCount,
      sheets: toPlacements(bestSheets),
      lowerBound: areaLB,
      complete: false,
      capped: false,
    };
  }
  // 貪欲解が面積下界に達していれば最適。
  if (areaLB >= bestCount) {
    return {
      count: bestCount,
      sheets: toPlacements(bestSheets),
      lowerBound: areaLB,
      complete: true,
      capped: false,
    };
  }

  const sheets: Rect[][] = [];
  let complete = true;

  const dfs = (pos: number): void => {
    // incumbent が面積下界に達したら探索全体を即終了する。
    if (bestCount <= areaLB) {
      return;
    }
    if (pos === n) {
      if (sheets.length < bestCount) {
        bestCount = sheets.length;
        bestSheets = sheets.map((s) => s.map((r) => ({ ...r })));
      }
      return;
    }
    // 下界: 残部材の面積のうち既存シートの空きに入り切らない分は新規シートを要する。
    const excess = suffixArea[pos] - freeAreaOf(sheets, sheetArea);
    const lb =
      sheets.length + (excess > EPS ? Math.ceil(excess / sheetArea - EPS) : 0);
    if (lb >= bestCount) {
      return;
    }

    const item = order[pos];
    const orients = fitOrientations(item, winW, winH);

    // 既存シートの全候補位置へ分枝する。
    for (let s = 0; s < sheets.length; s++) {
      const sheet = sheets[s];
      for (const [w, h, rotated] of orients) {
        for (const cx of xs) {
          if (cx + w > winW + EPS) {
            continue;
          }
          for (const cy of ys) {
            if (cy + h > winH + EPS) {
              continue;
            }
            budget.tick();
            if (sheet.some((r) => overlaps(r, cx, cy, w, h))) {
              continue;
            }
            sheet.push({ x: cx, y: cy, w, h, idx: item.idx, rotated });
            dfs(pos + 1);
            sheet.pop();
          }
        }
      }
    }

    // 新規シートを開く（末尾1枚のみ）。最初の部材は鏡映正準化で左下 1/4 に限定する。
    if (sheets.length + 1 < bestCount) {
      const sheet: Rect[] = [];
      sheets.push(sheet);
      for (const [w, h, rotated] of orients) {
        for (const cx of xs) {
          if (cx + w > winW + EPS) {
            continue;
          }
          if (cx + w / 2 > winW / 2 + EPS) {
            continue; // 鏡映正準化（X）: 中心を左半分へ。
          }
          for (const cy of ys) {
            if (cy + h > winH + EPS) {
              continue;
            }
            if (cy + h / 2 > winH / 2 + EPS) {
              continue; // 鏡映正準化（Y）: 中心を下半分へ。
            }
            budget.tick();
            sheet.push({ x: cx, y: cy, w, h, idx: item.idx, rotated });
            dfs(pos + 1);
            sheet.pop();
          }
        }
      }
      sheets.pop();
    }
  };

  try {
    dfs(0);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      complete = false;
    } else {
      throw e;
    }
  }

  return {
    count: bestCount,
    sheets: toPlacements(bestSheets),
    lowerBound: areaLB,
    complete,
    capped: false,
  };
}

/** 窓に収まる向き（[w, h, rotated]）の一覧を返す。 */
function fitOrientations(
  item: Exact2DItem,
  winW: number,
  winH: number,
): [number, number, boolean][] {
  const out: [number, number, boolean][] = [];
  if (item.w <= winW + EPS && item.h <= winH + EPS) {
    out.push([item.w, item.h, false]);
  }
  if (item.rot && Math.abs(item.w - item.h) > EPS && item.h <= winW + EPS && item.w <= winH + EPS) {
    out.push([item.h, item.w, true]);
  }
  return out;
}

/** 貪欲（コーナーポイント first-fit）で初期上界となる配置を構成する。 */
function greedyPack(
  order: Exact2DItem[],
  winW: number,
  winH: number,
): Rect[][] {
  const sheets: Rect[][] = [];
  for (const item of order) {
    let placed = false;
    for (const sheet of sheets) {
      const pos = tryPlaceGreedy(sheet, item, winW, winH);
      if (pos) {
        sheet.push(pos);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const orient = fitOrientations(item, winW, winH)[0];
      sheets.push([
        { x: 0, y: 0, w: orient[0], h: orient[1], idx: item.idx, rotated: orient[2] },
      ]);
    }
  }
  return sheets;
}

/** シート内のコーナーポイント候補（貪欲用）。 */
function cornerPositions(placed: Rect[]): [number, number][] {
  const xs = new Set<number>([0]);
  const ys = new Set<number>([0]);
  for (const r of placed) {
    xs.add(r.x + r.w);
    ys.add(r.y + r.h);
  }
  const out: [number, number][] = [];
  for (const x of xs) {
    for (const y of ys) {
      out.push([x, y]);
    }
  }
  out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return out;
}

/** first-fit: コーナーポイントを (y,x) 昇順に試し、最初に収まる位置の Rect を返す。 */
function tryPlaceGreedy(
  sheet: Rect[],
  item: Exact2DItem,
  winW: number,
  winH: number,
): Rect | null {
  for (const [cx, cy] of cornerPositions(sheet)) {
    for (const [w, h, rotated] of fitOrientations(item, winW, winH)) {
      if (cx + w > winW + EPS || cy + h > winH + EPS) {
        continue;
      }
      if (!sheet.some((r) => overlaps(r, cx, cy, w, h))) {
        return { x: cx, y: cy, w, h, idx: item.idx, rotated };
      }
    }
  }
  return null;
}

/** 既存シートの空き面積合計。 */
function freeAreaOf(sheets: Rect[][], sheetArea: number): number {
  let used = 0;
  for (const sheet of sheets) {
    for (const r of sheet) {
      used += r.w * r.h;
    }
  }
  return sheets.length * sheetArea - used;
}

function toPlacements(sheets: Rect[][]): Exact2DPlacement[][] {
  return sheets.map((sheet) =>
    sheet.map((r) => ({ idx: r.idx, x: r.x, y: r.y, rotated: r.rotated })),
  );
}
