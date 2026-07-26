/**
 * assemblies（構成グルーピング）・marks（取り付けシロ）のテスト（SPECS.md §4c）。
 *
 * 構成:
 * - SPECS §4c の例 YAML そのものに対する ref 解決（38×89）
 * - qty 導出の2規則（contains 合計が勝つ / 非所属は qty 明記が必須）
 * - assemblies / marks の意味検証（id 重複・ID 安全性・ファイル名衝突・
 *   contains 参照・marks の on/ref 参照・領域寸法指定の排他）
 * - assemblies 不在時に従来挙動が保存されること
 */

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { loadProjectFromRaw } from "../../src/core/loader";
import {
  collectMarkVariants,
  markVariantStem,
  resolveMarks,
} from "../../src/core/marks";
import { Issue } from "../../src/core/errors";
import { Project } from "../../src/core/types";

/**
 * SPECS.md §4c に掲載されている例 YAML（parts / assemblies は verbatim）。
 *
 * §4c の抜粋は meta / stocks を省略しているため、参照されている 2×4 材
 * （SPF 2×4 6F: length 1820 / width 89 / thickness 38）と meta をここで補う。
 * 補った部分以外は改変していない。
 */
const SPECS_4C_YAML = `\
meta: { project: ウマ, units: mm, schemaVersion: "0.4" }

stocks:
  - { id: 2x4-6f, preset: spf/2x4/6f, label: "2×4材 6F", kind: bar, length: 1820, width: 89, thickness: 38, price: 598 }

parts:
  - { id: leg,       label: 足,     stock: 2x4-6f, length: 800 }
  - { id: beam-top,  label: 天板,   stock: 2x4-6f, length: 850 }
  - { id: beam-foot, label: 接地面, stock: 2x4-6f, length: 900 }

assemblies:
  - id: uma-1
    label: ウマ1号機（足が内側）
    contains: { leg: 2, beam-top: 1, beam-foot: 1 }
    marks:
      - { on: beam-top, face: front, ref: leg, x: 50, note: 足当たり面 }
  - id: uma-2
    label: ウマ2号機（互い違いに噛み合う側）
    contains: { leg: 2, beam-top: 1, beam-foot: 1 }
    marks:
      - { on: beam-top, face: front, ref: leg, rot: 90, x: 120, y: top, note: 足当たり面 }
`;

/** bar 材1本＋sheet 材1枚と3形状からなる、物理的に整合する raw プロジェクト。 */
function baseRaw(): any {
  return {
    meta: { project: "テスト", units: "mm", schemaVersion: "0.4" },
    settings: { kerf: 3, edgeTrim: 5 },
    stocks: [
      {
        id: "2x4-6f",
        label: "2×4材 6F",
        kind: "bar",
        length: 1820,
        width: 89,
        thickness: 38,
        price: 598,
      },
      {
        id: "ply-12",
        label: "合板12mm",
        kind: "sheet",
        length: 1820,
        width: 910,
        thickness: 12,
        price: 3000,
      },
    ],
    parts: [
      { id: "leg", label: "足", stock: "2x4-6f", length: 800 },
      { id: "beam-top", label: "天板", stock: "2x4-6f", length: 850 },
    ],
    assemblies: [],
  };
}

function load(raw: unknown): { project: Project | null; issues: Issue[] } {
  return loadProjectFromRaw(raw);
}

function errorsAt(issues: Issue[], path: string): Issue[] {
  return issues.filter((i) => i.path === path && i.severity === "error");
}

function qtyOf(project: Project, id: string): number {
  const part = project.parts.find((p) => p.id === id);
  expect(part, `形状 '${id}' が見つかりません`).toBeDefined();
  return part!.qty;
}

// ---------------------------------------------------------------------------
// SPECS §4c の例
// ---------------------------------------------------------------------------

