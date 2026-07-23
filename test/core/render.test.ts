/**
 * render/cutplan.ts / render/partcard.ts の単体テスト
 * （Python 版 tests/test_render.py の移植＋v0.4 追加要件のケース）。
 *
 * Meta/Settings/Stock/Part/Groove/Hole/PartInstance/Placement/StockUnit/Plan を
 * すべて自前で構築する（pack1d/pack2d の実行結果に依存しない）。
 *
 * 検証観点:
 *   1. XML としてパース可能なこと（テスト内の最小 XML パーサで検証。
 *      Node には DOMParser が無く、依存追加はスコープ外のため）。
 *   2. 部材矩形（data-role="part-rect"）個数・配置番号ラベル（data-role="seq-label"）
 *      個数が、Plan の配置数と一致すること。
 *   3. 加工指示図の溝（data-role="groove"）・穴（data-role="hole"）要素数が
 *      part.features の内訳と一致すること。
 *   4. ヘッダ文字列に歩留まり・【採用】の有無が反映されること。
 *   5. bar パネル・sheet パネルの両方でパース・個数検証が通ること。
 *   6. v0.4: ★ 推奨案・（厳密解と一致）・候補X（厳密解）・カット回数（概算）の表記。
 */

import { describe, expect, it } from "vitest";

import type {
  Groove,
  Hole,
  Meta,
  Part,
  Project,
  Settings,
  Stock,
} from "../../src/core/types";
import type {
  PartInstance,
  Placement1D,
  Placement2D,
  Plan,
  StockUnit,
} from "../../src/core/packing/common";
import { instanceId } from "../../src/core/packing/common";
import type { PlanSummary } from "../../src/core/metrics";
import { circledNumber, renderCutplan } from "../../src/core/render/cutplan";
import { renderPartcard } from "../../src/core/render/partcard";

// ---------------------------------------------------------------------------
// 最小 XML パーサ（テスト用ヘルパ。xml.etree.ElementTree.fromstring 相当の検証）
// ---------------------------------------------------------------------------

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  textContent: string;
}

function parseXml(source: string): XmlNode {
  let i = 0;
  const s = source;

  function fail(msg: string): never {
    throw new Error(`XML parse error at index ${i}: ${msg}`);
  }
  function skipWs(): void {
    while (i < s.length && /\s/.test(s[i])) i++;
  }
  function decode(t: string): string {
    if (/&(?!(amp|lt|gt|quot|apos);)/.test(t)) fail("invalid entity");
    const map: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };
    return t.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => map[e]);
  }
  function parseName(): string {
    const m = /^[A-Za-z_][\w.:-]*/.exec(s.slice(i));
    if (!m) fail("invalid name");
    i += m[0].length;
    return m[0];
  }
  function parseElement(): XmlNode {
    if (s[i] !== "<") fail("expected '<'");
    i++;
    const tag = parseName();
    const attrs: Record<string, string> = {};
    for (;;) {
      skipWs();
      if (s[i] === "/") {
        if (s[i + 1] !== ">") fail("malformed self-closing tag");
        i += 2;
        return { tag, attrs, children: [], textContent: "" };
      }
      if (s[i] === ">") {
        i++;
        break;
      }
      const name = parseName();
      if (name in attrs) fail(`duplicate attribute '${name}'`);
      skipWs();
      if (s[i] !== "=") fail("expected '='");
      i++;
      skipWs();
      const quote = s[i];
      if (quote !== '"' && quote !== "'") fail("expected quoted attribute value");
      i++;
      const end = s.indexOf(quote, i);
      if (end < 0) fail("unterminated attribute value");
      const raw = s.slice(i, end);
      if (raw.includes("<")) fail("'<' in attribute value");
      attrs[name] = decode(raw);
      i = end + 1;
    }
    const children: XmlNode[] = [];
    let textContent = "";
    for (;;) {
      if (i >= s.length) fail("unexpected EOF (unclosed element)");
      if (s[i] === "<") {
        if (s[i + 1] === "/") {
          i += 2;
          const closing = parseName();
          if (closing !== tag) fail(`mismatched closing tag </${closing}> for <${tag}>`);
          skipWs();
          if (s[i] !== ">") fail("expected '>' after closing tag");
          i++;
          return { tag, attrs, children, textContent };
        }
        children.push(parseElement());
      } else {
        const next = s.indexOf("<", i);
        if (next < 0) fail("unexpected EOF in text content");
        textContent += decode(s.slice(i, next));
        i = next;
      }
    }
  }

  if (s.startsWith("<?xml")) {
    const end = s.indexOf("?>");
    if (end < 0) fail("unterminated XML declaration");
    i = end + 2;
  }
  skipWs();
  const root = parseElement();
  skipWs();
  if (i !== s.length) fail("trailing content after root element");
  return root;
}

