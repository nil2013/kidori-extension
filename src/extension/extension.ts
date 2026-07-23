/**
 * kidori VS Code 拡張のエントリポイント。
 *
 * 拡張層の責務（SPECS.md §3）:
 *   - 保存監視 → コアエンジンで自動ビルド（外部拡張に依存しない）
 *   - 補完・検証: Red Hat YAML への動的スキーマ登録＋ドメイン値補完
 *   - Webview プレビュー（木取り図／加工指示図、案の採用操作）
 *   - コマンド（ビルド・プレビュー・案選択）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseDocument } from "yaml";

import { build, BuildResult } from "../core/build";
import { Issue, ProjectError } from "../core/errors";
import { KidoriPreview, PlanAction, PreviewData } from "./preview";
import { createCompletionProvider } from "./completion";
import {
  SchemaContributor,
  isProjectFile,
  registerYamlSchemaContributor,
} from "./schemaContributor";
import { Presets, loadPresets } from "./presets";

let channel: vscode.OutputChannel;
let diagnostics: vscode.DiagnosticCollection;
let preview: KidoriPreview;
let lastProjectPath: string | null = null;
let lastResult: BuildResult | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  channel = vscode.window.createOutputChannel("kidori");
  diagnostics = vscode.languages.createDiagnosticCollection("kidori");
  context.subscriptions.push(channel, diagnostics);

  // --- プリセット（規格材マスタ）。kidori.presets.json の変更で再読込。
  let presets: Presets = loadPresets(context);
  const presetWatcher = vscode.workspace.createFileSystemWatcher(
    "**/kidori.presets.json",
  );
  const reloadPresets = (): void => {
    presets = loadPresets(context);
  };
  presetWatcher.onDidChange(reloadPresets);
  presetWatcher.onDidCreate(reloadPresets);
  presetWatcher.onDidDelete(reloadPresets);
  context.subscriptions.push(presetWatcher);

  // --- 動的スキーマ登録（Red Hat YAML）。
  const contributor = new SchemaContributor();
  const yamlOk = await registerYamlSchemaContributor(contributor);
  if (!yamlOk) {
    channel.appendLine(
      "[警告] redhat.vscode-yaml が見つからないため、スキーマ連携（キー補完・検証）は無効です",
    );
  }
  for (const doc of vscode.workspace.textDocuments) {
    contributor.update(doc);
  }
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => contributor.update(doc)),
  );

  // 編集のたび（デバウンス 300ms）に stocks[].id を再抽出し、スキーマを更新する。
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!isProjectFile(e.document.uri.toString())) {
        return;
      }
      const key = e.document.uri.toString();
      const prev = debounceTimers.get(key);
      if (prev) {
        clearTimeout(prev);
      }
      debounceTimers.set(
        key,
        setTimeout(() => {
          debounceTimers.delete(key);
          contributor.update(e.document);
        }, 300),
      );
    }),
  );

  // --- ドメイン値補完（規格材プリセット・定尺寸法）。YAML のみ（completion.ts 冒頭コメント参照）。
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      [{ language: "yaml", pattern: "**/project.{yaml,yml}" }],
      createCompletionProvider(() => presets),
      ":",
      " ",
      "-",
    ),
  );

  // --- JSON 入力用: 各 project.json の隣の project.schema.json を json.schemas に登録する。
  await registerJsonSchemaSetting();
  const projectJsonWatcher = vscode.workspace.createFileSystemWatcher("**/project.json");
  projectJsonWatcher.onDidCreate((uri) => {
    void registerSchemaForProjectJson(uri);
  });
  context.subscriptions.push(projectJsonWatcher);

  // --- Webview プレビュー。
  preview = new KidoriPreview((action: PlanAction) => {
    void handlePreviewAction(action);
  });

  // --- 保存時自動ビルド。
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isProjectFile(doc.uri.fsPath)) {
        return;
      }
      const config = vscode.workspace.getConfiguration("kidori");
      if (config.get<boolean>("buildOnSave", true)) {
        void buildProject(doc.uri.fsPath);
      }
    }),
  );

  // --- コマンド。
  context.subscriptions.push(
    vscode.commands.registerCommand("kidori.build", async () => {
      const target = await findProjectFile();
      if (target) {
        await buildProject(target);
      }
    }),
    vscode.commands.registerCommand("kidori.openPreview", async () => {
      preview.show();
      if (!lastResult) {
        const target = await findProjectFile();
        if (target) {
          await buildProject(target);
        }
      }
    }),
    vscode.commands.registerCommand("kidori.selectPlan", async () => {
      await selectPlanCommand();
    }),
  );
}

export function deactivate(): void {
  // 特別な後始末は不要（subscriptions が破棄する）。
}

