/**
 * ビルドオーケストレータ。
 *
 * `build(projectPath, options)` が公開エントリ。フロー:
 *
 *   ① readRaw（失敗しても schema 書き出しは試みる）
 *   ② writeSchema（stocks 抽出可能なら enum 入り）
 *   ③ loadProject（error なら Issue 一覧をログ出力し ProjectError を伝播）
 *   ④ generatePlans（ヒューリスティック案 A/B/C）
 *   ⑤ runExact（settings.exact に応じた厳密探索。案 X または最適一致判定）
 *   ⑥ metrics（summarize / rankPlans / buildSummary）— 推奨案★の決定
 *   ⑦ plan-X.svg + parts/*.svg
 *   ⑧ PNG（resvg-js。利用不可なら警告してスキップ）
 *   ⑨ summary.json（generatedAt は build 時刻の ISO 文字列）
 *   ⑩ 管理対象パターン（plan-*.svg/png, parts/*.svg/png, summary.json）の
 *      陳腐化ファイル削除（管理外ファイルには触れない）
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Issue, KidoriError, ProjectError } from "./errors";
import { extractStockIds, loadProject, readRaw } from "./loader";
import { writeSchema } from "./schema";
import { generatePlans } from "./packing";
import { Plan } from "./packing/common";
import { runExact } from "./exact";
import {
  ExactInfo,
  PlanSummary,
  Summary,
  buildSummary,
  rankPlans,
  summarize,
} from "./metrics";
import { renderCutplan } from "./render/cutplan";
import { renderPartcard } from "./render/partcard";
import { svgToPng } from "./png";
import type { Project } from "./types";

/** モードライン（YAML 先頭行）の想定プレフィックス。 */
const MODELINE_PREFIX = "# yaml-language-server: $schema=";

export interface BuildOptions {
  /** 出力先ディレクトリ。省略時は projectPath と同階層の out/。 */
  outDir?: string;
  /** PNG も生成するか。デフォルト true。 */
  png?: boolean;
  /** PNG 変換時のスケール。デフォルト 2.0。 */
  pngScale?: number;
  /** ログ出力先（CLI は stderr、拡張は出力チャンネル）。デフォルト console.error。 */
  log?: (message: string) => void;
}

export interface BuildResult {
  projectPath: string;
  outDir: string;
  partsDir: string;
  /** 今回生成した割付案の ID 一覧（selectedPlan 設定時は1件のみ）。 */
  planIds: string[];
  svgPaths: string[];
  /** 生成した PNG のパス一覧（resvg-js 利用不可の場合は空）。 */
  pngPaths: string[];
  summaryPath: string;
  /** loadProject が返した警告 Issue 一覧。 */
  warnings: Issue[];
  pngEnabled: boolean;
  /** summary.json と同内容（拡張の Webview プレビューが直接利用する）。 */
  summary: Summary;
  /** 加工指示図の一覧（Webview プレビュー用）。project.parts の宣言順。 */
  partCards: { id: string; label: string; svgPath: string }[];
}

function printIssue(issue: Issue, log: (m: string) => void): void {
  const label = issue.severity === "error" ? "エラー" : "警告";
  log(`[${label}] ${issue.path}: ${issue.message}`);
}

function checkModeline(projectPath: string, log: (m: string) => void): void {
  if (projectPath.endsWith(".json")) {
    return;
  }
  let firstLine: string;
  try {
    const text = fs.readFileSync(projectPath, "utf-8");
    firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  } catch {
    return;
  }
  if (!firstLine.trim().startsWith(MODELINE_PREFIX)) {
    log(
      "[案内] project.yaml の先頭行に " +
        `\`${MODELINE_PREFIX}./project.schema.json\` を追記すると、` +
        "VS Code 以外のエディタでも補完・検証が有効になります" +
        "（kidori 拡張を使う場合は不要です）。",
    );
  }
}