function* iterNodes(node: XmlNode): Generator<XmlNode> {
  yield node;
  for (const child of node.children) {
    yield* iterNodes(child);
  }
}

/** data-role 属性が一致する要素を列挙する（tag 指定時はさらに絞り込む）。 */
function findByRole(root: XmlNode, role: string, tag?: string): XmlNode[] {
  const result: XmlNode[] = [];
  for (const el of iterNodes(root)) {
    if (tag !== undefined && el.tag !== tag) continue;
    if (el.attrs["data-role"] === role) result.push(el);
  }
  return result;
}

function headerTexts(root: XmlNode): string[] {
  return findByRole(root, "header", "text").map((el) => el.textContent);
}

// ---------------------------------------------------------------------------
// fixture ヘルパ
// ---------------------------------------------------------------------------

function makeSettings(selectedPlan: string | null): Settings {
  return {
    kerf: 3.0,
    edgeTrim: 5.0,
    candidates: 3,
    rank: ["cost", "waste", "cuts"],
    exact: "auto",
    selectedPlan,
  };
}

function makeProject(settings: Settings, stocks: Stock[], parts: Part[]): Project {
  const meta: Meta = { project: "テスト棚", units: "mm", schemaVersion: "0.2" };
  return { meta, settings, stocks, parts };
}

function makeBarPart(id: string, label: string, qty: number, length: number): Part {
  return {
    id,
    label,
    qty,
    stock: "1x4-6f",
    length,
    width: null,
    rot: true,
    features: [],
  };
}

/** bar 原材1本に部材3個（shelf-0#1, shelf-0#2, shelf-1#1）を配置した Plan。 */
function makeBarPlanAndProject(selectedPlan: string | null): [Plan, Project] {
  const settings = makeSettings(selectedPlan);
  const stock: Stock = {
    id: "1x4-6f",
    label: "1×4材 6F",
    kind: "bar",
    length: 1820,
    width: 89,
    thickness: 19,
    price: 382,
  };
  const partA = makeBarPart("shelf-0", "棚板0", 2, 600);
  const partB = makeBarPart("shelf-1", "棚板1", 1, 500);
  const project = makeProject(settings, [stock], [partA, partB]);

  const instA1: PartInstance = { part: partA, index: 1 };
  const instA2: PartInstance = { part: partA, index: 2 };
  const instB1: PartInstance = { part: partB, index: 1 };

  const placements: Placement1D[] = [
    { instance: instA1, start: 5.0 },
    { instance: instA2, start: 608.0 },
    { instance: instB1, start: 1211.0 },
  ];
  const unit: StockUnit = { stock, index: 1, placements };
  const seq: Record<string, number> = {
    [instanceId(instA1)]: 1,
    [instanceId(instA2)]: 2,
    [instanceId(instB1)]: 3,
  };
  const plan: Plan = { id: "A", method1d: "ffd", method2d: "bssf", units: [unit], seq };
  return [plan, project];
}

