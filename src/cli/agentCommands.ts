/**
 * エージェント導線コマンド（SPECS.md §3b）: `kidori check <ファイル>` /
 * `kidori schema <ファイル>`。
 *
 * VS Code 拡張ホスト API に届かないコーディングエージェント（Claude Code 等）に、
 * 人間が VS Code で得ているのと同等の「編集 → 検証」フィードバックループ
 * （`check`）と、形式仕様の問い合わせ手段（`schema`）を提供する。
 *
 * `main.ts` から分離しているのは、`main.ts` がトップレベルで `main()` を実行する
 * ため（import するとテストプロセスの argv を解析してしまう）。ここは純粋に
 * import 可能なロジックとして切り出す。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LineCounter, parseDocument } from "yaml";

import { composeSchemaJson } from "../core/composeSchema";
import type { Issue } from "../core/errors";
import { loadProjectFromRaw, readRaw } from "../core/loader";
import { resolveIssueLine } from "./positions";
import { UsageError } from "./usageError";

/** `check`/`schema` 共通: 単一のファイルパス引数のみを受け付ける（SPECS.md §3b の `<ファイル>`）。 */
function parseSingleFileArg(command: string, args: string[]): string {
  const positional = args.filter((a) => {
    if (a.startsWith("-")) {
      throw new UsageError(`${command} にオプションは指定できません: ${a}`);
    }
    return true;
  });
  if (positional.length === 0) {
    throw new UsageError(`${command} には対象ファイルを指定してください`);
  }
  if (positional.length > 1) {
    throw new UsageError(`${command} に指定できるファイルは1つだけです`);
  }
  return positional[0];
}

/** `kidori check` の1件の診断（SPECS.md §3b: ファイル・行・severity・メッセージ ＋ path）。 */
export interface CheckDiagnostic {
  path: string;
  line: number | null;
  severity: "error" | "warning";
  message: string;
}

/** `kidori check` の出力全体。 */
export interface CheckResult {
  file: string;
  errorCount: number;
  warningCount: number;
  diagnostics: CheckDiagnostic[];
}

/**
 * `kidori check <ファイル>` の中身（引数解析込み）。
 *
 * ビルドせず検証だけを実行し、診断を JSON で stdout に出す。検証本体は
 * `loadProjectFromRaw`（src/core/loader.ts）をそのまま呼ぶ（設計裁定 D4: 拡張内の
 * 検証と同一実装を担保するため、意味検証ロジックをここに複製しない）。このコマンド
 * 固有の仕事は「Issue.path → 行番号」の写像（./positions.ts、設計裁定 D1）だけである。
 *
 * 終了コード（SPECS.md §3b・設計裁定 D3。main.ts 冒頭のコメントの一般規約とは
 * 独立した本コマンド固有の規約）:
 *   - 0: error 診断なし（warning は許容し、JSON では報告する）
 *   - 1: error 診断あり（構文エラーも診断1件として扱い、この扱いに含める）
 *   - 2: 引数エラー、またはファイルが読めない（ENOENT 等の IO エラー）
 *
 * 構文エラー（YAML/JSON のパース失敗）は「ファイルは読めたが中身に問題がある」
 * 状態であり IO エラーではないため、2 ではなく診断1件（severity: "error",
 * path: "<root>"）として 1 で報告する。行番号は YAML パーサ（`yaml` パッケージ）の
 * 例外が `linePos` を持つ場合のみ埋め、持たない場合（JSON.parse 等）は
 * null に縮退させる（設計裁定 D2: 行番号のでっち上げ禁止）。
 *
 * @param log JSON 出力先（既定 `console.log`）。テストから差し替え可能にする。
 * @param logError stderr 相当の出力先（既定 `console.error`）。
 */
