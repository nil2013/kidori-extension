/**
 * 1D 木取り（長尺材の割付）3方式の実装。
 *
 * kerf・edgeTrim の容量判定・座標計算はすべて packing/common の
 * fits1d / usableLength / EPS を経由し、本モジュールでは独自の
 * 容量判定・epsilon を定義しない。
 *
 * 3方式:
 * - ffd: 長さ降順に、開いた順で最初に入る原材へ配置する（FFD）。
 * - bfd: 長さ降順に、配置後の残り有効長が最小になる原材へ配置する（BFD）。
 *   タイブレークは先に開いた原材を優先する。
 * - grouped（グループ充填型）: 長さ降順・同長連続で処理し、
 *   各同長グループ（長さ x、残数 k）ごとに:
 *     1. 既に x を含み容量のある原材（開いた順）へ入るだけ配置する（top-up）。
 *     2. 残数 ≥ 2 の間: 新規原材を開き、入るだけ x を配置する。
 *        ただし新品1本に入る最大数 c == 1 なら手順 3 へ。
 *     3. 残り（1 個、または c==1 の場合の全部材）: 1 個ずつ FFD
 *        （既存原材の開いた順で最初に入る所、なければ新規）。
 *   歩留まりを犠牲に同長部材を同一原材へ集約し、丸鋸ストッパーでの
 *   連続カット（作業性）を優先する。FFD/BFD と明確に異なる結果を生む。
 *   〔当初案（①同長優先→②FFD→③新規）は、同長部材が降順ソートで必ず
 *   連続処理されるため任意入力で FFD と同一出力になることが証明され、
 *   本方式に差し替えられた。〕
 *
 * いずれの方式も、収まる原材が既存に無ければ新規原材を無制限に開く
 * （必要本数の自動決定）。空の1本にも入らない部材は意味検証層（loader）で
 * 事前に弾かれる前提であり、本モジュールはその防御を行わない。
 */

import type { Settings, Stock } from "../types";
import type { PartInstance, Placement1D, StockUnit } from "./common";
import { EPS, fits1d, usableLength } from "./common";

/**
 * 原材1本ぶんの割付進行状態（内部ヘルパ。公開契約ではない）。
 *
 * - usedLen: fits1d に渡す「これまでに配置した部材長合計（既に消費した
 *   内部 kerf を含む）」。common.fits1d の usedLen 引数と同じ定義。
 * - count: これまでにこの原材へ配置した部材の個数。
 * - placements: 確定済みの配置一覧（挿入順 = start 昇順）。
 */
interface UnitState {
  usedLen: number;
  count: number;
  placements: Placement1D[];
}

function newUnitState(): UnitState {
  return { usedLen: 0.0, count: 0, placements: [] };
}

/** この原材に既に同じ長さ（EPS 許容）の部材が配置済みかを返す。 */
function hasLength(unit: UnitState, length: number): boolean {
  return unit.placements.some(
    (p) => Math.abs(p.instance.part.length - length) <= EPS,
  );
}

/**
 * ソート規約: 主キー part.length 降順、タイブレーク (part.id, instance.index) 昇順。
 * Python 版のタプルキー (-length, id, index) と同じ全順序を与える比較関数。
 */
function compareInstances(a: PartInstance, b: PartInstance): number {
  if (a.part.length !== b.part.length) {
    return b.part.length - a.part.length;
  }
  if (a.part.id !== b.part.id) {
    return a.part.id < b.part.id ? -1 : 1;
  }
  return a.index - b.index;
}

/**
 * 原材 unit の末尾に instance を配置し、進行状態を更新する。
 *
 * 座標は規約 o_1 = edgeTrim、o_{i+1} = o_i + len_i + kerf に従う。
 * `start = edgeTrim + usedLen + (count>0 ? kerf : 0)` は count==0 のとき
 * usedLen==0 で edgeTrim = o_1 に一致し、以降は帰納的に o_{i+1} と一致する。
 */
function place(unit: UnitState, instance: PartInstance, s: Settings): void {
  const start = s.edgeTrim + unit.usedLen + (unit.count > 0 ? s.kerf : 0.0);
  unit.placements.push({ instance, start });
  unit.usedLen =
    unit.usedLen + (unit.count > 0 ? s.kerf : 0.0) + instance.part.length;
  unit.count += 1;
}

/** FFD: 開いた順（index 昇順）で最初に収まる原材の位置を返す。無ければ null。 */
function findFfdTarget(
  units: UnitState[],
  length: number,
  kerf: number,
  usable: number,
): number | null {
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (fits1d(u.usedLen, u.count, length, kerf, usable)) {
      return i;
    }
  }
  return null;
}

/**
 * BFD: 配置後の残り有効長が最小になる原材の位置を返す。無ければ null。
 *
 * タイブレークは先に開いた原材（index が小さい方）を優先する。
 * ループは index 昇順に進み、「厳密に」より小さい残りにのみ更新するため、
 * 同点（EPS 以内）では先勝ちが自然に保たれる。
 */
