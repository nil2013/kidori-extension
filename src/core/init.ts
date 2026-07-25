/**
 * `kidori init` のディレクトリ初期化（SPECS.md §3a）。エディタ非依存（SPECS.md §3）。
 *
 * 主経路は `kidori new`（雛形ファイル1枚。core/scaffold.ts）であり、`kidori init` は
 * **任意**の一括セットアップ。複数プロジェクトを同居させるディレクトリや、
 * エージェント・VS Code 外環境で作業するディレクトリ向け（§3a）。
 *
 * 生成物（§3a）:
 *   1. `AGENTS.md`         … エージェント向け導線（assets/AGENTS.template.md をコピー）
 *   2. `.gitignore`        … `*.out/` の除外
 *   3. `kidori.schema.json`… 基底スキーマの書き出し（core/schema.ts の writeBaseSchema）
 *   4. `stocks.yaml`       … 共有規格材の雛形（オプトイン。`--with-stocks`）
 *
 * 設計上の要点:
 *
 * - **冪等**。既存ファイルは一切書き換えずスキップし、1件ずつ結果を報告する。
 *   `.gitignore` だけは例外的に「必要なパターンが欠けている場合の追記」を行うが、
 *   既存行には触れない（ユーザーが書いた無関係な除外規則を壊さないため）。
 * - **スキーマは単一ソース**。`kidori.schema.json` は core/schema.ts の
 *   `writeBaseSchema` が書き出す。ここに手書きのコピーを置かない（drift 防止）。
 * - **AGENTS.md は薄いポインタ方針**（SPECS.md §3b）。形式仕様の要約を複製せず、
 *   コマンド一覧・PATH 非依存の実行方法・「`kidori schema` で取得」の案内・
 *   出力物の説明のみに留める。テンプレート・書き出しロジックは core/scaffold.ts の
 *   `ensureAgentsFile` に一本化し、`kidori new`（AGENTS.md 不在時）と共有する
 *   （二重実装防止）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { KidoriError } from "./errors";
import { BASE_SCHEMA_FILENAME, OUT_DIR_SUFFIX } from "./kidorifile";
import { baseSchemaJson, writeBaseSchema } from "./schema";
import {
  AGENTS_FILENAME,
  AGENTS_TEMPLATE_RELPATH,
  DEFAULT_BAR_PRESET,
  DEFAULT_SHEET_PRESET,
  ScaffoldError,
  availablePresets,
  ensureAgentsFile,
} from "./scaffold";
import { ResolvedStock, materializeEntry } from "./stocks";

export { AGENTS_FILENAME, AGENTS_TEMPLATE_RELPATH };

/** 共有規格材ファイルの名前（カスケードのディレクトリ層 兼 stocksFile: の参照先。§4b）。 */
export const SHARED_STOCKS_FILENAME = "stocks.yaml";

/** `.gitignore` に必要なパターン（`<stem>.out/` を一括で除外する）。 */
export const OUT_IGNORE_PATTERN = `*${OUT_DIR_SUFFIX}/`;

/** `kidori init` に固有のエラー（CLI は exit 1 で扱う）。 */
export class InitError extends KidoriError {}

/** 1ファイルに対する処理結果。 */
export interface InitAction {
  /** 対象ファイル名（ディレクトリ相対）。 */
  file: string;
  status: "created" | "skipped" | "appended";
  /** 人間向けの1行説明（CLI がそのまま出力する）。 */
  message: string;
}

export interface InitOptions {
  /** `assets/` を含むインストールルート（バンドル後は `dist/` の親）。 */
  rootPath: string;
  /** 共有 `stocks.yaml` の雛形も生成するか（SPECS.md §3a の「（任意）」）。 */
  withStocks?: boolean;
}

export interface InitResult {
  /** 初期化したディレクトリの絶対パス。 */
  dir: string;
  actions: InitAction[];
}

// ---------------------------------------------------------------------------
// 個別の生成物
// ---------------------------------------------------------------------------

function created(file: string, extra = ""): InitAction {
  return { file, status: "created", message: `作成: ${file}${extra}` };
}

function skipped(file: string, extra = ""): InitAction {
  return { file, status: "skipped", message: `スキップ: ${file}（既存）${extra}` };
}

/**
 * AGENTS.md を書き出す（テンプレート資産をそのままコピーする）。
 *
 * 実体は core/scaffold.ts の `ensureAgentsFile`（`kidori new` と共有。二重実装防止）。
 * ここではその結果を `initDirectory` の `InitAction` 報告形式に変換するだけ。
 */
function initAgents(dir: string, rootPath: string): InitAction {
  let result: ReturnType<typeof ensureAgentsFile>;
  try {
    result = ensureAgentsFile(dir, rootPath);
  } catch (e) {
    if (e instanceof ScaffoldError) {
      throw new InitError(e.message);
    }
    throw e;
  }
  return result.created ? created(AGENTS_FILENAME) : skipped(AGENTS_FILENAME);
}

