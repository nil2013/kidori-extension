/**
 * packing/pack2d（MaxRects 2D 割付）の性質テスト（Python tests/test_pack2d.py の移植）。
 *
 * MaxRects の free rect 管理は誤実装の検出コストが高いため、個別座標のゴールデン比較
 * ではなく不変条件（性質）で正しさを担保する。Part/PartInstance は本ファイル内で
 * 直接構築する。
 */

import { describe, expect, it } from "vitest";

import type {
  PartInstance,
  Placement2D,
  StockUnit,
} from "../../src/core/packing/common";
import { instanceId } from "../../src/core/packing/common";
import { pack2d, packSheets } from "../../src/core/packing/pack2d";
import type { Part, Settings, Stock } from "../../src/core/types";
import { DEFAULT_RANK, effectiveWidth } from "../../src/core/types";

const TEPS = 1e-6; // テスト側の許容誤差（実装側 EPS=1e-9 より緩く取る）

const METHODS = ["bssf", "baf", "bl"] as const;

// ---------------------------------------------------------------------------
// ビルダ / 補助
// ---------------------------------------------------------------------------

function makeStock(
  id = "sheet-1",
  length = 1820.0,
  width = 910.0,
  thickness = 18.0,
  price: number | null = null,
): Stock {
  return { id, label: id, kind: "sheet", length, width, thickness, price };
}

function makePart(
  id: string,
  length: number,
  width: number,
  rot = true,
  qty = 1,
  stock = "sheet-1",
): Part {
  return { id, label: id, qty, stock, length, width, rot, features: [] };
}

/** 各 Part を qty 展開して PartInstance のリストにする。 */
function instancesOf(...parts: Part[]): PartInstance[] {
  const out: PartInstance[] = [];
  for (const p of parts) {
    for (let i = 1; i <= p.qty; i++) {
      out.push({ part: p, index: i });
    }
  }
  return out;
}

function settings(kerf = 3.0, edgeTrim = 5.0): Settings {
  return {
    kerf,
    edgeTrim,
    candidates: 3,
    rank: [...DEFAULT_RANK],
    exact: "auto",
    selectedPlan: null,
  };
}

/** 配置の実座標フットプリント [x0, y0, x1, y1] を返す。 */
function realFootprint(
  p: Placement2D,
  stock: Stock,
): [number, number, number, number] {
  const length = p.instance.part.length;
  const width = effectiveWidth(p.instance.part, stock);
  const [fw, fh] = p.rotated ? [width, length] : [length, width];
  return [p.x, p.y, p.x + fw, p.y + fh];
}

