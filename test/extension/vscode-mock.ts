/**
 * vitest 用の最小 `vscode` モジュールスタブ。
 *
 * `src/extension/preview.ts` は `import * as vscode from "vscode"` するが、
 * `vscode` は拡張ホストが実行時に提供するモジュールであり node_modules には
 * 存在しない。vitest.config.ts の resolve.alias でこのファイルへ差し替える。
 *
 * 元々は preview.ts が触る API（window.createWebviewPanel / ViewColumn.Beside）
 * のみを実装していた。test/extension/activation.test.ts のために
 * `src/extension/extension.ts` の `activate()` が触る API 一式（保存イベント・
 * コマンド登録・設定・診断・findFiles 等）を追加している。ただし
 * activate() 内の全経路を「本物同様に」動かすのではなく、
 * 「保存イベントの発火」「コマンドの実行」という2つの経路が実際に
 * KidoriPreview.update() まで到達することだけを検証できる最小限の忠実さに
 * とどめる（詳細は activation.test.ts のコメント参照）。
 *
 * 各 API の形は node_modules/@types/vscode/index.d.ts の型定義に合わせている
 * （関数シグネチャ・constructor overload・enum 値など）。
 */

import * as fs from "node:fs";

export const ViewColumn = {
  Beside: -2,
} as const;

export interface FakeWebview {
  html: string;
  postMessage(message: unknown): Thenable<boolean>;
  onDidReceiveMessage(listener: (msg: unknown) => void): { dispose(): void };
}

export interface FakeWebviewPanel {
  viewType: string;
  title: string;
  webview: FakeWebview;
  posted: unknown[];
  reveal(column?: unknown, preserveFocus?: boolean): void;
  dispose(): void;
  onDidDispose(listener: () => void): { dispose(): void };
}

/** show() のたびに生成されたパネルが push される（テストから参照する）。 */
export const createdPanels: FakeWebviewPanel[] = [];

export function __resetPanels(): void {
  createdPanels.length = 0;
}

/** window.activeTextEditor はテストから随時差し替える（findProjectFile が参照）。 */
const activeEditorState: { value: unknown } = { value: undefined };
export function __setActiveTextEditor(editor: unknown): void {
  activeEditorState.value = editor;
}

/** createOutputChannel(name) ごとに appendLine された行を溜める（テストから検証する）。 */
const channelLines = new Map<string, string[]>();
export function __getChannelLines(name: string): readonly string[] {
  return channelLines.get(name) ?? [];
}
export function __resetChannels(): void {
  channelLines.clear();
}

export const window = {
  createWebviewPanel(
    viewType: string,
    title: string,
    _showOptions: unknown,
    _options?: unknown,
  ): FakeWebviewPanel {
    const posted: unknown[] = [];
    const disposeListeners: (() => void)[] = [];
    const panel: FakeWebviewPanel = {
      viewType,
      title,
      posted,
      webview: {
        html: "",
        postMessage(message: unknown) {
          posted.push(message);
          return Promise.resolve(true);
        },
        onDidReceiveMessage() {
          return { dispose() {} };
        },
      },
      reveal() {},
      dispose() {
        for (const l of disposeListeners) l();
      },
      onDidDispose(listener: () => void) {
        disposeListeners.push(listener);
        return { dispose() {} };
      },
    };
    createdPanels.push(panel);
    return panel;
  },
  get activeTextEditor(): unknown {
    return activeEditorState.value;
  },
  createOutputChannel(name: string) {
    const lines = channelLines.get(name) ?? [];
    channelLines.set(name, lines);
    return {
      appendLine(line: string) {
        lines.push(line);
      },
      show(..._args: unknown[]) {
        // 実際にはパネルを表示するが、テストは表示状態を検証しない。
      },
      dispose() {},
    };
  },
  showWarningMessage(message: string, ...items: unknown[]): Thenable<string | undefined> {
    recordedCalls.push({ kind: "showWarningMessage", message, items });
    return Promise.resolve(undefined);
  },
  showErrorMessage(message: string, ...items: unknown[]): Thenable<string | undefined> {
    recordedCalls.push({ kind: "showErrorMessage", message, items });
    return Promise.resolve(undefined);
  },
  setStatusBarMessage(..._args: unknown[]): { dispose(): void } {
    return { dispose() {} };
  },
  showQuickPick(items: unknown, options?: unknown): Thenable<unknown | undefined> {
    recordedCalls.push({ kind: "showQuickPick", items, options });
    return Promise.resolve(shiftQueue(quickPickQueue));
  },
  showInputBox(options?: unknown): Thenable<string | undefined> {
    recordedCalls.push({ kind: "showInputBox", options });
    return Promise.resolve(shiftQueue(inputBoxQueue) as string | undefined);
  },
  showInformationMessage(message: string, ...items: unknown[]): Thenable<unknown | undefined> {
    recordedCalls.push({ kind: "showInformationMessage", message, items });
    return Promise.resolve(shiftQueue(informationMessageQueue));
  },
  showTextDocument(document: unknown, ..._rest: unknown[]): Thenable<unknown> {
    openedTextDocuments.push(document);
    return Promise.resolve({ document });
  },
};

