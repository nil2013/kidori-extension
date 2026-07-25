/**
 * ビルドオーケストレータ。
 *
 * `build(projectPath, options)` が公開エントリ。フロー:
 *
 *   ① loadProject（error なら Issue 一覧をログ出力し ProjectError を伝播）
 *   ② 前回 summary.json の読み出し → 出力先の共有検出（warning）＋
 *      採用案の有効性判定（SPECS.md §5。割付フィンガープリントと adopted 記録を
 *      突き合わせ、実効 selectedPlan を決める）
 *   ③ generatePlans（ヒューリスティック案 A/B/C）
 *   ④ runExact（settings.exact に応じた厳密探索。案 X または最適一致判定）
 *   ⑤ metrics（summarize / rankPlans / buildSummary）— 推奨案★の決定
 *   ⑥ plan-X.svg + parts/*.svg（Phase 1: 全てメモリ上に用意）
 *   ⑦ PNG（resvg-js。PNG 有効かつ利用不可なら KidoriError。S-09）
 *   ⑧ summary.json（generatedAt は build 時刻の ISO 文字列。正本ハッシュ付き）
 *   ⑨ Phase 2: tmp+rename でアトミックにコミット。summary.json を最後に書く
 *   ⑩ 管理対象パターン（plan-*.svg/png, parts/*.svg/png, summary.json）の
 *      陳腐化ファイル削除（管理外ファイルには触れない）＋失敗マーカー除去
 *
 * 出力先は `<正本のディレクトリ>/<stem>.out/`（SPECS.md §3。`defaultOutDir`）。
 * スキーマファイルのディスク再生成は v0.6 で廃止された（§4b）。基底スキーマの
 * 書き出しは `kidori init` の仕事であり、`schema.ts` の `writeBaseSchema` が担う。
 *
 * `<stem>.out/` の現行正本反映保証（S-11 / S-12）:
 *   - build() 全体を try/catch し、例外時は BUILD-FAILED.txt を書いて rethrow。
 *     マーカーの有無で「直近ビルドがプロセス内で完走したか」を判定できる。
 *   - summary.json に正本の SHA-256 を載せ、`shasum` との照合で出力が現行正本
 *     由来かを外形判定できる（プロセス強制終了などマーカーが書けない場合の分担）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { Issue, KidoriError, ProjectError } from "./errors";
import { loadProject } from "./loader";
import { MODELINE_PREFIX, BASE_SCHEMA_FILENAME, defaultOutDir } from "./kidorifile";
import { AdoptionRecord, layoutFingerprint } from "./fingerprint";
import { generatePlans } from "./packing";
import { Plan } from "./packing/common";
import { runExact } from "./exact";
import {
  ExactInfo,
  PlanSummary,
  Summary,
  buildSummary,
  comparePlanSummaries,
  rankPlans,
  summarize,
} from "./metrics";
import { renderCutplan } from "./render/cutplan";
import { renderPartcard } from "./render/partcard";
import { pngAvailable, svgToPngBuffer } from "./png";
import type { Project, RankKey } from "./types";

/** 出力先に書き込む前の成果物（name は outDir 相対、区切りは "/"）。 */
interface Artifact {
  name: string;
  data: string | Uint8Array;
}

/** ビルド失敗マーカーのファイル名。存在＝直近ビルドが完走していない。 */
const FAILURE_MARKER = "BUILD-FAILED.txt";

/** summary.json のファイル名（前回の adopted 記録の読み出しにも使う）。 */
const SUMMARY_FILENAME = "summary.json";