function makeBarSummary(): PlanSummary {
  return {
    id: "A",
    method: { "1d": "ffd", "2d": "maxrects-bssf" },
    stocks: [
      {
        stockId: "1x4-6f",
        kind: "bar",
        count: 1,
        unitPrice: 382,
        subtotal: 382,
        yield: 0.9374,
        cutCount: 4,
        units: [],
      },
    ],
    totals: {
      cost: 382,
      costComplete: true,
      yield: 0.9374,
      cutCount: 4,
      stockCounts: { "1x4-6f": 1 },
    },
  };
}

/** sheet 原材1枚に部材2個（回転あり・なし各1）を配置した Plan。 */
function makeSheetPlanAndProject(selectedPlan: string | null): [Plan, Project] {
  const settings = makeSettings(selectedPlan);
  const stock: Stock = {
    id: "ply-12",
    label: "合板12mm",
    kind: "sheet",
    length: 910,
    width: 605,
    thickness: 12,
    price: 3000,
  };
  const part: Part = {
    id: "side-0",
    label: "側板0",
    qty: 2,
    stock: "ply-12",
    length: 300,
    width: 200,
    rot: true,
    features: [],
  };
  const project = makeProject(settings, [stock], [part]);

  const inst1: PartInstance = { part, index: 1 };
  const inst2: PartInstance = { part, index: 2 };

  const placements: Placement2D[] = [
    { instance: inst1, x: 5.0, y: 5.0, rotated: false },
    { instance: inst2, x: 308.0, y: 5.0, rotated: true },
  ];
  const unit: StockUnit = { stock, index: 1, placements };
  const seq: Record<string, number> = {
    [instanceId(inst1)]: 1,
    [instanceId(inst2)]: 2,
  };
  const plan: Plan = { id: "B", method1d: "bfd", method2d: "baf", units: [unit], seq };
  return [plan, project];
}

function makeSheetSummary(): PlanSummary {
  return {
    id: "B",
    method: { "1d": "bfd", "2d": "maxrects-baf" },
    stocks: [
      {
        stockId: "ply-12",
        kind: "sheet",
        count: 1,
        unitPrice: 3000,
        subtotal: 3000,
        yield: 0.217,
        cutCount: 8,
        units: [],
      },
    ],
    totals: {
      cost: 3000,
      costComplete: true,
      yield: 0.217,
      cutCount: 8,
      stockCounts: { "ply-12": 1 },
    },
  };
}

function makePartWithFeatures(): [Part, Stock] {
  const stock: Stock = {
    id: "pine-18",
    label: "パイン集成材18mm",
    kind: "sheet",
    length: 1820,
    width: 910,
    thickness: 18,
    price: 6356,
  };
  const groove1: Groove = {
    type: "groove",
    face: "front",
    dir: "across",
    pos: 300,
    width: 7,
    depth: 6,
    end: "through",
    from: null,
    to: null,
  };
  const groove2: Groove = {
    type: "groove",
    face: "back",
    dir: "along",
    pos: 100,
    width: 5,
    depth: 4,
    end: "stopped",
    from: 50,
    to: 400,
  };
  const hole1: Hole = { type: "hole", face: "front", x: 200, y: 150, dia: 4, depth: 8 };
  const hole2: Hole = {
    type: "hole",
    face: "front",
    x: 1000,
    y: 50,
    dia: 6,
    depth: null,
  };
  const part: Part = {
    id: "side-0",
    label: "側板0",
    qty: 1,
    stock: "pine-18",
    length: 1200,
    width: 200,
    rot: false,
    features: [groove1, groove2, hole1, hole2],
  };
  return [part, stock];
}

// ---------------------------------------------------------------------------
// renderCutplan
// ---------------------------------------------------------------------------

