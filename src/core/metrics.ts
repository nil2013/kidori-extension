/**
 * 割付案（Plan）から summary.json 相当のメトリクスを算出する。
 *
 * 公開 API:
 *   - `summarize(plan, project)`: Plan 1件ぶんの summary.json `plans[]` 要素。
 *   - `rankPlans(summaries, rankKeys)`: settings.rank に基づく順位付け（v0.4）。
 *   - `buildSummary(...)`: summary.json 全体。
 *
 * `generatedAt` は呼び出し側（build.ts）が ISO 文字列で渡す
 * （本モジュールが現在時刻を取得すると、テストの決定性が損なわれるため）。
 *
 * 1D のカット回数計算は `packing/common.cutCount1d` を必ず再利用し、
 * 本モジュールで独自の 1D カット回数式を再実装しない。
 *
 * 2D のカット回数は「縁の切り出し 4 回（edgeTrim>0 のとき）＋使用可能窓の境界に
 * 載っていない部材辺の数」による概算値である（共線カットの1パス統合は行わない。
 * ギロチン制約対応時に再定義する）。表示上は「カット回数（概算）」として扱う。
 */

import type { ExactMode, Project, RankKey, Settings, Stock } from "./types";
import { effectiveWidth } from "./types";
import {
  EPS,
  Placement1D,
  Placement2D,
  Plan,
  StockUnit,
  cutCount1d,
} from "./packing/common";

// ---------------------------------------------------------------------------
// summary.json の型
// ---------------------------------------------------------------------------

export interface PlacementOut1D {
  part: string;
  instance: number;
  seq: number;
  start: number;
  length: number;
}

export interface PlacementOut2D {
  part: string;
  instance: number;
  seq: number;
  x: number;
  y: number;
  rotated: boolean;
  length: number;
  width: number;
}

export interface UnitOut {
  index: number;
  placements: (PlacementOut1D | PlacementOut2D)[];
  /** bar のみ: 最後の部材右端から使用可能窓右端までの残長（mm）。 */
  remnant?: number;
}

export interface StockGroupOut {
  stockId: string;
  kind: "bar" | "sheet";
  count: number;
  unitPrice: number | null;
  subtotal: number | null;
  yield: number;
  cutCount: number;
  units: UnitOut[];
}

export interface PlanTotals {
  cost: number | null;
  costComplete: boolean;
  yield: number;
  cutCount: number;
  stockCounts: Record<string, number>;
}

/** summary.json の plans[] 1要素。 */
export interface PlanSummary {
  id: string;
  method: { "1d": string; "2d": string };
  stocks: StockGroupOut[];
  totals: PlanTotals;
  /** settings.rank に基づく順位（1始まり）。rankPlans() が設定する。 */
  rank?: number;
  /** 最上位＝推奨案（★）。rankPlans() が設定する。 */
  recommended?: boolean;
  /** 最小必要本数が厳密解と一致したヒューリスティック案に立つフラグ（proven 時のみ）。 */
  exactMatch?: boolean;
  /**
   * 案 X（厳密探索案）のみに設定する、最適性の証明状態。
   * true なら「候補X（厳密解）」、false なら「探索案X（最適性未証明）」と表示する。
   */
  exactProven?: boolean;
}

/** summary.json の exact 区画（厳密探索の実行結果メタ情報）。 */
export interface ExactInfo {
  mode: ExactMode;
  /** 厳密探索を実行したか。 */
  ran: boolean;
  /** 最適性を証明できたか（探索が打ち切りなしで完了したか）。 */
  proven: boolean;
  /** 厳密解と必要本数が一致したヒューリスティック案の ID（一致なしは null）。 */
  matchesPlan: string | null;
  /** 実行しなかった・証明できなかった場合の理由（日本語）。 */
  reason: string | null;
}