// ---------------------------------------------------------------------------
// テストからの応答注入（showQuickPick / showInputBox / showInformationMessage）。
//
// 実際の VS Code はユーザー操作の結果を Thenable で返すが、テストからは
// あらかじめ「次に呼ばれたときの戻り値」を1件ずつ積んでおくことでこれを模擬する
// （呼ばれる順に1件ずつ消費し、積んでいなければ undefined＝キャンセル相当）。
// 併せて呼び出し内容（渡された items/options/message）も記録し、
// 「何を提示したか」をテストからアサートできるようにする。
// ---------------------------------------------------------------------------

const quickPickQueue: unknown[] = [];
const inputBoxQueue: unknown[] = [];
const informationMessageQueue: unknown[] = [];
export interface RecordedWindowCall {
  kind:
    | "showQuickPick"
    | "showInputBox"
    | "showInformationMessage"
    | "showWarningMessage"
    | "showErrorMessage";
  [key: string]: unknown;
}
const recordedCalls: RecordedWindowCall[] = [];

function shiftQueue<T>(queue: T[]): T | undefined {
  return queue.length > 0 ? queue.shift() : undefined;
}

export function __queueQuickPick(value: unknown): void {
  quickPickQueue.push(value);
}
export function __queueInputBox(value: string | undefined): void {
  inputBoxQueue.push(value);
}
export function __queueInformationMessage(value: unknown): void {
  informationMessageQueue.push(value);
}
export function __recordedWindowCalls(): readonly RecordedWindowCall[] {
  return recordedCalls;
}
export function __resetWindowMocks(): void {
  quickPickQueue.length = 0;
  inputBoxQueue.length = 0;
  informationMessageQueue.length = 0;
  recordedCalls.length = 0;
  openedTextDocuments.length = 0;
}

/** showTextDocument に渡されたドキュメント（テストから開いたファイルを検証する）。 */
export const openedTextDocuments: unknown[] = [];

// ---------------------------------------------------------------------------
// ここから extension.ts の activate() を動かすための追加スタブ。
// ---------------------------------------------------------------------------

/** vscode.Position（@types/vscode 準拠の最小実装）。 */
export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

/**
 * vscode.SnippetString の最小実装。
 *
 * `kidori.insertAssembly`（extension.ts）が `editor.insertSnippet` に渡すために
 * `new vscode.SnippetString(body)` する。展開（tabstop 解決）そのものは拡張
 * ホストの責務であり、ここでは `.value` に本文を保持するだけでよい
 * （completion.test.ts が独自にモックしているのと同じ最小さ。§ completion.ts
 * 冒頭コメント参照）。
 */