export interface BuildOptions {
  /**
   * 出力先ディレクトリ。省略時は `<正本のディレクトリ>/<stem>.out/`
   * （SPECS.md §3。導出は `kidorifile.defaultOutDir`）。
   */
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
  /** 今回生成した割付案の ID 一覧（有効な採用案がある場合は1件のみ）。 */
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
      "[案内] 正本ファイルの先頭行に " +
        `\`${MODELINE_PREFIX}./${BASE_SCHEMA_FILENAME}\` を追記すると、` +
        "VS Code 以外のエディタでも補完・検証が有効になります" +
        `（kidori 拡張を使う場合は不要です。${BASE_SCHEMA_FILENAME} は ` +
        "`kidori init` が書き出します）。",
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

/** 正本ファイルのバイト列から SHA-256（hex）を求める。読めなければ "unknown"。 */
function computeSourceSha256(projectPath: string): string {
  try {
    // パース用の readRaw とは別に、正本のバイト列そのものをハッシュ化する
    // （TOCTOU の窓は運用上無視できるものとして、2回読みを許容する）。
    const bytes = fs.readFileSync(projectPath);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return "unknown";
  }
}

/**
 * ビルド失敗マーカー `<出力先>/BUILD-FAILED.txt` を書き出す。出力先が未作成なら作る。
 * マーカー書き込み自体の失敗はログして握りつぶす（元の例外の伝播を妨げない）。
 */
function writeFailureMarker(
  outDir: string,
  error: unknown,
  sourceFile: string,
  sourceSha256: string,
  log: (m: string) => void,
): void {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const reason = error instanceof Error ? error.message : String(error);
    const content =
      "この出力ディレクトリの図面は最新の正本を反映していません（ビルド失敗）。\n" +
      "最新の図面を得るには、正本を修正して再ビルドしてください。\n" +
      `failedAt: ${isoNow()}\n` +
      `source: ${sourceFile}\n` +
      `sourceSha256: ${sourceSha256}\n` +
      `reason: ${reason}\n`;
    fs.writeFileSync(path.join(outDir, FAILURE_MARKER), content, "utf-8");
  } catch (e) {
    log(
      `[警告] ビルド失敗マーカーの書き込みに失敗しました: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/** ディレクトリ直下に残った *.kidori-tmp（前回コミットの中断残骸）を掃除する。 */
function removeTmpResidue(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".kidori-tmp")) {
      fs.unlinkSync(path.join(dir, name));
    }
  }
}

/** 1成果物を tmp へ書いてから rename でアトミックに確定する（Phase 2）。 */
function writeArtifactAtomic(outDir: string, art: Artifact): void {
  const target = safeChildPath(outDir, art.name);
  const tmp = target + ".kidori-tmp";
  fs.writeFileSync(tmp, art.data);
  fs.renameSync(tmp, target);
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
 * S-04 タイ処理の判定: 必要本数が一致した全ヒューリスティック案よりも、案 X が
 * settings.rank 上で厳密に上位（comparePlanSummaries が負値）の場合のみ true。
 * comparePlanSummaries は全基準同値のときヒューリスティック案を X より上位に
 * 置くため、完全なタイでは false になる（＝案 X は破棄される）。
 * 候補保持の判定であり、最適性の証明状態（proven）には依存しない。
 */
export function exactPlanStrictlyBetter(
  exactSummary: PlanSummary,
  matching: PlanSummary[],
  rankKeys: RankKey[],
): boolean {
  return matching.every(
    (s) => comparePlanSummaries(exactSummary, s, rankKeys) < 0,
  );
}

/**
 * 割付案の生成＋厳密探索の統合（v0.4 §5）。
 *
 * `selected` は正本の `settings.selectedPlan` そのものではなく、採用案の有効性
 * 判定（`resolveAdoption`）を通した**実効選択**である（無効化中は null になり、
 * 全案が再生成される）。
 *
 * - selected が A/B/C: その案のみ生成し、厳密探索は省略する。
 * - selected が "X": 厳密探索の案 X のみ生成する（生成不能なら KidoriError）。
 * - selected が null: A/B/C を生成し、settings.exact に応じて厳密探索を実行。
 *   - 厳密解の必要本数が全 stock で一致するヒューリスティック案には、厳密探索が
 *     最適性を証明できた（exact.proven）場合に限り exactMatch を立てる。
 *   - 一致案があっても、案 X が rank 上で一致した全案より厳密に上位（例: 同じ本数で
 *     カット回数が少ない）なら、案 X も候補として保持する（S-04。候補としての価値は
 *     証明から独立なので proven は問わない）。
 *   - 一致案が無い（厳密解が真に少ない）場合は案 X を候補に加える。
 *   - 案 X の summary には exactProven（＝exact.proven）を設定し、表示側が
 *     「候補X（厳密解）」/「探索案X（最適性未証明）」を出し分けられるようにする。
 */
function generateAllPlans(
  project: Project,
  selected: string | null,
): {
  plans: Plan[];
  summaries: PlanSummary[];
  exactInfo: ExactInfo;
} {
  const settings = project.settings;
  const mode = settings.exact;

  const heuristics = generatePlans(project, selected);

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

  // selectedPlan: "X" 経路では AUTO_LIMIT 件数制限を無視する（検証を通過した
  // 正本が件数超過で確定的にビルド不能になるのを防ぐ。S-13）。
  const exact = runExact(project, { force: selected === "X" });

  if (selected === "X") {
    if (exact.plan === null) {
      throw new KidoriError(
        `selectedPlan: "X" が指定されていますが、厳密探索の案 X を生成できませんでした` +
          (exact.reason !== null ? `（${exact.reason}）` : ""),
      );
    }
    const summary = summarize(exact.plan, project);
    summary.exactProven = exact.proven;
    return {
      plans: [exact.plan],
      summaries: [summary],
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
    exactSummary.exactProven = exact.proven;
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
      // exactMatch は最適性が証明された場合のみ立てる（S-02/S-03）。
      if (exact.proven) {
        for (const s of matching) {
          s.exactMatch = true;
        }
      }
      // S-04: 本数が一致していても、案 X が rank 上で一致した全案より厳密に上位
      // （例: カット回数が少ない）なら案 X も候補として保持する。
      if (exactPlanStrictlyBetter(exactSummary, matching, settings.rank)) {
        plans.push(exact.plan);
        summaries.push(exactSummary);
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

/** 前回ビルドの summary.json から読み出した、今回のビルドに効く情報。 */
interface PreviousSummary {
  /** 採用記録（SPECS.md §5）。無い・壊れているなら null。 */
  adopted: AdoptionRecord | null;
  /** 前回この出力先を書いた正本のベース名。読めなければ null。 */
  sourceFile: string | null;
}

const NO_PREVIOUS: PreviousSummary = { adopted: null, sourceFile: null };

/**
 * 前回ビルドの summary.json を読み出す。
 *
 * 読めない・壊れている・形が違う場合はすべて「記録なし（null）」として扱う
 * （壊れた summary.json でビルドが死んではならない）。項目ごとに独立して
 * 判定するため、adopted が壊れていても sourceFile は拾える（逆も同様）。
 */
function readPreviousSummary(outDir: string): PreviousSummary {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(path.join(outDir, SUMMARY_FILENAME), "utf-8"));
  } catch {
    return NO_PREVIOUS;
  }
  if (typeof data !== "object" || data === null) {
    return NO_PREVIOUS;
  }
  const record = data as { adopted?: unknown; sourceFile?: unknown };

  let adopted: AdoptionRecord | null = null;
  const raw = record.adopted;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const { plan, fingerprint } = raw as Record<string, unknown>;
    if (
      typeof plan === "string" &&
      plan !== "" &&
      typeof fingerprint === "string" &&
      fingerprint !== ""
    ) {
      adopted = { plan, fingerprint };
    }
  }

  const sourceFile =
    typeof record.sourceFile === "string" && record.sourceFile !== ""
      ? record.sourceFile
      : null;

  return { adopted, sourceFile };
}

/**
 * 出力先が別の正本と共有されていないかを O(1) で確認する。
 *
 * `<stem>.out/` 規則（SPECS.md §3）では `foo.yaml` と `foo.kidori.yaml` が
 * 同居すると出力先が衝突し、互いの成果物を静かに上書きし合う。ディレクトリ
 * 走査によるガードは per-file ビルドの独立性に反するため行わず、CORE-7 で
 * どのみち読んでいる前回 summary.json の `sourceFile` を流用して検出する。
 *
 * 正当なユースケースではないがビルド自体は成功させてよいので warning とする。
 * summary.json が無い・壊れている場合は何もしない（「記録なし」扱い）。
 */
function checkOutDirOwner(
  previousSourceFile: string | null,
  sourceFile: string,
  outDir: string,
): Issue | null {
  if (previousSourceFile === null || previousSourceFile === sourceFile) {
    return null;
  }
  return {
    path: "<root>",
    message:
      `この出力先は別の正本 (${previousSourceFile}) と共有されています` +
      `（${outDir}）。同じ出力先を使う正本どうしは成果物を上書きし合います。` +
      "どちらかのファイル名を変えるか、--out で出力先を分けてください。",
    severity: "warning",
  };
}

/** `resolveAdoption` の結果。 */
interface AdoptionState {
  /** 実効的な採用案（無効化中は null ＝全案再生成）。 */
  effectiveSelected: string | null;
  /** summary.json に書き戻す採用記録。 */
  adopted: AdoptionRecord | null;
  /** 採用案が設計変更で無効化されているか。 */
  stale: boolean;
  /** 無効化を通知する warning Issue（無効化していなければ null）。 */
  issue: Issue | null;
}

/**
 * 採用案の有効性を判定する（SPECS.md §5「採用後の設計変更」）。
 *
 * 規則:
 * - `selectedPlan: null` → 全案生成、記録なし。
 * - `selectedPlan: P` で有効な記録が無い（出力ディレクトリが新規・手編集・
 *   チェックアウト直後）、または記録が別の案のもの → **今を採用時点とみなし**
 *   P のみ生成して `{P, 現 fp}` を記録する。
 * - 記録 `{P, F}` があり `F == 現 fp` → 有効。P のみ生成し記録を持ち回る。
 * - `F != 現 fp` → **無効**。`selectedPlan` を無視して全案を再生成し、warning で
 *   再選択を促す。このとき **`{P, F}` を元のまま保存する**のが要諦で、現 fp で
 *   上書きすると次のビルドが「自己治癒」して警告が消えてしまう。元 fp を保持
 *   すれば、幾何を F に戻したときだけ正しく再有効化される。
 *
 * `selectedPlan` の値自体は自動では書き換えない（正本の書き換えは人の操作に限る）。
 */
export function resolveAdoption(
  requested: string | null,
  fingerprint: string,
  previous: AdoptionRecord | null,
): AdoptionState {
  if (requested === null) {
    return {
      effectiveSelected: null,
      adopted: null,
      stale: false,
      issue: null,
    };
  }

  if (previous === null || previous.plan !== requested) {
    // 記録なし（または別案の記録）→ 今を採用時点とみなす。
    return {
      effectiveSelected: requested,
      adopted: { plan: requested, fingerprint },
      stale: false,
      issue: null,
    };
  }

  if (previous.fingerprint === fingerprint) {
    return {
      effectiveSelected: requested,
      adopted: previous,
      stale: false,
      issue: null,
    };
  }

  return {
    effectiveSelected: null,
    // 元のフィンガープリントを保持する（自己治癒させない）。
    adopted: previous,
    stale: true,
    issue: {
      path: "settings.selectedPlan",
      message:
        `採用案 ${requested} は設計変更後の割付に基づいていません。` +
        "案を選び直してください（全案を再生成しました）。",
      severity: "warning",
    },
  };
}

/**
 * kidori ファイル（正本）から SVG・PNG・summary.json を生成する。
 *
 * @throws ProjectError 正本データの検証エラーがある場合（送出前に Issue をログ出力）。
 * @throws KidoriError selectedPlan: "X" なのに案 X を生成できない場合等。
 */
export function build(projectPath: string, options: BuildOptions = {}): BuildResult {
  const log = options.log ?? ((m: string) => console.error(m));

  projectPath = path.resolve(projectPath);
  const outDir = options.outDir
    ? path.resolve(options.outDir)
    : defaultOutDir(projectPath);

  const sourceFile = path.basename(projectPath);
  const sourceSha256 = computeSourceSha256(projectPath);

  // S-11: build() 全体を try/catch し、いかなる例外でも出力先に失敗マーカーを
  // 残してから rethrow する（マーカーなし＝直近ビルド完走の不変条件）。
  try {
    return buildInner(projectPath, outDir, sourceFile, sourceSha256, options, log);
  } catch (e) {
    writeFailureMarker(outDir, e, sourceFile, sourceSha256, log);
    throw e;
  }
}

function buildInner(
  projectPath: string,
  outDir: string,
  sourceFile: string,
  sourceSha256: string,
  options: BuildOptions,
  log: (m: string) => void,
): BuildResult {
  const png = options.png ?? true;
  const pngScale = options.pngScale ?? 2.0;
  const partsDir = path.join(outDir, "parts");

  checkModeline(projectPath, log);

  // ① 検証（スキーマファイルのディスク再生成は v0.6 で廃止。SPECS.md §4b）。
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

  // ② 前回ビルドの summary.json を1回だけ読み、(a) 出力先の共有検出と
  //    (b) 採用案の有効性判定（SPECS.md §5）に使う。
  const previous = readPreviousSummary(outDir);

  const ownerIssue = checkOutDirOwner(previous.sourceFile, sourceFile, outDir);
  if (ownerIssue !== null) {
    warnings = [...warnings, ownerIssue];
  }

  // 現在の割付フィンガープリントと前回の adopted 記録を突き合わせ、
  // 実効的な選択を決める。
  const fingerprint = layoutFingerprint(project);
  const adoption = resolveAdoption(
    project.settings.selectedPlan,
    fingerprint,
    previous.adopted,
  );
  if (adoption.issue !== null) {
    warnings = [...warnings, adoption.issue];
  }
  for (const issue of warnings) {
    printIssue(issue, log);
  }

  // ③④⑤ 割付案生成＋厳密探索＋ランキング。
  const { plans, summaries, exactInfo } = generateAllPlans(
    project,
    adoption.effectiveSelected,
  );
  const rankedPlans = rankPlans(summaries, project.settings.rank);

  // 有効な採用案がある間は推奨★表示を行わない（採用案のみの再生成のため）。
  // 無効化中は全案を再生成しているので推奨★を復活させる。
  const recommendationActive = adoption.effectiveSelected === null;
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
    sourceFile,
    sourceSha256,
    adoption.adopted,
    adoption.stale,
  );

  // ---- Phase 1（純メモリ）: 全 SVG・全 PNG・summary.json を artifacts に集める ----
  // 出力先には一切書かない。この段階での例外（PNG 変換・パス検証等）は build() の
  // try/catch へ伝播し、出力先を無変更のまま失敗マーカーだけが残る（S-12）。

  // S-09: PNG が確定要件のため、PNG 有効なのに resvg-js が使えなければここで失敗させる。
  if (png && !pngAvailable()) {
    throw new KidoriError(
      "PNG 生成に必要な @resvg/resvg-js が利用できません。" +
        "PNG を生成しない場合は CLI で --no-png、" +
        "拡張では設定 kidori.png.enabled: false を指定してください。",
    );
  }

  const artifacts: Artifact[] = [];
  const managedSvg = new Set<string>();
  const managedPng = new Set<string>();
  const svgPaths: string[] = [];
  const pngPaths: string[] = [];

  // ⑥ 木取り図 SVG（＋⑦ PNG）。
  plans.forEach((plan, i) => {
    const svgText = renderCutplan(plan, project, summaries[i]);
    const svgName = `plan-${plan.id}.svg`;
    artifacts.push({ name: svgName, data: svgText });
    managedSvg.add(svgName);
    svgPaths.push(path.join(outDir, svgName));

    if (png) {
      const buf = svgToPngBuffer(svgText, pngScale);
      // pngAvailable() を上で確認済みのため buf は非 null（防御的に null をスキップ）。
      if (buf !== null) {
        const pngName = `plan-${plan.id}.png`;
        artifacts.push({ name: pngName, data: buf });
        managedPng.add(pngName);
        pngPaths.push(path.join(outDir, pngName));
      }
    }
  });

  // 加工指示図: 有効な採用案がある場合のみヘッダに配置番号（Plan.seq）を渡す。
  // 無効化中は全案を再生成しているため、配置番号は連動させない。
  const selectedPlanId = adoption.effectiveSelected;
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
    // safeChildPath で part.id に不正な区切りが無いことを Phase 1 中に検証する。
    const svgAbs = safeChildPath(partsDir, `${part.id}.svg`);
    const svgName = `parts/${part.id}.svg`;
    artifacts.push({ name: svgName, data: svgText });
    managedSvg.add(svgName);
    svgPaths.push(svgAbs);
    partCards.push({ id: part.id, label: part.label, svgPath: svgAbs });

    if (png) {
      const buf = svgToPngBuffer(svgText, pngScale);
      if (buf !== null) {
        const pngAbs = safeChildPath(partsDir, `${part.id}.png`);
        artifacts.push({ name: `parts/${part.id}.png`, data: buf });
        managedPng.add(`parts/${part.id}.png`);
        pngPaths.push(pngAbs);
      }
    }
  }

  // ⑧ summary.json（コミット記録として最後に確定する）。
  const summaryName = SUMMARY_FILENAME;
  const summaryPath = path.join(outDir, summaryName);
  const summaryData = JSON.stringify(summary, null, 2) + "\n";

  // ---- Phase 2（コミット）: tmp+rename でファイル単位にアトミックに確定する ----
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(partsDir, { recursive: true });
  removeTmpResidue(outDir);
  removeTmpResidue(partsDir);

  // 全成果物を先に確定し、最後に summary.json を書く（＝ビルド完走の記録）。
  for (const art of artifacts) {
    writeArtifactAtomic(outDir, art);
  }
  writeArtifactAtomic(outDir, { name: summaryName, data: summaryData });

  // ⑨ 陳腐化ファイル削除。
  cleanupStale(outDir, partsDir, managedSvg, managedPng);

  // ⑩ 成功コミットの最終ステップ: 失敗マーカーを除去する。
  fs.rmSync(path.join(outDir, FAILURE_MARKER), { force: true });

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