/** summary.json のトップレベル。 */
export interface Summary {
  schemaVersion: string;
  generatedAt: string;
  project: string;
  selectedPlan: string | null;
  rank: RankKey[];
  /** rank 最上位の案 ID（候補が空の場合 null）。 */
  recommendedPlan: string | null;
  /** rank 順に並べた案 ID の一覧。 */
  rankedPlans: string[];
  exact: ExactInfo;
  plans: PlanSummary[];
}

// ---------------------------------------------------------------------------
// 2D カット回数（概算）
// ---------------------------------------------------------------------------

/**
 * 配置された部材の実寸フットプリント (x方向長さ, y方向長さ) を実座標基準で返す。
 * rotated=true の場合、実寸は width×length になる。
 */
export function placementExtent(
  placement: Placement2D,
  stock: Stock,
): [number, number] {
  const part = placement.instance.part;
  const w = effectiveWidth(part, stock);
  if (placement.rotated) {
    return [w, part.length];
  }
  return [part.length, w];
}

/**
 * 1枚（1 StockUnit）あたりの2D割付カット回数（概算）を返す。
 *
 * 定義: 縁の切り出しカット 4回（edgeTrim>0 のとき）
 * ＋ 各部材ごとの「使用可能窓の境界に載っていない辺」の数の合計。
 *
 * 共線カットの1パス統合は行わない（自由配置では複数部材の切断線がちょうど
 * 一直線に並ぶ保証がなく、統合の可否判定が別途必要になるため）。
 */
export function cutCount2d(
  unit: StockUnit,
  stock: Stock,
  settings: Settings,
): number {
  const edgeTrim = settings.edgeTrim;
  const edgeCut = edgeTrim > EPS ? 4 : 0;

  const leftBoundary = edgeTrim;
  const rightBoundary = stock.length - edgeTrim;
  const bottomBoundary = edgeTrim;
  const topBoundary = stock.width - edgeTrim;

  let uncovered = 0;
  for (const placement of unit.placements as Placement2D[]) {
    const [ex, ey] = placementExtent(placement, stock);
    const onBoundary = [
      Math.abs(placement.x - leftBoundary) <= EPS,
      Math.abs(placement.x + ex - rightBoundary) <= EPS,
      Math.abs(placement.y - bottomBoundary) <= EPS,
      Math.abs(placement.y + ey - topBoundary) <= EPS,
    ];
    for (const on of onBoundary) {
      if (!on) {
        uncovered += 1;
      }
    }
  }

  return edgeCut + uncovered;
}

// ---------------------------------------------------------------------------
// summarize: Plan 1件ぶんの summary.json plans[] 要素
// ---------------------------------------------------------------------------

/**
 * Plan 1件ぶんの summary.json `plans[]` 要素を組み立てる。
 *
 * stocks[] は project.stocks の宣言順のうち、この plan で実際に使用された
 * stock id のみを列挙する。各要素の `units` は unit.index 昇順、
 * `placements` は 1D なら start 昇順、2D なら (y, x) 昇順。
 *
 * 算出定義:
 *   - 歩留まり: bar = Σ部材長 ÷ (本数×L)。sheet = Σ部材面積 ÷ (枚数×L×W)。
 *     分母は原材全体（有効長ではない）。
 *   - totals.yield は体積ベース:
 *     Σ(部材の length×width×原材thickness) ÷ Σ(原材 L×W×t)。
 *   - 費用: subtotal = count×price。totals.cost は price のある規格の小計和、
 *     costComplete = 全使用規格に price があるか。price が1つも無ければ cost: null。
 *   - カット回数: 1D は cutCount1d、2D は cutCount2d（概算）。
 */
