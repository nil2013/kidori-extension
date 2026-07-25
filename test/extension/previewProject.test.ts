/**
 * プレビューの**プロジェクト束縛**と採用バッジ（SPECS.md §3・§5）。
 *
 * 背景（実バグ）: v0.6 の「1ファイル=1プロジェクト」では同一ディレクトリに複数の
 * 正本が同居する。旧実装の `applySelection` はクリック時点のグローバル
 * `lastProjectPath` で対象を解決していたため、別プロジェクトを保存した直後に
 * プレビューの「この案を採用」を押すと、**表示中とは別のファイル**の
 * `settings.selectedPlan` を書き換えた。
 *
 * ここで固定する契約:
 *   1. Webview は描画に使ったデータの `projectPath` を操作メッセージに載せる。
 *   2. `KidoriPreview` は onAction へ **update 時にバインドされたパス**を渡す。
 *   3. `summary.selectedPlanStale === true` のとき、採用バッジは「採用（無効）」。
 *
 * 3 はインラインスクリプトの描画結果なので、抽出したスクリプトを最小の DOM
 * スタブ上で実際に実行して検証する（文字列の grep ではなく描画結果を見る）。
 */

import * as vm from "node:vm";

import { beforeEach, describe, expect, it } from "vitest";

import { KidoriPreview, PlanAction, PreviewData } from "../../src/extension/preview";
import { __resetPanels, createdPanels } from "./vscode-mock";

// ---------------------------------------------------------------------------
// テストデータ
// ---------------------------------------------------------------------------

function summary(overrides: Record<string, unknown> = {}): PreviewData["summary"] {
  return {
    schemaVersion: "0.3",
    generatedAt: "2026-07-25T00:00:00+09:00",
    sourceFile: "bookshelf.kidori.yaml",
    sourceSha256: "deadbeef",
    project: "書棚",
    selectedPlan: null,
    adopted: null,
    rank: ["cost", "waste", "cuts"],
    recommendedPlan: "A",
    rankedPlans: ["A", "B"],
    exact: { attempted: false, proven: false, matchesPlan: null, reason: null },
    plans: [planSummary("A"), planSummary("B")],
    ...overrides,
  } as unknown as PreviewData["summary"];
}

function planSummary(id: string): unknown {
  return {
    id,
    recommended: id === "A",
    rank: id === "A" ? 1 : 2,
    stocks: [{ id: "1x4-6f", kind: "bar", count: 2 }],
    totals: {
      cost: 764,
      costComplete: true,
      yield: 0.8,
      cutCount: 4,
      stockCounts: { "1x4-6f": 2 },
    },
  };
}

function data(projectPath: string, label: string, s = summary()): PreviewData {
  return {
    projectPath,
    label,
    summary: s,
    plans: [
      { id: "A", svg: "<svg/>" },
      { id: "B", svg: "<svg/>" },
    ],
    parts: [],
  };
}

// ---------------------------------------------------------------------------
// 1・2: 操作は update 時にバインドされたプロジェクトに向かう
// ---------------------------------------------------------------------------

describe("KidoriPreview: プロジェクト束縛", () => {
  beforeEach(() => {
    __resetPanels();
  });

  it("メッセージに載った projectPath を onAction へ渡す（表示中でない側を書き換えない）", () => {
    const seen: { action: PlanAction; projectPath: string | null }[] = [];
    const preview = new KidoriPreview((action, projectPath) =>
      seen.push({ action, projectPath }),
    );
    preview.show();

    preview.update(data("/diy/bookshelf.kidori.yaml", "bookshelf"));
    // 別プロジェクトのビルドが割り込んで表示が切り替わった状態。
    preview.update(data("/diy/desk.kidori.yaml", "desk"));

    // ユーザーが押したのは bookshelf を描画していた画面のボタン。
    preview.handleMessage({
      command: "selectPlan",
      planId: "A",
      projectPath: "/diy/bookshelf.kidori.yaml",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].projectPath).toBe("/diy/bookshelf.kidori.yaml");
  });

  it("projectPath の無いメッセージは現在の束縛（最後の update）に落ちる", () => {
    const seen: (string | null)[] = [];
    const preview = new KidoriPreview((_a, p) => seen.push(p));
    preview.show();
    preview.update(data("/diy/desk.kidori.yaml", "desk"));
    preview.handleMessage({ command: "clearSelection" });
    expect(seen).toEqual(["/diy/desk.kidori.yaml"]);
  });

  it("未ビルドでの操作は projectPath なし（拡張側が対象を探す）", () => {
    const seen: (string | null)[] = [];
    const preview = new KidoriPreview((_a, p) => seen.push(p));
    preview.show();
    preview.handleMessage({ command: "rebuild" });
    expect(seen).toEqual([null]);
  });

  it("パネルタイトルにプロジェクト名を出す", () => {
    const preview = new KidoriPreview(() => {});
    preview.show();
    expect(createdPanels[0].title).toBe("kidori プレビュー");
    preview.update(data("/diy/bookshelf.kidori.yaml", "bookshelf"));
    expect(createdPanels[0].title).toBe("kidori プレビュー — bookshelf");
    preview.update(data("/diy/desk.kidori.yaml", "desk"));
    expect(createdPanels[0].title).toBe("kidori プレビュー — desk");
  });
});

// ---------------------------------------------------------------------------
// 3: Webview を実際に走らせて描画結果を見る
// ---------------------------------------------------------------------------