function findBfdTarget(
  units: UnitState[],
  length: number,
  kerf: number,
  usable: number,
): number | null {
  let bestI: number | null = null;
  let bestRemaining: number | null = null;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (!fits1d(u.usedLen, u.count, length, kerf, usable)) {
      continue;
    }
    const needed = u.usedLen + (u.count > 0 ? kerf : 0.0) + length;
    const remaining = usable - needed;
    if (bestRemaining === null || remaining < bestRemaining - EPS) {
      bestRemaining = remaining;
      bestI = i;
    }
  }
  return bestI;
}

/**
 * 新品の原材1本に長さ length の部材が最大何個入るか（c）を返す。
 *
 * 容量判定は fits1d の反復のみで行う（独自の算術式は使わない）。
 * length > 0 は意味検証層で担保される前提（ループは必ず停止する）。
 */
function freshUnitCapacity(
  length: number,
  kerf: number,
  usable: number,
): number {
  let used = 0.0;
  let count = 0;
  while (fits1d(used, count, length, kerf, usable)) {
    used = used + (count > 0 ? kerf : 0.0) + length;
    count += 1;
  }
  return count;
}

/**
 * 案C（グループ充填型）の本体。手順 1〜3 を同長グループごとに適用する。
 *
 * sortedInstances は compareInstances で整列済みであることを前提とする
 * （同長部材は必ず連続し、グループ内の順序は (part.id, instance.index) 昇順）。
 */
function packGrouped(
  sortedInstances: PartInstance[],
  s: Settings,
  usable: number,
): UnitState[] {
  const kerf = s.kerf;
  const units: UnitState[] = [];

  let i = 0;
  const n = sortedInstances.length;
  while (i < n) {
    // 同長グループの切り出し（長さの一致判定は EPS 許容）。
    const x = sortedInstances[i].part.length;
    let j = i;
    while (j < n && Math.abs(sortedInstances[j].part.length - x) <= EPS) {
      j += 1;
    }
    const group = sortedInstances.slice(i, j);
    i = j;

    let pos = 0; // グループ内の未配置先頭位置

    // 手順1: 既に x を含み容量のある原材（開いた順）へ入るだけ配置（top-up）。
    for (const u of units) {
      if (pos >= group.length) {
        break;
      }
      if (!hasLength(u, x)) {
        continue;
      }
      while (pos < group.length && fits1d(u.usedLen, u.count, x, kerf, usable)) {
        place(u, group[pos], s);
        pos += 1;
      }
    }

    // 手順2: 残数 ≥ 2 の間、新規原材を開いて入るだけ配置。
    // ただし新品1本に1個しか入らない（c == 1）場合は手順3へ委ねる
    // （1本1個の新規開設は FFD と同じ結果にしかならず、既存原材の
    //  端材再利用の機会を失うだけのため）。
    const c = freshUnitCapacity(x, kerf, usable);
    if (c >= 2) {
      while (group.length - pos >= 2) {
        const u = newUnitState();
        units.push(u);
        while (
          pos < group.length &&
          fits1d(u.usedLen, u.count, x, kerf, usable)
        ) {
          place(u, group[pos], s);
          pos += 1;
        }
      }
    }

    // 手順3: 残り（1個、または c==1 の場合の全部材）を1個ずつ FFD。
    while (pos < group.length) {
      let idx = findFfdTarget(units, x, kerf, usable);
      if (idx === null) {
        units.push(newUnitState());
        idx = units.length - 1;
      }
      place(units[idx], group[pos], s);
      pos += 1;
    }
  }

  return units;
}

// ffd / bfd の原材選択関数（grouped は packGrouped が専用ルーチンで処理する）。
const FINDERS = {
  ffd: findFfdTarget,
  bfd: findBfdTarget,
} as const;

/**
 * 1D 木取りを実行し、使用した原材（StockUnit）一覧を返す。
 *
 * @param instances qty 展開済みの部材インスタンス一覧（呼び出し側が展開済み）。
 *   全て stock.kind==="bar" を前提とする（kind の検証はここでは行わない）。
 * @param stock 対象の原材定義。
 * @param settings 設定（kerf・edgeTrim を使用）。
 * @param method "ffd" / "bfd" / "grouped"。
 * @returns 使用順（StockUnit.index=1始まり、開いた順）の StockUnit 一覧。
 *   各 StockUnit.placements は Placement1D のリストで、start 昇順に確定済み。
 */
export function pack1d(
  instances: PartInstance[],
  stock: Stock,
  settings: Settings,
  method: "ffd" | "bfd" | "grouped",
): StockUnit[] {
  const usable = usableLength(stock.length, settings.edgeTrim);
  const sortedInstances = [...instances].sort(compareInstances);

  let units: UnitState[];
  if (method === "grouped") {
    units = packGrouped(sortedInstances, settings, usable);
  } else {
    const finder = FINDERS[method];
    units = [];
    for (const instance of sortedInstances) {
      const length = instance.part.length;
      let targetIdx = finder(units, length, settings.kerf, usable);
      if (targetIdx === null) {
        units.push(newUnitState());
        targetIdx = units.length - 1;
      }
      place(units[targetIdx], instance, settings);
    }
  }

  return units.map((u, idx) => ({
    stock,
    index: idx + 1,
    placements: [...u.placements],
  }));
}
