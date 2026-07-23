/**
 * 1D（bar）の厳密探索: kerf 込みビンパッキングの分枝限定法。
 *
 * 「部材長 len_i、有効長 U、部材間 kerf」のビンパッキングは、
 * サイズ len_i + kerf・容量 U + kerf の標準ビンパッキングと等価である
 * （1本に k 個入れる条件 Σlen + (k−1)·kerf ≤ U ⟺ Σ(len+kerf) ≤ U+kerf）。
 *
 * 分枝限定:
 *   - 初期上界（incumbent）は FFD 解。
 *   - 下界は ceil(残サイズ合計 ÷ 容量)。
 *   - 対称性除去: 残容量が同一のビンには最初の1つにのみ入れる。
 *     新規ビンは常に1つだけ開く。同一長の部材は直前の同長部材が入った
 *     ビン以降にのみ入れる。
 *
 * 探索が（予算内で）完了すれば、返る本数は真の最小本数である。予算超過時は
 * BudgetExceededError を内部で捕捉し、その時点の incumbent（FFD 解または探索中の
 * 最良解）を complete: false で返す。complete: false でも count === lowerBound なら
 * （下界一致により）最適が証明される。
 */

import { EPS } from "../packing/common";
import { Budget, BudgetExceededError } from "./budget";

export interface Exact1DResult {
  /** 必要本数の最小値（complete が false のときは上界）。 */
  count: number;
  /** 各ビンに入る部材のインデックス（入力配列基準）。ビン内は長い順。 */
  bins: number[][];
  /** 情報理論的下界 ceil(Σ(len+kerf) ÷ (usable+kerf))。count === lowerBound なら最適。 */
  lowerBound: number;
  /** 予算内で分枝限定が完走したか。true なら count は真の最小本数である。 */
  complete: boolean;
}

/**
 * 分枝限定で最小本数の 1D 割付を求める。
 *
 * @param lengths 部材長の配列（mm）。全要素が usable 以下であること（呼び出し側で担保）。
 * @param usable 有効長 U（mm）。
 * @param kerf 鋸刃厚（mm）。
 * @param budget 探索ノード予算。超過時は BudgetExceededError が伝播する。
 */
export function exactPack1d(
  lengths: number[],
  usable: number,
  kerf: number,
  budget: Budget,
): Exact1DResult {
  const n = lengths.length;
  if (n === 0) {
    return { count: 0, bins: [], lowerBound: 0, complete: true };
  }

  const cap = usable + kerf;
  // サイズ降順に並べ替え（元インデックスを保持）。
  const order = lengths
    .map((len, idx) => ({ size: len + kerf, idx }))
    .sort((a, b) => b.size - a.size || a.idx - b.idx);

  // FFD で初期上界を得る。
  const ffdBins: { remaining: number; items: number[] }[] = [];
  for (const item of order) {
    let placed = false;
    for (const bin of ffdBins) {
      if (item.size <= bin.remaining + EPS) {
        bin.remaining -= item.size;
        bin.items.push(item.idx);
        placed = true;
        break;
      }
    }
    if (!placed) {
      ffdBins.push({ remaining: cap - item.size, items: [item.idx] });
    }
  }

  let bestCount = ffdBins.length;
  let bestBins: number[][] = ffdBins.map((b) => [...b.items]);

  const totalSize = order.reduce((s, it) => s + it.size, 0);

  // suffixSize[i] = order[i..] のサイズ合計（下界計算用）。
  const suffixSize = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    suffixSize[i] = suffixSize[i + 1] + order[i].size;
  }

  // 下界: 使用中ビン数 + 「残部材サイズのうち使用中ビンの空きに入り切らない分」
  // に必要な追加ビン数。開いているビンの空き（freeSum）を差し引かないと
  // 下界が過大になり、最適枝を誤って刈ってしまう。
  const lowerBound = (
    used: number,
    remainingSize: number,
    freeSum: number,
  ): number => {
    const excess = remainingSize - freeSum;
    return used + (excess > EPS ? Math.ceil((excess - EPS) / cap) : 0);
  };

  // 情報理論的下界（ビン内を長い順に整えてから返す共通処理）。
  const gLB = lowerBound(0, totalSize, 0);
  const finish = (complete: boolean): Exact1DResult => {
    for (const bin of bestBins) {
      bin.sort((a, b) => lengths[b] - lengths[a] || a - b);
    }
    return { count: bestCount, bins: bestBins, lowerBound: gLB, complete };
  };

  // 直前の stock で予算枯渇済み → 探索せず FFD 解を返す（未証明）。
  if (budget.exhausted) {
    return finish(false);
  }
  if (gLB >= bestCount) {
    return finish(true);
  }

  const binRemaining: number[] = [];
  const binItems: number[][] = [];
  let freeSum = 0;
  // 同一長部材の対称性除去: order 上で直前の同サイズ部材が入ったビン番号。
  const minBinForItem = new Array<number>(n).fill(0);

  const dfs = (pos: number): void => {
    // incumbent が下界に達したら探索全体を即終了する。
    if (bestCount <= gLB) {
      return;
    }
    budget.tick();
    if (pos === n) {
      if (binItems.length < bestCount) {
        bestCount = binItems.length;
        bestBins = binItems.map((items) => [...items]);
      }
      return;
    }
    if (lowerBound(binItems.length, suffixSize[pos], freeSum) >= bestCount) {
      return;
    }

    const item = order[pos];

    // 同サイズの直前部材が入ったビン以降にのみ配置する。
    let minBin = 0;
    if (pos > 0 && Math.abs(order[pos - 1].size - item.size) <= EPS) {
      minBin = minBinForItem[pos - 1];
    }

    const triedRemaining: number[] = [];
    for (let b = minBin; b < binItems.length; b++) {
      if (item.size > binRemaining[b] + EPS) {
        continue;
      }
      // 残容量が同一のビンは最初の1つのみ試す（対称性除去）。
      if (triedRemaining.some((r) => Math.abs(r - binRemaining[b]) <= EPS)) {
        continue;
      }
      triedRemaining.push(binRemaining[b]);

      binRemaining[b] -= item.size;
      freeSum -= item.size;
      binItems[b].push(item.idx);
      minBinForItem[pos] = b;
      dfs(pos + 1);
      binItems[b].pop();
      binRemaining[b] += item.size;
      freeSum += item.size;

      // 途中で incumbent が更新され、これ以上の探索が無意味になった場合。
      if (lowerBound(binItems.length, suffixSize[pos], freeSum) >= bestCount) {
        return;
      }
    }

    // 新規ビンを開く（開くのは常に1つだけ）。
    if (binItems.length + 1 < bestCount) {
      binRemaining.push(cap - item.size);
      freeSum += cap - item.size;
      binItems.push([item.idx]);
      minBinForItem[pos] = binItems.length - 1;
      dfs(pos + 1);
      binItems.pop();
      binRemaining.pop();
      freeSum -= cap - item.size;
    }
  };

  let complete = true;
  try {
    dfs(0);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      complete = false;
    } else {
      throw e;
    }
  }

  // ビン内を入力インデックス順ではなく「長い順」に整える（FFD 由来の
  // bestBins と分枝限定由来の bins の表現を揃える。配置は長い順が自然）。
  return finish(complete);
}
