/**
 * `src/extension/extension.ts` の `activate()` が登録する経路のうち、以下の
 * 2つが実際に `KidoriPreview.update()`（＝ webview への
 * `postMessage({command:"update", ...})`）まで到達することを確認する。
 *
 *   1. 保存経路: `vscode.workspace.onDidSaveTextDocument` のハンドラ
 *      （extension.ts の buildOnSave 分岐）
 *   2. 手動ビルド経路: `vscode.commands.registerCommand("kidori.build", ...)`
 *      のハンドラ
 *
 * この2経路は「project.yaml を保存しても／手動ビルドを打っても
 * プレビューが更新されない」という不具合報告に対応する箇所であり、
 * 両者が実際に同じ `buildProject() → updatePreview() → preview.update()`
 * に合流することをコードの実行で示す。
 *
 * --- このテストが検証すること ---
 *   - onDidSaveTextDocument に登録されたリスナーが、project.yaml の保存を
 *     表す TextDocument で呼ばれたときに buildProject を起動し、最終的に
 *     webview へ command:"update" が飛ぶこと。
 *   - "kidori.build" として登録されたコマンドハンドラを実行したときに、
 *     同様に command:"update" が飛ぶこと。
 *
 * --- このテストが検証しないこと（over-claim を避けるための線引き） ---
 *   - VS Code 本体が実際にファイル保存を検知して onDidSaveTextDocument を
 *     発火させる仕組みそのもの。ここでは `vscode-mock.ts` の
 *     `__fireDidSave()` というテスト専用のフックでリスナーを直接呼んでおり、
 *     「拡張ホストからの実イベント配送」は検証していない
 *     （実際、公開 API に拡張側から発火させる手段は無い）。
 *   - `vscode.workspace.findFiles` によるプロジェクトファイルの自動検出
 *     （glob 走査）。モックの `findFiles` は常に空配列を返す no-op であり、
 *     本テストは `window.activeTextEditor` を明示的にセットすることで
 *     対象ファイルを決定させている。
 *   - Red Hat YAML 拡張との連携、補完・診断内容の正しさ、json.schemas
 *     登録、ファイルシステムウォッチャーの発火。
 *   - `kidori.presets.json` のマージなど、本題（保存／手動ビルド → 更新）に
 *     無関係な周辺機能。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activate } from "../../src/extension/extension";
import {
  __resetCommands,
  __resetConfig,
  __resetPanels,
  __resetSaveListeners,
  __setActiveTextEditor,
  __setConfig,
  __setWorkspaceFolders,
  __fireDidSave,
  commands,
  createdPanels,
  Uri,
} from "./vscode-mock";

const repoRoot = path.resolve(__dirname, "../..");

function isUpdateMessage(m: unknown): boolean {
  return typeof m === "object" && m !== null && (m as { command?: unknown }).command === "update";
}

describe("activation: 保存経路と手動ビルドコマンド経路がいずれも preview.update() に到達する", () => {
  let tmpDir: string;
  let projectPath: string;

  beforeEach(() => {
    __resetPanels();
    __resetConfig();
    __resetCommands();
    __resetSaveListeners();
    __setActiveTextEditor(undefined);

    // 副作用（kidori.schema.json / *.out/）をリポジトリ外に隔離するため、
    // examples/bookshelf/bookshelf.kidori.yaml を OS のテンポラリディレクトリへ
    // コピーして使う（命名規約 *.kidori.yaml。本テストは保存経路・手動ビルド
    // 経路を検証しており、内容判定の救済経路は対象外のため）。
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-activation-"));
    projectPath = path.join(tmpDir, "bookshelf.kidori.yaml");
    fs.copyFileSync(
      path.join(repoRoot, "examples/bookshelf/bookshelf.kidori.yaml"),
      projectPath,
    );

    __setWorkspaceFolders([{ uri: Uri.file(tmpDir), name: "test", index: 0 }]);
    // PNG 生成（resvg）を無効化して高速化する。
    __setConfig("kidori", "png.enabled", false);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("保存イベントと kidori.build コマンドの双方が update を webview に届ける", async () => {
    const context = {
      extensionPath: repoRoot,
      subscriptions: [] as { dispose(): void }[],
    };
    await activate(context as unknown as Parameters<typeof activate>[0]);

    // --- 事前準備: プレビューパネルを開く ---
    // KidoriPreview.update() は panel が存在する場合のみ postMessage する
    // （preview.ts:69 `if (this.panel) { ... postMessage ... }`）ため、
    // 検証対象の2経路を試す前に openPreview コマンドでパネルを生成する。
    // openPreview は「lastResult が無ければ自分でも1回ビルドする」ため、
    // ここで1回 update が飛ぶが、これは検証対象の2経路ではないので
    // 直後に posted をクリアして以降の検証に影響しないようにする。
    __setActiveTextEditor({ document: { uri: Uri.file(projectPath) } });
    await commands.executeCommand("kidori.openPreview");
    __setActiveTextEditor(undefined);
    expect(createdPanels).toHaveLength(1);
    const panel = createdPanels[0];
    expect(panel.posted.some(isUpdateMessage)).toBe(true);
    panel.posted.length = 0;

    // --- 経路1: 保存 ---
    __fireDidSave({ uri: Uri.file(projectPath) });
    // onDidSaveTextDocument のハンドラは `void buildProject(...)` で
    // 結果を待たずに発火するため、ここでは postMessage が届くまでポーリングする。
    await vi.waitFor(
      () => {
        expect(panel.posted.some(isUpdateMessage)).toBe(true);
      },
      { timeout: 5000, interval: 20 },
    );
    panel.posted.length = 0;

    // --- 経路2: 手動ビルド（kidori.build コマンド） ---
    // findProjectFile() はまず activeTextEditor を見るため、対象ファイルを
    // 明示的に設定する（モックの findFiles は空配列固定のため、それに
    // フォールバックさせない）。
    __setActiveTextEditor({ document: { uri: Uri.file(projectPath) } });
    // kidori.build のハンドラは `await buildProject(target)` するため、
    // executeCommand の返す Promise を待てば完了が保証される。
    await commands.executeCommand("kidori.build");
    expect(panel.posted.some(isUpdateMessage)).toBe(true);
  });
});
