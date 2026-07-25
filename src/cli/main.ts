/**
 * CLI ラッパ `kidori`。
 *
 * VS Code 拡張が主経路であり、CLI はバッチ処理・VS Code のない環境向けの
 * 補助経路（SPECS.md §3）。コアエンジン（src/core）を薄くラップする。
 *
 * コマンド:
 *   kidori new    <ファイル名> [--preset <キー>]...
 *   kidori init   [ディレクトリ] [--with-stocks]
 *   kidori build  [<name>.kidori.yaml] [--out DIR] [--no-png] [--scale N]
 *   kidori watch  [<name>.kidori.yaml] [--out DIR] [--no-png] [--scale N]
 *   kidori select <A|B|C|X|null> [<name>.kidori.yaml]
 *
 * **CLI は非対話を貫く**（SPECS.md §3a の「プリセットから選べる」は `--preset` の
 * 反復指定で充足する）。AGENTS.md の読者であるコーディングエージェントにとっても
 * 非対話が正しい形であり、対話 UI は拡張層（Quick Pick）の責務。
 *
 * 終了コード: 0=成功, 1=検証エラー・実行時エラー, 2=引数エラー。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseDocument } from "yaml";

import { build } from "../core/build";
import { ProjectError } from "../core/errors";
import { initDirectory } from "../core/init";
import { KIDORI_SUFFIXES, defaultOutDir, hasKidoriSuffix } from "../core/kidorifile";
import { createScaffold } from "../core/scaffold";

const USAGE = `使い方:
  kidori new    <ファイル名> [--preset <キー>]...      雛形ファイル1枚を生成（主経路）
  kidori init   [ディレクトリ] [--with-stocks]         ディレクトリを初期化（任意）
  kidori build  [<name>.kidori.yaml] [--out DIR] [--no-png] [--scale N]
  kidori watch  [<name>.kidori.yaml] [--out DIR] [--no-png] [--scale N]
  kidori select <A|B|C|X|null> [<name>.kidori.yaml]`;

interface CliOptions {
  projectPath: string;
  outDir?: string;
  png: boolean;
  pngScale: number;
}

/**
 * `assets/` を含むインストールルート（規格材マスタ・AGENTS.md テンプレートの起点）。
 * バンドル後は `<install>/dist/cli.js` で動くため、`dist/` の親を指す。
 */
function installRoot(): string {
  return path.resolve(__dirname, "..");
}

/**
 * 対象ファイル省略時の既定（SPECS.md §3「1ファイル=1プロジェクト」）。
 *
 * v0.6 で固定名 `project.yaml` は廃止されたため、カレントディレクトリの
 * `*.kidori.{yaml,yml,json}` を探索する。同居が前提の設計上、複数見つかった
 * 場合に暗黙で1つを選ぶのは危険なので、明示指定を促す。
 */
function defaultProjectPath(): string {
  let names: string[];
  try {
    names = fs.readdirSync(process.cwd());
  } catch {
    names = [];
  }
  const candidates = names.filter((n) => hasKidoriSuffix(n)).sort();
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length === 0) {
    throw new UsageError(
      `カレントディレクトリに kidori ファイル（${KIDORI_SUFFIXES.join(" / ")}）が` +
        "見つかりません。対象ファイルを引数で指定するか、" +
        "`kidori new <ファイル名>` で雛形を生成してください。",
    );
  }
  throw new UsageError(
    `カレントディレクトリに kidori ファイルが複数あります（${candidates.join(", ")}）。` +
      "1ファイル=1プロジェクトのため、対象ファイルを引数で指定してください。",
  );
}