describe("SPECS.md §4c の例 YAML", () => {
  it("そのまま読み込める（error なし）", () => {
    const { project, issues } = load(parse(SPECS_4C_YAML));

    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(project).not.toBeNull();
    expect(project!.assemblies.map((a) => a.id)).toEqual(["uma-1", "uma-2"]);
    expect(project!.assemblies[0].label).toBe("ウマ1号機（足が内側）");
    expect(project!.assemblies[0].contains).toEqual({
      leg: 2,
      "beam-top": 1,
      "beam-foot": 1,
    });
  });

  it("qty 省略でも contains 合計（2構成ぶん）から導出される", () => {
    const { project } = load(parse(SPECS_4C_YAML));

    expect(qtyOf(project!, "leg")).toBe(4); // 2 + 2
    expect(qtyOf(project!, "beam-top")).toBe(2); // 1 + 1
    expect(qtyOf(project!, "beam-foot")).toBe(2); // 1 + 1
  });

  it("ref: leg は 2×4 の 38×89 に解決される（SPECS §4c の数値例）", () => {
    const { project } = load(parse(SPECS_4C_YAML));
    const marks = resolveMarks(project!, project!.assemblies[0]);

    expect(marks).toHaveLength(1);
    expect(marks[0].w).toBe(38); // 原材 thickness
    expect(marks[0].h).toBe(89); // 実効幅（bar なので原材 width）
    expect(marks[0].x).toBe(50);
    expect(marks[0].y).toBe(0); // 省略時は 0（領域の左下角基準）
    expect(marks[0].on).toBe("beam-top");
    expect(marks[0].ref).toBe("leg");
    expect(marks[0].note).toBe("足当たり面");
  });

  it("同一形状でも assembly ごとに別の変種面になる", () => {
    const { project } = load(parse(SPECS_4C_YAML));
    const variants = collectMarkVariants(project!);

    expect(variants.map((v) => v.stem)).toEqual(["uma-1-beam-top", "uma-2-beam-top"]);
    expect(variants[0].marks[0].x).toBe(50);
    // uma-2 は rot: 90 + y: top（SPECS.md §4c の更新後の例そのもの）。
    // rot: 90 で (w, h) = (38, 89) → (89, 38) に入れ替わり、
    // y: top は beam-top の実効幅（bar なので stock.width = 89）から h を引いた
    // 89 − 38 = 51 に解決される。
    expect(variants[1].marks[0]).toMatchObject({ x: 120, y: 51, w: 89, h: 38, rot: 90 });
    // マークを持たない形状は変種面にならない（従来どおり形状ごとに1面）。
    expect(variants.every((v) => v.part.id === "beam-top")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rot（当たり面の面内回転）・x/y の端揃えエイリアス（SPECS.md §4c v0.7 追記）
// ---------------------------------------------------------------------------

describe("v0.7: marks の rot と端揃えエイリアス", () => {
  it("解決順序の証拠: 同じマークで rot だけを 0/90 に変えると y: top の解決値が変わる", () => {
    // beam-top（2×4、実効幅89）に leg（2×4、厚み38×幅89）を ref する。
    // rot: 0 なら (w, h) = (38, 89) → y: top は 89 − 89 = 0。
    // rot: 90 なら (w, h) = (89, 38) → y: top は 89 − 38 = 51。
    // これは D1（ref 導出 → rot 適用 → エイリアス解決の順序）を守っていなければ
    // 再現できない結果である（順序を誤ると rot が y の解決に影響しなくなる）。
    for (const [rot, expectedY] of [
      [0, 0],
      [90, 51],
    ] as const) {
      const raw = baseRaw();
      raw.assemblies = [
        {
          id: "asm",
          contains: { leg: 1, "beam-top": 1 },
          marks: [{ on: "beam-top", face: "front", ref: "leg", rot, y: "top" }],
        },
      ];
      const { project, issues } = load(raw);

      expect(issues.filter((i) => i.severity === "error")).toEqual([]);
      const mark = resolveMarks(project!, project!.assemblies[0])[0];
      expect(mark.y).toBe(expectedY);
      expect(mark.rot).toBe(rot);
    }
  });

  it("4方向の端揃えエイリアス（left/right/bottom/top）がそれぞれ解決される", () => {
    // beam-top: length 850、実効幅 89（bar なので stock.width）。
    // ref: leg（rot なし）→ (w, h) = (38, 89)。
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [
          { on: "beam-top", face: "front", ref: "leg", x: "left", y: "bottom" },
          { on: "beam-top", face: "front", ref: "leg", x: "right", y: "top" },
        ],
      },
    ];
    const { project, issues } = load(raw);

    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const marks = resolveMarks(project!, project!.assemblies[0]);

    expect(marks[0]).toMatchObject({ x: 0, y: 0 }); // left → 0, bottom → 0
    // right → part.length(850) − w(38) = 812。top → effectiveWidth(89) − h(89) = 0。
    expect(marks[1]).toMatchObject({ x: 812, y: 0 });
  });

  it("rot は w/h 直接指定にも一様に適用される（swap）", () => {
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [{ on: "beam-top", face: "front", w: 40, h: 20, rot: 90 }],
      },
    ];
    const { project, issues } = load(raw);

    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const mark = resolveMarks(project!, project!.assemblies[0])[0];
    // rot: 90 は w/h 直接指定であっても入れ替える（D2）。
    expect(mark.w).toBe(20);
    expect(mark.h).toBe(40);
  });

  it("rot 省略時・エイリアス不使用時は従来と同一の結果になる（既存挙動の保存）", () => {
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [{ on: "beam-top", face: "front", ref: "leg", x: 50 }],
      },
    ];
    const { project } = load(raw);
    const mark = resolveMarks(project!, project!.assemblies[0])[0];

    expect(mark).toEqual({
      on: "beam-top",
      face: "front",
      x: 50,
      y: 0,
      w: 38,
      h: 89,
      rot: 0,
      ref: "leg",
      note: null,
    });
  });

  it("rot に 0/90 以外の値（例: 45）を指定すると error になる", () => {
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [{ on: "beam-top", face: "front", w: 40, h: 20, rot: 45 }],
      },
    ];
    const { project, issues } = load(raw);

    expect(project).toBeNull();
    expect(issues.some((i) => i.severity === "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// center 揃えエイリアス（SPECS.md §4d のうち、今回スコープに含める部分のみ）
//
// §4d 逐語: 「矩形領域（marks の x/y 等）では領域全体を揃えるため、right/top は
// 『対象面の軸長 − w/h』、center は『（対象面の軸長 − w/h）÷2』に解決する。
// w/h は ref・rot による導出値でもよい。」
// ---------------------------------------------------------------------------

describe("v0.7d: marks の center 揃えエイリアス（矩形領域）", () => {
  it("x: center / y: center は (軸長 − w) / 2 / (軸長 − h) / 2 に解決される（rot: 90）", () => {
    // beam-top: length 850、実効幅 89（bar なので stock.width）。
    // ref: leg（2×4、厚み38×幅89）+ rot: 90 → (w, h) = (89, 38) に入れ替わる。
    // x: center → (850 − 89) / 2 = 380.5
    // y: center → (89 − 38) / 2 = 25.5
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [{ on: "beam-top", face: "front", ref: "leg", rot: 90, x: "center", y: "center" }],
      },
    ];
    const { project, issues } = load(raw);

    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const mark = resolveMarks(project!, project!.assemblies[0])[0];
    expect(mark.w).toBe(89);
    expect(mark.h).toBe(38);
    expect(mark.x).toBe(380.5);
    expect(mark.y).toBe(25.5);
  });

  it("center は「軸長の 1/2」ではなく「(軸長 − size) / 2」である（size 0 の退化例で確認）", () => {
    // w = h = 0 の退化例なら center は軸長そのものの 1/2 と数値上一致してしまうため、
    // ここでは w/h が非0の上のテストで既に「軸長の1/2ではない」ことを数値的に示している
    // （380.5 ≠ 850/2 = 425、25.5 ≠ 89/2 = 44.5）。念のため明記する。
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [{ on: "beam-top", face: "front", ref: "leg", rot: 90, x: "center", y: "center" }],
      },
    ];
    const { project } = load(raw);
    const mark = resolveMarks(project!, project!.assemblies[0])[0];

    expect(mark.x).not.toBe(850 / 2);
    expect(mark.y).not.toBe(89 / 2);
  });

  it("rot を 0/90 で振ると center の解決値が変わる（rot 適用後の w/h を使っている証拠）", () => {
    // rot: 0 なら (w, h) = (38, 89)。
    //   x: center → (850 − 38) / 2 = 406
    //   y: center → (89 − 89) / 2 = 0
    // rot: 90 なら (w, h) = (89, 38)。
    //   x: center → (850 − 89) / 2 = 380.5
    //   y: center → (89 − 38) / 2 = 25.5
    for (const [rot, expectedX, expectedY] of [
      [0, 406, 0],
      [90, 380.5, 25.5],
    ] as const) {
      const raw = baseRaw();
      raw.assemblies = [
        {
          id: "asm",
          contains: { leg: 1, "beam-top": 1 },
          marks: [{ on: "beam-top", face: "front", ref: "leg", rot, x: "center", y: "center" }],
        },
      ];
      const { project, issues } = load(raw);

      expect(issues.filter((i) => i.severity === "error")).toEqual([]);
      const mark = resolveMarks(project!, project!.assemblies[0])[0];
      expect(mark.x).toBe(expectedX);
      expect(mark.y).toBe(expectedY);
    }
  });

  it("既存の left/right/bottom/top の解決値は center 追加後も変わらない（回帰防止）", () => {
    // 既存テスト「4方向の端揃えエイリアス」と同じ数値例を、center と同居させて再確認する。
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [
          { on: "beam-top", face: "front", ref: "leg", x: "left", y: "bottom" },
          { on: "beam-top", face: "front", ref: "leg", x: "right", y: "top" },
          { on: "beam-top", face: "front", ref: "leg", x: "center", y: "center" },
        ],
      },
    ];
    const { project, issues } = load(raw);

    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const marks = resolveMarks(project!, project!.assemblies[0]);

    expect(marks[0]).toMatchObject({ x: 0, y: 0 }); // left → 0, bottom → 0
    expect(marks[1]).toMatchObject({ x: 812, y: 0 }); // right → 850−38=812, top → 89−89=0
    // center → (850−38)/2=406, (89−89)/2=0（rot 省略なので (w,h)=(38,89)）
    expect(marks[2]).toMatchObject({ x: 406, y: 0 });
  });
});

