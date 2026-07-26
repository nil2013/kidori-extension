/**
 * `vscode` モジュールの拡張版スタブ（`test/extension/vscode-mock.ts` の上位互換）。
 *
 * 既存の `vscode-mock.ts` は「保存イベント・コマンド実行がプレビュー更新に
 * 到達するか」を見る最小限のスタブで、正本の書き換え経路（WorkspaceEdit /
 * applyEdit / TextDocument.save / Webview からのメッセージ受信）を持たない。
 * `settings.selectedPlan` の書き換え先が**表示中のプロジェクトであること**
 * （SPECS.md §3「1ファイル=1プロジェクト」）を検証するにはそれらが要るため、
 * 本ファイルで必要な面を足したスタブを用意し、当該テストからのみ
 * `vi.mock("vscode", …)` で差し替えて使う。
 *
 * 忠実さの範囲:
 *   - `applyEdit` は「WorkspaceEdit に積まれたテキストでファイルを丸ごと
 *     置き換える」。extension.ts の `applySelection` は常に文書全体を対象に
 *     replace するため、この単純化で挙動は一致する（範囲の部分置換は未実装）。
 *   - `openTextDocument` はディスクから読み直す（applyEdit の結果が見える）。
 *   - それ以外（診断の内容・補完・findFiles の glob 走査）は vscode-mock.ts と
 *     同様に no-op のままで、テストは検証しない。
 */

import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// 基本型
// ---------------------------------------------------------------------------

export const ViewColumn = { Beside: -2 } as const;

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
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
  getExtension(_id: string): undefined {
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Webview パネル（メッセージ受信リスナを保持する点が vscode-mock.ts との差）
// ---------------------------------------------------------------------------

export interface RichPanel {
  viewType: string;
  title: string;
  webview: {
    html: string;
    postMessage(message: unknown): Thenable<boolean>;
    onDidReceiveMessage(listener: (msg: unknown) => void): { dispose(): void };
  };
  posted: unknown[];
  /** テスト専用: Webview から拡張へメッセージを送る。 */
  __receive(message: unknown): void;
  reveal(): void;
  dispose(): void;
  onDidDispose(listener: () => void): { dispose(): void };
}

export const createdPanels: RichPanel[] = [];
export function __resetPanels(): void {
  createdPanels.length = 0;
}

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
  ): RichPanel {
    const posted: unknown[] = [];
    const disposeListeners: (() => void)[] = [];
    const messageListeners: ((msg: unknown) => void)[] = [];
    const panel: RichPanel = {
      viewType,
      title,
      posted,
      webview: {
        html: "",
        postMessage(message: unknown) {
          posted.push(message);
          return Promise.resolve(true);
        },
        onDidReceiveMessage(listener: (msg: unknown) => void) {
          messageListeners.push(listener);
          return { dispose() {} };
        },
      },
      __receive(message: unknown) {
        for (const listener of [...messageListeners]) {
          listener(message);
        }
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
      appendLine(_line: string) {},
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
// languages / commands / configuration
// ---------------------------------------------------------------------------

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
    return { dispose() {} };
  },
  registerHoverProvider(_selector: unknown, _provider: unknown): { dispose(): void } {
    return { dispose() {} };
  },
};

const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  registerCommand(id: string, callback: (...args: unknown[]) => unknown): { dispose(): void } {
    commandRegistry.set(id, callback);
    return {
      dispose() {
        commandRegistry.delete(id);
      },
    };
  },
  executeCommand(id: string, ...args: unknown[]): Thenable<unknown> {
    const callback = commandRegistry.get(id);
    return callback ? Promise.resolve(callback(...args)) : Promise.resolve(undefined);
  },
};
export function __resetCommands(): void {
  commandRegistry.clear();
}

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
      return m && m.has(settingKey) ? (m.get(settingKey) as T) : (defaultValue as T);
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

// ---------------------------------------------------------------------------
// workspace（正本の書き換え経路を実装する）
// ---------------------------------------------------------------------------

