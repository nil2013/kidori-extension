/**
 * packing/pack1d の単体テスト（Python tests/test_pack1d.py の移植）。
 *
 * Part/PartInstance/Stock/Settings をすべて本ファイル内で構築する。
 * kerf/edgeTrim の容量判定は packing/common の fits1d / usableLength / EPS
 * を検証の基準として用い、本ファイルでは独自の epsilon・容量判定式を書かない。
 */

import { describe, expect, it } from "vitest";

import type {
  PartInstance,
  Placement1D,
  StockUnit,
} from "../../src/core/packing/common";
import {
  cutCount1d,
  fits1d,
  instanceId,
  usableLength,
} from "../../src/core/packing/common";
import { pack1d } from "../../src/core/packing/pack1d";
import type { Part, Settings, Stock } from "../../src/core/types";
import { DEFAULT_RANK } from "../../src/core/types";

// ---------------------------------------------------------------------------
// テスト用ヘルパ（本ファイル内に閉じる）
// ---------------------------------------------------------------------------

/** Settings を組み立てる（Python 版に無い rank/exact は既定値で補う）。 */
function makeSettings(over: Partial<Settings> = {}): Settings {
  return {
    kerf: 3.0,
    edgeTrim: 5.0,
    candidates: 3,
    rank: [...DEFAULT_RANK],
    exact: "auto",
    selectedPlan: null,
    ...over,
  };
}

/** bar 種別の Stock を1個組み立てる。 */
function makeStock(length: number, stockId = "bar-1", width = 89.0): Stock {
  return {
    id: stockId,
    label: `テスト材 ${stockId}`,
    kind: "bar",
    length,
    width,
    thickness: 19.0,
    price: null,
  };
}

/** bar 部材を1個組み立てる（width は省略＝ stock.width を使う想定）。 */
function makePart(
  partId: string,
  length: number,
  qty = 1,
  stockId = "bar-1",
): Part {
  return {
    id: partId,
    label: `部材 ${partId}`,
    qty,
    stock: stockId,
    length,
    width: null,
    rot: true,
    features: [],
  };
}

/** qty 展開: PartInstance(part, 1..qty) を生成する（本トラックのテストでは自前展開）。 */
function instancesOf(part: Part): PartInstance[] {
  const out: PartInstance[] = [];
  for (let i = 1; i <= part.qty; i++) {
    out.push({ part, index: i });
  }
  return out;
}

/** StockUnit の placements を Placement1D[] として取り出す（1D テスト専用）。 */
function placements1d(unit: StockUnit): Placement1D[] {
  return unit.placements as Placement1D[];
}

/** StockUnit 一覧を [unit.index, instanceId, start] のタプル列に平坦化する（比較用）。 */
function flattenStarts(units: StockUnit[]): Array<[number, string, number]> {
  const result: Array<[number, string, number]> = [];
  for (const u of units) {
    for (const p of placements1d(u)) {
      result.push([u.index, instanceId(p.instance), p.start]);
    }
  }
  return result;
}

/** 1原材内の配置を "{instanceId}@{start}" の集合に正規化する（順不同比較用）。 */
function placementSet(unit: StockUnit): Set<string> {
  return new Set(
    placements1d(unit).map((p) => `${instanceId(p.instance)}@${p.start}`),
  );
}

// ---------------------------------------------------------------------------
// §10-1: kerf/edgeTrim 境界（1D）
// ---------------------------------------------------------------------------