/** ビルド対象の project ファイルを決める（アクティブエディタ優先）。 */
async function findProjectFile(): Promise<string | null> {
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (active && isProjectFile(active)) {
    return active;
  }
  if (lastProjectPath && fs.existsSync(lastProjectPath)) {
    return lastProjectPath;
  }
  const found = await vscode.workspace.findFiles(
    "**/project.{yaml,yml,json}",
    "**/node_modules/**",
    1,
  );
  if (found.length > 0) {
    return found[0].fsPath;
  }
  void vscode.window.showWarningMessage(
    "kidori: project.yaml が見つかりません（ワークスペースに project.yaml を作成してください）",
  );
  return null;
}

async function buildProject(projectPath: string): Promise<void> {
  lastProjectPath = projectPath;
  const config = vscode.workspace.getConfiguration("kidori");
  const pngEnabled = config.get<boolean>("png.enabled", true);
  const pngScale = config.get<number>("png.scale", 2);

  channel.appendLine(`[build] ${projectPath}`);
  try {
    const result = build(projectPath, {
      png: pngEnabled,
      pngScale,
      log: (m) => channel.appendLine(m),
    });
    lastResult = result;
    await applyDiagnostics(projectPath, result.warnings);
    updatePreview(result);
    const star = result.summary.recommendedPlan
      ? `（推奨: ${result.summary.recommendedPlan}★）`
      : "";
    vscode.window.setStatusBarMessage(
      `kidori: 案 ${result.planIds.join("/")} を生成しました${star}`,
      5000,
    );
  } catch (e) {
    if (e instanceof ProjectError) {
      await applyDiagnostics(projectPath, e.issues);
      preview.showError(
        "検証エラー:\n" +
          e.issues.map((i) => `[${i.severity}] ${i.path}: ${i.message}`).join("\n"),
      );
      channel.appendLine(`[build] 検証エラーのため中断しました`);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      channel.appendLine(`[build] エラー: ${msg}`);
      void vscode.window.showErrorMessage(`kidori: ${msg}`);
    }
  }
}

function updatePreview(result: BuildResult): void {
  const data: PreviewData = {
    summary: result.summary,
    plans: result.planIds.map((id) => ({
      id,
      svg: readIfExists(path.join(result.outDir, `plan-${id}.svg`)),
    })),
    parts: result.partCards.map((p) => ({
      id: p.id,
      label: p.label,
      svg: readIfExists(p.svgPath),
    })),
  };
  preview.update(data);
}

function readIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/** Issue の path（例 "parts[2].features[0].pos"）から YAML 上の位置を求める。 */
function locateIssue(document: vscode.TextDocument, issuePath: string): vscode.Range {
  const zero = new vscode.Range(0, 0, 0, 0);
  if (issuePath === "" || document.fileName.endsWith(".json")) {
    return zero;
  }
  try {
    const doc = parseDocument(document.getText());
    const segments: (string | number)[] = [];
    for (const m of issuePath.matchAll(/([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)) {
      if (m[1] !== undefined) {
        segments.push(m[1]);
      } else {
        segments.push(Number(m[2]));
      }
    }
    // 完全一致するノードが無ければ末尾セグメントを削りながら探す。
    for (let end = segments.length; end > 0; end--) {
      const node = doc.getIn(segments.slice(0, end), true) as
        | { range?: [number, number, number] }
        | undefined;
      if (node && node.range) {
        return new vscode.Range(
          document.positionAt(node.range[0]),
          document.positionAt(node.range[1]),
        );
      }
    }
  } catch {
    // パース不能時は先頭に付ける。
  }
  return zero;
}

async function applyDiagnostics(projectPath: string, issues: Issue[]): Promise<void> {
  const uri = vscode.Uri.file(projectPath);
  const document = await vscode.workspace.openTextDocument(uri);
  const diags = issues.map((issue) => {
    const d = new vscode.Diagnostic(
      locateIssue(document, issue.path),
      `${issue.path}: ${issue.message}`,
      issue.severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning,
    );
    d.source = "kidori";
    return d;
  });
  diagnostics.set(uri, diags);
}

/** プレビューからの操作（案の採用・解除・再ビルド）。 */
async function handlePreviewAction(action: PlanAction): Promise<void> {
  if (action.command === "rebuild") {
    const target = await findProjectFile();
    if (target) {
      await buildProject(target);
    }
    return;
  }
  const planId = action.command === "selectPlan" ? action.planId : null;
  await applySelection(planId);
}

/** コマンドパレットからの案選択。 */
async function selectPlanCommand(): Promise<void> {
  const target = await findProjectFile();
  if (!target) {
    return;
  }
  const planIds = lastResult?.planIds ?? ["A", "B", "C"];
  const summary = lastResult?.summary;
  const items: vscode.QuickPickItem[] = planIds.map((id) => {
    const ps = summary?.plans.find((p) => p.id === id);
    const star = ps?.recommended ? " ★ 推奨" : "";
    const detailParts: string[] = [];
    if (ps) {
      if (ps.totals.cost !== null) {
        detailParts.push(`費用 ${ps.totals.cost.toLocaleString("ja-JP")} 円`);
      }
      detailParts.push(`歩留まり ${(ps.totals.yield * 100).toFixed(1)}%`);
      detailParts.push(`カット ${ps.totals.cutCount} 回`);
    }
    return {
      label: `案 ${id}${star}`,
      description: summary?.selectedPlan === id ? "採用済み" : "",
      detail: detailParts.join(" ／ "),
    };
  });
  items.push({ label: "採用を解除", description: "全案を再生成する" });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "採用する案を選択してください",
  });
  if (!picked) {
    return;
  }
  const planId = picked.label === "採用を解除" ? null : picked.label.replace(/^案 /, "").split(" ")[0];
  await applySelection(planId);
}