function allPlacements(units: StockUnit[]): Placement2D[] {
  const out: Placement2D[] = [];
  for (const u of units) {
    out.push(...(u.placements as Placement2D[]));
  }
  return out;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** 決定性比較用の正規化シグネチャ。 */
function placementSignature(
  units: StockUnit[],
): Array<[number, string, number, number, boolean]> {
  const sig: Array<[number, string, number, number, boolean]> = [];
  for (const u of units) {
    for (const p of u.placements as Placement2D[]) {
      sig.push([
        u.index,
        instanceId(p.instance),
        round6(p.x),
        round6(p.y),
        p.rotated,
      ]);
    }
  }
  return sig;
}

// ---------------------------------------------------------------------------
// 性質1: 全配置が使用可能窓 [e, L-e] × [e, W-e] 内（実座標）
// ---------------------------------------------------------------------------
describe("性質1: 全配置が使用可能窓内（実座標）", () => {
  for (const method of METHODS) {
    it(`全配置が窓内に収まる (${method})`, () => {
      const stock = makeStock("sheet-1", 1000, 600);
      const s = settings(3.0, 5.0);
      const parts = [
        makePart("a", 400, 200),
        makePart("b", 300, 250),
        makePart("c", 500, 180),
        makePart("d", 200, 200),
      ];
      const units = pack2d(instancesOf(...parts), stock, s, method);
      const e = s.edgeTrim;
      const [xLo, xHi] = [e, stock.length - e];
      const [yLo, yHi] = [e, stock.width - e];
      for (const p of allPlacements(units)) {
        const [x0, y0, x1, y1] = realFootprint(p, stock);
        expect(
          x0 >= xLo - TEPS,
          `${instanceId(p.instance)} が左窓外: x0=${x0}`,
        ).toBe(true);
        expect(
          y0 >= yLo - TEPS,
          `${instanceId(p.instance)} が下窓外: y0=${y0}`,
        ).toBe(true);
        expect(
          x1 <= xHi + TEPS,
          `${instanceId(p.instance)} が右窓外: x1=${x1}`,
        ).toBe(true);
        expect(
          y1 <= yHi + TEPS,
          `${instanceId(p.instance)} が上窓外: y1=${y1}`,
        ).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 性質2: 任意の2部材で x 投影か y 投影が分離し、離間 ≥ kerf（実座標）
// ---------------------------------------------------------------------------
describe("性質2: ペアワイズ離間 ≥ kerf（実座標）", () => {
  for (const method of METHODS) {
    for (const kerf of [0.0, 3.0, 5.5]) {
      it(`同一シート内の全ペアが分離する (${method}, kerf=${kerf})`, () => {
        const stock = makeStock("sheet-1", 1000, 600);
        const s = settings(kerf, 5.0);
        const parts = [
          makePart("a", 400, 200),
          makePart("b", 300, 250),
          makePart("c", 500, 180),
          makePart("d", 250, 220),
          makePart("e", 180, 180),
        ];
        const units = pack2d(instancesOf(...parts), stock, s, method);
        // 同一シート内のペアのみ検査（別シートは自明に分離）
        for (const u of units) {
          const plist = u.placements as Placement2D[];
          for (let i = 0; i < plist.length; i++) {
            for (let j = i + 1; j < plist.length; j++) {
              const [ax0, ay0, ax1, ay1] = realFootprint(plist[i], stock);
              const [bx0, by0, bx1, by1] = realFootprint(plist[j], stock);
              const sepX = bx0 - ax1 >= kerf - TEPS || ax0 - bx1 >= kerf - TEPS;
              const sepY = by0 - ay1 >= kerf - TEPS || ay0 - by1 >= kerf - TEPS;
              expect(
                sepX || sepY,
                `${instanceId(plist[i].instance)} と ` +
                  `${instanceId(plist[j].instance)} の離間が kerf 未満`,
              ).toBe(true);
            }
          }
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 性質3: rot:false は回転しない / rot:true では回転が起きうる
// ---------------------------------------------------------------------------
describe("性質3: 回転可否の遵守", () => {
  for (const method of METHODS) {
    it(`rot:false は決して回転しない (${method})`, () => {
      const stock = makeStock("sheet-1", 1000, 600);
      const s = settings(3.0, 5.0);
      // 原向きで素直に収まる部材群（全て rot=false）
      const parts = [
        makePart("a", 400, 200, false),
        makePart("b", 300, 250, false),
        makePart("c", 200, 200, false),
      ];
      const units = pack2d(instancesOf(...parts), stock, s, method);
      for (const p of allPlacements(units)) {
        expect(
          p.rotated,
          `${instanceId(p.instance)} が回転してしまった`,
        ).toBe(false);
      }
    });
  }

  for (const method of METHODS) {
    it(`回転しないと入らない部材は rot:true で回転配置される (${method})`, () => {
      // 窓の高さ Wu が部材幅より小さく、原向きでは入らない → 回転が強制される。
      // L=1000, W=200, e=5, kerf=0 → Lu=990, Wu=190。
      // 部材 length=150(<=190), width=250(>190,<=990)。原向き ph=250>190 で不可、
      // 回転 ph=150<=190, pw=250<=990 で可。
      const stock = makeStock("sheet-1", 1000, 200);
      const s = settings(0.0, 5.0);
      const part = makePart("tall", 150, 250, true);
      const units = pack2d(instancesOf(part), stock, s, method);
      const placements = allPlacements(units);
      expect(placements.length).toBe(1);
      expect(
        placements[0].rotated,
        "回転しないと収まらないのに原向きで配置された",
      ).toBe(true);
      // 実座標フットプリントが窓内であることも確認
      const [x0, y0, x1, y1] = realFootprint(placements[0], stock);
      expect(x0 >= 5 - TEPS && y0 >= 5 - TEPS).toBe(true);
      expect(x1 <= 1000 - 5 + TEPS && y1 <= 200 - 5 + TEPS).toBe(true);
    });
  }

  it("rot:false でどの向きでも入らない部材は例外を投げる", () => {
    // 上と同寸だが rot=false → どの向きでも入らずエラー。
    const stock = makeStock("sheet-1", 1000, 200);
    const s = settings(0.0, 5.0);
    const part = makePart("tall", 150, 250, false);
    expect(() => pack2d(instancesOf(part), stock, s, "bssf")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 性質4: 必要枚数の自動増加
// ---------------------------------------------------------------------------
describe("性質4: 必要枚数の自動増加", () => {
  for (const method of METHODS) {
    it(`1枚に収まらないと2枚目が開く (${method})`, () => {
      // 1枚には 1 個しか入らない大部材を 2 個 → 2 枚に分かれる。
      // L=1000, W=600, e=5 → Lu=990, Wu=590。
      // 部材 length=980, width=400。高さ方向に 2 個は 400*2=800 > 590 で不可 → 2 枚目。
      const stock = makeStock("sheet-1", 1000, 600);
      const s = settings(3.0, 5.0);
      const part = makePart("big", 980, 400, false, 2);
      const units = pack2d(instancesOf(part), stock, s, method);
      expect(units.length, `2 枚に分かれるはずが ${units.length} 枚`).toBe(2);
      expect(units.reduce((acc, u) => acc + u.placements.length, 0)).toBe(2);
      // 各シートに 1 個ずつ
      expect(units.every((u) => u.placements.length === 1)).toBe(true);
    });
  }

  for (const method of METHODS) {
    it(`小部材群は 1 枚に収まる (${method})`, () => {
      const stock = makeStock("sheet-1", 1000, 600);
      const s = settings(3.0, 5.0);
      const parts = [0, 1, 2, 3].map((i) => makePart(`p${i}`, 150, 150));
      const units = pack2d(instancesOf(...parts), stock, s, method);
      expect(units.length).toBe(1);
      expect(units[0].placements.length).toBe(4);
    });
  }
});

// ---------------------------------------------------------------------------
// 性質5: free rect の不変条件（重複包含なし）
// ---------------------------------------------------------------------------
describe("性質5: free rect の不変条件", () => {
  for (const method of METHODS) {
    it(`free rect に相互包含がない (${method})`, () => {
      const stock = makeStock("sheet-1", 1000, 600);
      const s = settings(3.0, 5.0);
      const parts = [
        makePart("a", 400, 200),
        makePart("b", 300, 250),
        makePart("c", 500, 180),
        makePart("d", 250, 220),
        makePart("e", 180, 180),
        makePart("f", 220, 300),
      ];
      const sheets = packSheets(instancesOf(...parts), stock, s, method);
      for (const sheet of sheets) {
        const frs = sheet.freeRects;
        for (let i = 0; i < frs.length; i++) {
          for (let j = 0; j < frs.length; j++) {
            if (i === j) {
              continue;
            }
            // 相互包含（＝重複を残す刈り込み漏れ）がないこと
            expect(
              frs[i].contains(frs[j]),
              `free rect ${j} が ${i} に包含されている（刈り込み漏れ）`,
            ).toBe(false);
          }
        }
      }
    });
  }

  it("退化した（面積ゼロ近傍の）free rect が残らない", () => {
    const stock = makeStock("sheet-1", 1000, 600);
    const s = settings(3.0, 5.0);
    const parts = [makePart("a", 400, 200), makePart("b", 600, 400)];
    const sheets = packSheets(instancesOf(...parts), stock, s, "bssf");
    for (const sheet of sheets) {
      for (const fr of sheet.freeRects) {
        expect(fr.w > 0 && fr.h > 0).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 性質6: 3方式の決定性と、方式間で結果が異なりうること
// ---------------------------------------------------------------------------
describe("性質6: 決定性と方式差", () => {
  for (const method of METHODS) {
    it(`同一入力で結果が一致する (${method})`, () => {
      const stock = makeStock("sheet-1", 1000, 600);
      const s = settings(3.0, 5.0);
      const parts = [
        makePart("a", 400, 200),
        makePart("b", 300, 250),
        makePart("c", 500, 180),
        makePart("d", 250, 220),
        makePart("e", 180, 180),
      ];
      const insts = instancesOf(...parts);
      const sig1 = placementSignature(pack2d(insts, stock, s, method));
      const sig2 = placementSignature(pack2d(insts, stock, s, method));
      expect(sig1, `方式 ${method} が非決定的`).toEqual(sig2);
    });
  }

  it("bssf と bl で配置結果が異なりうる", () => {
    // 異なる縦横比の部材を混ぜると、ソート順・スコアの違いで配置が変わる。
    const stock = makeStock("sheet-1", 1000, 600);
    const s = settings(3.0, 5.0);
    const parts = [
      makePart("wide", 100, 300),
      makePart("tall", 300, 100),
      makePart("square", 200, 200),
      makePart("long", 500, 150),
    ];
    const insts = instancesOf(...parts);
    const sigBssf = placementSignature(pack2d(insts, stock, s, "bssf"));
    const sigBl = placementSignature(pack2d(insts, stock, s, "bl"));
    // 少なくとも 1 ペアの方式で配置結果が異なること（人が比較する意味がある）
    expect(
      sigBssf,
      "bssf と bl で配置が完全一致（方式差が出ていない）",
    ).not.toEqual(sigBl);
  });
});

// ---------------------------------------------------------------------------
// 性質7: 膨張座標系の縁配置（2D カット回数の前提となる配置検証）
// ---------------------------------------------------------------------------
describe("性質7: 膨張座標系の縁配置", () => {
  for (const method of ["bssf", "bl"] as const) {
    it(`窓左下隅に接する配置が存在する (${method})`, () => {
      // 最初に置かれる部材は膨張座標 (0,0) → 実座標 (e, e)、窓の左下隅に接する。
      // これは「窓境界に載る辺には縁カットで足りる（追加カット不要）」という
      // カット回数定義の前提になる配置性質。
      const stock = makeStock("sheet-1", 1000, 600);
      const s = settings(3.0, 5.0);
      const parts = [makePart("a", 400, 200), makePart("b", 300, 250)];
      const units = pack2d(instancesOf(...parts), stock, s, method);
      // 全配置のうち窓左下隅 (e, e) に載るものが少なくとも1つ存在する
      const e = s.edgeTrim;
      const onCorner = allPlacements(units).filter(
        (p) => Math.abs(p.x - e) < TEPS && Math.abs(p.y - e) < TEPS,
      );
      expect(
        onCorner.length > 0,
        "窓左下隅に接する配置が無い（膨張座標原点の実座標復元が不正の疑い）",
      ).toBe(true);
    });
  }

  it("窓幅いっぱいの部材は上端が窓上境界 W-e に一致する", () => {
    // L=1000, W=210, e=5, kerf=0 → Wu=200。width=200 の部材は y0=e, y1=W-e=205。
    const stock = makeStock("sheet-1", 1000, 210);
    const s = settings(0.0, 5.0);
    const part = makePart("full", 300, 200, false);
    const units = pack2d(instancesOf(part), stock, s, "bssf");
    const p = allPlacements(units)[0];
    const [, y0, , y1] = realFootprint(p, stock);
    expect(Math.abs(y0 - 5)).toBeLessThan(TEPS);
    expect(Math.abs(y1 - (210 - 5))).toBeLessThan(TEPS);
  });
});

// ---------------------------------------------------------------------------
// 追加: 膨張座標系の境界（詰め込み可否の厳密境界）
// ---------------------------------------------------------------------------
describe("追加: 膨張座標系の境界", () => {
  it("部材が使用可能窓ぴったり（Lu×Wu）に収まる境界ケース", () => {
    // L=1000, W=600, e=5, kerf=3 → Lu=990, Wu=590。ビン=(993)×(593)。
    // 部材 length=990, width=590 → 膨張 993×593 = ビン全体。等号成立で 1 枚に収まる。
    const stock = makeStock("sheet-1", 1000, 600);
    const s = settings(3.0, 5.0);
    const part = makePart("exact", 990, 590, false);
    const units = pack2d(instancesOf(part), stock, s, "bssf");
    expect(units.length).toBe(1);
    const p = allPlacements(units)[0];
    const [x0, y0, x1, y1] = realFootprint(p, stock);
    expect(Math.abs(x0 - 5) < TEPS && Math.abs(y0 - 5) < TEPS).toBe(true);
    expect(Math.abs(x1 - 995) < TEPS && Math.abs(y1 - 595) < TEPS).toBe(true);
  });
});
