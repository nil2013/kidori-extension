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
  createOutputChannel(_name: string) {
    return {
      appendLine(_line: string) {
        // extension.ts はログ文字列を投げるだけ。テストは内容を検証しない。
      },
      dispose() {},
    };
  },
  showWarningMessage(..._args: unknown[]): Thenable<string | undefined> {
    return Promise.resolve(undefined);
  },
  showErrorMessage(..._args: unknown[]): Thenable<string | undefined> {
    return Promise.resolve(undefined);
  },
  setStatusBarMessage(..._args: unknown[]): { dispose(): void } {
    return { dispose() {} };
  },
  showQuickPick(..._args: unknown[]): Thenable<unknown | undefined> {
    return Promise.resolve(undefined);
  },
};

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

export const languages = {
  createDiagnosticCollection(_name?: string) {
    const store = new Map<string, unknown[]>();
    return {
      set(uri: { toString(): string }, diags: unknown[]) {
        store.set(uri.toString(), diags);
      },
      delete(uri: { toString(): string }) {
        store.delete(uri.toString());
      },
      clear() {
        store.clear();
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
  onDidChangeTextDocument(_listener: unknown): { dispose(): void } {
    return { dispose() {} };
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