// ---------------------------------------------------------------------------
// qty 導出（SPECS.md §4c）
// ---------------------------------------------------------------------------

describe("v0.7: qty 導出", () => {
  it("規則1: 全 assembly の contains 合計が qty になる", () => {
    const raw = baseRaw();
    raw.assemblies = [
      { id: "asm-1", contains: { leg: 2, "beam-top": 1 } },
      { id: "asm-2", contains: { leg: 3 } },
    ];

    const { project, issues } = load(raw);

    expect(issues).toEqual([]);
    expect(qtyOf(project!, "leg")).toBe(5);
    expect(qtyOf(project!, "beam-top")).toBe(1);
  });

  it("規則1: qty 併記が合計と一致していれば warning は出ない", () => {
    const raw = baseRaw();
    raw.parts[0].qty = 2;
    raw.assemblies = [{ id: "asm-1", contains: { leg: 2, "beam-top": 1 } }];

    const { project, issues } = load(raw);

    expect(issues).toEqual([]);
    expect(qtyOf(project!, "leg")).toBe(2);
  });

  it("規則1: qty 併記が合計と食い違えば warning（宣言値・導出値の両方を示す）", () => {
    const raw = baseRaw();
    raw.parts[0].qty = 9;
    raw.assemblies = [{ id: "asm-1", contains: { leg: 2, "beam-top": 1 } }];

    const { project, issues } = load(raw);

    expect(project).not.toBeNull();
    const w = issues.find((i) => i.path === "parts[0].qty");
    expect(w?.severity).toBe("warning");
    expect(w?.message).toContain("宣言値 9");
    expect(w?.message).toContain("導出値 2");
    // 割付は導出後の合計だけを見る（SPECS §4c）。
    expect(qtyOf(project!, "leg")).toBe(2);
  });

  it("規則2: どの構成にも含まれない形状は qty 明記を使う（部分採用を許す）", () => {
    const raw = baseRaw();
    raw.parts[1].qty = 7; // beam-top はどの assembly にも属さない
    raw.assemblies = [{ id: "asm-1", contains: { leg: 2 } }];

    const { project, issues } = load(raw);

    expect(issues).toEqual([]);
    expect(qtyOf(project!, "leg")).toBe(2);
    expect(qtyOf(project!, "beam-top")).toBe(7);
  });

  it("規則2: どの構成にも含まれず qty も無ければ error（黙って消さない）", () => {
    const raw = baseRaw();
    raw.assemblies = [{ id: "asm-1", contains: { leg: 2 } }];

    const { project, issues } = load(raw);

    expect(project).toBeNull();
    const e = errorsAt(issues, "parts[1].qty");
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("導出できません");
  });

  it("assemblies 不在なら従来どおり qty は必須", () => {
    const raw = baseRaw();
    delete raw.assemblies;

    const { project, issues } = load(raw);

    expect(project).toBeNull();
    expect(errorsAt(issues, "parts[0].qty")).toHaveLength(1);
    expect(errorsAt(issues, "parts[1].qty")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 意味検証（D3 の7項目）
// ---------------------------------------------------------------------------

describe("v0.7: assemblies の意味検証", () => {
  it("assemblies[].id の重複は error", () => {
    const raw = baseRaw();
    raw.assemblies = [
      { id: "asm", contains: { leg: 1 } },
      { id: "asm", contains: { "beam-top": 1 } },
    ];

    const { project, issues } = load(raw);

    expect(project).toBeNull();
    const e = errorsAt(issues, "assemblies[1].id");
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("重複");
  });

  it("assemblies[].id の ID 安全性（出力ファイル名に使うため）", () => {
    const raw = baseRaw();
    raw.assemblies = [{ id: "../evil", contains: { leg: 1, "beam-top": 1 } }];

    const { project, issues } = load(raw);

    expect(project).toBeNull();
    expect(errorsAt(issues, "assemblies[0].id").length).toBeGreaterThan(0);
  });

  it("assemblies[].id が Windows 予約名なら error", () => {
    const raw = baseRaw();
    raw.assemblies = [{ id: "CON", contains: { leg: 1, "beam-top": 1 } }];

    const { project, issues } = load(raw);

    expect(project).toBeNull();
    const e = errorsAt(issues, "assemblies[0].id");
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("予約デバイス名");
  });

  it("変種面の出力名が既存の部材 id と衝突すれば error", () => {
    const raw = baseRaw();
    // 変種面 'uma-leg' が部材 id 'uma-leg' と衝突する（両 id ともハイフンを含みうる）。
    raw.parts.push({ id: "uma-leg", label: "衝突する部材", qty: 1, stock: "2x4-6f", length: 300 });
    raw.assemblies = [
      {
        id: "uma",
        contains: { leg: 1, "beam-top": 1 },
        marks: [{ on: "leg", face: "front", w: 38, h: 89 }],
      },
    ];

    const { project, issues } = load(raw);

    expect(project).toBeNull();
    const e = errorsAt(issues, "assemblies[0].id");
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("'uma-leg'");
  });

  it("変種面の出力名どうしの衝突も error", () => {
    const raw = baseRaw();
    raw.parts = [
      { id: "y-z", label: "部材1", stock: "2x4-6f", length: 300 },
      { id: "z", label: "部材2", stock: "2x4-6f", length: 300 },
    ];
    raw.assemblies = [
      {
        id: "x",
        contains: { "y-z": 1 },
        marks: [{ on: "y-z", face: "front", w: 10, h: 10 }],
      },
      {
        id: "x-y",
        contains: { z: 1 },
        marks: [{ on: "z", face: "front", w: 10, h: 10 }],
      },
    ];

    const { project, issues } = load(raw);

    expect(project).toBeNull();
    const e = errorsAt(issues, "assemblies[1].id");
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("x-y-z");
    // 合成名は描画層と同じ規則で作られている。
    expect(markVariantStem("x", "y-z")).toBe("x-y-z");
    expect(markVariantStem("x-y", "z")).toBe("x-y-z");
  });

  it("マークを持たない (assembly, 形状) の組は衝突検査の対象外（ファイルが生成されないため）", () => {
    const raw = baseRaw();
    raw.parts.push({ id: "uma-leg", label: "同名の部材", qty: 1, stock: "2x4-6f", length: 300 });
    raw.assemblies = [{ id: "uma", contains: { leg: 1, "beam-top": 1 } }];

    const { project, issues } = load(raw);

    expect(issues).toEqual([]);
    expect(project).not.toBeNull();
  });

  it("contains のキーが parts に無ければ error（path は固定キーのみ）", () => {
    const raw = baseRaw();
    raw.assemblies = [{ id: "asm", contains: { leg: 1, "beam-top": 1, "no.such.part": 1 } }];

    const { project, issues } = load(raw);

    expect(project).toBeNull();
    const e = errorsAt(issues, "assemblies[0].contains");
    expect(e).toHaveLength(1);
    // ユーザー制御の id は path ではなくメッセージ側に載せる。
    expect(e[0].message).toContain("'no.such.part'");
  });

  it("contains の値は 1 以上の整数（層1のスキーマ検証）", () => {
    for (const bad of [0, -1, 1.5, "2"]) {
      const raw = baseRaw();
      raw.assemblies = [{ id: "asm", contains: { leg: bad, "beam-top": 1 } }];

      const { project, issues } = load(raw);

      expect(project, `contains: ${JSON.stringify(bad)} は拒否されるべき`).toBeNull();
      const e = errorsAt(issues, "assemblies[0].contains");
      expect(e.length).toBeGreaterThan(0);
      // キー名はメッセージ側（path には載せない）。
      expect(e[0].message).toContain("'leg'");
    }
  });

  it("marks[].on が parts に無ければ error", () => {
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [{ on: "nope", face: "front", w: 10, h: 10 }],
      },
    ];

    const { project, issues } = load(raw);

    expect(project).toBeNull();
    expect(errorsAt(issues, "assemblies[0].marks[0].on")).toHaveLength(1);
  });

  it("marks[].on がその構成の contains に含まれなければ error", () => {
    const raw = baseRaw();
    raw.parts[1].qty = 1; // beam-top はどの構成にも属さない
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1 },
        marks: [{ on: "beam-top", face: "front", w: 10, h: 10 }],
      },
    ];

    const { project, issues } = load(raw);

    expect(project).toBeNull();
    const e = errorsAt(issues, "assemblies[0].marks[0].on");
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("contains");
  });

  it("marks[].ref が parts に無ければ error", () => {
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [{ on: "beam-top", face: "front", ref: "nope" }],
      },
    ];

    const { project, issues } = load(raw);

    expect(project).toBeNull();
    expect(errorsAt(issues, "assemblies[0].marks[0].ref")).toHaveLength(1);
  });

  it("ref と w/h の併記は error（排他）", () => {
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [{ on: "beam-top", face: "front", ref: "leg", w: 38, h: 89 }],
      },
    ];

    const { project, issues } = load(raw);

    expect(project).toBeNull();
    // 層1（スキーマの oneOf）が先に弾くため、path は mark 要素そのものになる。
    const e = issues.filter(
      (i) => i.path === "assemblies[0].marks[0]" && i.severity === "error",
    );
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("取り付けシロ");
  });

  it("ref も w/h も無ければ error（領域寸法が決まらない）", () => {
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [{ on: "beam-top", face: "front", x: 50 }],
      },
    ];

    const { project, issues } = load(raw);

    expect(project).toBeNull();
    const e = errorsAt(issues, "assemblies[0].marks[0].w");
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("領域寸法");
  });

  it("w だけ・h だけの指定も error", () => {
    for (const partial of [{ w: 38 }, { h: 89 }]) {
      const raw = baseRaw();
      raw.assemblies = [
        {
          id: "asm",
          contains: { leg: 1, "beam-top": 1 },
          marks: [{ on: "beam-top", face: "front", ...partial }],
        },
      ];

      const { project, issues } = load(raw);

      expect(project).toBeNull();
      expect(errorsAt(issues, "assemblies[0].marks[0].w")).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// marks の解決
// ---------------------------------------------------------------------------

describe("v0.7: marks の解決（resolveMarks）", () => {
  it("bar 形状の ref は (厚み, 原材幅) に解決される", () => {
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [{ on: "beam-top", face: "front", ref: "leg", x: 50 }],
      },
    ];
    const { project } = load(raw);

    expect(resolveMarks(project!, project!.assemblies[0])[0]).toMatchObject({
      w: 38,
      h: 89,
      ref: "leg",
    });
  });

  it("sheet 形状の ref は (厚み, part.width) に解決される", () => {
    const raw = baseRaw();
    raw.parts.push({
      id: "panel",
      label: "板",
      stock: "ply-12",
      length: 400,
      width: 250,
    });
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1, panel: 1 },
        marks: [{ on: "beam-top", face: "front", ref: "panel" }],
      },
    ];
    const { project } = load(raw);

    expect(resolveMarks(project!, project!.assemblies[0])[0]).toMatchObject({
      w: 12, // ply-12 の thickness
      h: 250, // sheet なので part.width が実効幅
    });
  });

  it("w/h 直接指定はそのまま通り、x/y 省略時は 0（領域の左下角基準）", () => {
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [{ on: "beam-top", face: "back", w: 40, h: 20, note: "当たり" }],
      },
    ];
    const { project } = load(raw);

    expect(resolveMarks(project!, project!.assemblies[0])[0]).toEqual({
      on: "beam-top",
      face: "back",
      x: 0,
      y: 0,
      w: 40,
      h: 20,
      rot: 0,
      ref: null,
      note: "当たり",
    });
  });

  it("ref は face に依存しない（back でも同じ断面寸法）", () => {
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [
          { on: "beam-top", face: "front", ref: "leg" },
          { on: "beam-top", face: "back", ref: "leg" },
        ],
      },
    ];
    const { project } = load(raw);
    const marks = resolveMarks(project!, project!.assemblies[0]);

    expect(marks[0].w).toBe(marks[1].w);
    expect(marks[0].h).toBe(marks[1].h);
  });

  it("collectMarkVariants は形状ごとにマークをまとめる", () => {
    const raw = baseRaw();
    raw.assemblies = [
      {
        id: "asm",
        contains: { leg: 1, "beam-top": 1 },
        marks: [
          { on: "beam-top", face: "front", ref: "leg", x: 10 },
          { on: "leg", face: "front", w: 10, h: 10 },
          { on: "beam-top", face: "front", ref: "leg", x: 700 },
        ],
      },
    ];
    const { project } = load(raw);
    const variants = collectMarkVariants(project!);

    expect(variants.map((v) => v.stem)).toEqual(["asm-beam-top", "asm-leg"]);
    expect(variants[0].marks.map((m) => m.x)).toEqual([10, 700]);
    expect(variants[0].part.id).toBe("beam-top");
    expect(variants[0].assembly.id).toBe("asm");
    expect(variants[1].marks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 後方互換
// ---------------------------------------------------------------------------

describe("v0.7: assemblies 不在時の後方互換", () => {
  it("assemblies キーが無ければ空配列になり、qty は従来どおり", () => {
    const raw = baseRaw();
    delete raw.assemblies;
    raw.parts[0].qty = 2;
    raw.parts[1].qty = 1;

    const { project, issues } = load(raw);

    expect(issues).toEqual([]);
    expect(project!.assemblies).toEqual([]);
    expect(qtyOf(project!, "leg")).toBe(2);
    expect(qtyOf(project!, "beam-top")).toBe(1);
  });

  it("assemblies: [] も同じ（区画不在と等価）", () => {
    const raw = baseRaw();
    raw.parts[0].qty = 2;
    raw.parts[1].qty = 1;

    const { project, issues } = load(raw);

    expect(issues).toEqual([]);
    expect(project!.assemblies).toEqual([]);
    expect(collectMarkVariants(project!)).toEqual([]);
  });

  it("assemblies を使っても marks が無ければ変種面は生じない", () => {
    const raw = baseRaw();
    raw.assemblies = [{ id: "asm", contains: { leg: 2, "beam-top": 1 } }];

    const { project, issues } = load(raw);

    expect(issues).toEqual([]);
    expect(project!.assemblies[0].marks).toEqual([]);
    expect(collectMarkVariants(project!)).toEqual([]);
  });
});
