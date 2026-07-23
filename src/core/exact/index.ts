/**
 * 厳密探索（settings.exact）のオーケストレーション。
 *
 * parts[].stock は明示バインドのため、stock id ごとに独立へ分解して
 * 最小本数（枚数）を厳密に求め、全体を案 X（method "exact"）として組み立てる。
 *
 * - mode "off": 実行しない。
 * - mode "auto": 部材インスタンス総数が AUTO_LIMIT（15）以下のときのみ実行。
 * - mode "on": 部材数によらず実行（ノード予算は適用される）。
 *
 * 最適性の証明状態（proven）:
 *   - 1D は分枝限定が完了すれば常に証明あり。
 *   - 2D はコーナーポイント候補が配置存在性の完全網羅を保証しないため、
 *     面積下界と一致した場合のみ証明ありとする。
 *   - ノード予算超過で打ち切った場合は plan なし・証明なし。
 */

import type { Project, Stock } from "../types";
import { effectiveWidth } from "../types";
import {
  PartInstance,
  Placement1D,
  Placement2D,
  Plan,
  StockUnit,
  instanceId,
  usableLength,
} from "../packing/common";
import { Budget, BudgetExceededError } from "./budget";
import { exactPack1d } from "./exact1d";
import { Exact2DItem, exactPack2d } from "./exact2d";

/** exact: auto のとき厳密探索を実行する部材インスタンス総数の上限（SPECS.md §4 目安）。 */
export const AUTO_LIMIT = 15;

/** 探索ノード予算のデフォルト値。 */
export const DEFAULT_NODE_BUDGET = 500_000;

export interface ExactRunResult {
  /** 厳密探索を実行したか。 */
  ran: boolean;
  /** 最適性を証明できたか。 */
  proven: boolean;
  /** 厳密探索による案 X（実行しなかった・打ち切った場合は null）。 */
  plan: Plan | null;
  /** 実行しなかった・証明できなかった場合の理由（日本語）。proven 時は null。 */
  reason: string | null;
}

function expandByStock(project: Project): Map<string, PartInstance[]> {
  const byStock = new Map<string, PartInstance[]>();
  for (const part of project.parts) {
    for (let index = 1; index <= part.qty; index++) {
      const list = byStock.get(part.stock) ?? [];
      list.push({ part, index });
      byStock.set(part.stock, list);
    }
  }
  return byStock;
}

function packBarExact(
  instances: PartInstance[],
  stock: Stock,
  kerf: number,
  edgeTrim: number,
  budget: Budget,
): StockUnit[] {
  const usable = usableLength(stock.length, edgeTrim);
  const lengths = instances.map((inst) => inst.part.length);
  const result = exactPack1d(lengths, usable, kerf, budget);

  const units: StockUnit[] = [];
  result.bins.forEach((bin, i) => {
    const placements: Placement1D[] = [];
    let offset = edgeTrim;
    for (const itemIdx of bin) {
      const inst = instances[itemIdx];
      placements.push({ instance: inst, start: offset });
      offset += inst.part.length + kerf;
    }
    units.push({ stock, index: i + 1, placements });
  });
  return units;
}

function packSheetExact(
  instances: PartInstance[],
  stock: Stock,
  kerf: number,
  edgeTrim: number,
  budget: Budget,
): { units: StockUnit[]; proven: boolean } {
  const winW = usableLength(stock.length, edgeTrim) + kerf;
  const winH = usableLength(stock.width, edgeTrim) + kerf;
  const items: Exact2DItem[] = instances.map((inst, i) => ({
    idx: i,
    w: inst.part.length + kerf,
    h: effectiveWidth(inst.part, stock) + kerf,
    rot: inst.part.rot,
  }));
  const result = exactPack2d(items, winW, winH, budget);

  const units: StockUnit[] = [];
  result.sheets.forEach((sheet, i) => {
    const placements: Placement2D[] = sheet.map((p) => ({
      instance: instances[p.idx],
      x: edgeTrim + p.x,
      y: edgeTrim + p.y,
      rotated: p.rotated,
    }));
    placements.sort((a, b) => a.y - b.y || a.x - b.x);
    units.push({ stock, index: i + 1, placements });
  });
  return { units, proven: result.count === result.lowerBound };
}

/**
 * 厳密探索を実行し、案 X を組み立てる。
 *
 * @param project 検証済みの Project。
 * @param opts.nodeBudget 探索ノード予算（デフォルト DEFAULT_NODE_BUDGET）。
 */
export function runExact(
  project: Project,
  opts?: { nodeBudget?: number },
): ExactRunResult {
  const mode = project.settings.exact;
  if (mode === "off") {
    return {
      ran: false,
      proven: false,
      plan: null,
      reason: "exact: off のため厳密探索を実行しませんでした",
    };
  }

  const byStock = expandByStock(project);
  let total = 0;
  for (const list of byStock.values()) {
    total += list.length;
  }
  if (total === 0) {
    return {
      ran: false,
      proven: false,
      plan: null,
      reason: "部材がないため厳密探索を実行しませんでした",
    };
  }
  if (mode === "auto" && total > AUTO_LIMIT) {
    return {
      ran: false,
      proven: false,
      plan: null,
      reason: `部材数 ${total} が目安 ${AUTO_LIMIT} を超えるため厳密探索を省略しました（exact: auto）`,
    };
  }

  const budget = new Budget(opts?.nodeBudget ?? DEFAULT_NODE_BUDGET);
  const { kerf, edgeTrim } = project.settings;

  try {
    const units: StockUnit[] = [];
    let proven = true;
    for (const stock of project.stocks) {
      const instances = byStock.get(stock.id);
      if (!instances || instances.length === 0) {
        continue;
      }
      if (stock.kind === "bar") {
        units.push(...packBarExact(instances, stock, kerf, edgeTrim, budget));
      } else {
        const result = packSheetExact(instances, stock, kerf, edgeTrim, budget);
        units.push(...result.units);
        proven = proven && result.proven;
      }
    }

    const seq: Record<string, number> = {};
    let n = 0;
    for (const unit of units) {
      for (const placement of unit.placements) {
        n += 1;
        seq[instanceId(placement.instance)] = n;
      }
    }

    const plan: Plan = {
      id: "X",
      method1d: "exact",
      method2d: "exact",
      units,
      seq,
    };
    return {
      ran: true,
      proven,
      plan,
      reason: proven
        ? null
        : "2D 配置が面積下界と一致しなかったため、最適性は未証明です（得られた解は候補として有効）",
    };
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      return {
        ran: true,
        proven: false,
        plan: null,
        reason: "探索空間が大きいため厳密探索を打ち切りました（ノード予算超過）",
      };
    }
    throw e;
  }
}
