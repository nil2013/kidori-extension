/**
 * シャドウ通知の発行（SPECS.md §4b「同一キーのシャドウ時は診断で通知」）の検証。
 *
 * 対象: src/extension/presets.ts の StockShadowReporter（vscode 依存部）。
 *   - severity が Information で統一されていること
 *   - 通知先の振り分け
 *       (i)   ファイル内エントリが下層を隠す → 編集中ドキュメントの当該範囲に診断
 *       (ii)  ディレクトリ層が隠す → その stocks.yaml が開いていれば診断、
 *             開いていなければ出力チャンネルに1行
 *       (iii) ユーザー層がビルトインを隠す → 出力チャンネルのみ
 *   - シャドウ解消時に stocks.yaml 側の診断を取り下げること
 *
 * カスケードそのもの（マージ規則・キー解決・シャドウ検出とメッセージ）は
 * vscode 非依存なので test/core/stocks.test.ts が受け持つ。
 *
 * --- このテストが検証しないこと ---
 *   - VS Code 本体が診断を表示する挙動。DiagnosticCollection / OutputChannel は
 *     記録用スタブを注入し、「何をどこへ出したか」までを検証する。
 *   - Reporter の呼び出し配線（extension.ts の責務。現状は未配線＝申し送り事項）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadBuiltinLayer, StockMaster } from "../../src/core/stocks";
import { ShadowSinks, StockShadowReporter } from "../../src/extension/presets";
import { Position, Range, workspace } from "./vscode-mock";

const repoRoot = path.resolve(__dirname, "../..");

/** テスト用ドキュメント（PositionSource + getText の最小実装）。 */
function fakeDocument(fsPath: string, text: string) {
  const lines = text.split(/\r\n|\r|\n/);
  return {
    uri: { fsPath, toString: () => `file://${fsPath}` },
    getText: () => text,
    positionAt(offset: number): Position {
      let remaining = offset;
      for (let i = 0; i < lines.length; i++) {
        if (remaining <= lines[i].length) {
          return new Position(i, remaining);
        }
        remaining -= lines[i].length + 1;
      }
      return new Position(Math.max(lines.length - 1, 0), 0);
    },
  };
}

// ---------------------------------------------------------------------------

