/**
 * 編集時の再評価の配線テスト（`extension.ts` の `onDidChangeTextDocument` →
 * debounce → `applyLiveDiagnostics`。SPECS.md §4b:188、設計裁定 D2、D4 の
 * 「編集時再評価の debounce と、パース不能時の前回診断維持」）。
 *
 * `reevaluateInMemory`（`src/extension/liveEval.ts`）自体の契約
 * （有効な YAML/JSON → issues、パース不能 → null）は liveEval.test.ts が
 * 純関数として直接検証済み。ここでは vscode モック＋フェイクタイマーを使い、
 * **配線** — debounce によって短時間の連続編集が1回に丸められること、
 * `null`（パース不能）のときに `diagnostics` コレクションを上書きしない
 * （＝前回の内容を維持する）こと — を検証する。
 *
 * `reevaluateInMemory` 自体は `vi.mock` で差し替え、呼び出し回数・引数・
 * 戻り値を完全にテストの制御下に置く（実際の YAML パース結果に依存させず、
 * 「配線」だけを切り出して見る）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Issue } from "../../src/core/errors";

const reevalCalls: { text: string; fsPath: string; baseDir: string }[] = [];
let nextResult: Issue[] | null = [];

vi.mock("../../src/extension/liveEval", () => ({
  reevaluateInMemory: (text: string, fsPath: string, baseDir: string): Issue[] | null => {
    reevalCalls.push({ text, fsPath, baseDir });
    return nextResult;
  },
}));

const { activate } = await import("../../src/extension/extension");
const {
  __resetCommands,
  __resetConfig,
  __resetPanels,
  __resetChangeListeners,
  __setWorkspaceFolders,
  __fireDidChangeTextDocument,
  __getDiagnostics,
  __resetDiagnosticsStore,
  Uri,
} = await import("./vscode-mock");

const repoRoot = new URL("../../", import.meta.url).pathname;
const FS_PATH = "/tmp/uma.kidori.yaml";
const URI_STRING = `file://${FS_PATH}`;

/** `document.getText()` が固定テキストを返す最小 TextDocument。 */
function fakeDocument(text: string) {
  return {
    uri: Uri.file(FS_PATH),
    fileName: FS_PATH,
    getText: () => text,
  };
}

function messagesOf(diags: readonly unknown[]): string[] {
  return diags.map((d) => (d as { message: string }).message);
}

describe("編集時の再評価の配線（debounce・パース不能時の前回診断維持）", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    reevalCalls.length = 0;
    nextResult = [];
    __resetPanels();
    __resetConfig();
    __resetCommands();
    __resetChangeListeners();
    __resetDiagnosticsStore();
    __setWorkspaceFolders([{ uri: Uri.file(repoRoot), name: "test", index: 0 }]);

    const context = { extensionPath: repoRoot, subscriptions: [] as { dispose(): void }[] };
    await activate(context as unknown as Parameters<typeof activate>[0]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("500ms 経過するまでは再評価が走らない", () => {
    __fireDidChangeTextDocument({ document: fakeDocument("meta: {}\n") });
    vi.advanceTimersByTime(200);
    expect(reevalCalls.length).toBe(0);
  });

  it("debounce 幅内の連続編集は1回に丸められ、最後の内容だけが評価される", () => {
    __fireDidChangeTextDocument({ document: fakeDocument("meta: { project: 1回目 }\n") });
    vi.advanceTimersByTime(200); // < 500ms: まだ発火しない

    __fireDidChangeTextDocument({ document: fakeDocument("meta: { project: 2回目 }\n") });
    vi.advanceTimersByTime(500); // 2回目の編集から500ms

    expect(reevalCalls.length).toBe(1);
    expect(reevalCalls[0].text).toBe("meta: { project: 2回目 }\n");
  });

  it("パース不能（null）のときは診断コレクションを上書きしない（前回診断を維持する）", () => {
    // 1回目: 有効な内容。error 1件を診断として反映させる。
    nextResult = [{ path: "parts[0].length", message: "エラーその1", severity: "error" }];
    __fireDidChangeTextDocument({ document: fakeDocument("meta: { project: valid }\n") });
    vi.advanceTimersByTime(500);

    const afterFirst = __getDiagnostics(URI_STRING);
    expect(messagesOf(afterFirst)).toEqual(["parts[0].length: エラーその1"]);

    // 2回目: パース不能（reevaluateInMemory が null を返す）。
    nextResult = null;
    __fireDidChangeTextDocument({ document: fakeDocument("meta: [broken\n") });
    vi.advanceTimersByTime(500);

    // 前回（1回目）の診断がそのまま残っている（上書き・消去されていない）。
    const afterSecond = __getDiagnostics(URI_STRING);
    expect(messagesOf(afterSecond)).toEqual(["parts[0].length: エラーその1"]);
  });

  it("パース可能に戻れば診断は最新の内容で更新される", () => {
    nextResult = [{ path: "parts[0].length", message: "エラーその1", severity: "error" }];
    __fireDidChangeTextDocument({ document: fakeDocument("meta: { project: valid }\n") });
    vi.advanceTimersByTime(500);

    nextResult = [];
    __fireDidChangeTextDocument({ document: fakeDocument("meta: { project: fixed }\n") });
    vi.advanceTimersByTime(500);

    expect(__getDiagnostics(URI_STRING)).toEqual([]);
  });
});
