/**
 * 「この案を採用」が**表示中のプロジェクト**を書き換えることの回帰テスト
 * （SPECS.md §3「1ファイル=1プロジェクト」・§5）。
 *
 * 実バグ: 旧実装の `applySelection` はクリック時点のグローバル
 * `lastProjectPath`（＝最後にビルドしたプロジェクト）で対象を解決していた。
 * 1ディレクトリ=1プロジェクトの頃は同時に1つしか無かったため顕在化しなかったが、
 * v0.6 では同一ディレクトリに複数の正本が同居するため、
 * 「bookshelf を表示 → desk を保存（自動ビルド）→ プレビューで採用を押す」で
 * **desk.kidori.yaml の settings.selectedPlan が書き換わる**。
 *
 * 本テストは Webview からのメッセージ受信・WorkspaceEdit の適用を含む経路を
 * 実際に走らせ、書き換わったファイルと書き換わっていないファイルを直接確認する。
 * そのため `vscode-mock.ts`（更新経路を持たない最小スタブ）ではなく、
 * 上位互換の `vscode-rich.ts` を `vi.mock` で差し替えて使う。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", async () => await import("./vscode-rich"));

import { activate } from "../../src/extension/extension";
import {
  __fireDidSave,
  __resetCommands,
  __resetConfig,
  __resetListeners,
  __resetPanels,
  __setActiveTextEditor,
  __setConfig,
  __setWorkspaceFolders,
  commands,
  createdPanels,
  Uri,
} from "./vscode-rich";

function projectYaml(name: string): string {
  return `meta: { project: ${name}, units: mm, schemaVersion: "0.3" }
settings:
  kerf: 3
  edgeTrim: 5
  candidates: 3
  exact: off
  selectedPlan: null
stocks:
  - { id: 1x4-6f, label: "1×4材 6F", kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }
parts:
  - { id: shelf, label: 棚板, qty: 3, stock: 1x4-6f, length: 500 }
`;
}

function selectedPlanOf(filePath: string): string | null {
  const m = /selectedPlan:\s*(\S+)/.exec(fs.readFileSync(filePath, "utf-8"));
  return m ? m[1] : null;
}

describe("プレビューの採用操作は表示中のプロジェクトに適用される", () => {
  let tmpDir: string;
  let bookshelf: string;
  let desk: string;

  beforeEach(() => {
    __resetPanels();
    __resetConfig();
    __resetCommands();
    __resetListeners();
    __setActiveTextEditor(undefined);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-selection-"));
    bookshelf = path.join(tmpDir, "bookshelf.kidori.yaml");
    desk = path.join(tmpDir, "desk.kidori.yaml");
    fs.writeFileSync(bookshelf, projectYaml("書棚"), "utf-8");
    fs.writeFileSync(desk, projectYaml("机"), "utf-8");

    __setWorkspaceFolders([{ uri: Uri.file(tmpDir), name: "test", index: 0 }]);
    __setConfig("kidori", "png.enabled", false);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("別プロジェクトを後からビルドしても、押した画面のファイルだけが書き換わる", async () => {
    const context = {
      extensionPath: path.resolve(__dirname, "../.."),
      subscriptions: [] as { dispose(): void }[],
    };
    await activate(context as unknown as Parameters<typeof activate>[0]);

    // bookshelf を表示（プレビューを開く → ビルド）。
    __setActiveTextEditor({ document: { uri: Uri.file(bookshelf) } });
    await commands.executeCommand("kidori.openPreview");
    expect(createdPanels).toHaveLength(1);
    const panel = createdPanels[0];
    expect(panel.title).toContain("bookshelf");

    // 続いて desk を保存 → 自動ビルド（グローバルな「最後のビルド対象」は desk になる）。
    __setActiveTextEditor(undefined);
    __fireDidSave({ uri: Uri.file(desk) });
    await vi.waitFor(
      () => {
        expect(panel.title).toContain("desk");
      },
      { timeout: 5000, interval: 20 },
    );

    // bookshelf を描画していた画面のボタンが押された（メッセージは描画時に
    // バインドされた projectPath を伴う）。
    panel.__receive({
      command: "selectPlan",
      planId: "B",
      projectPath: bookshelf,
    });
    await vi.waitFor(
      () => {
        expect(selectedPlanOf(bookshelf)).toBe("B");
      },
      { timeout: 5000, interval: 20 },
    );

    // 表示中でなかった desk は書き換わらない。
    expect(selectedPlanOf(desk)).toBe("null");
  });

  it("採用の解除も同じくバインドされたパスに適用される", async () => {
    const context = {
      extensionPath: path.resolve(__dirname, "../.."),
      subscriptions: [] as { dispose(): void }[],
    };
    await activate(context as unknown as Parameters<typeof activate>[0]);

    __setActiveTextEditor({ document: { uri: Uri.file(desk) } });
    await commands.executeCommand("kidori.openPreview");
    const panel = createdPanels[0];

    __setActiveTextEditor({ document: { uri: Uri.file(bookshelf) } });
    await commands.executeCommand("kidori.build");

    panel.__receive({ command: "selectPlan", planId: "A", projectPath: desk });
    await vi.waitFor(
      () => {
        expect(selectedPlanOf(desk)).toBe("A");
      },
      { timeout: 5000, interval: 20 },
    );
    expect(selectedPlanOf(bookshelf)).toBe("null");

    panel.__receive({ command: "clearSelection", projectPath: desk });
    await vi.waitFor(
      () => {
        expect(selectedPlanOf(desk)).toBe("null");
      },
      { timeout: 5000, interval: 20 },
    );
  });
});
