/**
 * 採用後の設計変更による selectedPlan の無効化のテスト（SPECS.md §5）。
 *
 * 構成:
 * - 割付フィンガープリント（対象・除外フィールド、bar width の正規化）
 * - `resolveAdoption` の4状態（null / 記録なし / 一致 / 不一致）
 * - build() 統合: 記録の書き込み・持ち回り・無効化・**自己治癒しないこと**
 *
 * 要諦: 不一致（無効化）時は `adopted` を**元のフィンガープリントのまま**保存する。
 * 現在値で上書きすると、次のビルドで記録が現状と一致してしまい警告が自動的に
 * 消える（＝自己治癒する）。元の値を保つ限り、幾何を採用時点へ戻したときにだけ
 * 再有効化される。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { build, resolveAdoption } from "../../src/core/build";
import type { Issue } from "../../src/core/errors";
import { canonicalJson, layoutFingerprint } from "../../src/core/fingerprint";
import { loadProjectFromRaw } from "../../src/core/loader";
import type { Summary } from "../../src/core/metrics";
import type { Project } from "../../src/core/types";

const silent = (): void => {};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-adopt-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// フィンガープリント
// ---------------------------------------------------------------------------

function projectOf(raw: Record<string, unknown>): Project {
  const { project, issues } = loadProjectFromRaw(raw);
  if (project === null) {
    throw new Error(`検証エラー: ${JSON.stringify(issues)}`);
  }
  return project;
}

function baseRaw(): Record<string, any> {
  return {
    meta: { project: "テスト", units: "mm", schemaVersion: "0.3" },
    settings: { kerf: 3, edgeTrim: 5, candidates: 3, selectedPlan: null },
    stocks: [
      {
        id: "b1",
        label: "棒",
        kind: "bar",
        length: 1820,
        width: 89,
        thickness: 19,
        price: 382,
      },
    ],
    parts: [{ id: "p1", label: "部材", qty: 2, stock: "b1", length: 500 }],
  };
}

/** baseRaw に変更を加えたフィンガープリントを返す。 */
function fpWith(mutate: (raw: Record<string, any>) => void): string {
  const raw = baseRaw();
  mutate(raw);
  return layoutFingerprint(projectOf(raw));
}