describe("renderCutplan (bar)", () => {
  it("bar パネルがパース可能で、要素個数が配置と一致する", () => {
    const [plan, project] = makeBarPlanAndProject("A");
    const svgText = renderCutplan(plan, project, makeBarSummary());

    const root = parseXml(svgText); // パース可能なこと

    const partRects = findByRole(root, "part-rect", "rect");
    const seqLabels = findByRole(root, "seq-label", "text");
    const partDims = findByRole(root, "part-dims", "text");

    expect(partRects).toHaveLength(3);
    expect(seqLabels).toHaveLength(3);
    // 3枚とも矩形が十分大きいスケールになっているため寸法ラベルも出る想定。
    expect(partDims).toHaveLength(3);

    // SPECS §6: 各部材矩形に部材 ID・ラベル・寸法を記入。
    // ラベル行は「① shelf-0 棚板0」形式で id と label を併記する。
    const labelTexts = seqLabels.map((el) => el.textContent);
    expect(
      labelTexts.filter((t) => t.includes("shelf-0") && t.includes("棚板0")),
    ).toHaveLength(2);
    expect(
      labelTexts.filter((t) => t.includes("shelf-1") && t.includes("棚板1")),
    ).toHaveLength(1);

    // kerf 帯: 3配置の隣接ペアは2組。
    expect(findByRole(root, "kerf-band", "rect")).toHaveLength(2);

    // edgeTrim 域: 1D は先端・末尾の2枚のみ。
    expect(findByRole(root, "edge-trim", "rect")).toHaveLength(2);

    // 残長（端材）: stock.length(1820) - edgeTrim(5) - E(1711) = 104mm > 0。
    expect(findByRole(root, "remnant", "rect")).toHaveLength(1);
  });

  it("ヘッダに歩留まりが出て、採用案には【採用】が付く", () => {
    const [plan, project] = makeBarPlanAndProject("A");
    const svgText = renderCutplan(plan, project, makeBarSummary());
    const root = parseXml(svgText);

    const headers = headerTexts(root);
    expect(headers).toHaveLength(1);
    const header = headers[0];
    expect(header).toContain("歩留まり");
    expect(header).toContain("案A");
    expect(header).toContain("【採用】");
  });

  it("selectedPlan が null のとき【採用】が付かない", () => {
    const [plan, project] = makeBarPlanAndProject(null);
    const svgText = renderCutplan(plan, project, makeBarSummary());
    const root = parseXml(svgText);

    const header = headerTexts(root)[0];
    expect(header).toContain("歩留まり");
    expect(header).not.toContain("【採用】");
  });

  it("別案が採用されているとき【採用】が付かない", () => {
    const [plan, project] = makeBarPlanAndProject("B"); // 別案が採用
    const svgText = renderCutplan(plan, project, makeBarSummary());
    const root = parseXml(svgText);

    expect(headerTexts(root)[0]).not.toContain("【採用】");
  });
});

describe("renderCutplan (sheet)", () => {
  it("sheet パネルがパース可能で、要素個数が配置と一致する", () => {
    const [plan, project] = makeSheetPlanAndProject("B");
    const svgText = renderCutplan(plan, project, makeSheetSummary());

    const root = parseXml(svgText);

    const partRects = findByRole(root, "part-rect", "rect");
    const seqLabels = findByRole(root, "seq-label", "text");

    expect(partRects).toHaveLength(2);
    expect(seqLabels).toHaveLength(2);

    // SPECS §6: 部材矩形に part.label（側板0）が併記されること。
    const labelTexts = seqLabels.map((el) => el.textContent);
    expect(
      labelTexts.filter((t) => t.includes("side-0") && t.includes("側板0")),
    ).toHaveLength(2);

    // 2D の kerf 帯: 部材ごとに右・上の2本 = 4本。
    expect(findByRole(root, "kerf-band", "rect")).toHaveLength(4);

    // 2D の edgeTrim 域: 長さ方向2枚 + 幅方向2枚 = 4枚。
    expect(findByRole(root, "edge-trim", "rect")).toHaveLength(4);

    const header = headerTexts(root)[0];
    expect(header).toContain("歩留まり");
    expect(header).toContain("【採用】");
  });
});

// ---------------------------------------------------------------------------
// renderCutplan v0.4 追加要件（★ 推奨案・厳密解・カット回数（概算））
// ---------------------------------------------------------------------------