/** 最小 DOM スタブ上の要素。 */
class FakeElement {
  children: FakeElement[] = [];
  className = "";
  innerHTML = "";
  hidden = false;
  private text = "";
  readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  readonly classList = {
    toggle: () => {},
    add: () => {},
    remove: () => {},
  };

  constructor(readonly tagName: string) {}

  set textContent(value: string) {
    this.text = value;
    if (value === "") {
      this.children = [];
      this.innerHTML = "";
    }
  }
  get textContent(): string {
    return this.text;
  }
  appendChild(child: FakeElement): void {
    this.children.push(child);
  }
  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  /** 自身と子孫のテキスト・innerHTML を連結する（描画結果の検査用）。 */
  rendered(): string {
    return [this.text, this.innerHTML, ...this.children.map((c) => c.rendered())].join("\n");
  }
  /** 子孫から textContent が pattern を含む最初の要素を探す。 */
  find(pattern: string): FakeElement | null {
    if (this.text.includes(pattern)) {
      return this;
    }
    for (const c of this.children) {
      const hit = c.find(pattern);
      if (hit) {
        return hit;
      }
    }
    return null;
  }
}

interface Harness {
  /** Webview に postMessage 相当のメッセージを流し込む。 */
  send(message: unknown): void;
  /** 拡張側へ送られたメッセージ（vscode.postMessage）。 */
  posted: unknown[];
  elements: Map<string, FakeElement>;
}

/** preview.ts のインラインスクリプトを最小 DOM 上で実行する。 */
function runWebview(): Harness {
  __resetPanels();
  const preview = new KidoriPreview(() => {});
  preview.show();
  const html = createdPanels[0].webview.html;
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts).toHaveLength(1);

  const elements = new Map<string, FakeElement>();
  for (const id of ["tab-plans", "tab-parts", "view-plans", "view-parts", "error"]) {
    elements.set(id, new FakeElement("div"));
  }
  const posted: unknown[] = [];
  const messageListeners: ((event: { data: unknown }) => void)[] = [];

  const context = vm.createContext({
    acquireVsCodeApi: () => ({
      postMessage: (m: unknown) => posted.push(m),
    }),
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: (tag: string) => new FakeElement(tag),
      body: { classList: { add: () => {}, remove: () => {}, toggle: () => {} } },
    },
    window: {
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        if (type === "message") {
          messageListeners.push(listener);
        }
      },
    },
  });
  vm.runInContext(scripts[0], context, { filename: "preview-inline.js" });

  return {
    send: (message) => {
      for (const listener of messageListeners) {
        listener({ data: message });
      }
    },
    posted,
    elements,
  };
}

describe("Webview の描画: 採用バッジと操作メッセージ", () => {
  it("selectedPlan が有効なときは【採用】", () => {
    const h = runWebview();
    h.send({
      command: "update",
      data: data("/diy/bookshelf.kidori.yaml", "bookshelf", summary({ selectedPlan: "A" })),
    });
    const view = h.elements.get("view-plans") as FakeElement;
    expect(view.rendered()).toContain("【採用】");
    expect(view.rendered()).not.toContain("採用（無効）");
    expect(view.rendered()).toContain("採用済み");
  });

  it("selectedPlanStale === true のときは「採用（無効）」に切り替わる（SPECS.md §5）", () => {
    const h = runWebview();
    h.send({
      command: "update",
      data: data(
        "/diy/bookshelf.kidori.yaml",
        "bookshelf",
        summary({ selectedPlan: "A", selectedPlanStale: true }),
      ),
    });
    const view = h.elements.get("view-plans") as FakeElement;
    const text = view.rendered();
    expect(text).toContain("【採用（無効）】");
    expect(text).not.toContain("【採用】");
    expect(text).toContain("採用（無効）— 設計変更のため再選択してください");
    // 選び直しは「解除 → 採用」の2手（同じ案 ID の書き直しは正本のテキストが
    // 変わらず再ビルドも採用記録の更新も起きないため、再採用ボタンは置かない）。
    expect(view.find("採用を解除（選び直す）")).not.toBeNull();
    expect(view.find("この案を再採用")).toBeNull();
  });

  it("採用操作には描画に使ったデータの projectPath が載る", () => {
    const h = runWebview();
    h.send({
      command: "update",
      data: data("/diy/bookshelf.kidori.yaml", "bookshelf"),
    });
    const view = h.elements.get("view-plans") as FakeElement;
    const button = view.find("この案を採用");
    expect(button).not.toBeNull();
    for (const listener of button!.listeners.get("click") ?? []) {
      listener();
    }
    expect(h.posted).toEqual([
      { command: "selectPlan", planId: "A", projectPath: "/diy/bookshelf.kidori.yaml" },
    ]);
  });

  it("表示が別プロジェクトへ切り替わった後のクリックは切り替え後のパスを載せる", () => {
    const h = runWebview();
    h.send({ command: "update", data: data("/diy/bookshelf.kidori.yaml", "bookshelf") });
    h.send({ command: "update", data: data("/diy/desk.kidori.yaml", "desk") });
    const view = h.elements.get("view-plans") as FakeElement;
    for (const listener of view.find("この案を採用")!.listeners.get("click") ?? []) {
      listener();
    }
    expect(h.posted).toEqual([
      { command: "selectPlan", planId: "A", projectPath: "/diy/desk.kidori.yaml" },
    ]);
  });
});