export class SnippetString {
  constructor(public value: string) {}
}

/** vscode.Range。(Position, Position) と (line,char,line,char) の両overloadに対応。 */
export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(
    a: number | Position,
    b: number | Position,
    c?: number,
    d?: number,
  ) {
    if (typeof a === "number") {
      this.start = new Position(a, b as number);
      this.end = new Position(c as number, d as number);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
}

class UriImpl {
  constructor(public readonly fsPath: string) {}
  get scheme(): string {
    return "file";
  }
  get path(): string {
    return this.fsPath;
  }
  toString(): string {
    return `file://${this.fsPath}`;
  }
}

export const Uri = {
  file(fsPath: string): UriImpl {
    return new UriImpl(fsPath);
  },
};

export const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
} as const;

export class Diagnostic {
  source?: string;
  constructor(
    public range: Range,
    public message: string,
    public severity: number = DiagnosticSeverity.Error,
  ) {}
}

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

export const extensions = {
  /** redhat.vscode-yaml は常に「未導入」を返す（registerYamlSchemaContributor は false 経路）。 */
  getExtension(_id: string): undefined {
    return undefined;
  },
};

/**
 * `languages.createDiagnosticCollection(...).set(...)` の内容をテストから検証
 * できるようにする（U-EXT。編集時再評価の debounce・パース不能時の前回診断
 * 維持を検証するには、診断コレクションの中身を外から覗く手段が要る）。
 * `__getChannelLines` と同じ「モジュール単位のシンク」パターン。
 *
 * コレクション名ごとに独立したストアを持つ（extension.ts の "kidori" と
 * presets.ts の StockShadowReporter が持つ "kidori-stocks" は別物であり、
 * 同一 URI に対して独立に set/delete する。名前を無視して単一マップに
 * 共有すると、shadow 側の「シャドウ無し」判定（`delete(uri)`）が
 * "kidori" 側の診断を巻き添えで消してしまう）。
 */
const diagnosticsStore = new Map<string, Map<string, unknown[]>>();
export function __getDiagnostics(
  uriString: string,
  collectionName = "kidori",
): readonly unknown[] {
  return diagnosticsStore.get(collectionName)?.get(uriString) ?? [];
}
export function __resetDiagnosticsStore(): void {
  diagnosticsStore.clear();
}

export const languages = {
  createDiagnosticCollection(name = "kidori") {
    let store = diagnosticsStore.get(name);
    if (!store) {
      store = new Map<string, unknown[]>();
      diagnosticsStore.set(name, store);
    }
    const collection = store;
    return {
      set(uri: { toString(): string }, diags: unknown[]) {
        collection.set(uri.toString(), diags);
      },
      delete(uri: { toString(): string }) {
        collection.delete(uri.toString());
      },
      clear() {
        collection.clear();
      },
      dispose() {},
    };
  },
  registerCompletionItemProvider(
    _selector: unknown,
    _provider: unknown,
    ..._triggerCharacters: string[]
  ): { dispose(): void } {
    // completion.ts の provideCompletionItems は本テストの対象経路から
    // 呼び出されないため、登録を受理するだけの no-op。
    return { dispose() {} };
  },
  registerHoverProvider(_selector: unknown, _provider: unknown): { dispose(): void } {
    // hover.ts の provideHover も同様に本テストの対象経路からは呼び出されない
    // （U-EXT）。registerCompletionItemProvider と同じ理由の no-op。
    return { dispose() {} };
  },
};

// --- コマンド登録／実行。vscode.commands.executeCommand は実際の API と同名・同形。
const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  registerCommand(
    id: string,
    callback: (...args: unknown[]) => unknown,
  ): { dispose(): void } {
    commandRegistry.set(id, callback);
    return {
      dispose() {
        commandRegistry.delete(id);
      },
    };
  },
  executeCommand(id: string, ...args: unknown[]): Thenable<unknown> {
    const callback = commandRegistry.get(id);
    if (!callback) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(callback(...args));
  },
};
export function __resetCommands(): void {
  commandRegistry.clear();
}
/** コマンドが実際に registerCommand されているか（"command not found" の回帰検知）。 */
export function __isCommandRegistered(id: string): boolean {
  return commandRegistry.has(id);
}