describe("renderCutplan v0.4 header", () => {
  it("recommended === true のとき案タイトルに「★ 推奨案」が付く", () => {
    const [plan, project] = makeBarPlanAndProject(null);
    const summary = { ...makeBarSummary(), rank: 1, recommended: true };
    const root = parseXml(renderCutplan(plan, project, summary));

    const header = headerTexts(root)[0];
    expect(header).toContain("案A ★ 推奨案");
    expect(header).not.toContain("（厳密解と一致）");
  });

  it("recommended が無い（undefined/false）とき ★ 表記は付かない", () => {
    const [plan, project] = makeBarPlanAndProject(null);
    for (const summary of [
      makeBarSummary(),
      { ...makeBarSummary(), rank: 2, recommended: false },
    ]) {
      const root = parseXml(renderCutplan(plan, project, summary));
      expect(headerTexts(root)[0]).not.toContain("★ 推奨案");
    }
  });

  it("recommended かつ exactMatch のとき「（厳密解と一致）」が付記される", () => {
    const [plan, project] = makeBarPlanAndProject(null);
    const summary = {
      ...makeBarSummary(),
      rank: 1,
      recommended: true,
      exactMatch: true,
    };
    const root = parseXml(renderCutplan(plan, project, summary));

    expect(headerTexts(root)[0]).toContain("案A ★ 推奨案（厳密解と一致）");
  });

  it("exactMatch のみでも「（厳密解と一致）」が付記される", () => {
    const [plan, project] = makeBarPlanAndProject(null);
    const summary = { ...makeBarSummary(), exactMatch: true };
    const root = parseXml(renderCutplan(plan, project, summary));

    const header = headerTexts(root)[0];
    expect(header).toContain("案A（厳密解と一致）");
    expect(header).not.toContain("★ 推奨案");
  });

  it("plan.id === 'X' の案はタイトルが「候補X（厳密解）」になる", () => {
    const [planA, project] = makeBarPlanAndProject(null);
    const plan: Plan = { ...planA, id: "X", method1d: "exact", method2d: "exact" };
    const summary = { ...makeBarSummary(), id: "X" };
    const root = parseXml(renderCutplan(plan, project, summary));

    const header = headerTexts(root)[0];
    expect(header).toContain("候補X（厳密解）");
    expect(header).not.toContain("案X");
  });

  it("sheet を含む案はカット回数が「カット回数（概算）」表記になる", () => {
    const [plan, project] = makeSheetPlanAndProject(null);
    const root = parseXml(renderCutplan(plan, project, makeSheetSummary()));

    expect(headerTexts(root)[0]).toContain("カット回数（概算） 8");
  });

  it("bar のみの案は従来どおり「カット回数」表記（（概算）なし）", () => {
    const [plan, project] = makeBarPlanAndProject(null);
    const root = parseXml(renderCutplan(plan, project, makeBarSummary()));

    const header = headerTexts(root)[0];
    expect(header).toContain("カット回数 4");
    expect(header).not.toContain("カット回数（概算）");
  });
});

// ---------------------------------------------------------------------------
// renderPartcard
// ---------------------------------------------------------------------------

