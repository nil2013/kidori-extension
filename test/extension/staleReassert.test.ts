/**
 * WIRE-4: 「失敗プロジェクトの stale 状態が消える」穴の回帰テスト。
 *
 * v0.6 で複数プロジェクト対応のため `results: Map<projectPath, BuildResult>` を
 * 導入した際、`results` は**成功したビルド結果しか保持しない**一方、stale
 * （直近ビルドが失敗し、表示中の図面が最新の正本を反映していない）はパネル
 * 単位（`KidoriPreview.stale`）にしか無かった。そのため次の経路で
 * 「古い図面がバナー無しで現行であるかのように表示される」状態が作れた:
 *
 *   1. プロジェクト Y のビルドが失敗する（Y 表示中なので stale バナーが出る）
 *   2. プレビューを別プロジェクト X に切り替える（成功ビルド。stale が晴れる）
 *   3. Y に戻す → `showResult(Y)` は **results に残る最後の成功結果**を
 *      無条件で表示していた（stale バナー無し）
 *   4. Y の古い（壊れる前の）図面が、バナー無しで「現行」であるかのように
 *      表示されてしまう ← 本テストが固定するのはここ
 *
 * 修正: `failedProjects: Map<projectPath, string>` を `results` と並置し、
 * ビルド失敗時に記録・成功時に削除する。`showResult` は表示を戻した直後、
 * 対象が `failedProjects` にあれば `preview.showError` を再発行して stale を
 * 再度立てる（extension.ts の `showResult` 参照）。
 *
 * --- このテストが検証すること ---
 *   - 上記1〜4の手順をそのまま踏み、手順4の時点でプレビューに投げられた
 *     直近のメッセージが `command: "error"` であること（stale バナーの根拠）。
 *   - そのエラーメッセージが Y の実際の壊れ方（存在しない原材 id）を含むこと
 *     （踏み違えて別の理由の error を拾っていないことの確認）。
 *
 * --- 検証しないこと ---
 *   - Webview 側の実際の DOM 描画（stale クラス付与・opacity 等）。
 *     postMessage の command で代理検証する（preview.ts の html() 内 JS は
 *     jsdom 無しでは実行できないため）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activate } from "../../src/extension/extension";
import {
  __resetCloseListeners,
  __resetCommands,
  __resetConfig,
  __resetPanels,
  __resetSaveListeners,
  __setActiveTextEditor,
  __setConfig,
  __setWorkspaceFolders,
  commands,
  createdPanels,
  Uri,
} from "./vscode-mock";

const repoRoot = path.resolve(__dirname, "../..");

interface PostedMessage {
  command?: unknown;
  message?: unknown;
}

function lastMessage(posted: unknown[]): PostedMessage | undefined {
  return posted[posted.length - 1] as PostedMessage | undefined;
}

describe("WIRE-4: 失敗プロジェクトへ表示を戻すと stale バナーが再度立つ", () => {
  let tmpDir: string;
  let xPath: string;
  let yPath: string;

  beforeEach(() => {
    __resetPanels();
    __resetConfig();
    __resetCommands();
    __resetSaveListeners();
    __resetCloseListeners();
    __setActiveTextEditor(undefined);

    // 副作用（*.out/）をリポジトリ外に隔離するため、examples/bookshelf の
    // 正本を X・Y 2プロジェクトとしてテンポラリディレクトリへコピーする。
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-stale-"));
    xPath = path.join(tmpDir, "x.kidori.yaml");
    yPath = path.join(tmpDir, "y.kidori.yaml");
    const source = fs.readFileSync(
      path.join(repoRoot, "examples/bookshelf/bookshelf.kidori.yaml"),
      "utf-8",
    );
    fs.writeFileSync(xPath, source, "utf-8");
    fs.writeFileSync(yPath, source, "utf-8");

    __setWorkspaceFolders([{ uri: Uri.file(tmpDir), name: "test", index: 0 }]);
    // PNG 生成（resvg）を無効化して高速化する。
    __setConfig("kidori", "png.enabled", false);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Y 失敗 → X へ切替（成功） → Y へ戻すと、古い成功結果に stale バナーが再度立つ", async () => {
    const context = {
      extensionPath: repoRoot,
      subscriptions: [] as { dispose(): void }[],
    };
    await activate(context as unknown as Parameters<typeof activate>[0]);

    // --- 1. Y を開いてプレビューを表示 → 成功ビルド ---
    __setActiveTextEditor({ document: { uri: Uri.file(yPath) } });
    await commands.executeCommand("kidori.openPreview");
    expect(createdPanels).toHaveLength(1);
    const panel = createdPanels[0];
    expect(lastMessage(panel.posted)?.command).toBe("update");
    panel.posted.length = 0;

    // --- 2. Y を壊して再ビルド → 失敗（表示中なので stale バナーが出る） ---
    const original = fs.readFileSync(yPath, "utf-8");
    const corrupted = original.replace("stock: pine-18", "stock: pine-999");
    expect(corrupted).not.toBe(original); // 置換が実際に効いたことの前提を固定する
    fs.writeFileSync(yPath, corrupted, "utf-8");

    await commands.executeCommand("kidori.build");
    const afterFailure = lastMessage(panel.posted);
    expect(afterFailure?.command).toBe("error");
    panel.posted.length = 0;

    // --- 3. X へ切り替えて成功ビルド（プレビューは X に切り替わり、stale が晴れる） ---
    __setActiveTextEditor({ document: { uri: Uri.file(xPath) } });
    await commands.executeCommand("kidori.build");
    expect(lastMessage(panel.posted)?.command).toBe("update");
    panel.posted.length = 0;

    // --- 4. Y に表示を戻す（Y は既にビルド済み＝results にある → showResult 経路） ---
    __setActiveTextEditor({ document: { uri: Uri.file(yPath) } });
    await commands.executeCommand("kidori.openPreview");

    // 本題: Y の「壊れる前の」最後の成功結果が表示されるが、直近のビルドは
    // 失敗している。stale バナー無しで「現行」であるかのように表示してはならない。
    const afterReturn = lastMessage(panel.posted);
    expect(afterReturn?.command).toBe("error");
    expect(String(afterReturn?.message)).toContain("pine-999");
  });
});