export function summarize(plan: Plan, project: Project): PlanSummary {
  const settings = project.settings;

  const unitsByStock = new Map<string, StockUnit[]>();
  for (const unit of plan.units) {
    const list = unitsByStock.get(unit.stock.id) ?? [];
    list.push(unit);
    unitsByStock.set(unit.stock.id, list);
  }
  for (const units of unitsByStock.values()) {
    units.sort((a, b) => a.index - b.index);
  }

  const stocksOut: StockGroupOut[] = [];
  const stockCounts: Record<string, number> = {};
  let costTotal = 0.0;
  let costAnyPriced = false;
  let costAllPriced = true;
  let volNumTotal = 0.0;
  let volDenTotal = 0.0;
  let cutCountTotal = 0;

  for (const stock of project.stocks) {
    const units = unitsByStock.get(stock.id);
    if (!units || units.length === 0) {
      continue;
    }

    const count = units.length;
    stockCounts[stock.id] = count;

    let subtotal: number | null;
    if (stock.price !== null) {
      subtotal = count * stock.price;
      costTotal += subtotal;
      costAnyPriced = true;
    } else {
      subtotal = null;
      costAllPriced = false;
    }

    if (stock.kind === "bar") {
      let groupLenSum = 0.0;
      let groupCutCount = 0;
      const unitsOut: UnitOut[] = [];
      for (const unit of units) {
        const placements = [...(unit.placements as Placement1D[])].sort(
          (a, b) => a.start - b.start,
        );

        let lenSum = 0.0;
        for (const p of placements) {
          lenSum += p.instance.part.length;
        }
        groupLenSum += lenSum;
        groupCutCount += cutCount1d(placements, stock, settings);

        let endEdge: number;
        if (placements.length > 0) {
          const last = placements[placements.length - 1];
          endEdge = last.start + last.instance.part.length;
        } else {
          endEdge = settings.edgeTrim;
        }
        const remnant = stock.length - settings.edgeTrim - endEdge;

        const placementsOut: PlacementOut1D[] = placements.map((p) => ({
          part: p.instance.part.id,
          instance: p.instance.index,
          seq: plan.seq[`${p.instance.part.id}#${p.instance.index}`],
          start: p.start,
          length: p.instance.part.length,
        }));
        unitsOut.push({ index: unit.index, placements: placementsOut, remnant });

        volDenTotal += stock.length * stock.width * stock.thickness;
        for (const p of placements) {
          const part = p.instance.part;
          volNumTotal += part.length * effectiveWidth(part, stock) * stock.thickness;
        }
      }

      const denom = count * stock.length;
      const groupYield = denom > 0 ? groupLenSum / denom : 0.0;
      cutCountTotal += groupCutCount;

      stocksOut.push({
        stockId: stock.id,
        kind: "bar",
        count,
        unitPrice: stock.price,
        subtotal,
        yield: groupYield,
        cutCount: groupCutCount,
        units: unitsOut,
      });
    } else {
      let groupAreaSum = 0.0;
      let groupCutCount = 0;
      const unitsOut: UnitOut[] = [];
      for (const unit of units) {
        const placements = [...(unit.placements as Placement2D[])].sort(
          (a, b) => a.y - b.y || a.x - b.x,
        );

        let areaSum = 0.0;
        for (const p of placements) {
          areaSum += p.instance.part.length * effectiveWidth(p.instance.part, stock);
        }
        groupAreaSum += areaSum;
        groupCutCount += cutCount2d(unit, stock, settings);

        const placementsOut: PlacementOut2D[] = placements.map((p) => ({
          part: p.instance.part.id,
          instance: p.instance.index,
          seq: plan.seq[`${p.instance.part.id}#${p.instance.index}`],
          x: p.x,
          y: p.y,
          rotated: p.rotated,
          length: p.instance.part.length,
          width: effectiveWidth(p.instance.part, stock),
        }));
        unitsOut.push({ index: unit.index, placements: placementsOut });

        volDenTotal += stock.length * stock.width * stock.thickness;
        for (const p of placements) {
          const part = p.instance.part;
          volNumTotal += part.length * effectiveWidth(part, stock) * stock.thickness;
        }
      }

      const denom = count * stock.length * stock.width;
      const groupYield = denom > 0 ? groupAreaSum / denom : 0.0;
      cutCountTotal += groupCutCount;

      stocksOut.push({
        stockId: stock.id,
        kind: "sheet",
        count,
        unitPrice: stock.price,
        subtotal,
        yield: groupYield,
        cutCount: groupCutCount,
        units: unitsOut,
      });
    }
  }

  const totalsYield = volDenTotal > 0 ? volNumTotal / volDenTotal : 0.0;

  const methodLabel = (m: string, prefix: string): string =>
    m === "exact" ? "exact" : `${prefix}${m}`;

  return {
    id: plan.id,
    method: {
      "1d": methodLabel(plan.method1d, ""),
      "2d": methodLabel(plan.method2d, "maxrects-"),
    },
    stocks: stocksOut,
    totals: {
      cost: costAnyPriced ? costTotal : null,
      costComplete: costAllPriced,
      yield: totalsYield,
      cutCount: cutCountTotal,
      stockCounts,
    },
  };
}