/** ISO 8601（ローカルタイムゾーンのオフセット付き、秒精度）で現在時刻を返す。 */
function isoNow(): string {
  const d = new Date();
  const pad = (n: number): string => String(Math.abs(n)).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offset}`
  );
}

/** 出力ファイル名が親ディレクトリ内に収まることを防御的に検証する。 */
function safeChildPath(dir: string, fileName: string): string {
  const resolved = path.resolve(dir, fileName);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
    throw new KidoriError(
      `出力ファイル名 '${fileName}' が出力ディレクトリの外を指しています`,
    );
  }
  return resolved;
}

function cleanupStale(
  outDir: string,
  partsDir: string,
  managedSvg: Set<string>,
  managedPng: Set<string>,
): void {
  if (fs.existsSync(outDir)) {
    for (const name of fs.readdirSync(outDir)) {
      if (/^plan-.*\.svg$/.test(name) && !managedSvg.has(name)) {
        fs.unlinkSync(path.join(outDir, name));
      }
      if (/^plan-.*\.png$/.test(name) && !managedPng.has(name)) {
        fs.unlinkSync(path.join(outDir, name));
      }
    }
  }
  if (fs.existsSync(partsDir)) {
    for (const name of fs.readdirSync(partsDir)) {
      if (name.endsWith(".svg") && !managedSvg.has(`parts/${name}`)) {
        fs.unlinkSync(path.join(partsDir, name));
      }
      if (name.endsWith(".png") && !managedPng.has(`parts/${name}`)) {
        fs.unlinkSync(path.join(partsDir, name));
      }
    }
  }
}

/**
 * 割付案の生成＋厳密探索の統合（v0.4 §5）。
 *
 * - selectedPlan が A/B/C: その案のみ生成し、厳密探索は省略する。
 * - selectedPlan が "X": 厳密探索の案 X のみ生成する（生成不能なら KidoriError）。
 * - selectedPlan が null: A/B/C を生成し、settings.exact に応じて厳密探索を実行。
 *   厳密解の必要本数がいずれかのヒューリスティック案と全 stock で一致する場合は
 *   案 X を追加せず、一致した案に exactMatch を立てる。厳密解が真に少ない場合のみ
 *   案 X を候補に加える。
 */
function generateAllPlans(project: Project): {
  plans: Plan[];
  summaries: PlanSummary[];
  exactInfo: ExactInfo;
} {
  const settings = project.settings;
  const selected = settings.selectedPlan;
  const mode = settings.exact;

  const heuristics = generatePlans(project);

  if (selected !== null && selected !== "X") {
    return {
      plans: heuristics,
      summaries: heuristics.map((p) => summarize(p, project)),
      exactInfo: {
        mode,
        ran: false,
        proven: false,
        matchesPlan: null,
        reason: "selectedPlan が設定済みのため厳密探索を省略しました",
      },
    };
  }

  const exact = runExact(project);

  if (selected === "X") {
    if (exact.plan === null) {
      throw new KidoriError(
        `selectedPlan: "X" が指定されていますが、厳密探索の案 X を生成できませんでした` +
          (exact.reason !== null ? `（${exact.reason}）` : ""),
      );
    }
    const summaries = [summarize(exact.plan, project)];
    return {
      plans: [exact.plan],
      summaries,
      exactInfo: {
        mode,
        ran: exact.ran,
        proven: exact.proven,
        matchesPlan: null,
        reason: exact.reason,
      },
    };
  }

  // selected === null
  const plans = [...heuristics];
  const summaries = plans.map((p) => summarize(p, project));
  let matchesPlan: string | null = null;

  if (exact.plan !== null) {
    const exactSummary = summarize(exact.plan, project);
    const sameCounts = (a: PlanSummary, b: PlanSummary): boolean => {
      const keysA = Object.keys(a.totals.stockCounts);
      const keysB = Object.keys(b.totals.stockCounts);
      if (keysA.length !== keysB.length) {
        return false;
      }
      return keysA.every(
        (k) => a.totals.stockCounts[k] === b.totals.stockCounts[k],
      );
    };
    const matching = summaries.filter((s) => sameCounts(s, exactSummary));
    if (matching.length > 0) {
      for (const s of matching) {
        s.exactMatch = true;
      }
    } else {
      plans.push(exact.plan);
      summaries.push(exactSummary);
    }
  }

  const rankedForMatch = rankPlans(summaries, settings.rank);
  if (exact.plan !== null) {
    matchesPlan =
      rankedForMatch.find(
        (id) => summaries.find((s) => s.id === id)?.exactMatch === true,
      ) ?? null;
  }

  return {
    plans,
    summaries,
    exactInfo: {
      mode,
      ran: exact.ran,
      proven: exact.proven,
      matchesPlan,
      reason: exact.reason,
    },
  };
}

/**
 * project.yaml / project.json から SVG・PNG・summary.json を生成する。
 *
 * @throws ProjectError 正本データの検証エラーがある場合（送出前に Issue をログ出力）。
 * @throws KidoriError selectedPlan: "X" なのに案 X を生成できない場合等。
 */
export function build(projectPath: string, options: BuildOptions = {}): BuildResult {
  const log = options.log ?? ((m: string) => console.error(m));
  const png = options.png ?? true;
  const pngScale = options.pngScale ?? 2.0;

  projectPath = path.resolve(projectPath);
  const outDir = options.outDir
    ? path.resolve(options.outDir)
    : path.join(path.dirname(projectPath), "out");
  const partsDir = path.join(outDir, "parts");

  checkModeline(projectPath, log);

  // ① raw 読込（失敗しても schema 書き出しは試みる）。
  let rawForSchema: unknown = null;
  try {
    rawForSchema = readRaw(projectPath);
  } catch {
    rawForSchema = null;
  }
  const stockIds = extractStockIds(rawForSchema);

  // ② schema 書き出し（検証より先に、毎回）。
  writeSchema(projectPath, stockIds);

  // ③ 検証。
  let project: Project;
  let warnings: Issue[];
  try {
    const loaded = loadProject(projectPath);
    project = loaded.project;
    warnings = loaded.warnings;
  } catch (e) {
    if (e instanceof ProjectError) {
      for (const issue of e.issues) {
        printIssue(issue, log);
      }
    }
    throw e;
  }
  for (const issue of warnings) {
    printIssue(issue, log);
  }

  // ④⑤⑥ 割付案生成＋厳密探索＋ランキング。
  const { plans, summaries, exactInfo } = generateAllPlans(project);
  const rankedPlans = rankPlans(summaries, project.settings.rank);

  // selectedPlan 採用後は推奨★表示を行わない（採用案のみの再生成のため）。
  const recommendationActive = project.settings.selectedPlan === null;
  if (!recommendationActive) {
    for (const s of summaries) {
      s.recommended = false;
    }
  }

  const generatedAt = isoNow();
  const summary = buildSummary(
    summaries,
    project,
    generatedAt,
    exactInfo,
    recommendationActive ? rankedPlans : [],
  );

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(partsDir, { recursive: true });

  const managedSvg = new Set<string>();
  const managedPng = new Set<string>();
  const svgPaths: string[] = [];
  const pngPaths: string[] = [];

  // ⑦ 木取り図 SVG（＋⑧ PNG）。
  let pngWarned = false;
  const emitPng = (svgText: string, pngPath: string, managedName: string): void => {
    if (!png) {
      return;
    }
    if (svgToPng(svgText, pngPath, pngScale)) {
      managedPng.add(managedName);
      pngPaths.push(pngPath);
    } else if (!pngWarned) {
      log("[警告] resvg-js が利用できないため PNG 生成をスキップしました");
      pngWarned = true;
    }
  };

  plans.forEach((plan, i) => {
    const svgText = renderCutplan(plan, project, summaries[i]);
    const svgName = `plan-${plan.id}.svg`;
    const svgPath = path.join(outDir, svgName);
    fs.writeFileSync(svgPath, svgText, "utf-8");
    managedSvg.add(svgName);
    svgPaths.push(svgPath);

    emitPng(svgText, path.join(outDir, `plan-${plan.id}.png`), `plan-${plan.id}.png`);
  });

  // 加工指示図: selectedPlan 設定時のみヘッダに配置番号（Plan.seq）を渡す。
  const selectedPlanId = project.settings.selectedPlan;
  const seqByPart = new Map<string, number[]>();
  if (selectedPlanId !== null) {
    const selected = plans.find((p) => p.id === selectedPlanId);
    if (selected) {
      for (const [instId, seqNum] of Object.entries(selected.seq)) {
        const partId = instId.slice(0, instId.lastIndexOf("#"));
        const list = seqByPart.get(partId) ?? [];
        list.push(seqNum);
        seqByPart.set(partId, list);
      }
      for (const nums of seqByPart.values()) {
        nums.sort((a, b) => a - b);
      }
    }
  }

  const stocksById = new Map(project.stocks.map((s) => [s.id, s]));
  const partCards: { id: string; label: string; svgPath: string }[] = [];
  for (const part of project.parts) {
    const stock = stocksById.get(part.stock);
    if (!stock) {
      continue; // 意味検証層で既に error のはずだが防御的にスキップ。
    }
    const seqLabels =
      selectedPlanId !== null ? (seqByPart.get(part.id) ?? null) : null;
    const svgText = renderPartcard(part, stock, {
      seqLabels,
      planId: selectedPlanId,
    });
    const svgName = `${part.id}.svg`;
    const svgPath = safeChildPath(partsDir, svgName);
    fs.writeFileSync(svgPath, svgText, "utf-8");
    managedSvg.add(`parts/${svgName}`);
    svgPaths.push(svgPath);
    partCards.push({ id: part.id, label: part.label, svgPath });

    emitPng(svgText, safeChildPath(partsDir, `${part.id}.png`), `parts/${part.id}.png`);
  }

  // ⑨ summary.json。
  const summaryPath = path.join(outDir, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf-8");

  // ⑩ 陳腐化ファイル削除。
  cleanupStale(outDir, partsDir, managedSvg, managedPng);

  return {
    projectPath,
    outDir,
    partsDir,
    planIds: plans.map((p) => p.id),
    svgPaths,
    pngPaths,
    summaryPath,
    warnings,
    pngEnabled: png,
    summary,
    partCards,
  };
}