describe("kerf/edgeTrim 境界（1D）", () => {
  it("Σlen + (n-1)*kerf == U ちょうどのとき、1本に収まる（等号成立を許容）", () => {
    const s = makeSettings({ kerf: 3.0, edgeTrim: 5.0 });
    const stock = makeStock(100.0); // U = 100 - 2*5 = 90
    const part = makePart("p", 28.0, 3); // 28*3 + 2*3 = 90 == U
    const units = pack1d(instancesOf(part), stock, s, "ffd");

    expect(units.length).toBe(1);
    expect(units[0].index).toBe(1);
    expect(units[0].placements.length).toBe(3);

    const starts = placements1d(units[0])
      .map((p) => p.start)
      .sort((a, b) => a - b);
    expect(starts).toEqual([5.0, 36.0, 67.0]); // o1=5, o2=5+28+3=36, o3=36+28+3=67
    const last = placements1d(units[0]).reduce((acc, p) =>
      p.start > acc.start ? p : acc,
    );
    const end = last.start + last.instance.part.length;
    expect(Math.abs(end - 95.0)).toBeLessThan(1e-9); // E == L - edgeTrim == 95、有効長の限界に一致
  });

  it("境界値に +0.1 すると2本目が開く", () => {
    const s = makeSettings({ kerf: 3.0, edgeTrim: 5.0 });
    const stock = makeStock(100.0); // U = 90
    // 3本のうち1本だけ +0.1（28.1, 28, 28）。合計 = 84.1 + 6 = 90.1 > 90。
    const partBig = makePart("big", 28.1, 1);
    const partRest = makePart("rest", 28.0, 2);
    const instances = [...instancesOf(partBig), ...instancesOf(partRest)];

    const units = pack1d(instances, stock, s, "ffd");

    expect(units.length).toBe(2);
    // 長さ降順で処理: 28.1(新規unit1) → 28(unit1に入る, needed=59.1<=90) →
    // 28(unit1に入らない, needed=90.1>90 → unit2を新規に開く)
    expect(units[0].placements.length).toBe(2);
    expect(units[1].placements.length).toBe(1);
  });

  it("kerf=0 のとき、部材間に隙間なく詰められる", () => {
    const s = makeSettings({ kerf: 0.0, edgeTrim: 5.0 });
    const stock = makeStock(100.0); // U = 90
    const part = makePart("p", 30.0, 3); // 30*3 + 0 = 90 == U

    const units = pack1d(instancesOf(part), stock, s, "ffd");

    expect(units.length).toBe(1);
    const starts = placements1d(units[0])
      .map((p) => p.start)
      .sort((a, b) => a - b);
    expect(starts).toEqual([5.0, 35.0, 65.0]); // kerf=0 のため隙間なく連続
    const last = placements1d(units[0]).reduce((acc, p) =>
      p.start > acc.start ? p : acc,
    );
    const end = last.start + last.instance.part.length;
    expect(Math.abs(end - 95.0)).toBeLessThan(1e-9);
  });

  it("edgeTrim=0 のとき、先頭配置が生端 (start=0) から始まる", () => {
    const s = makeSettings({ kerf: 3.0, edgeTrim: 0.0 });
    const stock = makeStock(100.0); // U = 100
    const part = makePart("p", 100.0, 1); // ちょうど全長を使い切る

    const units = pack1d(instancesOf(part), stock, s, "ffd");

    expect(units.length).toBe(1);
    expect(placements1d(units[0])[0].start).toBe(0.0);
    const end = placements1d(units[0])[0].start + part.length;
    expect(Math.abs(end - 100.0)).toBeLessThan(1e-9); // E == L
  });

  it("kerf=0 かつ edgeTrim=0 の組合せ: 生端から生端まで隙間なく詰める", () => {
    const s = makeSettings({ kerf: 0.0, edgeTrim: 0.0 });
    const stock = makeStock(50.0); // U = 50
    const part = makePart("p", 25.0, 2); // 25*2 + 0 = 50 == U

    const units = pack1d(instancesOf(part), stock, s, "ffd");

    expect(units.length).toBe(1);
    const starts = placements1d(units[0])
      .map((p) => p.start)
      .sort((a, b) => a - b);
    expect(starts).toEqual([0.0, 25.0]);
    const last = placements1d(units[0]).reduce((acc, p) =>
      p.start > acc.start ? p : acc,
    );
    const end = last.start + last.instance.part.length;
    expect(Math.abs(end - 50.0)).toBeLessThan(1e-9); // E == L（末尾カット省略の前提条件）

    // このケースは cutCount1d の「edgeTrim=0 かつ kerf=0」境界も兼ねる。
    const cc = cutCount1d(placements1d(units[0]), stock, s);
    expect(cc).toBe(1); // leading=0 + interior(n-1=1) + trailing=0(edgeTrim=0 かつ E==L)
  });
});

// ---------------------------------------------------------------------------
// §10-3: FFD/BFD 分岐フィクスチャ、grouped の同長隣接、決定性
// ---------------------------------------------------------------------------