describe("canonicalJson", () => {
  it("キー順に依存しない", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("配列順は保持する", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("入れ子のキーもソートする", () => {
    expect(canonicalJson({ x: { b: 1, a: 2 } })).toBe('{"x":{"a":2,"b":1}}');
  });
});

describe("layoutFingerprint: 対象フィールド（変化すべき）", () => {
  const base = layoutFingerprint(projectOf(baseRaw()));

  it("parts の length / qty / stock / rot", () => {
    expect(fpWith((r) => (r.parts[0].length = 501))).not.toBe(base);
    expect(fpWith((r) => (r.parts[0].qty = 3))).not.toBe(base);
    expect(
      fpWith((r) => {
        r.stocks.push({
          id: "b2",
          label: "棒2",
          kind: "bar",
          length: 1820,
          width: 89,
          thickness: 19,
        });
        r.parts[0].stock = "b2";
      }),
    ).not.toBe(base);
  });

  it("parts の id（加工指示図のファイル名かつ配置の同一性）", () => {
    expect(fpWith((r) => (r.parts[0].id = "p9"))).not.toBe(base);
  });

  it("stocks の length / width / kind", () => {
    expect(fpWith((r) => (r.stocks[0].length = 1800))).not.toBe(base);
    // bar の stock.width は部材の実効幅なので、正規化を通じて変化する。
    expect(fpWith((r) => (r.stocks[0].width = 90))).not.toBe(base);
  });

  it("stocks の thickness（配置幾何には効かないが材の同一性として含める）", () => {
    expect(fpWith((r) => (r.stocks[0].thickness = 18))).not.toBe(base);
  });

  it("settings の kerf / edgeTrim", () => {
    expect(fpWith((r) => (r.settings.kerf = 4))).not.toBe(base);
    expect(fpWith((r) => (r.settings.edgeTrim = 6))).not.toBe(base);
  });
});

describe("layoutFingerprint: 除外フィールド（変化すべきでない）", () => {
  const base = layoutFingerprint(projectOf(baseRaw()));

  it("label は表示のみ", () => {
    expect(fpWith((r) => (r.parts[0].label = "別名"))).toBe(base);
    expect(fpWith((r) => (r.stocks[0].label = "別名"))).toBe(base);
  });

  it("price は費用表示のみ（SPECS §8「price は変動が本質」）", () => {
    expect(fpWith((r) => (r.stocks[0].price = 999))).toBe(base);
    expect(fpWith((r) => delete r.stocks[0].price)).toBe(base);
  });

  it("preset は来歴メタデータ", () => {
    expect(fpWith((r) => (r.stocks[0].preset = "spf/1x4/6f"))).toBe(base);
  });

  it("features は毎ビルド再生成され配置に無関係", () => {
    expect(
      fpWith(
        (r) =>
          (r.parts[0].features = [
            { type: "hole", face: "front", x: 100, y: 40, dia: 4, depth: 8 },
          ]),
      ),
    ).toBe(base);
  });

  it("candidates / rank / exact は採用後の配置の妥当性に無関係", () => {
    expect(fpWith((r) => (r.settings.candidates = 1))).toBe(base);
    expect(fpWith((r) => (r.settings.rank = ["cuts", "waste"]))).toBe(base);
    expect(fpWith((r) => (r.settings.exact = "off"))).toBe(base);
  });

  it("selectedPlan 自体は含めない（採用操作でフィンガープリントは動かない）", () => {
    expect(fpWith((r) => (r.settings.selectedPlan = "B"))).toBe(base);
  });
});

describe("layoutFingerprint: bar 部材の正規化", () => {
  it("width 省略と stock.width の明示が同じフィンガープリントになる", () => {
    const omitted = layoutFingerprint(projectOf(baseRaw()));
    const explicit = fpWith((r) => (r.parts[0].width = 89)); // == stocks[0].width
    expect(explicit).toBe(omitted);
  });

  // FIX-A: bar の rot は pack1d が参照せず、loader も warning にして無視する
  //（＝配置を決定しない）。width と同じく「配置を決定する入力のみ」の原則を適用する。
  it("bar 部材の rot を切り替えてもフィンガープリントは変わらない", () => {
    const base = layoutFingerprint(projectOf(baseRaw()));

    expect(fpWith((r) => (r.parts[0].rot = false))).toBe(base);
    expect(fpWith((r) => (r.parts[0].rot = true))).toBe(base);
  });

  it("sheet 部材の rot は配置を決定するので変わる", () => {
    const sheetRaw = (): Record<string, any> => ({
      meta: { project: "テスト", units: "mm", schemaVersion: "0.3" },
      settings: { kerf: 3, edgeTrim: 5, candidates: 3, selectedPlan: null },
      stocks: [
        {
          id: "s1",
          label: "板",
          kind: "sheet",
          length: 1820,
          width: 910,
          thickness: 18,
        },
      ],
      parts: [
        { id: "p1", label: "部材", qty: 2, stock: "s1", length: 500, width: 300 },
      ],
    });

    const withRot = (rot: boolean): string => {
      const raw = sheetRaw();
      raw.parts[0].rot = rot;
      return layoutFingerprint(projectOf(raw));
    };

    expect(withRot(false)).not.toBe(withRot(true));
  });
});

// ---------------------------------------------------------------------------
// resolveAdoption: 4状態
// ---------------------------------------------------------------------------

describe("resolveAdoption（4状態）", () => {
  const FP = "fp-now";

  it("① selectedPlan: null → 全案生成・記録なし", () => {
    const r = resolveAdoption(null, FP, { plan: "B", fingerprint: "old" });
    expect(r.effectiveSelected).toBeNull();
    expect(r.adopted).toBeNull();
    expect(r.stale).toBe(false);
    expect(r.issue).toBeNull();
  });

  it("② 記録なし → 今を採用時点とみなし、現フィンガープリントを記録", () => {
    const r = resolveAdoption("B", FP, null);
    expect(r.effectiveSelected).toBe("B");
    expect(r.adopted).toEqual({ plan: "B", fingerprint: FP });
    expect(r.stale).toBe(false);
    expect(r.issue).toBeNull();
  });

  it("② 別案の記録しかない場合も採用時点を取り直す", () => {
    const r = resolveAdoption("C", FP, { plan: "B", fingerprint: "old" });
    expect(r.effectiveSelected).toBe("C");
    expect(r.adopted).toEqual({ plan: "C", fingerprint: FP });
    expect(r.stale).toBe(false);
  });

  it("③ 記録と一致 → 有効。記録をそのまま持ち回る", () => {
    const prev = { plan: "B", fingerprint: FP };
    const r = resolveAdoption("B", FP, prev);
    expect(r.effectiveSelected).toBe("B");
    expect(r.adopted).toEqual(prev);
    expect(r.stale).toBe(false);
    expect(r.issue).toBeNull();
  });

  it("④ 記録と不一致 → 無効。全案生成＋warning、記録は元のまま保持", () => {
    const prev = { plan: "B", fingerprint: "fp-at-adoption" };
    const r = resolveAdoption("B", FP, prev);

    expect(r.effectiveSelected).toBeNull(); // selectedPlan を無視して全案生成
    expect(r.stale).toBe(true);
    // 元 fp を保持する（現 fp で上書きしない＝自己治癒させない）。
    expect(r.adopted).toEqual(prev);
    expect(r.issue).not.toBeNull();
    expect(r.issue!.path).toBe("settings.selectedPlan");
    expect(r.issue!.severity).toBe("warning");
    expect(r.issue!.message).toContain("選び直");
  });
});

// ---------------------------------------------------------------------------
// build() 統合
// ---------------------------------------------------------------------------

const yaml = (opts: {
  selectedPlan?: string | null;
  length?: number;
  label?: string;
  price?: number;
}): string => `
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
settings: { kerf: 3, edgeTrim: 5, candidates: 3, exact: off, selectedPlan: ${
  opts.selectedPlan === undefined || opts.selectedPlan === null
    ? "null"
    : opts.selectedPlan
} }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19, price: ${
    opts.price ?? 382
  } }
parts:
  - { id: p1, label: ${opts.label ?? "部材"}, qty: 3, stock: b1, length: ${
    opts.length ?? 500
  } }
`;

function writeProject(text: string): string {
  const p = path.join(dir, "project.yaml");
  fs.writeFileSync(p, text, "utf-8");
  return p;
}

function readSummary(outDir: string): Summary {
  return JSON.parse(
    fs.readFileSync(path.join(outDir, "summary.json"), "utf-8"),
  ) as Summary;
}

describe("build（採用案の無効化・SPECS §5）", () => {
  it("selectedPlan: null なら adopted は null", () => {
    const p = writeProject(yaml({ selectedPlan: null }));
    const r = build(p, { png: false, log: silent });

    expect(r.planIds).toEqual(["A", "B", "C"]);
    expect(readSummary(r.outDir).adopted).toBeNull();
    expect(r.summary.selectedPlanStale).toBe(false);
  });

  it("記録が無い初回は今を採用時点として記録し、採用案のみ生成する", () => {
    const p = writeProject(yaml({ selectedPlan: "B" }));
    const r = build(p, { png: false, log: silent });

    expect(r.planIds).toEqual(["B"]);
    const s = readSummary(r.outDir);
    expect(s.adopted).not.toBeNull();
    expect(s.adopted!.plan).toBe("B");
    expect(s.adopted!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(s.selectedPlanStale).toBe(false);
    expect(s.recommendedPlan).toBeNull(); // 採用中は推奨★を出さない
  });

  it("配置に無関係な編集（label / price）では記録を持ち回り、採用が維持される", () => {
    const p = writeProject(yaml({ selectedPlan: "B" }));
    const first = readSummary(build(p, { png: false, log: silent }).outDir);

    writeProject(yaml({ selectedPlan: "B", label: "改名", price: 999 }));
    const r2 = build(p, { png: false, log: silent });
    const second = readSummary(r2.outDir);

    expect(r2.planIds).toEqual(["B"]);
    expect(second.adopted).toEqual(first.adopted);
    expect(second.selectedPlanStale).toBe(false);
  });

  it("割付へ影響する編集で無効化し、全案を再生成して warning を出す", () => {
    const p = writeProject(yaml({ selectedPlan: "B" }));
    const first = readSummary(build(p, { png: false, log: silent }).outDir);

    writeProject(yaml({ selectedPlan: "B", length: 600 }));
    const r2 = build(p, { png: false, log: silent });
    const second = readSummary(r2.outDir);

    // 採用案を無視して全案を再生成する。
    expect(r2.planIds).toEqual(["A", "B", "C"]);
    expect(second.selectedPlanStale).toBe(true);
    // selectedPlan の値自体は自動書き換えしない（正本も summary も元の値のまま）。
    expect(second.selectedPlan).toBe("B");
    expect(fs.readFileSync(p, "utf-8")).toContain("selectedPlan: B");
    // 無効化中は全案生成なので推奨★を復活させる。
    expect(second.recommendedPlan).not.toBeNull();
    // warning が出る。
    const w = r2.warnings.find((i) => i.path === "settings.selectedPlan");
    expect(w).toBeDefined();
    expect(w!.severity).toBe("warning");
    // **元のフィンガープリントを保持する**。
    expect(second.adopted).toEqual(first.adopted);
  });

  it("無効化は自己治癒しない（再ビルドしても警告と stale が持続する）", () => {
    const p = writeProject(yaml({ selectedPlan: "B" }));
    const first = readSummary(build(p, { png: false, log: silent }).outDir);

    writeProject(yaml({ selectedPlan: "B", length: 600 }));
    build(p, { png: false, log: silent });

    // 何も直さずにもう一度ビルドしても、警告は消えない。
    const r3 = build(p, { png: false, log: silent });
    const third = readSummary(r3.outDir);

    expect(r3.planIds).toEqual(["A", "B", "C"]);
    expect(third.selectedPlanStale).toBe(true);
    expect(
      r3.warnings.some((i) => i.path === "settings.selectedPlan"),
    ).toBe(true);
    expect(third.adopted).toEqual(first.adopted);
  });

  it("幾何を採用時点へ戻すと再び有効になる", () => {
    const p = writeProject(yaml({ selectedPlan: "B" }));
    const first = readSummary(build(p, { png: false, log: silent }).outDir);

    writeProject(yaml({ selectedPlan: "B", length: 600 }));
    expect(readSummary(build(p, { png: false, log: silent }).outDir).selectedPlanStale)
      .toBe(true);

    writeProject(yaml({ selectedPlan: "B", length: 500 }));
    const r3 = build(p, { png: false, log: silent });
    const third = readSummary(r3.outDir);

    expect(r3.planIds).toEqual(["B"]);
    expect(third.selectedPlanStale).toBe(false);
    expect(third.adopted).toEqual(first.adopted);
  });

  it("採用案を選び直すと新しい採用時点として記録し直す", () => {
    const p = writeProject(yaml({ selectedPlan: "B" }));
    build(p, { png: false, log: silent });

    writeProject(yaml({ selectedPlan: "B", length: 600 }));
    build(p, { png: false, log: silent }); // 無効化

    writeProject(yaml({ selectedPlan: "C", length: 600 }));
    const r3 = build(p, { png: false, log: silent });
    const third = readSummary(r3.outDir);

    expect(r3.planIds).toEqual(["C"]);
    expect(third.selectedPlanStale).toBe(false);
    expect(third.adopted!.plan).toBe("C");
  });

  it("前回 summary.json が壊れていても死なず、記録なしとして扱う", () => {
    const p = writeProject(yaml({ selectedPlan: "B" }));
    const r1 = build(p, { png: false, log: silent });
    fs.writeFileSync(path.join(r1.outDir, "summary.json"), "{ broken", "utf-8");

    const r2 = build(p, { png: false, log: silent });
    const s = readSummary(r2.outDir);

    expect(r2.planIds).toEqual(["B"]);
    expect(s.selectedPlanStale).toBe(false);
    expect(s.adopted!.plan).toBe("B");
  });

  it("adopted の形が壊れていても記録なしとして扱う", () => {
    const p = writeProject(yaml({ selectedPlan: "B" }));
    const r1 = build(p, { png: false, log: silent });
    const s1 = readSummary(r1.outDir);
    fs.writeFileSync(
      path.join(r1.outDir, "summary.json"),
      JSON.stringify({ ...s1, adopted: { plan: 42 } }),
      "utf-8",
    );

    const r2 = build(p, { png: false, log: silent });
    expect(r2.planIds).toEqual(["B"]);
    expect(readSummary(r2.outDir).selectedPlanStale).toBe(false);
  });

  it("出力ディレクトリを消すと現状態を採用時点として静かに再有効化する（既知の限界）", () => {
    // <stem>.out/ は gitignore 対象の派生物であり、正本非改変原則
    //（SPECS §5）の下では採用時点を正本側に持てない。構造的トレードオフ。
    const p = writeProject(yaml({ selectedPlan: "B" }));
    const r1 = build(p, { png: false, log: silent });
    const first = readSummary(r1.outDir);

    writeProject(yaml({ selectedPlan: "B", length: 600 }));
    fs.rmSync(r1.outDir, { recursive: true, force: true });
    const r2 = build(p, { png: false, log: silent });
    const second = readSummary(r2.outDir);

    expect(r2.planIds).toEqual(["B"]);
    expect(second.selectedPlanStale).toBe(false);
    expect(second.adopted!.fingerprint).not.toBe(first.adopted!.fingerprint);
  });
});


// ---------------------------------------------------------------------------
// FIX-B: 出力先の共有検出
// ---------------------------------------------------------------------------

describe("build（出力先の共有検出）", () => {
  /**
   * `<stem>.out/` 規則では foo.yaml と foo.kidori.yaml がどちらも foo.out/ を
   * 出力先にする。ディレクトリ走査はせず、CORE-7 でどのみち読んでいる前回
   * summary.json の sourceFile を O(1) で突き合わせて検出する。
   */
  const body = `
meta: { project: テスト, units: mm, schemaVersion: "0.3" }
settings: { kerf: 3, edgeTrim: 5, candidates: 3, exact: off, selectedPlan: null }
stocks:
  - { id: b1, label: 棒, kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }
parts:
  - { id: p1, label: 部材, qty: 2, stock: b1, length: 800 }
`;

  function writeNamed(name: string): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body, "utf-8");
    return p;
  }

  const ownerWarning = (issues: Issue[]): Issue | undefined =>
    issues.find((i) => i.message.includes("別の正本"));

  it("同じ出力先を別 basename の正本が使うと warning を出す", () => {
    // foo.yaml → foo.out/、foo.kidori.yaml → foo.out/（衝突）。
    const plain = writeNamed("foo.yaml");
    const suffixed = writeNamed("foo.kidori.yaml");

    const r1 = build(plain, { png: false, log: silent });
    expect(ownerWarning(r1.warnings)).toBeUndefined();

    const r2 = build(suffixed, { png: false, log: silent });
    expect(r1.outDir).toBe(r2.outDir); // 同じ出力先を指している

    const w = ownerWarning(r2.warnings);
    expect(w).toBeDefined();
    expect(w!.severity).toBe("warning");
    expect(w!.message).toContain("foo.yaml");
    // warning であってビルドは成功する。
    expect(fs.existsSync(path.join(r2.outDir, "summary.json"))).toBe(true);
  });

  it("同じ正本の再ビルドでは warning を出さない", () => {
    const p = writeNamed("foo.kidori.yaml");
    build(p, { png: false, log: silent });
    const r2 = build(p, { png: false, log: silent });

    expect(ownerWarning(r2.warnings)).toBeUndefined();
  });

  it("summary.json が無い初回は何も出さない", () => {
    const r = build(writeNamed("foo.kidori.yaml"), { png: false, log: silent });
    expect(ownerWarning(r.warnings)).toBeUndefined();
  });

  it("summary.json が壊れていれば何も出さない（記録なし扱い）", () => {
    const plain = writeNamed("foo.yaml");
    const r1 = build(plain, { png: false, log: silent });
    fs.writeFileSync(path.join(r1.outDir, "summary.json"), "{ broken", "utf-8");

    const r2 = build(writeNamed("foo.kidori.yaml"), { png: false, log: silent });
    expect(ownerWarning(r2.warnings)).toBeUndefined();
  });

  it("adopted が壊れていても sourceFile の照合は独立して効く", () => {
    const plain = writeNamed("foo.yaml");
    const r1 = build(plain, { png: false, log: silent });
    const s1 = JSON.parse(
      fs.readFileSync(path.join(r1.outDir, "summary.json"), "utf-8"),
    );
    fs.writeFileSync(
      path.join(r1.outDir, "summary.json"),
      JSON.stringify({ ...s1, adopted: { plan: 42 } }),
      "utf-8",
    );

    const r2 = build(writeNamed("foo.kidori.yaml"), { png: false, log: silent });
    expect(ownerWarning(r2.warnings)).toBeDefined();
  });
});