/**
 * settings.selectedPlan を書き換えて保存する（YAML はコメント・アンカーを
 * 保持したまま該当キーのみ変更）。保存により buildOnSave が再ビルドを行う。
 */
async function applySelection(planId: string | null): Promise<void> {
  const target = lastProjectPath ?? (await findProjectFile());
  if (!target) {
    return;
  }
  const uri = vscode.Uri.file(target);
  const document = await vscode.workspace.openTextDocument(uri);
  const original = document.getText();

  let updated: string;
  if (target.endsWith(".json")) {
    const data = JSON.parse(original) as Record<string, unknown>;
    const settings = (data.settings ?? {}) as Record<string, unknown>;
    settings.selectedPlan = planId;
    data.settings = settings;
    updated = JSON.stringify(data, null, 2) + "\n";
  } else {
    // lineWidth: 0 で折り返しを無効にし、フロー形式の1行表記を保つ。
    const doc = parseDocument(original);
    doc.setIn(["settings", "selectedPlan"], planId);
    updated = doc.toString({ lineWidth: 0 });
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(document.positionAt(0), document.positionAt(original.length)),
    updated,
  );
  await vscode.workspace.applyEdit(edit);
  await document.save();

  // buildOnSave が無効でも採用結果を反映する。
  const config = vscode.workspace.getConfiguration("kidori");
  if (!config.get<boolean>("buildOnSave", true)) {
    await buildProject(target);
  }
}

/**
 * JSON 入力用に、ワークスペース内の全 project.json を検出して
 * json.schemas 設定へ登録する（S-10-c）。
 *
 * 直下の project.json だけでなく、サブディレクトリの project.json も
 * 対象にするため、単一フォルダ直下チェックではなく findFiles で走査する。
 */
async function registerJsonSchemaSetting(): Promise<void> {
  const found = await vscode.workspace.findFiles(
    "**/project.json",
    "**/node_modules/**",
  );
  for (const uri of found) {
    await registerSchemaForProjectJson(uri);
  }
}

/**
 * 1 件の project.json を json.schemas に登録する。
 *
 * 登録方式について: json.schemas の url が相対パスの場合、公式ドキュメント
 * （code.visualstudio.com/docs/languages/json）は「ワークスペースルートから
 * の相対パス」と説明しており、一致した project.json 自身の隣（サブディレクトリ）
 * を指すとは限らない。そのため fileMatch を全ファイル一致の単一ワイルドカード
 * パターン 1 件にまとめ、url を隣接スキーマへの相対パスにする案は、
 * project.json がワークスペースルート以外のディレクトリにある場合に
 * 誤ったスキーマ（ルート直下の project.schema.json、多くは存在しない）を
 * 指してしまい破綻する。
 *
 * 確実に動作させるため、project.json ごとに 1 エントリを生成する方式を採る:
 *   - fileMatch: その project.json のワークスペースフォルダ相対パス
 *     （例: "sub/project.json"）。フォルダ設定（WorkspaceFolder スコープ）に
 *     登録するため、フォルダ直下からの相対パスとして解決される。
 *   - url: 隣接する project.schema.json への絶対 file:// URI。
 *     相対パス解決の曖昧さを避けるため、常に一意に解決できる絶対 URI を使う。
 */
async function registerSchemaForProjectJson(uri: vscode.Uri): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return;
  }
  const relPath = path
    .relative(folder.uri.fsPath, uri.fsPath)
    .split(path.sep)
    .join("/");
  const schemaPath = path.join(path.dirname(uri.fsPath), "project.schema.json");
  const schemaUrl = vscode.Uri.file(schemaPath).toString();

  const config = vscode.workspace.getConfiguration("json", folder.uri);
  const schemas =
    config.get<{ fileMatch?: string[]; url?: string }[]>("schemas") ?? [];
  const exists = schemas.some((s) => s.fileMatch?.includes(relPath));
  if (exists) {
    return;
  }
  schemas.push({ fileMatch: [relPath], url: schemaUrl });
  try {
    await config.update("schemas", schemas, vscode.ConfigurationTarget.WorkspaceFolder);
    channel.appendLine(`[設定] ${relPath} 用に json.schemas へスキーマを登録しました`);
  } catch {
    // マルチルートでない等で失敗した場合は Workspace スコープで再試行。
    try {
      await config.update("schemas", schemas, vscode.ConfigurationTarget.Workspace);
    } catch {
      channel.appendLine(`[警告] ${relPath} の json.schemas 登録に失敗しました`);
    }
  }
}
