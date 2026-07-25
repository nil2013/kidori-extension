/**
 * 規格材マスタの拡張側ラッパ（SPECS.md §4b）。
 *
 * カスケードの本体（型・層の読み込み・マージ・実体化）は `vscode` 非依存の
 * `src/core/stocks/` にある（拡張と CLI が同じ実装・同じユーザー層ファイルを
 * 使うため。SPECS.md §3・§4b）。本モジュールに残すのは vscode API に依存する
 * 部分だけ:
 *   - `loadStockMaster(context)` … ExtensionContext からの読み込み
 *   - `StockShadowReporter`      … シャドウの診断・出力チャンネル通知
 */

import * as vscode from "vscode";

import {
  StockMaster,
  loadStockMasterFrom,
  resolveCascade,
  shadowMessage,
} from "../core/stocks";

export type { StockMaster };

/** 拡張から規格材マスタを読み込む（ExtensionContext 版）。 */
export function loadStockMaster(context: vscode.ExtensionContext): StockMaster {
  return loadStockMasterFrom(context.extensionPath);
}

// ---------------------------------------------------------------------------
// シャドウ診断（SPECS.md §4b「同一キーのシャドウ時は診断で通知」）
// ---------------------------------------------------------------------------

export interface ShadowSinks {
  /** ファイル上に出す Information 診断の置き場。 */
  diagnostics: vscode.DiagnosticCollection;
  /** 開いていないファイル由来のシャドウを1行で流す先。 */
  channel: { appendLine(line: string): void };
}

/**
 * offsets → Range 変換に必要な最小の TextDocument 面。
 * vscode.TextDocument そのものを要求せず構造的に受けることで、
 * 診断の位置決めロジックをテストから直接実行できるようにする。
 */
interface PositionSource {
  uri: { fsPath: string; toString(): string };
  positionAt(offset: number): { line: number; character: number };
}

/**
 * シャドウ通知の発行者。
 *
 * severity は Information で統一する。「近い層が勝つ」はカスケードの設計
 * そのものであり、シャドウは正当な操作であるため（SPECS.md §4b の文言も
 * 「診断で通知」であって警告ではない）。
 *
 * 出し先:
 *   (i)   ファイル層が下層を隠す   → 編集中ドキュメントの当該エントリ範囲に診断
 *   (ii)  ディレクトリ層が隠す     → その stocks.yaml が開いていれば診断、
 *                                    開いていなければ出力チャンネルに1行
 *   (iii) ユーザー層がビルトインを隠す → 出力チャンネルのみ
 *         （ビルトインの上書きは想定用途の中心なので静かに）
 */
export class StockShadowReporter {
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly channel: { appendLine(line: string): void };
  private readonly ownsDiagnostics: boolean;
  /** 出力チャンネルへ同じ行を撒き続けないための既出集合。 */
  private readonly reported = new Set<string>();
  /**
   * 直前に診断を出した「編集中ドキュメント以外」の URI（ディレクトリ層の
   * stocks.yaml）。シャドウが解消したときに取り下げるために保持する。
   */
  private readonly sideEffects = new Map<string, vscode.Uri>();

  constructor(
    private readonly getMaster: () => StockMaster,
    sinks?: Partial<ShadowSinks>,
  ) {
    this.ownsDiagnostics = sinks?.diagnostics === undefined;
    this.diagnostics =
      sinks?.diagnostics ?? vscode.languages.createDiagnosticCollection("kidori-stocks");
    this.channel = sinks?.channel ?? vscode.window.createOutputChannel("kidori");
  }

  /** ドキュメント1枚ぶんのシャドウ通知を更新する。 */
  update(document: PositionSource & { getText(): string }): void {
    const cascade = resolveCascade(this.getMaster(), {
      documentPath: document.uri.fsPath,
      documentText: document.getText(),
    });

    const diags: vscode.Diagnostic[] = [];
    const byOrigin = new Map<string, vscode.Diagnostic[]>();

    for (const shadow of cascade.shadows) {
      const message = shadowMessage(shadow);
      const winner = shadow.winner;
      if (winner.layer === "file") {
        diags.push(this.makeDiagnostic(document, winner.offsets, message));
        continue;
      }
      if (winner.layer === "directory") {
        const opened = findOpenDocument(winner.origin);
        if (opened) {
          const list = byOrigin.get(winner.origin) ?? [];
          list.push(this.makeDiagnostic(opened, winner.offsets, message));
          byOrigin.set(winner.origin, list);
          continue;
        }
        this.log(`${message}（${winner.origin}）`);
        continue;
      }
      // (iii) ユーザー層 → ビルトイン層。
      this.log(`${message}（${winner.origin}）`);
    }

    this.diagnostics.set(document.uri as vscode.Uri, diags);

    // シャドウが解消した stocks.yaml の診断を取り下げてから、今回ぶんを出す。
    for (const [origin, uri] of this.sideEffects) {
      if (!byOrigin.has(origin)) {
        this.diagnostics.delete(uri);
        this.sideEffects.delete(origin);
      }
    }
    for (const [origin, list] of byOrigin) {
      const opened = findOpenDocument(origin);
      if (opened) {
        this.diagnostics.set(opened.uri as vscode.Uri, list);
        this.sideEffects.set(origin, opened.uri as vscode.Uri);
      }
    }
  }

  /** ドキュメントを閉じた等で通知を取り下げる。 */
  clear(uri: vscode.Uri): void {
    this.diagnostics.delete(uri);
  }

  dispose(): void {
    if (this.ownsDiagnostics) {
      this.diagnostics.dispose();
    }
  }

  private log(line: string): void {
    if (this.reported.has(line)) {
      return;
    }
    this.reported.add(line);
    this.channel.appendLine(`[stocks] ${line}`);
  }

  private makeDiagnostic(
    document: PositionSource,
    offsets: [number, number] | undefined,
    message: string,
  ): vscode.Diagnostic {
    let range = new vscode.Range(0, 0, 0, 0);
    if (offsets) {
      const start = document.positionAt(offsets[0]);
      const end = document.positionAt(offsets[1]);
      range = new vscode.Range(start.line, start.character, end.line, end.character);
    }
    const diagnostic = new vscode.Diagnostic(
      range,
      message,
      vscode.DiagnosticSeverity.Information,
    );
    diagnostic.source = "kidori";
    return diagnostic;
  }
}

function findOpenDocument(fsPath: string): (PositionSource & { getText(): string }) | null {
  for (const doc of vscode.workspace.textDocuments as unknown as (PositionSource & {
    getText(): string;
  })[]) {
    if (doc.uri?.fsPath === fsPath) {
      return doc;
    }
  }
  return null;
}
