/**
 * packing パッケージの公開インターフェース。
 *
 * 1D/2D 割付エンジンの入口を提供する。案 ID と (1D割付方式, 2D割付方式) の
 * 固定ペア定義（PLAN_METHODS）に加え、qty 展開（expandInstancesByStock）・
 * 配置番号採番（assignSeq）・案の組み立て（buildPlan）・案生成
 * （generatePlans）を提供する。
 */

import type { Project } from "../types";
import type {
  Method1D,
  Method2D,
  PartInstance,
  Plan,
  StockUnit,
} from "./common";
import { instanceId } from "./common";
import { pack1d } from "./pack1d";
import { pack2d } from "./pack2d";

/**
 * 案 ID と (1D割付方式, 2D割付方式) の固定ペア。
 *
 * 1案 = 1D方式 + 2D方式の固定ペアであり、bar/sheet が混在するプロジェクトでも
 * 案 ID は横断で1系列とする。
 * - A: FFD          + MaxRects-BSSF（歩留まり重視の定番）
 * - B: BFD          + MaxRects-BAF （残り容量の評価軸を変えた対抗案）
 * - C: 同種グループ化 + MaxRects-BL （カット線を揃え作業性を重視）
 */
export const PLAN_METHODS: ReadonlyArray<
  readonly [string, Method1D, Method2D]
> = [
  ["A", "ffd", "bssf"],
  ["B", "bfd", "baf"],
  ["C", "grouped", "bl"],
];

/**
 * qty 展開: 全 part を PartInstance(part, 1..qty) に展開し、stock id ごとに束ねる。
 *
 * parts[].stock が明示バインドのため、パッキングは stock id ごとに独立に
 * 実行できる。ここでは project.parts の宣言順に処理するが、戻り値は
 * 「stock id → その stock を使う全 PartInstance」の対応表であり、
 * stocks 自体の宣言順の適用は buildPlan 側（project.stocks を辿る側）で行う。
 */
export function expandInstancesByStock(
  project: Project,
): Map<string, PartInstance[]> {
  const byStock = new Map<string, PartInstance[]>();
  for (const part of project.parts) {
    for (let index = 1; index <= part.qty; index++) {
      let list = byStock.get(part.stock);
      if (list === undefined) {
        list = [];
        byStock.set(part.stock, list);
      }
      list.push({ part, index });
    }
  }
  return byStock;
}

/**
 * units→placements の順で 1始まりの通し番号（配置番号①②③…）を振る。
 *
 * 前提: 各 StockUnit.placements は既に規約順（1D は start 昇順、2D は (y, x)
 * 昇順）に整列済みであること（pack1d / pack2d はその順で返す）。
 * 厳密探索モジュールも同じ前提で本関数を再利用する。
 */
export function assignSeq(units: StockUnit[]): Record<string, number> {
  const seq: Record<string, number> = {};
  let n = 0;
  for (const unit of units) {
    for (const placement of unit.placements) {
      n += 1;
      seq[instanceId(placement.instance)] = n;
    }
  }
  return seq;
}

/**
 * 1案ぶんの Plan を組み立てる（stock ごとに pack1d / pack2d へ委譲）。
 *
 * Plan.units は「stocks の宣言順 → index 順」に整列する。pack1d / pack2d は
 * それぞれ1 stock 分だけを呼び出すため、project.stocks を宣言順に走査して
 * その戻り値（index=1始まりで既に整列済み）を単純に連結するだけで、この整列
 * 規則を満たす。
 *
 * Plan.seq は assignSeq による通し採番（pack1d/pack2d は既に規約順で
 * placements を確定させて返すため、列挙して番号を振るだけでよい）。
 *
 * method1d / method2d に "exact" を渡してはならない（厳密探索の案 X は
 * 別モジュールが組み立てる）。
 */
export function buildPlan(
  planId: string,
  method1d: Method1D,
  method2d: Method2D,
  project: Project,
  instancesByStock: Map<string, PartInstance[]>,
): Plan {
  const units: StockUnit[] = [];
  for (const stock of project.stocks) {
    const instances = instancesByStock.get(stock.id);
    if (instances === undefined || instances.length === 0) {
      continue;
    }
    if (stock.kind === "bar") {
      units.push(
        ...pack1d(
          instances,
          stock,
          project.settings,
          method1d as "ffd" | "bfd" | "grouped",
        ),
      );
    } else {
      // sheet
      units.push(
        ...pack2d(
          instances,
          stock,
          project.settings,
          method2d as "bssf" | "baf" | "bl",
        ),
      );
    }
  }

  return {
    id: planId,
    method1d,
    method2d,
    units,
    seq: assignSeq(units),
  };
}

/**
 * 割付案 A/B/C を生成する。
 *
 * - qty 展開: PartInstance(part, 1..qty)。
 * - stock id ごとに部材を分け、Stock.kind に応じ pack1d / pack2d に委譲する
 *   （方式は PLAN_METHODS の固定ペア）。
 * - settings.candidates を 1〜3 にクランプした件数の案を生成する。
 * - 採用案（selected）が指定されている場合は、クランプ後の候補一覧の
 *   うち該当する案 ID の Plan のみを生成する（他案のアルゴリズムは実行しない）。
 *   採用案がクランプ後の範囲外の場合は空リストを返す（採用案が
 *   "X"（厳密探索案）の場合も同様に空リストとなり、案 X は別モジュールが担う。
 *   不正な組み合わせは loader の意味検証層で既に error として弾かれる前提で
 *   あり、本関数はその防御を重ねて行わない）。
 *
 * @param project 検証済みの Project（loader の戻り値を想定）。
 * @param selected 実効的な採用案 ID。省略時は `project.settings.selectedPlan`。
 *   build.ts は採用後の設計変更による無効化判定（SPECS.md §5）を通した
 *   **実効選択**を明示的に渡す（無効化中は null ＝全案生成）。
 * @returns 生成された Plan のリスト（候補順、最大3件）。
 */
export function generatePlans(
  project: Project,
  selected: string | null = project.settings.selectedPlan,
): Plan[] {
  const instancesByStock = expandInstancesByStock(project);

  const clamped = Math.max(1, Math.min(3, project.settings.candidates));
  let methods = PLAN_METHODS.slice(0, clamped);

  if (selected !== null) {
    methods = methods.filter(([planId]) => planId === selected);
  }

  return methods.map(([planId, method1d, method2d]) =>
    buildPlan(planId, method1d, method2d, project, instancesByStock),
  );
}
