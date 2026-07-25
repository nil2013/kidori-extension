/**
 * WIRE-1/WIRE-2/WIRE-3: `kidori.new`（雛形生成）と `kidori.init`
 * （ディレクトリ初期化）の VS Code 側ハンドラ配線（SPECS.md §3a「① 着手」）。
 *
 * これらのコアロジックは `src/core/scaffold.ts` / `src/core/init.ts` に実装済み・
 * `package.json` の `contributes.commands` にも定義済みだったが、拡張側で
 * `vscode.commands.registerCommand` されていなかったため、コマンドパレットから
 * 実行すると "command not found" になっていた。本ファイルはその配線を検証する。
 *
 * --- 固定する契約 ---
 *   1. コマンドが実際に registerCommand されていること（本題の回帰検知）。
 *   2. `kidori.new`: ファイル名入力 → プリセット選択（スキップ可）→ 生成 →
 *      生成ファイルをエディタで開く。
 *   3. `kidori.new`: 対象ディレクトリはアクティブエディタ優先、無ければ
 *      ワークスペースルート（単一/複数で分岐）。
 *   4. `kidori.new`: `modelineEnabled === false` のとき `kidori init` への
 *      導線（アクションボタン付き情報メッセージ）を出し、押すと実際に
 *      `kidori.init` が実行されること。
 *   5. `kidori.init`: 対象ディレクトリ決定（単一/複数）、`--with-stocks`
 *      相当のオプトイン、結果の1行ずつの報告、冪等性。
 *   6. WIRE-3: `vscode.workspace.onDidCloseTextDocument` が `typeof` ガード
 *      無しで無条件登録されること（vscode-mock.ts に同 API を実装したことの
 *      回帰確認を兼ねる）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activate } from "../../src/extension/extension";
import { availablePresets } from "../../src/core/scaffold";
import {
  __fireDidClose,
  __getChannelLines,
  __isCommandRegistered,
  __queueInformationMessage,
  __queueInputBox,
  __queueQuickPick,
  __recordedWindowCalls,
  __resetChannels,
  __resetCloseListeners,
  __resetCommands,
  __resetConfig,
  __resetPanels,
  __resetSaveListeners,
  __resetWindowMocks,
  __setActiveTextEditor,
  __setWorkspaceFolders,
  commands,
  openedTextDocuments,
  Uri,
} from "./vscode-mock";

const repoRoot = path.resolve(__dirname, "../..");

let savedXdg: string | undefined;
let xdgDir: string;
const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function activateExtension(): Promise<void> {
  const context = {
    extensionPath: repoRoot,
    subscriptions: [] as { dispose(): void }[],
  };
  await activate(context as unknown as Parameters<typeof activate>[0]);
}

beforeEach(() => {
  __resetPanels();
  __resetConfig();
  __resetCommands();
  __resetSaveListeners();
  __resetCloseListeners();
  __resetWindowMocks();
  __resetChannels();
  __setActiveTextEditor(undefined);
  __setWorkspaceFolders([]);

  // ユーザー層（$XDG_CONFIG_HOME/kidori/stocks.yaml）を読ませないよう、
  // 実ユーザーの ~/.config には触れずテンポラリへ向ける
  // （test/core/scaffold.test.ts と同じ扱い）。
  xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-xdg-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgDir;

  tmpDirs.length = 0;
});

afterEach(() => {
  if (savedXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = savedXdg;
  }
  fs.rmSync(xdgDir, { recursive: true, force: true });
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("コマンド登録（'command not found' の回帰検知）", () => {
  it("kidori.new / kidori.init が commands レジストリに存在する", async () => {
    expect(__isCommandRegistered("kidori.new")).toBe(false);
    expect(__isCommandRegistered("kidori.init")).toBe(false);

    await activateExtension();

    expect(__isCommandRegistered("kidori.new")).toBe(true);
    expect(__isCommandRegistered("kidori.init")).toBe(true);
    // 既存コマンドも巻き添えで壊していないことの確認。
    expect(__isCommandRegistered("kidori.build")).toBe(true);
    expect(__isCommandRegistered("kidori.openPreview")).toBe(true);
    expect(__isCommandRegistered("kidori.selectPlan")).toBe(true);
    expect(__isCommandRegistered("kidori.insertAssembly")).toBe(true);
  });
});

describe("WIRE-3: onDidCloseTextDocument が typeof ガード無しで登録される", () => {
  it("ドキュメントを閉じた通知でハンドラが例外なく呼ばれる", async () => {
    await activateExtension();
    // typeof ガードが復活していれば以前は「登録されない」という形で沈黙して
    // いたが、いまは無条件登録なので __fireDidClose が例外なく届く
    // （ハンドラは shadowReporter.clear / contributor.forget を呼ぶだけで
    // 副作用は無いため、ここでは「例外を投げず実行できる」ことを固定する）。
    expect(() => __fireDidClose({ uri: Uri.file(path.join(os.tmpdir(), "dummy.kidori.yaml")) })).not.toThrow();
  });
});

describe("kidori.new: 雛形生成コマンド", () => {
  it("ファイル名入力 → プリセットはスキップ → 生成 → エディタで開く", async () => {
    const dir = makeTmpDir("kidori-new-");
    __setWorkspaceFolders([{ uri: Uri.file(dir), name: "root", index: 0 }]);

    __queueInputBox("shelf");
    __queueQuickPick(undefined); // プリセット選択をキャンセル＝スキップ
    __queueInformationMessage(undefined); // modeline 案内は無視

    await activateExtension();
    await commands.executeCommand("kidori.new");

    const generated = path.join(dir, "shelf.kidori.yaml");
    expect(fs.existsSync(generated)).toBe(true);
    const content = fs.readFileSync(generated, "utf-8");
    expect(content).toContain('meta: { project: "shelf"');

    // 生成ファイルがエディタで開かれること。
    expect(openedTextDocuments).toHaveLength(1);
    const opened = openedTextDocuments[0] as { uri: { fsPath: string } };
    expect(opened.uri.fsPath).toBe(generated);
  });

  it("プリセットを明示的に選ぶと、その規格材が正本に実体化される", async () => {
    const dir = makeTmpDir("kidori-new-preset-");
    __setWorkspaceFolders([{ uri: Uri.file(dir), name: "root", index: 0 }]);

    // extension.ts が内部で計算するのと同じ候補一覧を得て、確実に存在する
    // キーを選ぶ（ビルトイン資産のキー一覧に依存せず頑健にする）。
    const target = path.join(dir, "cabinet.kidori.yaml");
    const available = availablePresets(repoRoot, target);
    const picked = available.find((s) => s.key === "spf/2x4/6f") ?? available[0];
    expect(picked).toBeDefined();

    __queueInputBox("cabinet");
    __queueQuickPick([{ key: picked.key }]);
    __queueInformationMessage(undefined);

    await activateExtension();
    await commands.executeCommand("kidori.new");

    const content = fs.readFileSync(target, "utf-8");
    expect(content).toContain(`preset: ${picked.key}`);
  });

  it("空文字・パス区切りを含むファイル名は拒否し、ファイルを作らない", async () => {
    const dir = makeTmpDir("kidori-new-invalid-");
    __setWorkspaceFolders([{ uri: Uri.file(dir), name: "root", index: 0 }]);

    __queueInputBox("sub/dir/name");

    await activateExtension();
    await commands.executeCommand("kidori.new");

    // ワークスペース内にもその外にも、意図しないファイルが作られていない。
    expect(fs.existsSync(path.join(dir, "sub"))).toBe(false);
    const errorCalls = __recordedWindowCalls().filter(
      (c) => c.kind === "showErrorMessage",
    );
    expect(errorCalls.length).toBeGreaterThan(0);
  });

  it("アクティブエディタがあれば、そのディレクトリに生成する（ワークスペースルートより優先）", async () => {
    const root = makeTmpDir("kidori-new-root-");
    const activeDir = makeTmpDir("kidori-new-active-");
    __setWorkspaceFolders([{ uri: Uri.file(root), name: "root", index: 0 }]);
    __setActiveTextEditor({ document: { uri: Uri.file(path.join(activeDir, "other.kidori.yaml")) } });

    __queueInputBox("fromActive");
    __queueQuickPick(undefined);
    __queueInformationMessage(undefined);

    await activateExtension();
    await commands.executeCommand("kidori.new");

    expect(fs.existsSync(path.join(activeDir, "fromActive.kidori.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "fromActive.kidori.yaml"))).toBe(false);
  });

  it("マルチルートではフォルダ選択の QuickPick を出し、選んだ側に生成する", async () => {
    const dirA = makeTmpDir("kidori-new-a-");
    const dirB = makeTmpDir("kidori-new-b-");
    __setWorkspaceFolders([
      { uri: Uri.file(dirA), name: "a", index: 0 },
      { uri: Uri.file(dirB), name: "b", index: 1 },
    ]);

    __queueQuickPick({ fsPath: dirB }); // フォルダ選択 → B を選ぶ
    __queueInputBox("multi");
    __queueQuickPick(undefined); // プリセット選択はスキップ
    __queueInformationMessage(undefined);

    await activateExtension();
    await commands.executeCommand("kidori.new");

    expect(fs.existsSync(path.join(dirB, "multi.kidori.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(dirA, "multi.kidori.yaml"))).toBe(false);
  });

  it("modelineEnabled===false のとき、kidori init への導線となる情報メッセージを出す", async () => {
    const dir = makeTmpDir("kidori-new-modeline-");
    __setWorkspaceFolders([{ uri: Uri.file(dir), name: "root", index: 0 }]);

    __queueInputBox("noschema");
    __queueQuickPick(undefined);
    __queueInformationMessage(undefined); // 案内は見るだけ（押さない）

    await activateExtension();
    await commands.executeCommand("kidori.new");

    // kidori.schema.json が無いディレクトリなので modelineEnabled は false のはず。
    expect(fs.existsSync(path.join(dir, "kidori.schema.json"))).toBe(false);

    const infoCalls = __recordedWindowCalls().filter(
      (c) => c.kind === "showInformationMessage",
    );
    const hint = infoCalls.find((c) => String(c.message).includes("kidori init"));
    expect(hint).toBeDefined();
    expect(hint?.items).toContain("kidori init を実行");
  });

  it("kidori init への導線ボタンを押すと、実際に kidori.init が実行される", async () => {
    const dir = makeTmpDir("kidori-new-autoinit-");
    __setWorkspaceFolders([{ uri: Uri.file(dir), name: "root", index: 0 }]);

    __queueInputBox("autoinit");
    __queueQuickPick(undefined); // ① kidori.new: プリセット選択スキップ
    __queueInformationMessage("kidori init を実行"); // ② kidori.new: 導線ボタンを押す
    __queueQuickPick({ label: "含めない（既定）", withStocks: false }); // ③ kidori.init: with-stocks 選択
    __queueInformationMessage(undefined); // ④ kidori.init: 結果サマリは見るだけ

    await activateExtension();
    await commands.executeCommand("kidori.new");

    // kidori.new が案内どおり kidori.init を実行し、ディレクトリが初期化される。
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "kidori.schema.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "stocks.yaml"))).toBe(false);
  });
});

describe("kidori.init: ディレクトリ初期化コマンド", () => {
  it("既定（with-stocks オプトインなし）で AGENTS.md 等を生成し、1行ずつ報告する", async () => {
    const dir = makeTmpDir("kidori-init-");
    __setWorkspaceFolders([{ uri: Uri.file(dir), name: "root", index: 0 }]);

    __queueQuickPick({ label: "含めない（既定）", withStocks: false });
    __queueInformationMessage(undefined);

    await activateExtension();
    await commands.executeCommand("kidori.init");

    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "kidori.schema.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "stocks.yaml"))).toBe(false);

    const lines = __getChannelLines("kidori");
    expect(lines.some((l) => l.includes("AGENTS.md"))).toBe(true);
    expect(lines.some((l) => l.includes("kidori.schema.json"))).toBe(true);
  });

  it("with-stocks を選ぶと stocks.yaml も生成される", async () => {
    const dir = makeTmpDir("kidori-init-stocks-");
    __setWorkspaceFolders([{ uri: Uri.file(dir), name: "root", index: 0 }]);

    __queueQuickPick({ label: "共有 stocks.yaml も生成する", withStocks: true });
    __queueInformationMessage(undefined);

    await activateExtension();
    await commands.executeCommand("kidori.init");

    expect(fs.existsSync(path.join(dir, "stocks.yaml"))).toBe(true);
  });

  it("2回実行しても結果は変わらない（冪等）", async () => {
    const dir = makeTmpDir("kidori-init-idempotent-");
    __setWorkspaceFolders([{ uri: Uri.file(dir), name: "root", index: 0 }]);

    __queueQuickPick({ label: "含めない（既定）", withStocks: false });
    __queueInformationMessage(undefined);
    await activateExtension();
    await commands.executeCommand("kidori.init");

    const agentsAfterFirst = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    // 出力チャンネルは activate() で一度だけ作られ、以降 appendLine が
    // 同じ配列へ蓄積し続ける（実際の VS Code の挙動どおり）。2回目の実行分だけを
    // 見るため、1回目終了時点の行数を境目として以降を切り出す。
    const linesAfterFirst = __getChannelLines("kidori").length;

    __queueQuickPick({ label: "含めない（既定）", withStocks: false });
    __queueInformationMessage(undefined);
    await commands.executeCommand("kidori.init");

    const agentsAfterSecond = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    expect(agentsAfterSecond).toBe(agentsAfterFirst);

    const secondRunLines = __getChannelLines("kidori").slice(linesAfterFirst);
    expect(secondRunLines.some((l) => l.includes("スキップ"))).toBe(true);
  });

  it("マルチルートではフォルダ選択の QuickPick を出し、選んだ側だけ初期化する", async () => {
    const dirA = makeTmpDir("kidori-init-a-");
    const dirB = makeTmpDir("kidori-init-b-");
    __setWorkspaceFolders([
      { uri: Uri.file(dirA), name: "a", index: 0 },
      { uri: Uri.file(dirB), name: "b", index: 1 },
    ]);

    __queueQuickPick({ fsPath: dirA }); // フォルダ選択 → A を選ぶ
    __queueQuickPick({ label: "含めない（既定）", withStocks: false });
    __queueInformationMessage(undefined);

    await activateExtension();
    await commands.executeCommand("kidori.init");

    expect(fs.existsSync(path.join(dirA, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(dirB, "AGENTS.md"))).toBe(false);
  });

  it("ワークスペース未オープンならエラーを出し、何も作らない", async () => {
    __setWorkspaceFolders([]);

    await activateExtension();
    await commands.executeCommand("kidori.init");

    const errorCalls = __recordedWindowCalls().filter(
      (c) => c.kind === "showErrorMessage",
    );
    expect(errorCalls.length).toBeGreaterThan(0);
  });
});