// --- workspace.getConfiguration。section 単位のフラットな key→value ストア。
const configStore = new Map<string, Map<string, unknown>>();

export function __setConfig(section: string, key: string, value: unknown): void {
  let m = configStore.get(section);
  if (!m) {
    m = new Map();
    configStore.set(section, m);
  }
  m.set(key, value);
}
export function __resetConfig(): void {
  configStore.clear();
}

function getConfiguration(section?: string) {
  const key = section ?? "";
  return {
    get<T>(settingKey: string, defaultValue?: T): T {
      const m = configStore.get(key);
      if (m && m.has(settingKey)) {
        return m.get(settingKey) as T;
      }
      return defaultValue as T;
    },
    update(settingKey: string, value: unknown, _target?: unknown): Thenable<void> {
      let m = configStore.get(key);
      if (!m) {
        m = new Map();
        configStore.set(key, m);
      }
      m.set(settingKey, value);
      return Promise.resolve();
    },
  };
}

// --- ワークスペースフォルダ。loadPresets / getWorkspaceFolder が参照する。
interface FakeWorkspaceFolder {
  uri: UriImpl;
  name: string;
  index: number;
}
const workspaceFoldersState: { value: FakeWorkspaceFolder[] } = { value: [] };
export function __setWorkspaceFolders(folders: FakeWorkspaceFolder[]): void {
  workspaceFoldersState.value = folders;
}

// --- onDidSaveTextDocument。実際の VS Code では拡張ホストが発火させる
// イベントであり、拡張側から発火させる公開 API は無い。ここでは
// 「拡張ホストがファイル保存を検知してリスナーを呼ぶ」動作そのものを
// テストのために模擬する __fireDidSave を用意する。これは
// 「保存経路のハンドラが正しく登録され、正しく動くか」を検証するためのもので
// あり、「VS Code 本体が実際に保存を検知する」ことまでは検証しない。
type TextDocumentLike = { uri: UriImpl; fsPath?: string };
const saveListeners: ((doc: TextDocumentLike) => void)[] = [];
export function __fireDidSave(doc: TextDocumentLike): void {
  for (const listener of [...saveListeners]) {
    listener(doc);
  }
}
export function __resetSaveListeners(): void {
  saveListeners.length = 0;
}

// --- onDidChangeTextDocument。__fireDidSave と同じ理由で、拡張ホストが
// 編集イベントを検知してリスナーを呼ぶ動作を模擬する（U-EXT: 編集時再評価の
// debounce・パース不能時の前回診断維持を検証するのに使う）。activate() は
// 本イベントに2本のリスナー（スキーマ用 300ms debounce・診断用 500ms
// debounce）を登録するため、`__fireDidChangeTextDocument` は登録済みの
// **全リスナー**を順に呼ぶ（save/close と異なり複数登録を前提にする）。
type ChangeEvent = { document: TextDocumentLike & { getText(): string } };
const changeListeners: ((e: ChangeEvent) => void)[] = [];
export function __fireDidChangeTextDocument(e: ChangeEvent): void {
  for (const listener of [...changeListeners]) {
    listener(e);
  }
}
export function __resetChangeListeners(): void {
  changeListeners.length = 0;
}

// --- onDidCloseTextDocument。__fireDidSave と同じ理由で、拡張ホストが
// ドキュメントを閉じたことを検知してリスナーを呼ぶ動作を模擬する。
const closeListeners: ((doc: TextDocumentLike) => void)[] = [];
export function __fireDidClose(doc: TextDocumentLike): void {
  for (const listener of [...closeListeners]) {
    listener(doc);
  }
}
export function __resetCloseListeners(): void {
  closeListeners.length = 0;
}

