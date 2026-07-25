/**
 * extension/preview.ts が Webview に流し込む HTML の単体テスト。
 *
 * 背景: html() は HTML 全体を1つの外側テンプレートリテラルとして組み立て、
 * その中にインライン `<script>` を「文字列として」同梱している。そのため
 * 内側スクリプト向けに書いたつもりのエスケープ（`\n` など）が、外側の
 * テンプレートリテラルに先に消費される事故が起きうる。実際に v0.4.0 では
 * エラーバナー文字列の `\n` が外側で生の改行に化け、インラインスクリプト全体が
 * SyntaxError でパース不能になり、タブ切り替え・postMessage 受信の
 * すべてが無反応になった。
 *
 * 検証観点:
 *   1. 生成 HTML 中のすべての `<script>` が JavaScript としてパース可能なこと
 *      （node:vm でコンパイルのみ行い、実行はしない）。
 *   2. タブボタンの id と、それらへの click リスナ登録がスクリプト中に在ること。
 *   3. stale 警告バナーの文字列が1行の文字列リテラルであり、改行が `\n`
 *      エスケープとして残っていること（上記事故そのものの回帰検知）。
 */

import * as vm from "node:vm";

import { beforeEach, describe, expect, it } from "vitest";

import { KidoriPreview } from "../../src/extension/preview";
import { __resetPanels, createdPanels } from "./vscode-mock";

/**
 * html() は private のため、テストからは公開経路である show() を通して
 * webview.html に実際に代入された文字列を取得する。private メソッドを
 * `as any` で叩くより、拡張ホストが受け取る値そのものを検査できる。
 */
function renderHtml(): string {
  const preview = new KidoriPreview(() => {});
  preview.show();
  expect(createdPanels).toHaveLength(1);
  return createdPanels[0].webview.html;
}

function extractScripts(html: string): string[] {
  const scripts: string[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) scripts.push(m[1]);
  return scripts;
}

/**
 * 構文検査のみ。node:vm はコンパイル時エラーに「ファイル名:行番号」と
 * 該当行のソースを付けた stack を返すため、失敗時に原因行が特定できる。
 */
function syntaxCheck(script: string, filename: string): string | null {
  try {
    new vm.Script(script, { filename });
    return null;
  } catch (err) {
    const e = err as Error;
    return e.stack ?? e.message;
  }
}

describe("KidoriPreview.html", () => {
  beforeEach(() => {
    __resetPanels();
  });

  it("インライン script が JavaScript としてパースできる", () => {
    const html = renderHtml();
    const scripts = extractScripts(html);
    expect(scripts.length).toBeGreaterThan(0);

    scripts.forEach((script, i) => {
      const failure = syntaxCheck(script, `preview-inline-${i}.js`);
      expect(
        failure,
        `インライン script #${i} が構文エラーです。` +
          `外側テンプレートリテラルにエスケープが消費されていないか確認してください。\n${failure}`,
      ).toBeNull();
    });
  });

  it("タブボタンの id と click リスナ登録が存在する", () => {
    const html = renderHtml();
    expect(html).toContain('id="tab-plans"');
    expect(html).toContain('id="tab-parts"');

    const script = extractScripts(html).join("\n");
    expect(script).toMatch(/el\(\s*"tab-plans"\s*\)\.addEventListener\(\s*"click"/);
    expect(script).toMatch(/el\(\s*"tab-parts"\s*\)\.addEventListener\(\s*"click"/);
  });

  it("update / error の postMessage 受信ハンドラが存在する", () => {
    const script = extractScripts(renderHtml()).join("\n");
    expect(script).toMatch(/window\.addEventListener\(\s*"message"/);
    expect(script).toMatch(/msg\.command === "update"/);
    expect(script).toMatch(/msg\.command === "error"/);
  });

  it("stale 警告バナーの改行が生の改行でなく \\n エスケープで出力される", () => {
    const script = extractScripts(renderHtml()).join("\n");
    // 生の改行が混入すると、この行は文字列リテラルとして閉じない。
    expect(script).toMatch(/"⚠[^"\n]*\\n"/);
    expect(script).not.toMatch(/"⚠[^"]*\n/);
  });
});