interface FakeWorkspaceFolder {
  uri: UriImpl;
  name: string;
  index: number;
}
const workspaceFoldersState: { value: FakeWorkspaceFolder[] } = { value: [] };
export function __setWorkspaceFolders(folders: FakeWorkspaceFolder[]): void {
  workspaceFoldersState.value = folders;
}

type DocLike = { uri: { fsPath: string } };
const saveListeners: ((doc: DocLike) => void)[] = [];
export function __fireDidSave(doc: DocLike): void {
  for (const listener of [...saveListeners]) {
    listener(doc);
  }
}
const closeListeners: ((doc: DocLike) => void)[] = [];
export function __fireDidClose(doc: DocLike): void {
  for (const listener of [...closeListeners]) {
    listener(doc);
  }
}
export function __resetListeners(): void {
  saveListeners.length = 0;
  closeListeners.length = 0;
}

function makeTextDocument(fsPath: string) {
  const text = fs.readFileSync(fsPath, "utf-8");
  const lines = text.split(/\r\n|\r|\n/);
  return {
    uri: Uri.file(fsPath),
    fileName: fsPath,
    languageId: fsPath.endsWith(".json") ? "json" : "yaml",
    getText: (): string => text,
    lineAt: (line: number): { text: string } => ({ text: lines[line] ?? "" }),
    positionAt(offset: number): Position {
      let remaining = offset;
      for (let i = 0; i < lines.length; i++) {
        if (remaining <= lines[i].length) {
          return new Position(i, remaining);
        }
        remaining -= lines[i].length + 1;
      }
      const last = Math.max(lines.length - 1, 0);
      return new Position(last, lines[last]?.length ?? 0);
    },
    /** 実際の保存は applyEdit が済ませているため no-op（保存イベントは発火しない）。 */
    save: (): Thenable<boolean> => Promise.resolve(true),
  };
}

/** vscode.WorkspaceEdit の最小実装（全文置換のみ）。 */
export class WorkspaceEdit {
  readonly edits: { fsPath: string; text: string }[] = [];
  replace(uri: { fsPath: string }, _range: unknown, newText: string): void {
    this.edits.push({ fsPath: uri.fsPath, text: newText });
  }
}

export const workspace = {
  get workspaceFolders(): FakeWorkspaceFolder[] | undefined {
    return workspaceFoldersState.value.length > 0 ? workspaceFoldersState.value : undefined;
  },
  textDocuments: [] as unknown[],
  getConfiguration,
  createFileSystemWatcher(_globPattern: unknown) {
    return {
      onDidChange: () => ({ dispose() {} }),
      onDidCreate: () => ({ dispose() {} }),
      onDidDelete: () => ({ dispose() {} }),
      dispose() {},
    };
  },
  onDidOpenTextDocument(_listener: unknown): { dispose(): void } {
    return { dispose() {} };
  },
  onDidChangeTextDocument(_listener: unknown): { dispose(): void } {
    return { dispose() {} };
  },
  onDidCloseTextDocument(listener: (doc: DocLike) => void): { dispose(): void } {
    closeListeners.push(listener);
    return { dispose() {} };
  },
  onDidSaveTextDocument(listener: (doc: DocLike) => void): { dispose(): void } {
    saveListeners.push(listener);
    return {
      dispose() {
        const i = saveListeners.indexOf(listener);
        if (i >= 0) saveListeners.splice(i, 1);
      },
    };
  },
  findFiles(_include: unknown, _exclude?: unknown, _max?: number): Thenable<UriImpl[]> {
    return Promise.resolve([]);
  },
  getWorkspaceFolder(uri: { fsPath: string }): FakeWorkspaceFolder | undefined {
    return workspaceFoldersState.value.find((f) => uri.fsPath.startsWith(f.uri.fsPath));
  },
  openTextDocument(uri: { fsPath: string }): Thenable<ReturnType<typeof makeTextDocument>> {
    return Promise.resolve(makeTextDocument(uri.fsPath));
  },
  applyEdit(edit: WorkspaceEdit): Thenable<boolean> {
    for (const { fsPath, text } of edit.edits) {
      fs.writeFileSync(fsPath, text, "utf-8");
    }
    return Promise.resolve(true);
  },
};
