/**
 * kidori VS Code 拡張のエントリポイント。
 *
 * 拡張層の責務（SPECS.md §3）:
 *   - kidori ファイル判定（命名規約 `*.kidori.yaml` ＋ 内容判定。core に委譲）
 *   - 保存監視 → コアエンジンで自動ビルド（外部拡張に依存しない）
 *   - 補完・検証: Red Hat YAML への動的スキーマ供給（メモリ上合成）＋ドメイン値補完
 *   - Webview プレビュー（木取り図／加工指示図、案の採用操作）
 *   - コマンド（ビルド・プレビュー・案選択。雛形生成・初期化は別ユニットで配線）
 *
 * v0.6 の「1ファイル=1プロジェクト」（SPECS.md §3）に伴い、ビルド結果は
 * プロジェクトパスをキーにした Map で保持する（同一ディレクトリに複数の正本が
 * 同居しうるため、グローバル1組では取り違える）。プレビューパネルは1枚のまま
 * 「最後にビルド／指定されたプロジェクト」を表示し、タイトルに名前を出す。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseDocument } from "yaml";

import { build, BuildResult } from "../core/build";
import { Issue, ProjectError } from "../core/errors";
import { BASE_SCHEMA_FILENAME, hasKidoriSuffix, projectStem } from "../core/kidorifile";
import { KidoriPreview, PlanAction, PreviewData } from "./preview";
import { createCompletionProvider } from "./completion";
import {
  SchemaContributor,
  isKidoriCandidatePath,
  registerYamlSchemaContributor,
} from "./schemaContributor";
import { StockMaster, StockShadowReporter, loadStockMaster } from "./presets";

let channel: vscode.OutputChannel;
let diagnostics: vscode.DiagnosticCollection;
let preview: KidoriPreview;
let contributor: SchemaContributor;
let shadowReporter: StockShadowReporter;
/** 拡張のインストールルート（同梱 assets/ の解決に使う）。 */
let extensionPath = "";

