/**
 * 2D 割付（板材の自由配置）— MaxRects ヒューリスティクス（Jylänki 準拠）。
 *
 * sheet 原材に対し、複数の部材を自由配置で割り付ける。案 A/B/C は
 * 「スコア関数 × 部材ソート順」を変えることで生成する（bssf / baf / bl）。
 *
 * ## 膨張座標系（kerf / edgeTrim のモデル化）
 *
 * 古典的な「アイテム膨張」方式を用いる。
 *
 * - ビン（配置空間）= (Lu + kerf) × (Wu + kerf)。Lu = L − 2e, Wu = W − 2e。
 * - 各部材は (l + kerf) × (w + kerf) に膨張して配置する。
 * - これにより「部材間の隙間 ≥ kerf」と「使用可能窓の縁には kerf 不要（縁の切り出し
 *   カットの刃は不健全域＝edgeTrim 域へ逃げる）」が同時に成立する。
 * - 実座標復元: 膨張座標 (x, y) → 実座標 (edgeTrim + x, edgeTrim + y)、実寸は l × w。
 *   Placement2D には実座標・実寸基準の値（x, y は実座標左下角、rotated フラグ）を格納する。
 *
 * ## アルゴリズム（逐次型 MaxRects）
 *
 * - 各シートは free rectangle のリストを持つ（初期値はビン全体 1 個）。
 * - 部材列を方式ごとのキーでソートし、1 個ずつ処理する。各部材について
 *   「開いているシート群 × free rect × 向き」の全候補から最良スコアの位置を選ぶ。
 *   どこにも入らなければ新しいシートを開く（＝必要枚数の自動決定）。
 * - 配置時、配置矩形（used）と交差する全 free rect を上下左右に最大 4 分割し、
 *   包含関係で刈り込む（prune）。
 * - rot: true の部材は 90° 回転（l↔w）候補も評価する。rot: false は原向きのみ。
 *
 * 浮動小数の等号成立判定は common.EPS で許容する。
 */

import type { Part, Settings, Stock } from "../types";
import { effectiveWidth } from "../types";
import type { PartInstance, Placement2D, StockUnit } from "./common";
import { EPS, instanceId, usableLength } from "./common";

/** 2D 割付方式（ヒューリスティクス3種。厳密探索 "exact" は別モジュール）。 */
export type Method2DHeuristic = "bssf" | "baf" | "bl";

// ---------------------------------------------------------------------------
// 内部データ型（テスト用フックとして公開する。free rect の不変条件検査に用いる）
// ---------------------------------------------------------------------------

/** 膨張座標系での軸並行矩形（free rect / used rect の表現）。不変値として扱う。 */
export class Rect {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly w: number,
    readonly h: number,
  ) {}

  get right(): number {
    return this.x + this.w;
  }

  get top(): number {
    return this.y + this.h;
  }

  /** this が other を（EPS 許容で）完全に包含するかを返す。 */
  contains(other: Rect): boolean {
    return (
      other.x >= this.x - EPS &&
      other.y >= this.y - EPS &&
      other.right <= this.right + EPS &&
      other.top <= this.top + EPS
    );
  }
}

/** 1 枚のシート（原材）。free rect リストと膨張座標の配置記録を持つ。 */
export interface Sheet {
  freeRects: Rect[];
  /** 配置記録: [インスタンス, 膨張x, 膨張y, 回転フラグ]。 */
  placements: Array<[PartInstance, number, number, boolean]>;
}

// ---------------------------------------------------------------------------
// MaxRects コア: free rect の分割と刈り込み
// ---------------------------------------------------------------------------

/**
 * free を used で分割した新しい free rect 群を返す。
 *
 * Jylänki "A Thousand Ways to Pack the Bin" の SplitFreeNode に準拠する。
 * used と交差しなければ free をそのまま返す。交差する場合は、used の下・上・左・右
 * に残る帯状領域を（幅・高さが EPS を超えるもののみ）最大 4 個生成する。
 *
 * 座標系は Y 上向き（部材ローカルと同じ左下原点）で、
 * 「下」= y 小さい側、「上」= y 大きい側。
 */
function splitFreeRect(free: Rect, used: Rect): Rect[] {
  // 交差なし判定（縁で接するだけは交差とみなさない）
  if (
    used.x >= free.right - EPS ||
    used.right <= free.x + EPS ||
    used.y >= free.top - EPS ||
    used.top <= free.y + EPS
  ) {
    return [free];
  }

  const result: Rect[] = [];

  const add = (x: number, y: number, w: number, h: number): void => {
    // 退化した（幅・高さが EPS 以下の）帯は捨てる
    if (w > EPS && h > EPS) {
      result.push(new Rect(x, y, w, h));
    }
  };

  // X 方向に重なりがある → 下側・上側の帯を残す
  if (used.x < free.right - EPS && used.right > free.x + EPS) {
    // 下側（used の下端より下）
    if (used.y > free.y + EPS) {
      add(free.x, free.y, free.w, used.y - free.y);
    }
    // 上側（used の上端より上）
    if (used.top < free.top - EPS) {
      add(free.x, used.top, free.w, free.top - used.top);
    }
  }

  // Y 方向に重なりがある → 左側・右側の帯を残す
  if (used.y < free.top - EPS && used.top > free.y + EPS) {
    // 左側（used の左端より左）
    if (used.x > free.x + EPS) {
      add(free.x, free.y, used.x - free.x, free.h);
    }
    // 右側（used の右端より右）
    if (used.right < free.right - EPS) {
      add(used.right, free.y, free.right - used.right, free.h);
    }
  }

  return result;
}

