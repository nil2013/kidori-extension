/**
 * render/dimension.ts・render/svgdoc.ts の単体テスト
 * （Python 版 tests/test_dimension.py の移植）。
 *
 * 必須観点:
 *   - チェーン寸法: Σ区間 == 全長（許容差 1e-6）
 *   - 溝2本＋穴1個の抽出点数と順序
 *   - 0.01mm 未満の近接点デデュープ
 *   - 特徴なし部材 → 全長寸法のみ
 *   - svgdoc の基本テスト（生成 SVG が XML としてパース可能、座標変換の既知値）
 *
 * XML パース検証はテスト内の最小 XML パーサで行う（Node には DOMParser が無く、
 * 依存追加はスコープ外のため）。
 */

import { describe, expect, it } from "vitest";

import type { Groove, Hole, Part, ResolvedMark, Stock } from "../../src/core/types";
import {
  ChainSegment,
  DimensionStyle,
  DEFAULT_DIMENSION_STYLE,
  buildChainSegments,
  computeLabelPlacement,
  dedupeSorted,
  estimatedLabelWidth,
  extractChainPoints,
  formatDimensionValue,
  renderAxisChain,
  renderPartDimensions,
} from "../../src/core/render/dimension";
import {
  CoordTransform,
  SvgDocument,
  circle,
  g,
  line,
  path,
  pattern,
  rect,
  text,
} from "../../src/core/render/svgdoc";

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

function findAll(root: XmlNode, tag: string): XmlNode[] {
  const result: XmlNode[] = [];
  for (const el of iterNodes(root)) {
    if (el.tag === tag) result.push(el);
  }
  return result;
}

// ---------------------------------------------------------------------------
// テスト用フィクスチャ相当（直接構築）
// ---------------------------------------------------------------------------

function makeSheetStock(overrides: Partial<Stock> = {}): Stock {
  return {
    id: "pine-18",
    label: "パイン集成材18mm",
    kind: "sheet",
    length: 1820,
    width: 910,
    thickness: 18,
    price: 6356,
    ...overrides,
  };
}

function makeBarStock(overrides: Partial<Stock> = {}): Stock {
  return {
    id: "1x4-6f",
    label: "1×4材 6F",
    kind: "bar",
    length: 1820,
    width: 89,
    thickness: 19,
    price: 382,
    ...overrides,
  };
}

function makePart(overrides: Partial<Part> = {}): Part {
  return {
    id: "side-0",
    label: "側板0",
    qty: 1,
    stock: "pine-18",
    length: 1985,
    width: 200,
    rot: false,
    features: [],
    ...overrides,
  };
}

function makeGroove(overrides: Partial<Groove> = {}): Groove {
  return {
    type: "groove",
    face: "front",
    dir: "across",
    pos: 248,
    width: 7,
    depth: 6,
    end: "through",
    from: null,
    to: null,
    ...overrides,
  };
}