function parseOptions(args: string[]): CliOptions {
  const positional: string[] = [];
  let outDir: string | undefined;
  let png = true;
  let pngScale = 2.0;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") {
      outDir = args[++i];
      if (outDir === undefined) {
        throw new UsageError("--out にはディレクトリを指定してください");
      }
    } else if (a === "--no-png") {
      png = false;
    } else if (a === "--scale") {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        throw new UsageError("--scale には正の数を指定してください");
      }
      pngScale = v;
    } else if (a.startsWith("-")) {
      throw new UsageError(`不明なオプション: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) {
    throw new UsageError("project ファイルは1つだけ指定してください");
  }
  return {
    projectPath: positional[0] ?? defaultProjectPath(),
    outDir,
    png,
    pngScale,
  };
}

class UsageError extends Error {}

function runBuild(options: CliOptions): number {
  try {
    const result = build(options.projectPath, {
      outDir: options.outDir,
      png: options.png,
      pngScale: options.pngScale,
    });
    const summary = result.summary;
    const star =
      summary.recommendedPlan !== null ? `（推奨: ${summary.recommendedPlan}★）` : "";
    console.error(
      `[完了] 案 ${result.planIds.join("/")} を生成しました${star} → ${result.outDir}`,
    );
    return 0;
  } catch (e) {
    if (e instanceof ProjectError) {
      // Issue 一覧は build() が log 済み。
      console.error(String(e.message));
    } else {
      console.error(`[エラー] ${e instanceof Error ? e.message : String(e)}`);
    }
    // ビルド失敗時は出力先に失敗マーカーが残る（図面は最新の正本を反映していない）。
    const outDir = options.outDir
      ? path.resolve(options.outDir)
      : defaultOutDir(options.projectPath);
    console.error(
      `[案内] ${path.join(outDir, "BUILD-FAILED.txt")} に失敗の詳細と正本ハッシュを` +
        `記録しました（${outDir} の図面は最新の正本を反映していません）`,
    );
    return 1;
  }
}

function runWatch(options: CliOptions): void {
  const target = path.resolve(options.projectPath);
  if (!fs.existsSync(target)) {
    console.error(`[エラー] ファイルが見つかりません: ${target}`);
    process.exitCode = 1;
    return;
  }
  console.error(`[watch] ${target} を監視しています（Ctrl+C で終了）`);
  runBuild(options);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const trigger = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      if (fs.existsSync(target)) {
        console.error(`[watch] 変更を検出、再ビルドします`);
        runBuild(options);
      }
    }, 200);
  };

  // エディタの保存はファイル置換（rename）になることがあるため、
  // ファイル本体ではなく親ディレクトリを監視する。
  fs.watch(path.dirname(target), (_event, filename) => {
    if (filename === path.basename(target)) {
      trigger();
    }
  });
}

function runSelect(planId: string, options: CliOptions): number {
  const projectPath = options.projectPath;
  const allowed = ["A", "B", "C", "X", "null"];
  if (!allowed.includes(planId)) {
    throw new UsageError(
      `案 ID は A/B/C/X または null を指定してください（指定値: ${planId}）`,
    );
  }
  const value = planId === "null" ? null : planId;
  const text = fs.readFileSync(projectPath, "utf-8");

  if (projectPath.endsWith(".json")) {
    const data = JSON.parse(text) as Record<string, unknown>;
    const settings = (data.settings ?? {}) as Record<string, unknown>;
    settings.selectedPlan = value;
    data.settings = settings;
    fs.writeFileSync(projectPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } else {
    // YAML はコメント・アンカーを保持したまま該当キーのみ書き換える。
    // lineWidth: 0 で折り返しを無効にし、フロー形式の1行表記を保つ。
    const doc = parseDocument(text);
    doc.setIn(["settings", "selectedPlan"], value);
    fs.writeFileSync(projectPath, doc.toString({ lineWidth: 0 }), "utf-8");
  }
  console.error(
    value === null
      ? `[完了] selectedPlan を解除しました（全案を再生成します）`
      : `[完了] 案 ${value} を採用しました`,
  );
  // 採用後の再ビルドにも build と同じオプション（--out / --no-png / --scale）を通す。
  return runBuild(options);
}

/** `kidori new <ファイル名> [--preset <キー>]...` の引数解析。 */
function parseNewArgs(args: string[]): { filePath: string; presets: string[] } {
  const positional: string[] = [];
  const presets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--preset") {
      const key = args[++i];
      if (key === undefined) {
        throw new UsageError("--preset には規格材マスタのキーを指定してください");
      }
      presets.push(key);
    } else if (a.startsWith("-")) {
      throw new UsageError(`不明なオプション: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length === 0) {
    throw new UsageError("new には生成するファイル名を指定してください");
  }
  if (positional.length > 1) {
    throw new UsageError("new に指定できるファイル名は1つだけです");
  }
  return { filePath: positional[0], presets };
}

function runNew(args: string[]): number {
  const { filePath, presets } = parseNewArgs(args);
  const result = createScaffold(filePath, { rootPath: installRoot(), presets });
  console.error(`[完了] 雛形を生成しました → ${result.path}`);
  if (!result.modelineEnabled) {
    console.error(
      "[案内] VS Code 以外の環境で補完・検証を使う場合は `kidori init` で " +
        "kidori.schema.json を生成し、先頭のモードライン行を有効化してください",
    );
  }
  console.error(
    `[案内] 編集して保存すると自動ビルドされます（CLI: kidori build ${result.path}）`,
  );
  return 0;
}

/** `kidori init [ディレクトリ] [--with-stocks]` の引数解析。 */
function parseInitArgs(args: string[]): { dir: string; withStocks: boolean } {
  const positional: string[] = [];
  let withStocks = false;
  for (const a of args) {
    if (a === "--with-stocks") {
      withStocks = true;
    } else if (a.startsWith("-")) {
      throw new UsageError(`不明なオプション: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) {
    throw new UsageError("init に指定できるディレクトリは1つだけです");
  }
  return { dir: positional[0] ?? ".", withStocks };
}

function runInit(args: string[]): number {
  const { dir, withStocks } = parseInitArgs(args);
  const result = initDirectory(dir, { rootPath: installRoot(), withStocks });
  console.error(`[完了] ${result.dir} を初期化しました`);
  for (const action of result.actions) {
    console.error(`  ${action.message}`);
  }
  if (!withStocks) {
    console.error(
      "[案内] 複数プロジェクトで規格材を共有する場合は --with-stocks で " +
        "stocks.yaml の雛形も生成できます",
    );
  }
  return 0;
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];

  try {
    if (command === "new") {
      process.exitCode = runNew(argv.slice(1));
    } else if (command === "init") {
      process.exitCode = runInit(argv.slice(1));
    } else if (command === "build") {
      process.exitCode = runBuild(parseOptions(argv.slice(1)));
    } else if (command === "watch") {
      runWatch(parseOptions(argv.slice(1)));
    } else if (command === "select") {
      const planId = argv[1];
      if (planId === undefined) {
        throw new UsageError("select には案 ID を指定してください");
      }
      const rest = parseOptions(argv.slice(2));
      process.exitCode = runSelect(planId, rest);
    } else {
      console.error(USAGE);
      process.exitCode = command === undefined || command === "--help" ? 0 : 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`[エラー] ${e.message}`);
      console.error(USAGE);
      process.exitCode = 2;
    } else {
      console.error(`[エラー] ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  }
}

main();