/**
 * 他の free rect に完全包含される free rect を除去する（PruneFreeList）。
 *
 * 包含関係にあるペアのうち、包含される側を 1 つだけ落とす。完全一致（相互包含）
 * の場合も片方だけが残る（i < j の走査順により、決定的にリスト後方が残る）。
 */
function prune(rects: Rect[]): Rect[] {
  const n = rects.length;
  const removed: boolean[] = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (removed[i]) {
      continue;
    }
    for (let j = 0; j < n; j++) {
      if (i === j || removed[j]) {
        continue;
      }
      // rects[j] が rects[i] を包含 → i を落とす
      if (rects[j].contains(rects[i])) {
        removed[i] = true;
        break;
      }
    }
  }
  return rects.filter((_, i) => !removed[i]);
}

/** used を配置し、シートの free rect を分割・刈り込みで更新する。 */
function placeUsed(sheet: Sheet, used: Rect): void {
  const newFree: Rect[] = [];
  for (const fr of sheet.freeRects) {
    newFree.push(...splitFreeRect(fr, used));
  }
  sheet.freeRects = prune(newFree);
}

// ---------------------------------------------------------------------------
// スコア関数・ソートキー
// ---------------------------------------------------------------------------

/**
 * 方式ごとの配置スコア（小さいほど良い）を [主, 副] で返す。
 *
 * - bssf: min(短辺残り), タイ: 長辺残り
 * - baf : min(面積残り), タイ: 短辺残り
 * - bl  : min(配置上端 y), タイ: min(x)
 */
function score(
  method: Method2DHeuristic,
  fr: Rect,
  pw: number,
  ph: number,
): [number, number] {
  const leftoverH = fr.w - pw;
  const leftoverV = fr.h - ph;
  const shortSide = Math.min(leftoverH, leftoverV);
  const longSide = Math.max(leftoverH, leftoverV);
  if (method === "bssf") {
    return [shortSide, longSide];
  }
  if (method === "baf") {
    return [fr.w * fr.h - pw * ph, shortSide];
  }
  if (method === "bl") {
    return [fr.y + ph, fr.x];
  }
  throw new Error(`未知の 2D 割付方式: ${JSON.stringify(method)}`);
}

/**
 * 方式ごとの部材ソート順の比較関数を返す。
 *
 * - bssf: 面積降順
 * - baf : 最大辺降順
 * - bl  : (幅, 長さ) 降順（同幅グループを連続させる）
 * タイブレークは常に (part.id, instance.index) 昇順で決定的にする。
 * Python 版のタプルキーと同じ全順序を与える。
 */
function makeComparator(
  stock: Stock,
  method: Method2DHeuristic,
): (a: PartInstance, b: PartInstance) => number {
  return (a, b) => {
    const la = a.part.length;
    const wa = effectiveWidth(a.part, stock);
    const lb = b.part.length;
    const wb = effectiveWidth(b.part, stock);

    let d: number;
    if (method === "bssf") {
      d = lb * wb - la * wa;
    } else if (method === "baf") {
      d = Math.max(lb, wb) - Math.max(la, wa);
    } else if (method === "bl") {
      d = wb - wa;
      if (d === 0) {
        d = lb - la;
      }
    } else {
      throw new Error(`未知の 2D 割付方式: ${JSON.stringify(method)}`);
    }
    if (d !== 0) {
      return d;
    }
    if (a.part.id !== b.part.id) {
      return a.part.id < b.part.id ? -1 : 1;
    }
    return a.index - b.index;
  };
}

/**
 * 膨張後の [幅, 高さ, 回転フラグ] 候補を返す。
 *
 * 原向きは (l+kerf, w+kerf, false)。rot=true の場合のみ 90° 回転
 * (w+kerf, l+kerf, true) を追加する。
 */
function orientationsOf(
  part: Part,
  stock: Stock,
  kerf: number,
): Array<[number, number, boolean]> {
  const length = part.length;
  const width = effectiveWidth(part, stock);
  const cands: Array<[number, number, boolean]> = [
    [length + kerf, width + kerf, false],
  ];
  if (part.rot) {
    cands.push([width + kerf, length + kerf, true]);
  }
  return cands;
}

// ---------------------------------------------------------------------------
// 候補探索
// ---------------------------------------------------------------------------

interface BestCandidate {
  si: number;
  fr: Rect;
  pw: number;
  ph: number;
  rotated: boolean;
}