// ---------------------------------------------------------------------------
// rankPlans: settings.rank に基づく順位付け（v0.4）
// ---------------------------------------------------------------------------

/**
 * settings.rank の優先順で案を比較する。
 *
 * - cost: 概算費用の昇順（安いほど上位）。両者とも null の場合はこの基準を
 *   スキップする（parts[].stock が固定バインドのため、使用規格集合は案間で
 *   同一であり、cost は全案 null か全案非 null になる）。
 * - waste: 歩留まり（totals.yield）の降順（高いほど上位）。
 * - cuts: カット回数（totals.cutCount）の昇順（少ないほど上位）。
 *
 * 全基準で同値の場合はヒューリスティック案（A/B/C）を厳密案（X）より
 * 上位とし、さらに案 ID の辞書順で安定させる。
 */
export function comparePlanSummaries(
  a: PlanSummary,
  b: PlanSummary,
  rankKeys: RankKey[],
): number {
  for (const key of rankKeys) {
    let diff = 0;
    if (key === "cost") {
      if (a.totals.cost !== null && b.totals.cost !== null) {
        diff = a.totals.cost - b.totals.cost;
      }
    } else if (key === "waste") {
      diff = b.totals.yield - a.totals.yield;
    } else {
      diff = a.totals.cutCount - b.totals.cutCount;
    }
    if (Math.abs(diff) > EPS) {
      return diff;
    }
  }
  const aExact = a.id === "X" ? 1 : 0;
  const bExact = b.id === "X" ? 1 : 0;
  if (aExact !== bExact) {
    return aExact - bExact;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 各 PlanSummary に rank（1始まり）と recommended（最上位のみ true）を
 * 破壊的に設定し、rank 順の案 ID 一覧を返す。
 */
export function rankPlans(
  summaries: PlanSummary[],
  rankKeys: RankKey[],
): string[] {
  const sorted = [...summaries].sort((a, b) =>
    comparePlanSummaries(a, b, rankKeys),
  );
  sorted.forEach((s, i) => {
    s.rank = i + 1;
    s.recommended = i === 0;
  });
  return sorted.map((s) => s.id);
}

// ---------------------------------------------------------------------------
// buildSummary: summary.json 全体
// ---------------------------------------------------------------------------

/**
 * summary.json 全体を組み立てる。
 *
 * @param plansSummaries summarize()（＋rankPlans() 適用済み）の戻り値のリスト。
 * @param project 対象の Project。
 * @param generatedAt ISO 形式の生成時刻文字列（呼び出し側が現在時刻を渡す）。
 * @param exact 厳密探索の実行結果メタ情報。
 * @param rankedPlans rankPlans() が返した rank 順の案 ID 一覧。
 */
export function buildSummary(
  plansSummaries: PlanSummary[],
  project: Project,
  generatedAt: string,
  exact: ExactInfo,
  rankedPlans: string[],
): Summary {
  return {
    schemaVersion: project.meta.schemaVersion,
    generatedAt,
    project: project.meta.project,
    selectedPlan: project.settings.selectedPlan,
    rank: project.settings.rank,
    recommendedPlan: rankedPlans.length > 0 ? rankedPlans[0] : null,
    rankedPlans,
    exact,
    plans: plansSummaries,
  };
}