/**
 * `.gitignore` を用意する。
 *
 * - 無ければ `*.out/` を含む形で新規作成する。
 * - 有れば当該パターンが欠けている場合のみ**追記**する。既存行は決して書き換えない
 *   （ユーザーが書いた除外規則を壊さないため）。
 */
export function ensureGitignore(dir: string): InitAction {
  const file = ".gitignore";
  const target = join(dir, file);
  const header = "# kidori の出力（正本から再生成される派生物）";

  if (!existsSync(target)) {
    writeFileSync(target, `${header}\n${OUT_IGNORE_PATTERN}\n`, "utf-8");
    return created(file, `（${OUT_IGNORE_PATTERN} を除外）`);
  }

  const text = readFileSync(target, "utf-8");
  // `*.out/` と `*.out` のどちらでもディレクトリは除外されるため、
  // 既にどちらかがあれば追記しない（重複行を増やさない）。
  const covered = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === OUT_IGNORE_PATTERN || line === `*${OUT_DIR_SUFFIX}`);
  if (covered) {
    return skipped(file, `（${OUT_IGNORE_PATTERN} は既に除外されています）`);
  }

  const prefix = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileSync(target, `${text}${prefix}\n${header}\n${OUT_IGNORE_PATTERN}\n`, "utf-8");
  return {
    file,
    status: "appended",
    message: `追記: ${file}（${OUT_IGNORE_PATTERN} を追加。既存の行は変更していません）`,
  };
}

/** 基底スキーマ `kidori.schema.json` を書き出す（core/schema.ts が単一ソース）。 */
function initSchema(dir: string): InitAction {
  const target = join(dir, BASE_SCHEMA_FILENAME);
  if (existsSync(target)) {
    // 冪等性のため上書きはしないが、内容が現行の基底スキーマと違う場合は
    // 気づけるようにしておく（kidori 更新後の陳腐化の検知）。
    let stale = false;
    try {
      stale = readFileSync(target, "utf-8") !== baseSchemaJson();
    } catch {
      stale = false;
    }
    return skipped(
      BASE_SCHEMA_FILENAME,
      stale
        ? "。内容が現行の基底スキーマと異なります（更新するには削除して再実行してください）"
        : "",
    );
  }
  writeBaseSchema(dir);
  return created(BASE_SCHEMA_FILENAME);
}

/** 共有 `stocks.yaml` の雛形本文（正本の stocks エントリと同一形。§4・§4b）。 */
export function renderSharedStocks(entries: readonly ResolvedStock[]): string {
  const lines = [
    "# kidori 共有規格材（SPECS.md §4・§4b）",
    "#",
    "# このファイルは2つの役割を兼ねる:",
    "#   1. 補完候補の供給（4層カスケードのディレクトリ層。同居する kidori ファイルに効く）",
    "#   2. `stocksFile: ./stocks.yaml` の参照先（ビルドが読む外部 stocks）",
    "#",
    "# 形式は正本の stocks エントリと同一（トップレベル stocks: リストのみ）。",
    "# preset はマスタの来歴キー（任意）。price（円）を書き入れると概算費用でランク付けされる。",
    "stocks:",
  ];
  for (const entry of entries) {
    lines.push(`  - ${materializeEntry(entry)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function initSharedStocks(dir: string, rootPath: string): InitAction {
  const target = join(dir, SHARED_STOCKS_FILENAME);
  if (existsSync(target)) {
    return skipped(SHARED_STOCKS_FILENAME);
  }
  // 対象ディレクトリの stocks.yaml 自身をディレクトリ層として読ませない
  // （まだ存在しないので実害はないが、意図を明示するため documentPath は渡さない）。
  const available = availablePresets(rootPath);
  const picked = [DEFAULT_BAR_PRESET, DEFAULT_SHEET_PRESET]
    .map((key) => available.find((s) => s.key === key))
    .filter((s): s is ResolvedStock => s !== undefined);
  if (picked.length === 0) {
    throw new InitError(
      "規格材マスタから雛形に載せられる規格材を取得できませんでした" +
        "（assets/stock-presets.json を読めていない可能性があります）。",
    );
  }
  writeFileSync(target, renderSharedStocks(picked), "utf-8");
  return created(SHARED_STOCKS_FILENAME);
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

/**
 * ディレクトリを kidori の作業ディレクトリとして初期化する（`kidori init`）。
 *
 * 既存ファイルは書き換えない（`.gitignore` は不足パターンの追記のみ）。
 * 2回実行しても結果は変わらない（冪等）。
 *
 * @param dir 対象ディレクトリ（存在しなければ作成する）。
 */
export function initDirectory(dir: string, options: InitOptions): InitResult {
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });

  const actions: InitAction[] = [
    initAgents(target, options.rootPath),
    ensureGitignore(target),
    initSchema(target),
  ];
  if (options.withStocks === true) {
    actions.push(initSharedStocks(target, options.rootPath));
  }
  return { dir: target, actions };
}