function makeHole(overrides: Partial<Hole> = {}): Hole {
  return {
    type: "hole",
    face: "front",
    x: 100,
    y: 320,
    dia: 4,
    depth: 8,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 対象点抽出（extractChainPoints）
// ---------------------------------------------------------------------------

describe("extractChainPoints", () => {
  it("特徴なし部材 → 全長のみ（対象点は {0, L} / {0, W} だけ）", () => {
    const stock = makeSheetStock();
    const part = makePart({ length: 1985, width: 200, features: [] });
    const [xs, ys] = extractChainPoints(part, stock);
    expect(xs).toEqual([0.0, 1985.0]);
    expect(ys).toEqual([0.0, 200.0]);
  });

  it("溝2本（across/along 各1）＋穴1個の抽出点数・順序", () => {
    const stock = makeSheetStock();
    const features = [
      makeGroove({ dir: "across", pos: 248 }),
      makeGroove({ dir: "along", pos: 50 }),
      makeHole({ x: 100, y: 320 }),
    ];
    const part = makePart({ length: 1985, width: 400, features });
    const [xs, ys] = extractChainPoints(part, stock);
    // X軸: {0, 1985} ∪ {across溝中心 248} ∪ {穴x 100} → 昇順4点
    expect(xs).toEqual([0.0, 100.0, 248.0, 1985.0]);
    // Y軸: {0, 400} ∪ {along溝中心 50} ∪ {穴y 320} → 昇順4点
    expect(ys).toEqual([0.0, 50.0, 320.0, 400.0]);
  });

  it("0.01mm 未満の近接点はデデュープされ1点に統合される", () => {
    const stock = makeSheetStock();
    const features = [
      makeGroove({ pos: 248.0 }),
      makeHole({ x: 248.005, y: 100 }), // 差 0.005mm
    ];
    const part = makePart({ length: 1985, width: 200, features });
    const [xs] = extractChainPoints(part, stock);
    expect(xs).toEqual([0.0, 248.0, 1985.0]);
  });

  it("0.01mm を超える差の点は別点として残る（デデュープの境界確認）", () => {
    const stock = makeSheetStock();
    const features = [
      makeGroove({ pos: 248.0 }),
      makeHole({ x: 248.02, y: 100 }), // 差 0.02mm
    ];
    const part = makePart({ length: 1985, width: 200, features });
    const [xs] = extractChainPoints(part, stock);
    expect(xs).toEqual([0.0, 248.0, 248.02, 1985.0]);
  });

  it("bar 部材では Y軸の全長が effectiveWidth（=stock.width）になる", () => {
    const stock = makeBarStock(); // width=89
    const part = makePart({ stock: "1x4-6f", length: 1820, width: null, features: [] });
    const [xs, ys] = extractChainPoints(part, stock);
    expect(xs).toEqual([0.0, 1820.0]);
    expect(ys).toEqual([0.0, 89.0]);
  });

  // S-08: 止め溝（end="stopped"）は走行方向軸に from/to が対象点として追加される。
  it("dir=across の止め溝は走行方向（Y軸）に from/to が追加される", () => {
    const stock = makeSheetStock();
    const groove = makeGroove({
      dir: "across",
      pos: 248,
      end: "stopped",
      from: 30,
      to: 170,
    });
    const part = makePart({ length: 1985, width: 200, features: [groove] });
    const [xs, ys] = extractChainPoints(part, stock);
    // X軸: pos(248) は従来どおり対象点。
    expect(xs).toEqual([0.0, 248.0, 1985.0]);
    // Y軸: 走行方向の from/to が追加される。
    expect(ys).toEqual([0.0, 30.0, 170.0, 200.0]);
  });

  it("dir=along の止め溝は走行方向（X軸）に from/to が追加される", () => {
    const stock = makeSheetStock();
    const groove = makeGroove({
      dir: "along",
      pos: 100,
      end: "stopped",
      from: 50,
      to: 400,
    });
    const part = makePart({ length: 1985, width: 200, features: [groove] });
    const [xs, ys] = extractChainPoints(part, stock);
    // X軸: 走行方向の from/to が追加される。
    expect(xs).toEqual([0.0, 50.0, 400.0, 1985.0]);
    // Y軸: pos(100) は従来どおり対象点。
    expect(ys).toEqual([0.0, 100.0, 200.0]);
  });

  it("end=through の溝は from/to を持たず、走行方向軸に余分な対象点が現れない", () => {
    const stock = makeSheetStock();
    const groove = makeGroove({ dir: "across", pos: 248, end: "through" });
    const part = makePart({ length: 1985, width: 200, features: [groove] });
    const [xs, ys] = extractChainPoints(part, stock);
    expect(xs).toEqual([0.0, 248.0, 1985.0]);
    // 走行方向（Y軸）は {0, W} のみ。
    expect(ys).toEqual([0.0, 200.0]);
  });
});

// ---------------------------------------------------------------------------
// 非切削マーク（marks）由来の対象点（SPECS.md §4c:215）
// ---------------------------------------------------------------------------

function makeMark(overrides: Partial<ResolvedMark> = {}): ResolvedMark {
  return {
    on: "beam-top",
    face: "front",
    x: 50,
    y: 0,
    w: 38,
    h: 89,
    ref: null,
    note: null,
    ...overrides,
  };
}

describe("extractChainPoints（marks）", () => {
  it("マークの端と中心の両方 {x, x+w/2, x+w} / {y, y+h/2, y+h} を拾う", () => {
    const stock = makeSheetStock();
    const part = makePart({ length: 1000, width: 200, features: [] });
    const mark = makeMark({ x: 100, y: 20, w: 40, h: 60 });
    const [xs, ys] = extractChainPoints(part, stock, [mark]);
    // X軸: {0, 1000} ∪ {100, 120, 140}
    expect(xs).toEqual([0.0, 100.0, 120.0, 140.0, 1000.0]);
    // Y軸: {0, 200} ∪ {20, 50, 80}
    expect(ys).toEqual([0.0, 20.0, 50.0, 80.0, 200.0]);
  });

  it("第3引数を省略すると従来の抽出結果と完全に一致する", () => {
    const stock = makeSheetStock();
    const features = [makeGroove({ dir: "across", pos: 248 }), makeHole()];
    const part = makePart({ length: 1985, width: 400, features });
    expect(extractChainPoints(part, stock)).toEqual(
      extractChainPoints(part, stock, []),
    );
  });

  it("マークが部材端に接する場合、端点とデデュープされて重複しない", () => {
    const stock = makeSheetStock();
    const part = makePart({ length: 1000, width: 100, features: [] });
    // y=0・h=100 は部材面の全高に一致する（ウマの足当たり面の典型）。
    const mark = makeMark({ x: 0, y: 0, w: 200, h: 100 });
    const [xs, ys] = extractChainPoints(part, stock, [mark]);
    expect(xs).toEqual([0.0, 100.0, 200.0, 1000.0]);
    expect(ys).toEqual([0.0, 50.0, 100.0]);
  });

  it("部材面をはみ出すマークの点は寸法チェーンに入れない（全長寸法を守る）", () => {
    const stock = makeSheetStock();
    const part = makePart({ length: 1000, width: 200, features: [] });
    // x=960 / w=100 → 右端 1060 は部材長 1000 を超える。中心 1010 も範囲外。
    const mark = makeMark({ x: 960, y: -10, w: 100, h: 40 });
    const [xs, ys] = extractChainPoints(part, stock, [mark]);
    // 範囲内の 960 だけが残り、両端は {0, 1000} のまま。
    expect(xs).toEqual([0.0, 960.0, 1000.0]);
    expect(xs[0]).toBe(0.0);
    expect(xs[xs.length - 1]).toBe(part.length);
    // Y軸: -10 は範囲外、中心 10 と上端 30 は範囲内。
    expect(ys).toEqual([0.0, 10.0, 30.0, 200.0]);
  });

  it("複数マークの点をすべて拾う", () => {
    const stock = makeSheetStock();
    const part = makePart({ length: 1000, width: 200, features: [] });
    const marks = [
      makeMark({ x: 100, y: 0, w: 40, h: 200 }),
      makeMark({ x: 800, y: 0, w: 40, h: 200 }),
    ];
    const [xs] = extractChainPoints(part, stock, marks);
    expect(xs).toEqual([0.0, 100.0, 120.0, 140.0, 800.0, 820.0, 840.0, 1000.0]);
  });
});

describe("dedupeSorted", () => {
  it("許容差内の点を統合する", () => {
    expect(dedupeSorted([0.0, 0.005, 10.0])).toEqual([0.0, 10.0]);
  });

  it("許容差を超える点は残す", () => {
    expect(dedupeSorted([0.0, 0.02, 10.0])).toEqual([0.0, 0.02, 10.0]);
  });

  it("順不同の入力をソートする", () => {
    expect(dedupeSorted([10.0, 0.0, 5.0])).toEqual([0.0, 5.0, 10.0]);
  });
});

// ---------------------------------------------------------------------------
// チェーン化（buildChainSegments）と不変条件
// ---------------------------------------------------------------------------

describe("buildChainSegments", () => {
  it("特徴なし: Σ区間 == 全長", () => {
    const points = [0.0, 1985.0];
    const segments = buildChainSegments(points);
    const sum = segments.reduce((acc, seg) => acc + seg.value, 0);
    expect(sum).toBeCloseTo(1985.0, 6);
  });

  it("特徴あり: Σ区間 == 全長（許容差 1e-6）", () => {
    const stock = makeSheetStock();
    const features = [
      makeGroove({ pos: 248 }),
      makeGroove({ pos: 486 }),
      makeHole({ x: 724, y: 100 }),
    ];
    const part = makePart({ length: 1985, width: 200, features });
    const [xs] = extractChainPoints(part, stock);
    const segments = buildChainSegments(xs);
    const total = xs[xs.length - 1] - xs[0];
    expect(total).toBeCloseTo(1985.0, 6);
    const sum = segments.reduce((acc, seg) => acc + seg.value, 0);
    expect(sum).toBeCloseTo(total, 6);
  });

  it("区間値・ラベルが隣接差分になる", () => {
    const segments = buildChainSegments([0.0, 100.0, 248.0, 1985.0]);
    const values = segments.map((seg) => seg.value);
    expect(values).toHaveLength(3);
    expect(values[0]).toBeCloseTo(100.0, 6);
    expect(values[1]).toBeCloseTo(148.0, 6);
    expect(values[2]).toBeCloseTo(1737.0, 6);
    expect(segments.map((seg) => seg.label)).toEqual(["100", "148", "1737"]);
  });
});

describe("ChainSegment", () => {
  it("直接構築できる", () => {
    const seg: ChainSegment = { start: 0.0, end: 100.0, value: 100.0, label: "100" };
    expect([seg.start, seg.end, seg.value, seg.label]).toEqual([0.0, 100.0, 100.0, "100"]);
  });
});

// ---------------------------------------------------------------------------
// ラベル文字列化・被り回避（純粋計算部）
// ---------------------------------------------------------------------------

describe("formatDimensionValue", () => {
  it("整数値は整数表記", () => {
    expect(formatDimensionValue(600.0)).toBe("600");
  });

  it("小数は1桁表記", () => {
    expect(formatDimensionValue(248.5)).toBe("248.5");
  });

  it("浮動小数の丸め誤差は整数として扱う", () => {
    expect(formatDimensionValue(599.9999999998)).toBe("600");
  });

  it("真の小数は整数に丸めない", () => {
    expect(formatDimensionValue(0.4)).toBe("0.4");
  });
});

describe("estimatedLabelWidth", () => {
  it("式 0.62 × fontSize × 文字数 と一致する", () => {
    expect(estimatedLabelWidth("600", 10.0)).toBeCloseTo(0.62 * 10.0 * 3, 9);
  });
});

describe("computeLabelPlacement", () => {
  it("広い区間は通常位置（0）", () => {
    const segments = buildChainSegments([0.0, 100.0]);
    const placements = computeLabelPlacement(segments, 1.0, 10.0);
    expect(placements).toEqual([0]);
  });

  it("狭い区間は反対側（1）へ逃がす", () => {
    // 区間3mm・scale=1 → 描画幅3px。ラベル"3"の推定幅 = 0.62*10*1 = 6.2px > 3px → 狭区間
    const segments = buildChainSegments([0.0, 3.0]);
    const placements = computeLabelPlacement(segments, 1.0, 10.0);
    expect(placements).toEqual([1]);
  });

  it("狭区間が連続する場合は交互にスタガする", () => {
    const segments = buildChainSegments([0.0, 3.0, 6.0, 9.0]);
    const placements = computeLabelPlacement(segments, 1.0, 10.0);
    expect(placements[0]).toBe(1);
    expect(placements[1]).not.toBe(placements[0]);
    expect(placements[2]).not.toBe(placements[1]);
  });
});

// ---------------------------------------------------------------------------
// svgdoc.ts の基本テスト
// ---------------------------------------------------------------------------

describe("SvgDocument rendering", () => {
  it("生成した文書が XML としてパース可能", () => {
    const doc = new SvgDocument(100, 50);
    doc.add(rect(0, 0, 10, 10, { fill: "red" }));
    doc.add(line(0, 0, 10, 10, { stroke: "black" }));
    doc.add(circle(5, 5, 2));
    doc.add(text(1, 1, "テスト & <特殊文字>"));
    doc.add(g([path("M0 0 L10 10")]));
    const rendered = doc.render();
    const root = parseXml(rendered);
    expect(root.tag).toBe("svg");
    expect(root.attrs["viewBox"]).toBe("0 0 100 50");
    expect(root.attrs["width"]).toBe("100");
    expect(root.attrs["height"]).toBe("50");
  });

  it("pattern 要素が子要素付きで描画される", () => {
    const hatch = pattern("hatch", 4, 4, [line(0, 0, 4, 4, { stroke: "gray" })], {
      patternUnits: "userSpaceOnUse",
    });
    const doc = new SvgDocument(10, 10);
    doc.add(g([hatch]));
    const root = parseXml(doc.render());
    const patterns = findAll(root, "pattern");
    expect(patterns).toHaveLength(1);
    expect(patterns[0].attrs["id"]).toBe("hatch");
    expect(patterns[0].children.some((c) => c.tag === "line")).toBe(true);
  });

  it("属性値がエスケープされる", () => {
    const el = rect(0, 0, 1, 1, { data_label: 'He said "hi" & <bye>' });
    const rendered = el.render();
    expect(rendered).toContain("&quot;");
    expect(rendered).toContain("&amp;");
    expect(rendered).toContain("&lt;");
    // ハイフン変換: data_label -> data-label
    expect(rendered).toContain("data-label=");
  });

  it("テキストノードがエスケープされる", () => {
    const el = text(0, 0, "A & B < C");
    const rendered = el.render();
    expect(rendered).toContain("A &amp; B &lt; C");
  });

  it("float 属性は末尾の 0 を削って整形される", () => {
    const el = rect(1.5, 2.0, 10.1, 3.0);
    const rendered = el.render();
    expect(rendered).toContain('x="1.5"');
    expect(rendered).toContain('y="2"');
    expect(rendered).toContain('width="10.1"');
    expect(rendered).toContain('height="3"');
  });
});

describe("CoordTransform", () => {
  it("point は Y 反転とスケール・オフセットを適用する", () => {
    const tr = new CoordTransform({
      scale: 2.0,
      localHeight: 100.0,
      offsetX: 10.0,
      offsetY: 5.0,
    });
    // ローカル (0, 0)（左下）→ SVG では最も下（offsetY + localHeight*scale）
    const [sx, sy] = tr.point(0.0, 0.0);
    expect(sx).toBeCloseTo(10.0, 9);
    expect(sy).toBeCloseTo(5.0 + 100.0 * 2.0, 9);
    // ローカル (0, 100)（左上）→ SVG では最も上（offsetY）
    const [sx2, sy2] = tr.point(0.0, 100.0);
    expect(sx2).toBeCloseTo(10.0, 9);
    expect(sy2).toBeCloseTo(5.0, 9);
  });

  it("length はオフセット・反転なしでスケールのみ適用する", () => {
    const tr = new CoordTransform({ scale: 0.5, localHeight: 100.0 });
    expect(tr.length(600.0)).toBeCloseTo(300.0, 9);
  });

  it("rect（全高）の既知値", () => {
    const tr = new CoordTransform({ scale: 1.0, localHeight: 89.0 });
    const [sx, sy, sw, sh] = tr.rect(0.0, 0.0, 600.0, 89.0);
    expect(sx).toBeCloseTo(0.0, 9);
    expect(sy).toBeCloseTo(0.0, 9);
    expect(sw).toBeCloseTo(600.0, 9);
    expect(sh).toBeCloseTo(89.0, 9);
  });

  it("rect（部分高）の既知値", () => {
    const tr = new CoordTransform({ scale: 1.0, localHeight: 200.0 });
    // ローカル矩形: 左下(0,0)、幅50・高さ80 → 上端 local y=80 → SVG y = 200-80 = 120
    const [sx, sy, sw, sh] = tr.rect(0.0, 0.0, 50.0, 80.0);
    expect(sx).toBeCloseTo(0.0, 9);
    expect(sy).toBeCloseTo(120.0, 9);
    expect(sw).toBeCloseTo(50.0, 9);
    expect(sh).toBeCloseTo(80.0, 9);
  });
});

// ---------------------------------------------------------------------------
// SVG 描画部（renderAxisChain / renderPartDimensions）のスモークテスト
// ---------------------------------------------------------------------------

describe("renderAxisChain", () => {
  it("全長寸法のみのチェーンが期待どおりの要素数になる", () => {
    const tr = new CoordTransform({ scale: 1.0, localHeight: 200.0 });
    const style: DimensionStyle = { ...DEFAULT_DIMENSION_STYLE, fontSize: 8.0 };
    const el = renderAxisChain([0.0, 1985.0], tr, { axis: "x", levelIndex: 0, style });
    const doc = new SvgDocument(2200, 400);
    doc.add(el);
    const root = parseXml(doc.render());
    const lines = findAll(root, "line");
    const texts = findAll(root, "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].textContent).toBe("1985");
    // 寸法線1 + ティック2 + 補助線(始点・終点)2 = 5
    expect(lines).toHaveLength(5);
  });
});

describe("renderPartDimensions", () => {
  it("特徴なし部材は各軸とも全長寸法1段のみの2グループ", () => {
    const stock = makeSheetStock();
    const part = makePart({ length: 1000, width: 300, features: [] });
    const tr = new CoordTransform({ scale: 0.2, localHeight: 300.0 });
    const el = renderPartDimensions(part, stock, tr);
    // X軸グループ・Y軸グループの2つ
    expect(el.children).toHaveLength(2);
    for (const axisGroup of el.children) {
      // 特徴なしなので各軸は全長寸法の1段のみ
      expect(axisGroup.children).toHaveLength(1);
    }
  });

  it("特徴ありは2段（内側チェーン+全長）になり、文書がパース可能", () => {
    const stock = makeSheetStock();
    const features = [makeGroove({ pos: 248 }), makeHole({ x: 724, y: 100 })];
    const part = makePart({ length: 1985, width: 200, features });
    const tr = new CoordTransform({
      scale: 0.3,
      localHeight: 200.0,
      offsetX: 20.0,
      offsetY: 20.0,
    });
    const el = renderPartDimensions(part, stock, tr);
    expect(el.children).toHaveLength(2);
    for (const axisGroup of el.children) {
      // 特徴ありの軸(X)は内側チェーン+全長=2段、特徴なしの軸(Y)は全長のみ1段
      expect([1, 2]).toContain(axisGroup.children.length);
    }

    const doc = new SvgDocument(700, 700);
    doc.add(el);
    const root = parseXml(doc.render());
    const texts = findAll(root, "text");
    expect(texts.length).toBeGreaterThan(0);
  });
});