describe("FFD/BFD/grouped の分岐と決定性", () => {
  it("FFD と BFD が異なる配置結果になる既知フィクスチャ", () => {
    // kerf=0, edgeTrim=0, stock.length=10 (U=10)。部材長 [8, 5, 4, 1]（降順処理）。
    //
    // 手計算（監査用）:
    //   1) len=8  -> 既存原材なし -> Unit1 新規。Unit1.used=8, count=1。
    //   2) len=5  -> Unit1: needed=8+0+5=13>10 で不適合 -> Unit2 新規。Unit2.used=5, count=1。
    //   3) len=4  -> Unit1: needed=8+0+4=12>10 不適合。
    //                Unit2: needed=5+0+4=9<=10 適合（他に選択肢なし）-> Unit2 に配置。
    //                Unit2.used=9, count=2。
    //   4) len=1  -> ここで両原材とも適合する分岐点:
    //                Unit1: needed=8+0+1=9<=10 適合。
    //                Unit2: needed=9+0+1=10<=10 適合（ちょうど）。
    //      FFD: 開いた順（Unit1が先）に最初に適合したものを採用 -> Unit1 に配置。
    //           Unit1 = [8@0, 1@8]（used=9）、Unit2 = [5@0, 4@5]（used=9）。
    //      BFD: 配置後の残り有効長が最小になる方を採用
    //           (Unit1採用時の残り=10-9=1、Unit2採用時の残り=10-10=0 で Unit2 が最小)
    //           -> Unit2 に配置。
    //           Unit1 = [8@0]（used=8）、Unit2 = [5@0, 4@5, 1@9]（used=10）。
    const s = makeSettings({ kerf: 0.0, edgeTrim: 0.0 });
    const stock = makeStock(10.0);

    const p8 = makePart("p8", 8.0, 1);
    const p5 = makePart("p5", 5.0, 1);
    const p4 = makePart("p4", 4.0, 1);
    const p1 = makePart("p1", 1.0, 1);
    const instances = [
      ...instancesOf(p8),
      ...instancesOf(p5),
      ...instancesOf(p4),
      ...instancesOf(p1),
    ];

    const ffdUnits = pack1d(instances, stock, s, "ffd");
    const bfdUnits = pack1d(instances, stock, s, "bfd");

    // FFD 期待結果
    expect(ffdUnits.length).toBe(2);
    const ffdUnit1 = ffdUnits.find((u) => u.index === 1)!;
    const ffdUnit2 = ffdUnits.find((u) => u.index === 2)!;
    expect(placementSet(ffdUnit1)).toEqual(new Set(["p8#1@0", "p1#1@8"]));
    expect(placementSet(ffdUnit2)).toEqual(new Set(["p5#1@0", "p4#1@5"]));

    // BFD 期待結果（p1 の配置先が FFD と異なる = 分岐の証拠）
    expect(bfdUnits.length).toBe(2);
    const bfdUnit1 = bfdUnits.find((u) => u.index === 1)!;
    const bfdUnit2 = bfdUnits.find((u) => u.index === 2)!;
    expect(placementSet(bfdUnit1)).toEqual(new Set(["p8#1@0"]));
    expect(placementSet(bfdUnit2)).toEqual(
      new Set(["p5#1@0", "p4#1@5", "p1#1@9"]),
    );

    // 明示的に FFD != BFD であることを確認する。
    expect(flattenStarts(ffdUnits)).not.toEqual(flattenStarts(bfdUnits));
  });

  it("grouped（グループ充填型）と FFD が異なる本数・配置になる既知フィクスチャ", () => {
    // kerf=0, edgeTrim=0, stock.length=100 (U=100)。部材長 [60, 55, 40, 40, 40, 40]。
    //
    // 手計算（監査用）:
    //   FFD（長さ降順に first-fit）:
    //     60 -> Unit1(used=60)
    //     55 -> Unit1: 60+55=115>100 不適合 -> Unit2(used=55)
    //     40 -> Unit1: 60+40=100<=100 適合 -> Unit1=[60@0, 40@60]
    //     40 -> Unit1 満杯, Unit2: 55+40=95<=100 -> Unit2=[55@0, 40@55]
    //     40 -> Unit1/Unit2 不適合 -> Unit3(40@0)
    //     40 -> Unit3: 40+40=80<=100 -> Unit3=[40@0, 40@40]
    //     => 3本: [60,40], [55,40], [40,40]
    //
    //   grouped（同長グループごとに手順1〜3）:
    //     グループ60 (k=1): 手順1 該当なし。手順2 k<2 スキップ。手順3 FFD ->
    //         既存なし -> Unit1=[60@0]
    //     グループ55 (k=1): 手順3 FFD -> Unit1: 115>100 不適合 -> Unit2=[55@0]
    //     グループ40 (k=4): 手順1 40を含む原材なし。
    //         手順2: c（新品1本の最大数）= 2（40+40=80<=100, +40=120>100）>= 2。
    //           残4>=2 -> Unit3 新規に 40@0, 40@40（3個目 120>100 で停止）。残2。
    //           残2>=2 -> Unit4 新規に 40@0, 40@40。残0。
    //     => 4本: [60], [55], [40,40], [40,40]
    //
    // 歩留まりでは FFD（3本）が優るが、grouped は同長4個を2本の原材へ集約し
    // 連続カット向きの配置になる。
    const s = makeSettings({ kerf: 0.0, edgeTrim: 0.0 });
    const stock = makeStock(100.0);
    const p60 = makePart("p60", 60.0, 1);
    const p55 = makePart("p55", 55.0, 1);
    const p40 = makePart("p40", 40.0, 4);
    const instances = [
      ...instancesOf(p60),
      ...instancesOf(p55),
      ...instancesOf(p40),
    ];

    const ffdUnits = pack1d(instances, stock, s, "ffd");
    const groupedUnits = pack1d(instances, stock, s, "grouped");

    // FFD: 3本
    expect(ffdUnits.length).toBe(3);
    expect(flattenStarts(ffdUnits)).toEqual([
      [1, "p60#1", 0.0],
      [1, "p40#1", 60.0],
      [2, "p55#1", 0.0],
      [2, "p40#2", 55.0],
      [3, "p40#3", 0.0],
      [3, "p40#4", 40.0],
    ]);

    // grouped: 4本（同長40×4 が Unit3/Unit4 に2個ずつ集約される）
    expect(groupedUnits.length).toBe(4);
    expect(flattenStarts(groupedUnits)).toEqual([
      [1, "p60#1", 0.0],
      [2, "p55#1", 0.0],
      [3, "p40#1", 0.0],
      [3, "p40#2", 40.0],
      [4, "p40#3", 0.0],
      [4, "p40#4", 40.0],
    ]);

    // 明示的に分岐していることを確認する。
    expect(flattenStarts(ffdUnits)).not.toEqual(flattenStarts(groupedUnits));
  });

  it("grouped: 同じ長さの部材が同じ原材に隣接して集まる（同長隣接）", () => {
    // kerf=2, edgeTrim=0, stock.length=100 (U=100)。長さ30の部材が4個。
    // グループ30 (k=4): 手順1 該当なし。手順2: c=3（30*3+2*2=94<=100、
    // 4個目は 94+2+30=126>100）>= 2 -> 残4>=2 で Unit1 新規に3個充填。残1。
    // 手順3: 残1個を FFD -> Unit1 は 126>100 で不適合 -> Unit2 新規。
    // 結果: Unit1 に同長3個が隣接、Unit2 に1個。
    const s = makeSettings({ kerf: 2.0, edgeTrim: 0.0 });
    const stock = makeStock(100.0);
    const part = makePart("p30", 30.0, 4);

    const units = pack1d(instancesOf(part), stock, s, "grouped");

    expect(units.length).toBe(2);
    const unit1 = units.find((u) => u.index === 1)!;
    const unit2 = units.find((u) => u.index === 2)!;
    expect(unit1.placements.length).toBe(3); // 同長3個が同じ原材に集まる
    expect(unit2.placements.length).toBe(1); // 容量超過分のみ新規原材へ

    const starts1 = placements1d(unit1)
      .map((p) => p.start)
      .sort((a, b) => a - b);
    expect(starts1).toEqual([0.0, 32.0, 64.0]); // 30, +30+kerf(2)=32, +30+kerf(2)=64
    expect(placements1d(unit2)[0].start).toBe(0.0);
  });

  it("grouped 手順3: グループの端数1個は FFD により既存原材の端材へ入る", () => {
    // kerf=0, edgeTrim=0, U=100。部材長 [60, 40, 40, 40]。
    // グループ60 (k=1) -> Unit1=[60@0]（残り40）。
    // グループ40 (k=3): 手順2 c=2 -> Unit2 新規に 40@0, 40@40。残1。
    // 手順3: 残1個を FFD -> Unit1: 60+40=100<=100 適合 -> Unit1 に 40@60。
    // （新規原材を開かず既存の端材を使う = 手順3 の存在意義）
    const s = makeSettings({ kerf: 0.0, edgeTrim: 0.0 });
    const stock = makeStock(100.0);
    const p60 = makePart("p60", 60.0, 1);
    const p40 = makePart("p40", 40.0, 3);
    const instances = [...instancesOf(p60), ...instancesOf(p40)];

    const units = pack1d(instances, stock, s, "grouped");

    expect(units.length).toBe(2);
    const unit1 = units.find((u) => u.index === 1)!;
    const unit2 = units.find((u) => u.index === 2)!;
    expect(placementSet(unit1)).toEqual(
      new Set([
        "p60#1@0",
        "p40#3@60", // 端数1個が Unit1 の端材へ
      ]),
    );
    expect(placementSet(unit2)).toEqual(new Set(["p40#1@0", "p40#2@40"]));
  });

  it("grouped 手順2 の c==1 フォールバック: 新品1本に1個しか入らない長い部材は1個ずつ FFD 挙動になる", () => {
    // kerf=0, edgeTrim=0, U=100。部材長 [70, 60, 60]。
    // グループ70 (k=1) -> 手順3 FFD -> Unit1=[70@0]。
    // グループ60 (k=2): c=1（60<=100 だが 60+60=120>100）-> 手順2 スキップ ->
    // 手順3 で1個ずつ FFD: どの既存原材にも入らないため Unit2=[60@0], Unit3=[60@0]。
    // 結果は ffd と完全一致する。
    const s = makeSettings({ kerf: 0.0, edgeTrim: 0.0 });
    const stock = makeStock(100.0);
    const p70 = makePart("p70", 70.0, 1);
    const p60 = makePart("p60", 60.0, 2);
    const instances = [...instancesOf(p70), ...instancesOf(p60)];

    const groupedUnits = pack1d(instances, stock, s, "grouped");
    const ffdUnits = pack1d(instances, stock, s, "ffd");

    expect(groupedUnits.length).toBe(3);
    expect(groupedUnits.every((u) => u.placements.length === 1)).toBe(true);
    expect(flattenStarts(groupedUnits)).toEqual([
      [1, "p70#1", 0.0],
      [2, "p60#1", 0.0],
      [3, "p60#2", 0.0],
    ]);
    // c==1 経路は FFD と同一出力（グループ充填の劣化を避けるためのフォールバック）
    expect(flattenStarts(groupedUnits)).toEqual(flattenStarts(ffdUnits));
  });

  it("同一入力を2回実行しても完全に一致する（安定・決定的ソートの帰結）", () => {
    const s = makeSettings({ kerf: 3.0, edgeTrim: 5.0 });
    const stock = makeStock(200.0);
    const partA = makePart("a", 40.0, 3);
    const partB = makePart("b", 25.0, 2);
    const partC = makePart("c", 40.0, 1); // a と同長、id違い（タイブレーク確認）
    const instances = [
      ...instancesOf(partA),
      ...instancesOf(partB),
      ...instancesOf(partC),
    ];

    for (const method of ["ffd", "bfd", "grouped"] as const) {
      const result1 = pack1d(instances, stock, s, method);
      const result2 = pack1d(instances, stock, s, method);
      expect(flattenStarts(result1)).toEqual(flattenStarts(result2));
      expect(result1.map((u) => u.index)).toEqual(result2.map((u) => u.index));
    }
  });

  it("同長タイブレーク: (part.id, instance.index) 昇順で決定的に並ぶ（3方式共通）", () => {
    // grouped では同長グループ内の処理順序の検証を兼ねる（グループ内順序は
    // (part.id, instance.index) 昇順と規定されている）。
    const s = makeSettings({ kerf: 0.0, edgeTrim: 0.0 });
    const stock = makeStock(1000.0); // 十分大きく、常に1本に収まる
    // 同じ長さ(10)の部材を id 逆順・qty>1 で用意し、処理順が
    // (id昇順, index昇順) になることを配置順（start昇順）から確認する。
    const partB = makePart("b", 10.0, 2); // b#1, b#2
    const partA = makePart("a", 10.0, 2); // a#1, a#2
    const instances = [...instancesOf(partB), ...instancesOf(partA)];

    for (const method of ["ffd", "bfd", "grouped"] as const) {
      const units = pack1d(instances, stock, s, method);
      expect(units.length).toBe(1);
      const orderedIds = [...placements1d(units[0])]
        .sort((a, b) => a.start - b.start)
        .map((p) => instanceId(p.instance));
      expect(orderedIds).toEqual(["a#1", "a#2", "b#1", "b#2"]);
    }
  });
});