/** プロジェクトパス → 直近のビルド結果（SPECS.md §3。1ファイル=1プロジェクト）。 */
const results = new Map<string, BuildResult>();
/** プレビューが表示している（＝最後にビルド／指定された）プロジェクト。 */
let activeProjectPath: string | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  channel = vscode.window.createOutputChannel("kidori");
  diagnostics = vscode.languages.createDiagnosticCollection("kidori");
  context.subscriptions.push(channel, diagnostics);
  extensionPath = context.extensionPath;
  results.clear();
  activeProjectPath = null;

  // --- 規格材マスタ（4層カスケードのビルトイン層＋ユーザー層）。
  // 層2〜4 は補完・シャドウ診断のたびに resolveCascade がディスクから読み直すため、
  // ここで監視するのはビルトイン／ユーザー層を抱えるマスタ1件だけでよい
  // （旧 kidori.presets.json のウォッチャは v0.6 のカスケード導入で不要になった）。
  const master: StockMaster = loadStockMaster(context);

  // --- 動的スキーマ供給（Red Hat YAML）。ディスクへの書き出しは行わない（§4b）。
  contributor = new SchemaContributor();
  const yamlOk = await registerYamlSchemaContributor(contributor);
  if (!yamlOk) {
    channel.appendLine(
      "[警告] redhat.vscode-yaml が見つからないため、スキーマ連携（キー補完・検証）は無効です",
    );
  }

  // --- 規格材マスタのシャドウ通知（SPECS.md §4b）。診断コレクションは
  // ビルド診断と混ざらないよう Reporter 自身に持たせ、ログだけ共有する。
  shadowReporter = new StockShadowReporter(() => master, { channel });
  context.subscriptions.push(shadowReporter);

  for (const doc of vscode.workspace.textDocuments) {
    handleDocument(doc);
  }
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => handleDocument(doc)),
  );

  // 編集のたび（デバウンス 300ms）に判定・stocks[].id・シャドウ通知を更新する。
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!isKidoriCandidatePath(e.document.uri.fsPath)) {
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
          handleDocument(e.document);
        }, 300),
      );
    }),
  );

  // 閉じたドキュメントの通知は取り下げる。
  // （テスト用スタブには onDidCloseTextDocument が無いため存在確認する。）
  const onDidClose = vscode.workspace.onDidCloseTextDocument;
  if (typeof onDidClose === "function") {
    context.subscriptions.push(
      onDidClose((doc) => {
        shadowReporter.clear(doc.uri);
        contributor.forget(doc.uri.fsPath);
      }),
    );
  }

  // --- ドメイン値補完（規格材カスケード・定尺寸法）。YAML のみ（completion.ts 冒頭コメント参照）。
  // セレクタは広く取り（ファイルごとの register/unregister は churn と解放漏れの元、
  // 独自 languageId は Red Hat YAML の関連付けを壊す）、プロバイダ内で
  // キャッシュ済みの kidori ファイル判定によりゲートする。
  const domainCompletion = createCompletionProvider(() => master);
  const gatedCompletion: vscode.CompletionItemProvider = {
    provideCompletionItems(document, position, token, completionContext) {
      if (!contributor.isKidoriDocument(document)) {
        return [];
      }
      return domainCompletion.provideCompletionItems(
        document,
        position,
        token,
        completionContext,
      );
    },
  };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      [{ language: "yaml", scheme: "file" }],
      gatedCompletion,
      ":",
      " ",
      "-",
    ),
  );

  // --- Webview プレビュー。
  preview = new KidoriPreview((action: PlanAction, projectPath: string | null) => {
    void handlePreviewAction(action, projectPath);
  });

  // --- 保存時自動ビルド。
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!contributor.isKidoriPath(doc.uri.fsPath)) {
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
      const target = await findProjectFile();
      if (target && !results.has(target)) {
        await buildProject(target);
      } else if (target && target !== activeProjectPath) {
        // すでにビルド済みの別プロジェクトへ表示を切り替える。
        showResult(target);
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

/**
 * 開いた／編集されたドキュメント1枚ぶんの追随処理。
 *
 * 判定は SchemaContributor が一元的に行い（"unknown" のときは直前の判定を維持）、
 * kidori ファイルと判定されたものだけシャドウ通知・JSON スキーマ登録へ進む。
 */
function handleDocument(document: vscode.TextDocument): void {
  if (!contributor.update(document)) {
    return;
  }
  shadowReporter.update(document);
  void registerRescueJsonSchema(document);
}

/** ビルド対象の kidori ファイルを決める（アクティブエディタ優先）。 */
async function findProjectFile(): Promise<string | null> {
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (active && contributor.isKidoriPath(active)) {
    return active;
  }
  if (activeProjectPath && fs.existsSync(activeProjectPath)) {
    return activeProjectPath;
  }
  // 内容判定で拾う素の *.yaml はグロブで探せない（アクティブエディタ経由で拾う）。
  // ここで探せるのは命名規約に従うファイルだけ。
  const found = await vscode.workspace.findFiles(
    "**/*.kidori.{yaml,yml,json}",
    "**/node_modules/**",
    1,
  );
  if (found.length > 0) {
    return found[0].fsPath;
  }
  void vscode.window.showWarningMessage(
    "kidori: kidori ファイルが見つかりません" +
      "（`*.kidori.yaml` を作成するか、コマンド「kidori: New Cutting Plan」で雛形を生成してください。" +
      "素の *.yaml は meta.schemaVersion があれば認識しますが、エディタで開いている必要があります）",
  );
  return null;
}

async function buildProject(projectPath: string): Promise<void> {
  activeProjectPath = projectPath;
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
    results.set(projectPath, result);
    await applyDiagnostics(projectPath, result.warnings);
    updatePreview(projectPath, result);
    const star = result.summary.recommendedPlan
      ? `（推奨: ${result.summary.recommendedPlan}★）`
      : "";
    vscode.window.setStatusBarMessage(
      `kidori: ${projectStem(projectPath)} の案 ${result.planIds.join("/")} を生成しました${star}`,
      5000,
    );
  } catch (e) {
    // プレビューの stale 表示（薄色化＋警告バナー）は、いま表示しているのが
    // 失敗したプロジェクト自身のときだけ出す。複数プロジェクトが同居する v0.6
    // では、別プロジェクトの失敗で表示中の正しい図面を無効化してはならない。
    const showsThisProject =
      preview.boundProjectPath === null || preview.boundProjectPath === projectPath;
    if (e instanceof ProjectError) {
      await applyDiagnostics(projectPath, e.issues);
      if (showsThisProject) {
        preview.showError(
          "検証エラー:\n" +
            e.issues.map((i) => `[${i.severity}] ${i.path}: ${i.message}`).join("\n"),
        );
      }
      channel.appendLine(`[build] 検証エラーのため中断しました`);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      channel.appendLine(`[build] エラー: ${msg}`);
      if (showsThisProject) {
        preview.showError(`ビルドエラー:\n${msg}`);
      }
      void vscode.window.showErrorMessage(`kidori: ${projectStem(projectPath)}: ${msg}`);
    }
    // ビルド失敗時は <stem>.out/ に失敗マーカーが残り、旧図面は最新ではない旨を案内する。
    channel.appendLine(
      "[build] 失敗しました。<stem>.out/BUILD-FAILED.txt に詳細と正本ハッシュを記録しました" +
        "（出力ディレクトリの図面は最新の正本を反映していません）",
    );
  }
}

/** 既にビルド済みのプロジェクトへプレビューの表示を切り替える。 */
function showResult(projectPath: string): void {
  const result = results.get(projectPath);
  if (!result) {
    return;
  }
  activeProjectPath = projectPath;
  updatePreview(projectPath, result);
}

function updatePreview(projectPath: string, result: BuildResult): void {
  const data: PreviewData = {
    projectPath,
    label: projectStem(projectPath),
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

/**
 * プレビューからの操作（案の採用・解除・再ビルド）。
 *
 * `projectPath` は **その表示がバインドしていた正本パス**（preview.ts 参照）。
 * グローバルな「最後にビルドしたプロジェクト」で解決してはならない
 * （別プロジェクトを保存した直後のクリックが表示中でないファイルを書き換える）。
 */
async function handlePreviewAction(
  action: PlanAction,
  projectPath: string | null,
): Promise<void> {
  const target = projectPath ?? (await findProjectFile());
  if (!target) {
    return;
  }
  if (action.command === "rebuild") {
    await buildProject(target);
    return;
  }
  const planId = action.command === "selectPlan" ? action.planId : null;
  await applySelection(planId, target);
}

/** コマンドパレットからの案選択。 */
async function selectPlanCommand(): Promise<void> {
  const target = await findProjectFile();
  if (!target) {
    return;
  }
  const result = results.get(target);
  const planIds = result?.planIds ?? ["A", "B", "C"];
  const summary = result?.summary;
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
    const adopted =
      summary?.selectedPlan === id
        ? summary?.selectedPlanStale === true
          ? "採用（無効）"
          : "採用済み"
        : "";
    return {
      label: `案 ${id}${star}`,
      description: adopted,
      detail: detailParts.join(" ／ "),
    };
  });
  items.push({ label: "採用を解除", description: "全案を再生成する" });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `採用する案を選択してください（${projectStem(target)}）`,
  });
  if (!picked) {
    return;
  }
  const planId =
    picked.label === "採用を解除" ? null : picked.label.replace(/^案 /, "").split(" ")[0];
  await applySelection(planId, target);
}