describe("シャドウ通知（severity は Information で統一）", () => {

  /** 注入用の DiagnosticCollection / OutputChannel の記録スタブ。 */
  function makeSinks() {
    const store = new Map<string, unknown[]>();
    const lines: string[] = [];
    return {
      store,
      lines,
      sinks: {
        diagnostics: {
          set(uri: { toString(): string }, diags: unknown[]) {
            store.set(uri.toString(), diags);
          },
          delete(uri: { toString(): string }) {
            store.delete(uri.toString());
          },
          dispose() {},
        } as unknown as ShadowSinks["diagnostics"],
        channel: {
          appendLine(line: string) {
            lines.push(line);
          },
        },
      },
    };
  }

  let tmpDir: string;
  let xdgDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-shadow-"));
    xdgDir = path.join(tmpDir, "config");
    projectDir = path.join(tmpDir, "diy");
    fs.mkdirSync(path.join(xdgDir, "kidori"), { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    workspace.textDocuments = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    workspace.textDocuments = [];
  });

  function master(): StockMaster {
    return {
      builtin: loadBuiltinLayer(repoRoot),
      userStocksPath: path.join(xdgDir, "kidori", "stocks.yaml"),
    };
  }

  it("(i) ファイル内エントリが下層を隠すと、その範囲に Information 診断が出る", () => {
    fs.writeFileSync(
      path.join(xdgDir, "kidori", "stocks.yaml"),
      `stocks:\n  - { id: 1x4-6f, preset: spf/1x4/6f, kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }\n`,
      "utf-8",
    );
    const docPath = path.join(projectDir, "bookshelf.kidori.yaml");
    const text = `stocks:\n  - { id: 1x4-6f, preset: spf/1x4/6f, kind: bar, length: 1800, width: 89, thickness: 19, price: 382 }\n`;
    const { store, lines, sinks } = makeSinks();
    const reporter = new StockShadowReporter(master, sinks);

    reporter.update(fakeDocument(docPath, text));

    const diags = store.get(`file://${docPath}`) as {
      severity: number;
      message: string;
      range: Range;
      source?: string;
    }[];
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe(2); // DiagnosticSeverity.Information
    expect(diags[0].source).toBe("kidori");
    expect(diags[0].message).toContain("spf/1x4/6f");
    // 値が異なるので両層の値を併記する。
    expect(diags[0].message).toContain("1800");
    expect(diags[0].message).toContain("1820");
    // 当該エントリの範囲（1行目）を指す。
    expect(diags[0].range.start.line).toBe(1);
    // ユーザー層→ビルトイン層のシャドウは出力チャンネルのみ。
    expect(lines.some((l) => l.includes("ユーザー層"))).toBe(true);
    expect(diags.some((d) => d.message.includes("ユーザー層の定義"))).toBe(false);
  });

  it("(ii) ディレクトリ層のシャドウは、その stocks.yaml が開いていなければ出力チャンネルへ", () => {
    fs.writeFileSync(
      path.join(projectDir, "stocks.yaml"),
      `stocks:\n  - { id: 1x4-6f, preset: spf/1x4/6f, kind: bar, length: 1900, width: 89, thickness: 19 }\n`,
      "utf-8",
    );
    const docPath = path.join(projectDir, "bookshelf.kidori.yaml");
    const { store, lines, sinks } = makeSinks();
    new StockShadowReporter(master, sinks).update(fakeDocument(docPath, "parts: []\n"));

    expect(store.get(`file://${docPath}`)).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ディレクトリ層");
    expect(lines[0]).toContain(path.join(projectDir, "stocks.yaml"));
  });

  it("(ii) その stocks.yaml が開いていれば、そちらに診断を出す", () => {
    const stocksPath = path.join(projectDir, "stocks.yaml");
    const stocksText = `stocks:\n  - { id: 1x4-6f, preset: spf/1x4/6f, kind: bar, length: 1900, width: 89, thickness: 19 }\n`;
    fs.writeFileSync(stocksPath, stocksText, "utf-8");
    workspace.textDocuments = [fakeDocument(stocksPath, stocksText)];

    const docPath = path.join(projectDir, "bookshelf.kidori.yaml");
    const { store, lines, sinks } = makeSinks();
    new StockShadowReporter(master, sinks).update(fakeDocument(docPath, "parts: []\n"));

    expect(lines).toEqual([]);
    const diags = store.get(`file://${stocksPath}`) as { message: string; range: Range }[];
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("ディレクトリ層");
    expect(diags[0].range.start.line).toBe(1);
  });

  it("(ii) シャドウが解消したら stocks.yaml 側の診断を取り下げる", () => {
    const stocksPath = path.join(projectDir, "stocks.yaml");
    const shadowing = `stocks:\n  - { id: 1x4-6f, preset: spf/1x4/6f, kind: bar, length: 1900, width: 89, thickness: 19 }\n`;
    fs.writeFileSync(stocksPath, shadowing, "utf-8");
    workspace.textDocuments = [fakeDocument(stocksPath, shadowing)];

    const docPath = path.join(projectDir, "bookshelf.kidori.yaml");
    const { store, sinks } = makeSinks();
    const reporter = new StockShadowReporter(master, sinks);
    reporter.update(fakeDocument(docPath, "parts: []\n"));
    expect(store.has(`file://${stocksPath}`)).toBe(true);

    // マスタキーを持たない独自材だけになればシャドウは消える。
    const clean = `stocks:\n  - { id: my-oak, kind: sheet, length: 1800, width: 900, thickness: 20 }\n`;
    fs.writeFileSync(stocksPath, clean, "utf-8");
    workspace.textDocuments = [fakeDocument(stocksPath, clean)];
    reporter.update(fakeDocument(docPath, "parts: []\n"));
    expect(store.has(`file://${stocksPath}`)).toBe(false);
  });

  it("(iii) ユーザー層がビルトインを隠す場合は出力チャンネルのみ・同じ行は繰り返さない", () => {
    fs.writeFileSync(
      path.join(xdgDir, "kidori", "stocks.yaml"),
      `stocks:\n  - { id: 1x4-6f, preset: spf/1x4/6f, kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }\n`,
      "utf-8",
    );
    const docPath = path.join(projectDir, "bookshelf.kidori.yaml");
    const { store, lines, sinks } = makeSinks();
    const reporter = new StockShadowReporter(master, sinks);
    reporter.update(fakeDocument(docPath, "parts: []\n"));
    reporter.update(fakeDocument(docPath, "parts: []\n"));

    expect(store.get(`file://${docPath}`)).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ユーザー層");
  });
});
