/**
 * 2D（sheet）の厳密探索: 分枝限定＋コーナーポイント配置の全探索。
 *
 * kerf は各部材の右・上に kerf を付加し、使用可能窓も右・上に kerf を
 * 拡張することで表現する（部材間隔 kerf の確保と等価）:
 *   窓 W' = (L − 2·edgeTrim) + kerf, H' = (W − 2·edgeTrim) + kerf
 *   部材 w' = len + kerf, h' = wid + kerf（rot 時は入替え）
 *
 * 分枝限定:
 *   - 部材を面積降順に並べ、各部材について「既存シートのコーナーポイント
 *     候補位置 × 回転可否」および「新規シートの原点」への配置をすべて分枝する。
 *   - コーナーポイント候補: x ∈ {0} ∪ {配置済み矩形の右端}、
 *     y ∈ {0} ∪ {配置済み矩形の上端}（窓内・非重複のもの）。
 *   - 下界は ceil(残面積合計 ÷ 窓面積)。
 *
 * 注意: コーナーポイント候補は配置存在性の完全な網羅を保証しない
 * （厳密な網羅には normal patterns 全列挙が必要）。そのため本探索の結果は、
 * 面積下界と一致した場合に限り「最適性証明あり」として扱う（exact/index.ts）。
 */

import { EPS } from "../packing/common";
import { Budget } from "./budget";

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

/** シート内の候補位置（コーナーポイント）を列挙する。 */
function candidatePositions(placed: Rect[]): [number, number][] {
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
  // 左下優先（(y, x) 昇順）で並べる。
  out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return out;
}

/**
 * 分枝限定で最小枚数の 2D 割付を求める。
 *
 * @param items kerf 込みサイズの部材一覧。全部材が単体で窓に収まること
 *   （呼び出し側＝意味検証層で担保）。
 * @param winW 窓の X 方向サイズ（kerf 込み）。
 * @param winH 窓の Y 方向サイズ（kerf 込み）。
 * @param budget 探索ノード予算。超過時は BudgetExceededError が伝播する。
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
    return { count: 0, sheets: [], lowerBound: 0 };
  }

  // 面積降順に並べる。
  const order = [...items].sort((a, b) => b.w * b.h - a.w * a.h || a.idx - b.idx);

  const totalArea = order.reduce((s, it) => s + it.w * it.h, 0);
  const suffixArea = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    suffixArea[i] = suffixArea[i + 1] + order[i].w * order[i].h;
  }
  const areaLB = Math.max(1, Math.ceil(totalArea / sheetArea - EPS));

  // 貪欲（先頭候補位置への first-fit）で初期上界を得る。
  const greedySheets: Rect[][] = [];
  for (const item of order) {
    let placed = false;
    for (const sheet of greedySheets) {
      const pos = tryPlace(sheet, item, winW, winH);
      if (pos) {
        sheet.push(pos);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const orient = fitOrientations(item, winW, winH)[0];
      greedySheets.push([
        { x: 0, y: 0, w: orient[0], h: orient[1], idx: item.idx, rotated: orient[2] },
      ]);
    }
  }

  let bestCount = greedySheets.length;
  let bestSheets: Rect[][] = greedySheets.map((s) => s.map((r) => ({ ...r })));

  if (areaLB >= bestCount) {
    return { count: bestCount, sheets: toPlacements(bestSheets), lowerBound: areaLB };
  }

  const sheets: Rect[][] = [];

  const dfs = (pos: number): void => {
    budget.tick();
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

    for (let s = 0; s < sheets.length; s++) {
      const sheet = sheets[s];
      const positions = candidatePositions(sheet);
      for (const [cx, cy] of positions) {
        for (const [w, h, rotated] of fitOrientations(item, winW, winH)) {
          if (cx + w > winW + EPS || cy + h > winH + EPS) {
            continue;
          }
          if (sheet.some((r) => overlaps(r, cx, cy, w, h))) {
            continue;
          }
          sheet.push({ x: cx, y: cy, w, h, idx: item.idx, rotated });
          dfs(pos + 1);
          sheet.pop();
        }
      }
    }

    // 新規シートを開く（原点配置のみ。開くのは常に1つだけ）。
    if (sheets.length + 1 < bestCount) {
      for (const [w, h, rotated] of fitOrientations(item, winW, winH)) {
        sheets.push([{ x: 0, y: 0, w, h, idx: item.idx, rotated }]);
        dfs(pos + 1);
        sheets.pop();
        // 正方形（回転が無意味）の場合は1方向のみ。
        if (Math.abs(item.w - item.h) <= EPS) {
          break;
        }
      }
    }
  };

  dfs(0);

  return { count: bestCount, sheets: toPlacements(bestSheets), lowerBound: areaLB };
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

/** first-fit: 候補位置を (y,x) 昇順に試し、最初に収まる位置の Rect を返す。 */
function tryPlace(
  sheet: Rect[],
  item: Exact2DItem,
  winW: number,
  winH: number,
): Rect | null {
  for (const [cx, cy] of candidatePositions(sheet)) {
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