export function runCheck(
  args: string[],
  log: (s: string) => void = (s) => console.log(s),
  logError: (s: string) => void = (s) => console.error(s),
): number {
  const filePath = parseSingleFileArg("check", args);
  const target = path.resolve(filePath);

  let text: string;
  try {
    text = fs.readFileSync(target, "utf-8");
  } catch (e) {
    logError(
      `[エラー] ファイルを読み込めません: ${target}（${e instanceof Error ? e.message : String(e)}）`,
    );
    return 2;
  }

  let diagnostics: CheckDiagnostic[];
  try {
    // D4: readRaw は loader.ts と同一実装（.json は JSON.parse、それ以外は yaml の
    // parse）。ここで独自にパースを書き直さない。
    const raw = readRaw(target);
    const { issues } = loadProjectFromRaw(raw, { baseDir: path.dirname(target) });

    // D1: 行番号は CLI 側の写像層（parseDocument + LineCounter）で得る。
    // loader.ts は改造しない。yaml の parseDocument は JSON もサブセットとして
    // 解釈できる（D2-4。実機で確認済み）。
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, { lineCounter });
    diagnostics = issues.map((issue: Issue) => ({
      path: issue.path,
      line: resolveIssueLine(doc, lineCounter, issue.path),
      severity: issue.severity,
      message: issue.message,
    }));
  } catch (e) {
    // YAML/JSON の構文エラー。ファイル自体は読めているため IO エラー（exit 2）
    // ではなく、診断1件として報告する（exit 1 側）。
    const linePos = (e as { linePos?: Array<{ line: number }> } | undefined)?.linePos;
    const line =
      Array.isArray(linePos) && linePos.length > 0 && linePos[0].line > 0
        ? linePos[0].line
        : null;
    diagnostics = [
      {
        path: "<root>",
        line,
        severity: "error",
        message: `構文エラーのため解析できませんでした: ${e instanceof Error ? e.message : String(e)}`,
      },
    ];
  }

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.length - errorCount;
  const result: CheckResult = { file: target, errorCount, warningCount, diagnostics };
  log(JSON.stringify(result, null, 2));
  return errorCount > 0 ? 1 : 0;
}

/**
 * `kidori schema <ファイル>` の中身（引数解析込み）。
 *
 * 合成ロジックは `src/core/composeSchema.ts`（`composeSchemaJson`）にあり、
 * ここは薄いラッパ（設計裁定 D5）。`src/extension/schemaContributor.ts` の
 * `requestSchemaContent`/`collectStockIds`（227-239行付近）と同じ合成手順を踏む:
 * インラインの stocks[].id ＋ stocksFile 参照先の id を合わせて enum に注入する。
 * `kidori build` が書き出す `<ファイル名>.out/schema.json`（SPECS.md §3b）も
 * 同じ `composeSchemaJson` を通るため、両者の出力は定義上一致する。
 *
 * baseDir（stocksFile の相対パス解決基準）は `loadProject`（loader.ts:1201-1205 付近）・
 * schemaContributor と同一の `dirname(resolve(filePath))` にする（D5 必須条件）。
 * ここがずれると、同じファイルに対して拡張と CLI が違うスキーマを返してしまう。
 *
 * 終了コード: 0=成功、1=ファイルは読めたが構文エラー等で解析できない実行時エラー、
 * 2=引数エラー、またはファイルが読めない（IO エラー）。`check` と異なり診断という
 * 概念がないため、ここは main.ts 冒頭コメントの一般規約に従う。
 *
 * @param write stdout 相当の出力先（既定 `process.stdout.write`）。
 * @param logError stderr 相当の出力先（既定 `console.error`）。
 */
export function runSchema(
  args: string[],
  write: (s: string) => void = (s) => {
    process.stdout.write(s);
  },
  logError: (s: string) => void = (s) => console.error(s),
): number {
  const filePath = parseSingleFileArg("schema", args);
  const target = path.resolve(filePath);
  const baseDir = path.dirname(target);

  let raw: unknown;
  try {
    raw = readRaw(target);
  } catch (e) {
    // readRaw は「ファイルが読めない（fs 由来）」と「読めたが構文が壊れている
    // （SyntaxError／yaml の YAMLParseError）」の両方でここに落ちる。
    // 後者は Node の fs エラーと同じく `.code` プロパティを持つ場合がある
    // （YAMLParseError.code は yaml パッケージ独自のエラーコードで、Node の
    // errno 系コードとは無関係）ため、`.code` の有無では判別できない。
    // 構文エラーの型（SyntaxError / YAMLParseError）で先に判定する。
    const isParseError =
      e instanceof SyntaxError || (e as { name?: unknown } | undefined)?.name === "YAMLParseError";
    logError(
      `[エラー] ファイルを読み込めません: ${target}（${e instanceof Error ? e.message : String(e)}）`,
    );
    return isParseError ? 1 : 2;
  }

  write(composeSchemaJson(raw, baseDir));
  return 0;
}
