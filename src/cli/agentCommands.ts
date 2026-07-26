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
import type { ResolutionTrace } from "../core/expr";
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

/**
 * `check` 専用の引数解析: 単一のファイルパス＋任意の `--resolved` フラグ
 * （SPECS.md §3b:100）。`--resolved` 以外の `-` 始まりの引数は従来どおり拒否する
 * （`schema` は `parseSingleFileArg` のまま・オプションを一切増やさない）。
 */
function parseCheckArgs(args: string[]): { filePath: string; resolved: boolean } {
  const positional: string[] = [];
  let resolved = false;
  for (const a of args) {
    if (a === "--resolved") {
      resolved = true;
    } else if (a.startsWith("-")) {
      throw new UsageError(`check に不明なオプションが指定されました: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length === 0) {
    throw new UsageError("check には対象ファイルを指定してください");
  }
  if (positional.length > 1) {
    throw new UsageError("check に指定できるファイルは1つだけです");
  }
  return { filePath: positional[0], resolved };
}

/** `kidori check` の1件の診断（SPECS.md §3b: ファイル・行・severity・メッセージ ＋ path）。 */
export interface CheckDiagnostic {
  path: string;
  line: number | null;
  severity: "error" | "warning" | "hint";
  message: string;
}

/**
 * `--resolved` 指定時に併記する1件の解決値（SPECS.md §3b:100 の逐語:
 * 「`resolvedValues`（`path`・`expression`・`value`・`unit: mm`）」）。
 *
 * 対象は式が書かれたフィールドのみ（設計裁定・Supervisor 確定済み）。リテラル
 * 数値は原式を持たないため対象外（SPECS.md §4d:274「原式と解決値」）。行番号は
 * 意図的に含めない（詳細は runCheck の実装コメント参照）。
 */
export interface ResolvedValueEntry {
  path: string;
  expression: string;
  value: number;
  unit: "mm";
}

/**
 * `kidori check` の出力全体。
 *
 * `errorCount`/`warningCount` は既存の意味（それぞれ severity が厳密に一致する
 * 診断の件数）を変えない（U-HINT 導入前と同じ消費者互換性）。hint は独立した
 * `hintCount` に計上し、`warningCount` には混ぜない（hint は warning より弱い
 * 情報であり、既存の warningCount 消費者に「warning が増えた」と誤解させない
 * ため）。
 *
 * `resolvedValues` は `--resolved` 指定時のみ存在するオプショナルフィールド
 * （既存の出力契約を壊さないため。SPECS.md §3b:100）。
 */
export interface CheckResult {
  file: string;
  errorCount: number;
  warningCount: number;
  hintCount: number;
  diagnostics: CheckDiagnostic[];
  resolvedValues?: ResolvedValueEntry[];
}

/**
 * `ResolutionTrace`（`src/core/expr.ts`）を `--resolved` 出力用の配列へ変換する。
 *
 * 並び順は `path` の辞書順（JS の既定の文字列比較。ロケール依存を避けるため
 * `localeCompare` ではなく単純な `<`/`>` 比較を使う）に固定する。`ResolutionTrace`
 * は `Record`（内部のパイプライン各段が書き込んだ挿入順）であり、その挿入順を
 * そのまま漏らすと将来 loader.ts 側のパイプライン順序を変えただけで CLI の出力
 * 順が変わってしまう。機械可読な出力は安定した順序を持つべき、という要件
 * （§3b:100 の意図）に対し、path 文字列という利用者から見える安定なキーで
 * ソートすることで、内部実装の変更から独立させる。
 */
function toResolvedValues(trace: ResolutionTrace): ResolvedValueEntry[] {
  return Object.entries(trace)
    .map(([path, t]) => ({ path, expression: t.expression, value: t.value, unit: "mm" as const }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
 * `--resolved`（SPECS.md §3b:100）指定時は、`resolved`（`ResolutionTrace`。
 * `src/core/loader.ts` の `loadProjectFromRaw` が式解決の副産物として返す
 * 「原式 → 解決値」対応表。U-PIPE で導入済み）を `resolvedValues` として
 * JSON に併記する。指定しない場合は既存の出力契約を変えないためフィールド
 * 自体を出さない。診断（error/warning/hint）の有無とは独立に出す（§3b:100
 * 「診断が0件でも」）。exit code の規約（0/1/2）は `--resolved` の有無で変えない。
 *
 * error 時の挙動: `loadProjectFromRaw` は severity "error" の Issue が1件でも
 * あっても、式解決フェーズに到達済みであれば、そこまでに解決できた式は
 * `resolved` に残して返す（loader.ts の設計裁定 D1。SPECS.md §3b:100「正常な式を
 * 含めて」に "error のないファイルに限る" という条件節は無い）。したがって
 * error があっても解決済みの式があれば `resolvedValues` はそれを反映する。
 * 一方、式解決フェーズ自体に届く前の error（層1・参照フェーズ等）では
 * `loadProjectFromRaw` はまだ何も解決していないため `resolved` は自然に空になる。
 * 構文エラー（catch 節。`loadProjectFromRaw` 自体を呼べていない）も同様に
 * 空配列にする（何も解決していないため）。
 *
 * @param log JSON 出力先（既定 `console.log`）。テストから差し替え可能にする。
 * @param logError stderr 相当の出力先（既定 `console.error`）。
 */
export function runCheck(
  args: string[],
  log: (s: string) => void = (s) => console.log(s),
  logError: (s: string) => void = (s) => console.error(s),
): number {
  const { filePath, resolved: showResolved } = parseCheckArgs(args);
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
  let resolvedTrace: ResolutionTrace = {};
  try {
    // D4: readRaw は loader.ts と同一実装（.json は JSON.parse、それ以外は yaml の
    // parse）。ここで独自にパースを書き直さない。
    const raw = readRaw(target);
    const { issues, resolved } = loadProjectFromRaw(raw, { baseDir: path.dirname(target) });
    // `resolved` は型上省略可能（test/cli/checkHint.test.ts の vi.mock が
    // `{ project, issues }` のみを返すため。loader.ts のコメント参照）。
    resolvedTrace = resolved ?? {};

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

  // 各カウントは severity の厳密一致（否定形にしない）。hint を warning 側の
  // 否定形カウント（"!== error"）に含めてしまうと hint が warningCount に
  // 混入するため、3値それぞれを独立に数える（U-HINT）。
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
  const hintCount = diagnostics.filter((d) => d.severity === "hint").length;
  const result: CheckResult = {
    file: target,
    errorCount,
    warningCount,
    hintCount,
    diagnostics,
  };
  if (showResolved) {
    result.resolvedValues = toResolvedValues(resolvedTrace);
  }
  log(JSON.stringify(result, null, 2));
  // exit code は severity === "error" の有無のみで決める（設計裁定 D3）。
  // warning・hint はどちらも error 扱いにしない（否定形 "!== error" ではなく
  // errorCount > 0 という肯定形の判定なので、hint 追加後もここは安全）。
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