/**
 * settings.selectedPlan を書き換えて保存する（YAML はコメント・アンカーを
 * 保持したまま該当キーのみ変更）。保存により buildOnSave が再ビルドを行う。
 *
 * @param target 書き換える正本のパス（呼び出し側が明示的に決める。§3）。
 */
async function applySelection(planId: string | null, target: string): Promise<void> {
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
 * 内容判定で拾った素の `*.json`（救済経路）に、拡張同梱の基底スキーマを
 * `json.schemas` 設定経由で結びつける（SPECS.md §3・§4b）。
 *
 * 命名規約に従う `*.kidori.json` は package.json の `contributes.jsonValidation`
 * が宣言的に担当する（設定を書き換えず、アンインストールで消える）。ここで
 * 実行時登録するのは、グロブでは表現できない**内容判定の救済経路だけ**である。
 *
 * 動的 stock-id enum は JSON では合成しない（v1 の判断）。SPECS.md §4b の
 * per-file メモリ合成は Red Hat YAML の供給機構についての記述であり、JSON 側の
 * 要求は「同じスキーマを json.schemas 相当の仕組みで登録する」ことのみ。JSON は
 * §4a が機械生成・他ツール連携用途と位置づけており、手書き補完の価値が低い。
 *
 * 登録方式について: json.schemas の url が相対パスの場合、公式ドキュメント
 * （code.visualstudio.com/docs/languages/json）は「ワークスペースルートからの
 * 相対パス」と説明しており、一致したファイル自身の隣を指すとは限らない。そのため:
 *   - fileMatch: そのファイルのワークスペースフォルダ相対パス
 *     （例: "sub/plan.json"）。フォルダ設定（WorkspaceFolder スコープ）に
 *     登録するため、フォルダ直下からの相対パスとして解決される。
 *   - url: 拡張同梱 `assets/kidori.schema.json` への絶対 file:// URI。
 *     相対パス解決の曖昧さを避けるため、常に一意に解決できる絶対 URI を使う。
 */
async function registerRescueJsonSchema(document: vscode.TextDocument): Promise<void> {
  const uri = document.uri;
  if (uri.scheme !== "file" || !uri.fsPath.endsWith(".json")) {
    return;
  }
  if (hasKidoriSuffix(uri.fsPath)) {
    return; // contributes.jsonValidation が担当する。
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return;
  }
  const relPath = path
    .relative(folder.uri.fsPath, uri.fsPath)
    .split(path.sep)
    .join("/");
  const schemaUrl = vscode.Uri.file(bundledSchemaPath()).toString();

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

/**
 * 拡張に同梱した基底スキーマ（動的 enum なし）の絶対パス。
 *
 * 実体は esbuild が `src/core/schema.ts` の `baseSchemaJson()` から生成する
 * （スキーマの単一ソースは core のまま。手書きコピーを置かない）。
 */
function bundledSchemaPath(): string {
  return path.join(extensionPath, "assets", BASE_SCHEMA_FILENAME);
}
