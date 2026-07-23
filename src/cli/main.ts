/**
 * CLI ラッパ `kidori`。
 *
 * VS Code 拡張が主経路であり、CLI はバッチ処理・VS Code のない環境向けの
 * 補助経路（SPECS.md §3）。コアエンジン（src/core）を薄くラップする。
 *
 * コマンド:
 *   kidori build  [project.yaml] [--out DIR] [--no-png] [--scale N]
 *   kidori watch  [project.yaml] [--out DIR] [--no-png] [--scale N]
 *   kidori select <A|B|C|X|null> [project.yaml]
 *
 * 終了コード: 0=成功, 1=検証エラー・実行時エラー, 2=引数エラー。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseDocument } from "yaml";

import { build } from "../core/build";
import { ProjectError } from "../core/errors";

const USAGE = `使い方:
  kidori build  [project.yaml] [--out DIR] [--no-png] [--scale N]
  kidori watch  [project.yaml] [--out DIR] [--no-png] [--scale N]
  kidori select <A|B|C|X|null> [project.yaml]`;

interface CliOptions {
  projectPath: string;
  outDir?: string;
  png: boolean;
  pngScale: number;
}

function defaultProjectPath(): string {
  if (fs.existsSync("project.yaml")) {
    return "project.yaml";
  }
  if (fs.existsSync("project.json")) {
    return "project.json";
  }
  return "project.yaml";
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
    // ビルド失敗時は out/ に失敗マーカーが残る（out/ の図面は最新ではない）。
    console.error(
      "[案内] out/BUILD-FAILED.txt に失敗の詳細と正本ハッシュを記録しました" +
        "（out/ の図面は最新の正本を反映していません）",
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

function runSelect(planId: string, projectPath: string): number {
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
  return runBuild({ projectPath, png: true, pngScale: 2.0 });
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];

  try {
    if (command === "build") {
      process.exitCode = runBuild(parseOptions(argv.slice(1)));
    } else if (command === "watch") {
      runWatch(parseOptions(argv.slice(1)));
    } else if (command === "select") {
      const planId = argv[1];
      if (planId === undefined) {
        throw new UsageError("select には案 ID を指定してください");
      }
      const rest = parseOptions(argv.slice(2));
      process.exitCode = runSelect(planId, rest.projectPath);
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