// ---------------------------------------------------------------------------
// §10-5: カット回数（1D 部分、cutCount1d との結合）
// ---------------------------------------------------------------------------

describe("カット回数（cutCount1d との結合）", () => {
  it("n=1, edgeTrim>0 -> 2回（先頭捨て切り + 末尾切り）", () => {
    const s = makeSettings({ kerf: 3.0, edgeTrim: 5.0 });
    const stock = makeStock(100.0);
    const part = makePart("p", 50.0, 1);

    const units = pack1d(instancesOf(part), stock, s, "ffd");
    expect(units.length).toBe(1);
    const cc = cutCount1d(placements1d(units[0]), stock, s);
    expect(cc).toBe(2);
  });

  it("n=1, edgeTrim=0, len==L -> 0回（先頭・末尾とも省略）", () => {
    const s = makeSettings({ kerf: 3.0, edgeTrim: 0.0 });
    const stock = makeStock(100.0);
    const part = makePart("p", 100.0, 1);

    const units = pack1d(instancesOf(part), stock, s, "ffd");
    expect(units.length).toBe(1);
    const cc = cutCount1d(placements1d(units[0]), stock, s);
    expect(cc).toBe(0);
  });

  it("n=3 のフルケース: edgeTrim>0 なら leading(1) + interior(2) + trailing(1) = 4", () => {
    const s = makeSettings({ kerf: 3.0, edgeTrim: 5.0 });
    const stock = makeStock(100.0); // U = 90
    const part = makePart("p", 20.0, 3); // 20*3+2*3=66<=90、余裕あり

    const units = pack1d(instancesOf(part), stock, s, "ffd");
    expect(units.length).toBe(1);
    expect(units[0].placements.length).toBe(3);
    const cc = cutCount1d(placements1d(units[0]), stock, s);
    expect(cc).toBe(4);
  });

  it("cutCount1d の前提となる fits1d / usableLength と pack1d の整合性を確認する", () => {
    const s = makeSettings({ kerf: 2.0, edgeTrim: 4.0 });
    const stock = makeStock(120.0);
    const usable = usableLength(stock.length, s.edgeTrim);
    expect(usable).toBe(112.0);

    const part = makePart("p", 30.0, 3); // 30*3+2*2=94<=112
    const units = pack1d(instancesOf(part), stock, s, "bfd");
    expect(units.length).toBe(1);

    // pack1d が生成した配置が fits1d の容量条件を満たしていることを再確認する
    // （n個目までの累積が usable を超えていない）。
    const placementsSorted = [...placements1d(units[0])].sort(
      (a, b) => a.start - b.start,
    );
    let used = 0.0;
    for (let i = 0; i < placementsSorted.length; i++) {
      const p = placementsSorted[i];
      expect(fits1d(used, i, p.instance.part.length, s.kerf, usable)).toBe(
        true,
      );
      used = used + (i > 0 ? s.kerf : 0.0) + p.instance.part.length;
    }

    const cc = cutCount1d(placements1d(units[0]), stock, s);
    expect(cc).toBe(4); // leading(1) + interior(2) + trailing(1)
  });
});