/** vscode.workspace.openTextDocument が返す TextDocument の最小実装。 */
function makeTextDocument(fsPath: string) {
  const text = fs.readFileSync(fsPath, "utf-8");
  const lines = text.split(/\r\n|\r|\n/);
  return {
    uri: Uri.file(fsPath),
    fileName: fsPath,
    languageId: fsPath.endsWith(".json") ? "json" : "yaml",
    getText(): string {
      return text;
    },
    lineAt(line: number): { text: string } {
      return { text: lines[line] ?? "" };
    },
    positionAt(offset: number): Position {
      let remaining = offset;
      for (let i = 0; i < lines.length; i++) {
        const lineLength = lines[i].length;
        if (remaining <= lineLength) {
          return new Position(i, remaining);
        }
        remaining -= lineLength + 1; // +1: 改行1文字ぶん
      }
      const lastLine = Math.max(lines.length - 1, 0);
      return new Position(lastLine, lines[lastLine]?.length ?? 0);
    },
  };
}

export const workspace = {
  get workspaceFolders(): FakeWorkspaceFolder[] | undefined {
    return workspaceFoldersState.value.length > 0 ? workspaceFoldersState.value : undefined;
  },
  textDocuments: [] as unknown[],
  getConfiguration,
  createFileSystemWatcher(_globPattern: unknown) {
    // presetWatcher / projectJsonWatcher 用。本テストの2経路
    // （保存・kidori.build コマンド）はファイル監視イベントに依存しないため、
    // 登録を受理するだけの no-op（発火は一切テストしない）。
    return {
      onDidChange(_listener: unknown) {
        return { dispose() {} };
      },
      onDidCreate(_listener: unknown) {
        return { dispose() {} };
      },
      onDidDelete(_listener: unknown) {
        return { dispose() {} };
      },
      dispose() {},
    };
  },
  onDidOpenTextDocument(_listener: unknown): { dispose(): void } {
    // contributor.update 用。本テストの対象経路からは発火させない。
    return { dispose() {} };
  },
  onDidChangeTextDocument(
    listener: (e: ChangeEvent) => void,
  ): { dispose(): void } {
    changeListeners.push(listener);
    return {
      dispose() {
        const i = changeListeners.indexOf(listener);
        if (i >= 0) changeListeners.splice(i, 1);
      },
    };
  },
  onDidCloseTextDocument(
    listener: (doc: TextDocumentLike) => void,
  ): { dispose(): void } {
    closeListeners.push(listener);
    return {
      dispose() {
        const i = closeListeners.indexOf(listener);
        if (i >= 0) closeListeners.splice(i, 1);
      },
    };
  },
  onDidSaveTextDocument(
    listener: (doc: TextDocumentLike) => void,
  ): { dispose(): void } {
    saveListeners.push(listener);
    return {
      dispose() {
        const i = saveListeners.indexOf(listener);
        if (i >= 0) saveListeners.splice(i, 1);
      },
    };
  },
  findFiles(
    _include: unknown,
    _exclude?: unknown,
    _maxResults?: number,
  ): Thenable<UriImpl[]> {
    // 実ファイルシステムを glob 走査する本物の findFiles は再現しない
    // （本テストの2経路は window.activeTextEditor 経由で対象ファイルを
    // 決定させるため、findFiles の結果には依存しない）。常に空を返す。
    return Promise.resolve([]);
  },
  getWorkspaceFolder(uri: { fsPath: string }): FakeWorkspaceFolder | undefined {
    return workspaceFoldersState.value.find((f) => uri.fsPath.startsWith(f.uri.fsPath));
  },
  openTextDocument(uri: { fsPath: string }): Thenable<ReturnType<typeof makeTextDocument>> {
    return Promise.resolve(makeTextDocument(uri.fsPath));
  },
};