describe("renderPartcard", () => {
  it("フィーチャの要素個数が features の内訳と一致する", () => {
    const [part, stock] = makePartWithFeatures();
    const svgText = renderPartcard(part, stock);

    const root = parseXml(svgText); // パース可能なこと

    const grooves = findByRole(root, "groove");
    const holes = findByRole(root, "hole");
    const holeMarks = findByRole(root, "hole-center-mark", "line");

    expect(grooves).toHaveLength(2);
    expect(holes).toHaveLength(2);
    // 貫通穴は1個（dia=6, depth=null）のため十字マークは2本（横・縦）。
    expect(holeMarks).toHaveLength(2);

    const headers = headerTexts(root);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain("side-0");
    expect(headers[0]).toContain("側板0");
    expect(headers[0]).not.toContain("配置");
  });

  it("seqLabels 指定時にヘッダへ配置番号行が出る", () => {
    const [part, stock] = makePartWithFeatures();
    const svgText = renderPartcard(part, stock, { seqLabels: [1, 3], planId: "A" });

    const root = parseXml(svgText);
    const headers = headerTexts(root);

    expect(headers).toHaveLength(2);
    expect(headers[1]).toContain("配置: 案A");
    expect(headers[1]).toContain("①");
    expect(headers[1]).toContain("③");
  });

  it("溝の face が front/back で描き分けられる", () => {
    const [part, stock] = makePartWithFeatures();
    const svgText = renderPartcard(part, stock);
    const root = parseXml(svgText);

    const grooves = findByRole(root, "groove");
    const faces = new Set(grooves.map((el) => el.attrs["data-face"]));
    expect(faces).toEqual(new Set(["front", "back"]));
  });

  // S-07: 丸穴の加工面が図（破線区別）にも注記にも反映されること。
  it("丸穴の face が front/back で破線描き分けされ、注記に面が含まれる", () => {
    const stock: Stock = {
      id: "pine-18",
      label: "パイン集成材18mm",
      kind: "sheet",
      length: 1820,
      width: 910,
      thickness: 18,
      price: 6356,
    };
    const holeFront: Hole = { type: "hole", face: "front", x: 100, y: 100, dia: 4, depth: 8 };
    const holeBack: Hole = { type: "hole", face: "back", x: 500, y: 100, dia: 6, depth: 5 };
    const part: Part = {
      id: "side-1",
      label: "側板1",
      qty: 1,
      stock: "pine-18",
      length: 1200,
      width: 200,
      rot: false,
      features: [holeFront, holeBack],
    };

    const svgText = renderPartcard(part, stock);
    const root = parseXml(svgText);

    const holes = findByRole(root, "hole", "circle");
    expect(holes).toHaveLength(2);

    const frontHole = holes.find((el) => el.attrs["data-face"] === "front");
    const backHole = holes.find((el) => el.attrs["data-face"] === "back");
    expect(frontHole).toBeDefined();
    expect(backHole).toBeDefined();

    // face=front は実線（stroke-dasharray 属性なし）。
    expect(frontHole!.attrs["stroke-dasharray"]).toBeUndefined();
    // face=back は溝の隠れ線規約と同一の破線属性を持つ。
    expect(backHole!.attrs["stroke-dasharray"]).toBe("5,3");

    const annotations = findByRole(root, "annotation", "text").map((el) => el.textContent);
    expect(annotations.some((t) => t.includes("Φ4") && t.includes("（表面）"))).toBe(true);
    expect(annotations.some((t) => t.includes("Φ6") && t.includes("（裏面）"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// circledNumber
// ---------------------------------------------------------------------------

describe("circledNumber", () => {
  it("境界値（1・20・21）", () => {
    expect(circledNumber(1)).toBe("①");
    expect(circledNumber(20)).toBe("⑳");
    expect(circledNumber(21)).toBe("(21)");
  });
});

// ---------------------------------------------------------------------------
// フォント指定（PNG 変換時の日本語判読性）
// ---------------------------------------------------------------------------

describe("CJK font family", () => {
  it("ルート svg に CJK 対応の font-family が付与される", () => {
    // PNG 変換時に日本語が豆腐化しないための担保。
    const [plan, project] = makeBarPlanAndProject(null);
    const [part, stock] = makePartWithFeatures();
    for (const svgText of [
      renderCutplan(plan, project, makeBarSummary()),
      renderPartcard(part, stock),
    ]) {
      const root = parseXml(svgText);
      const fontFamily = root.attrs["font-family"] ?? "";
      expect(fontFamily).not.toBe("");
      expect(fontFamily).toContain("Noto Sans CJK JP");
      expect(fontFamily).toContain("sans-serif");
    }
  });
});