/** 数値配列キーの辞書式比較（a < b なら true）。Python のタプル比較に対応する。 */
function keyLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) {
      return true;
    }
    if (a[i] > b[i]) {
      return false;
    }
  }
  return false;
}

/**
 * 開いている全シート × free rect × 向き から最良候補を選ぶ。
 *
 * 候補キー = (主スコア, 副スコア, free rect の y, x, シート番号, 回転フラグ)。
 * 最終タイブレークは (free rect の y, x, シート番号) 昇順で決定的にする
 * （回転フラグは同座標同スコア時の最後の決定要素として原向きを優先）。
 *
 * @returns {シート番号, 採用 free rect, 膨張幅 pw, 膨張高 ph, 回転フラグ}。
 *   どこにも入らなければ null。
 */
function findBest(
  sheets: Sheet[],
  orientations: Array<[number, number, boolean]>,
  method: Method2DHeuristic,
): BestCandidate | null {
  let bestKey: number[] | null = null;
  let best: BestCandidate | null = null;
  for (let si = 0; si < sheets.length; si++) {
    for (const fr of sheets[si].freeRects) {
      for (const [pw, ph, rotated] of orientations) {
        if (pw <= fr.w + EPS && ph <= fr.h + EPS) {
          const [primary, secondary] = score(method, fr, pw, ph);
          const key = [primary, secondary, fr.y, fr.x, si, rotated ? 1 : 0];
          if (bestKey === null || keyLess(key, bestKey)) {
            bestKey = key;
            best = { si, fr, pw, ph, rotated };
          }
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 公開エントリ
// ---------------------------------------------------------------------------

/**
 * MaxRects 本体。シート（free rect 付き）のリストを返す（テスト用フック）。
 *
 * free rect の不変条件検査など、内部状態を要するテストはこの関数を用いる。
 * 実配置の取得には pack2d を使う。
 */
export function packSheets(
  instances: PartInstance[],
  stock: Stock,
  settings: Settings,
  method: Method2DHeuristic,
): Sheet[] {
  const kerf = settings.kerf;
  const edgeTrim = settings.edgeTrim;
  const lengthU = usableLength(stock.length, edgeTrim); // Lu
  const widthU = usableLength(stock.width, edgeTrim); // Wu
  const binW = lengthU + kerf;
  const binH = widthU + kerf;
  if (binW <= EPS || binH <= EPS) {
    throw new Error(
      `原材 '${stock.id}' の使用可能窓が非正（edgeTrim 過大）: ` +
        `Lu=${lengthU}, Wu=${widthU}`,
    );
  }

  const comparator = makeComparator(stock, method);
  const sortedInstances = [...instances].sort(comparator);

  const sheets: Sheet[] = [];
  for (const inst of sortedInstances) {
    const orientations = orientationsOf(inst.part, stock, kerf);
    let best = findBest(sheets, orientations, method);
    if (best === null) {
      // どの既存シートにも入らない → 新シートを開く
      sheets.push({
        freeRects: [new Rect(0.0, 0.0, binW, binH)],
        placements: [],
      });
      best = findBest(sheets, orientations, method);
      if (best === null) {
        // 事前チェック（loader）が正しければ到達しない
        throw new Error(
          `部材 '${instanceId(inst)}' は原材 '${stock.id}' の` +
            "使用可能窓に収まりません（rot 指定と寸法を確認してください）",
        );
      }
    }
    const { si, fr, pw, ph, rotated } = best;
    const sheet = sheets[si];
    placeUsed(sheet, new Rect(fr.x, fr.y, pw, ph));
    sheet.placements.push([inst, fr.x, fr.y, rotated]);
  }

  return sheets;
}

/**
 * sheet 原材への 2D 割付を行い、使用した StockUnit のリストを返す。
 *
 * @param instances qty 展開済みの部材インスタンス（同一 stock にバインドされた sheet 部材）。
 * @param stock 対象の原材（kind==="sheet" を想定）。
 * @param settings 設定（kerf・edgeTrim を使用）。
 * @param method "bssf" / "baf" / "bl" のいずれか。
 * @returns 使用したシートごとの StockUnit（index は 1 始まり）。各 Placement2D は
 *   実座標左下角 (x, y)・実寸基準・rotated フラグを持つ。
 */
export function pack2d(
  instances: PartInstance[],
  stock: Stock,
  settings: Settings,
  method: Method2DHeuristic,
): StockUnit[] {
  const sheets = packSheets(instances, stock, settings, method);
  const edgeTrim = settings.edgeTrim;
  const units: StockUnit[] = [];
  for (let i = 0; i < sheets.length; i++) {
    const placements: Placement2D[] = sheets[i].placements.map(
      ([inst, xExp, yExp, rotated]) => ({
        instance: inst,
        x: edgeTrim + xExp,
        y: edgeTrim + yExp,
        rotated,
      }),
    );
    // 決定的な順序（(y, x) 昇順）に整える。配置番号採番の前提と揃える。
    placements.sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
    units.push({ stock, index: i + 1, placements });
  }
  return units;
}
