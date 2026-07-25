/**
 * vitest 用の最小 `vscode` モジュールスタブ。
 *
 * `src/extension/preview.ts` は `import * as vscode from "vscode"` するが、
 * `vscode` は拡張ホストが実行時に提供するモジュールであり node_modules には
 * 存在しない。vitest.config.ts の resolve.alias でこのファイルへ差し替える。
 *
 * preview.ts が実際に触る API（window.createWebviewPanel / ViewColumn.Beside）
 * のみを実装する。生成された WebviewPanel は createdPanels に記録され、
 * テストから `webview.html` の実値を読み取れる。
 */

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
};
