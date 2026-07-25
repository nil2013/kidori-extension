/**
 * `kidori new` の雛形生成（SPECS.md §3a「① 着手」）。エディタ非依存（SPECS.md §3）。
 *
 * 主経路として、**コメント注釈付きの kidori ファイル1枚**を生成し、これだけで
 * 作業を開始できる状態にする（§3a「ファイル雛形」）。VS Code のコマンド
 * 「kidori: New Cutting Plan」と CLI `kidori new` はいずれも本モジュールを呼ぶ
 * （雛形の内容を二重に持たない）。
 *
 * 設計上の要点:
 *
 * 1. **プリセットは実体化して書き出す**（SPECS.md §4b）。規格材マスタの4層
 *    カスケード（core/stocks）から実値と `preset:` 来歴キーを取り出し、正本へ
 *    そのまま埋め込む。ビルドは `preset` を解決しないため、生成された雛形は
 *    マスタが無くてもそのままビルドできる（正本の自己完結性）。
 *    実体化コードは補完（拡張）と共有する（core/stocks/materialize.ts）。
 *
 * 2. **サンプル部材の寸法は原材から導出する**。固定値を書くと、小さい定尺の
 *    プリセットを指定したときに「生成直後の雛形がビルドを通らない」ことが
 *    起こりうる。原材の使用可能寸法（length − 2×edgeTrim）から部材長・溝の
 *    寸法を計算し、雛形が常に loader の意味検証（物理的整合性）を通るようにする。
 *
 * 3. **モードラインは参照先が実在するときだけ有効化する**（SPECS.md §4b）。
 *    §3a は雛形に「モードライン入り」と書くが、参照先 `./kidori.schema.json` は
 *    `kidori init` の生成物であり、`kidori new` 単独の主経路では存在しない。
 *    存在しないファイルを指すモードラインは YAML 言語サービス側のエラーになる
 *    ため、実在しない場合はコメントアウトし、`kidori init` 後に有効化する旨の
 *    ヒントを添える。§4b 自身がモードラインを「VS Code 以外の環境向けの代替
 *    手段」と位置づけており（VS Code では拡張がスキーマをメモリ上で供給する）、
 *    字面からの軽微な逸脱だが意図には忠実である。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { KidoriError } from "./errors";
import {
  BASE_SCHEMA_FILENAME,
  MODELINE_PREFIX,
  hasKidoriSuffix,
  projectStem,
} from "./kidorifile";
import {
  ResolvedStock,
  defaultStockId,
  isInsertable,
  loadStockMasterFrom,
  materializeEntry,
  resolveCascade,
} from "./stocks";

/** 雛形の既定サフィックス（SPECS.md §3「命名規約: *.kidori.yaml（推奨）」）。 */
export const DEFAULT_SCAFFOLD_SUFFIX = ".kidori.yaml";

/** 雛形が書き込む `meta.schemaVersion`（loader.SUPPORTED_SCHEMA_VERSION と同値）。 */
export const SCAFFOLD_SCHEMA_VERSION = "0.4";

/** 既定の雛形が使うビルトインのマスタキー（bar: アクティブ / sheet: コメントアウト）。 */
export const DEFAULT_BAR_PRESET = "spf/1x4/6f";
export const DEFAULT_SHEET_PRESET = "pine/18mm/sabroku";

/** 雛形が書き込む settings の既定値（SPECS.md §4 の主要フィールド定義）。 */
const KERF = 3;
const EDGE_TRIM = 5;

/** `kidori new` に固有のエラー（CLI は exit 1 で扱う）。 */
export class ScaffoldError extends KidoriError {}

export interface ScaffoldOptions {
  /**
   * `assets/` を含むインストールルート（バンドル後は `dist/` の親）。
   * 規格材マスタのビルトイン層を読むために必要（core/stocks/cascade.ts）。
   */
  rootPath: string;
  /**
   * 使用する規格材マスタのキー（`--preset` の反復指定。順序は保持し重複は除去）。
   * 空・未指定なら既定の最小雛形（bar 1本＋コメントアウトされた sheet 1枚）。
   */
  presets?: readonly string[];
}

export interface ScaffoldResult {
  /** 実際に書き出したファイルの絶対パス。 */
  path: string;
  /** 雛形に実体化したマスタキー（既定雛形では bar・sheet の2件）。 */
  presetKeys: string[];
  /** モードラインを有効な形で書いたか（`kidori.schema.json` が実在した）。 */
  modelineEnabled: boolean;
}

// ---------------------------------------------------------------------------
// ファイル名の解決
// ---------------------------------------------------------------------------

/**
 * `kidori new <ファイル名>` の引数から実際の書き出し先を決める。
 *
 * - 既に `*.kidori.{yaml,yml,json}` なら**そのまま**。
 * - 素の `.yaml` / `.yml` / `.json` で終わるなら、その拡張子を
 *   `.kidori.yaml` に**置き換える**（`foo.yaml` → `foo.kidori.yaml`。
 *   単純な後置だと `foo.yaml.kidori.yaml` という二重拡張子になってしまう）。
 * - それ以外は `.kidori.yaml` を後置する（`bookshelf` → `bookshelf.kidori.yaml`）。
 */
export function resolveScaffoldPath(filePath: string): string {
  if (hasKidoriSuffix(filePath)) {
    return filePath;
  }
  const m = /\.(?:yaml|yml|json)$/i.exec(filePath);
  const stem = m === null ? filePath : filePath.slice(0, -m[0].length);
  return stem + DEFAULT_SCAFFOLD_SUFFIX;
}

// ---------------------------------------------------------------------------
// プリセットの解決
// ---------------------------------------------------------------------------

/** 雛形に載せられる（実値が揃っている）カスケード候補の一覧。 */
export function availablePresets(rootPath: string, documentPath?: string): ResolvedStock[] {
  const master = loadStockMasterFrom(rootPath);
  const cascade = resolveCascade(master, { documentPath });
  return cascade.entries.filter(isInsertable);
}

/** 未知のキーに対するエラー文（利用可能なキーを必ず列挙する）。 */
function unknownPresetMessage(key: string, available: ResolvedStock[]): string {
  const list = available.map((s) => `  ${s.key}  （${s.entry.label ?? s.key}）`).join("\n");
  return (
    `規格材マスタに '${key}' というキーはありません。\n` +
    `利用可能なキー（${available.length} 件）:\n${list}\n` +
    "独自の規格材を候補に加えるには、ユーザー層 " +
    "($XDG_CONFIG_HOME/kidori/stocks.yaml) またはディレクトリ層 " +
    "(stocks.yaml) に追記してください。"
  );
}

/** 指定キー列を実体化対象のカスケード候補へ解決する（重複は先勝ちで除去）。 */
function resolvePresets(keys: readonly string[], available: ResolvedStock[]): ResolvedStock[] {
  const byKey = new Map(available.map((s) => [s.key, s]));
  const out: ResolvedStock[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const found = byKey.get(key);
    if (found === undefined) {
      throw new ScaffoldError(unknownPresetMessage(key, available));
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(found);
  }
  return out;
}

/** 既定雛形が使う bar / sheet を選ぶ（既定キーが無ければ同種の先頭で代替）。 */
function pickDefault(available: ResolvedStock[], key: string, kind: "bar" | "sheet"):
  | ResolvedStock
  | undefined {
  return (
    available.find((s) => s.key === key) ?? available.find((s) => s.entry.kind === kind)
  );
}

// ---------------------------------------------------------------------------
// サンプル部材の寸法導出
// ---------------------------------------------------------------------------

/** 小数第1位までに丸めて YAML の数値トークンにする（1.0 → "1"）。 */
function fmt(value: number): string {
  return String(Math.round(value * 10) / 10);
}

interface SamplePart {
  length: number;
  /** sheet 部材のみ（bar 部材は width を省略する＝原材幅が実効幅）。 */
  width: number | null;
  grooveWidth: number;
  groovePos: number;
  grooveDepth: number;
  /** コメントアウトで例示する丸穴（外して有効化してもビルドが通る値）。 */
  holeX: number;
  holeY: number;
  holeDia: number;
}

/**
 * 原材から、必ず loader の意味検証を通るサンプル部材の寸法を導く。
 *
 * - 部材長は使用可能長（length − 2×edgeTrim）の半分を上限に 600mm へ丸める。
 * - 溝幅は部材長の 1/4 を上限に 7mm、溝中心は部材長の 1/3（pos ± width/2 が
 *   必ず [0, length] に収まる）。
 * - 溝深さは原材厚みの半分を上限に 6mm（厚み同値は「実質貫通」warning になる）。
 */
function sampleDimensions(stock: ResolvedStock): SamplePart {
  const entry = stock.entry;
  const stockLength = entry.length as number;
  const stockWidth = entry.width as number;
  const thickness = entry.thickness as number;

  const usableLength = stockLength - 2 * EDGE_TRIM;
  const length = Math.round(Math.min(600, usableLength / 2));

  let width: number | null = null;
  if (entry.kind === "sheet") {
    const usableWidth = stockWidth - 2 * EDGE_TRIM;
    width = Math.round(Math.min(300, usableWidth / 2));
  }

  const grooveWidth = Math.round(Math.min(7, length / 4) * 10) / 10;
  const groovePos = Math.round(length / 3);
  const grooveDepth = Math.round(Math.min(6, thickness / 2) * 10) / 10;

  // 丸穴の例は「# を外せばそのままビルドが通る」値にする（部材中央やや右）。
  const effWidth = width ?? stockWidth;
  const holeDia = Math.round(Math.min(5, effWidth / 4) * 10) / 10;
  const holeX = Math.round((length * 2) / 3);
  const holeY = Math.round(effWidth / 2);

  if (length < 20 || grooveWidth <= 0 || grooveDepth <= 0 || (width !== null && width < 20)) {
    throw new ScaffoldError(
      `規格材 '${stock.key}' は小さすぎて雛形のサンプル部材を作れません` +
        `（${stockLength}×${stockWidth}×${thickness}mm）。` +
        "別のプリセットを指定するか、生成後に parts を手で書いてください。",
    );
  }
  return {
    length,
    width,
    grooveWidth,
    groovePos,
    grooveDepth,
    holeX,
    holeY,
    holeDia,
  };
}

// ---------------------------------------------------------------------------
// 雛形本文の組み立て
// ---------------------------------------------------------------------------

/** YAML の二重引用符スカラー（JSON 文字列は YAML の二重引用符表記の部分集合）。 */
function quote(value: string): string {
  return JSON.stringify(value);
}

/** モードライン部（参照先の実在で有効／コメントアウトを切り替える。§4b）。 */
function modelineBlock(enabled: boolean): string[] {
  if (enabled) {
    return [`${MODELINE_PREFIX}./${BASE_SCHEMA_FILENAME}`];
  }
  return [
    "# VS Code では kidori 拡張がファイルごとにスキーマを供給するため、モードラインは不要。",
    `# VS Code 以外のエディタ・エージェントで使う場合は \`kidori init\` で ${BASE_SCHEMA_FILENAME} を`,
    '# 生成し、次の行の先頭の "# " を外してモードラインを有効化する:',
    `# ${MODELINE_PREFIX}./${BASE_SCHEMA_FILENAME}`,
  ];
}

interface RenderInput {
  /** `meta.project` に入れるプロジェクト名（既定は正本の stem）。 */
  project: string;
  /** 出力ディレクトリ名の元（`<stem>.out/` の案内に使う）。 */
  stem: string;
  /** アクティブに書き出す規格材（先頭がサンプル部材の参照先）。 */
  active: ResolvedStock[];
  /** コメントアウトで例示する規格材（既定雛形の sheet 材）。 */
  commented: ResolvedStock[];
  modelineEnabled: boolean;
}

/** 雛形の本文（末尾改行付き）を組み立てる。 */
export function renderScaffold(input: RenderInput): string {
  const primary = input.active[0];
  if (primary === undefined) {
    throw new ScaffoldError(
      "規格材マスタから雛形に載せられる規格材を1件も取得できませんでした" +
        "（assets/stock-presets.json を読めていない可能性があります）。",
    );
  }
  const sample = sampleDimensions(primary);
  // parts[].stock は materializeEntry が書き出す id と一致していなければならない
  // （雛形がそのままビルドを通ることの前提）。id 規則は materialize 側に一本化する。
  const stockId = defaultStockId(primary);

  const lines: string[] = [];
  lines.push(...modelineBlock(input.modelineEnabled));
  lines.push("#");
  lines.push(`# ${input.project} — kidori 木取りプロジェクト（1ファイル=1プロジェクト）`);
  lines.push("# ------------------------------------------------------------");
  lines.push(
    `# 保存すると kidori 拡張が自動ビルドし、${input.stem}.out/ に木取り図・加工指示図が再生成される`,
  );
  lines.push("# （CLI からは `kidori build` / `kidori watch`）。図は正本からの派生物なので直接編集しない。");
  lines.push("# 単位は mm 固定。部材ローカル座標系は左下原点・X 右・Y 上。");
  lines.push(
    `meta: { project: ${quote(input.project)}, units: mm, schemaVersion: ${quote(SCAFFOLD_SCHEMA_VERSION)} }`,
  );
  lines.push("");
  lines.push("settings:");
  lines.push(`  kerf: ${fmt(KERF)}            # 鋸刃厚（mm、仮値）。手持ち丸鋸の刃厚を実測したら更新すること`);
  lines.push(`  edgeTrim: ${fmt(EDGE_TRIM)}        # 木口の捨て代（mm、仮値）。荒れた木口を落とす分`);
  lines.push("  candidates: 3      # 生成する割付候補数（1〜3）");
  lines.push("  rank: [cost, waste, cuts]  # 推奨案の評価優先順（概算費用 → 歩留まり → カット回数）");
  lines.push("  exact: auto        # 部材数が少ないときは厳密探索で最適構成（案 X）も確認する");
  lines.push("  selectedPlan: null # 案を確定したらプレビューの「この案を採用」または `kidori select A`");
  lines.push("");
  lines.push("stocks:");
  lines.push("  # preset は規格材マスタの来歴キー（任意のメタデータ）。ビルドは preset を解決しないので、");
  lines.push("  # 手持ちの材に合わせて実値を書き換えてよい。price（円）を足すと概算費用でランク付けされる。");
  for (const stock of input.active) {
    lines.push(`  - ${materializeEntry(stock)}`);
  }
  for (const stock of input.commented) {
    lines.push(`  # 板材を使う場合の例（先頭の "# " を外して有効化する）:`);
    lines.push(`  # - ${materializeEntry(stock)}`);
  }
  lines.push("");
  lines.push("parts:");
  lines.push("  # 1エントリ＝1形状（寸法＋加工）× qty 個。同じ形状の実体を個別に列挙しない。");
  lines.push("  - id: part-0");
  lines.push("    label: 部材サンプル");
  lines.push("    qty: 2");
  lines.push(`    stock: ${stockId}`);
  lines.push(`    length: ${fmt(sample.length)}`);
  if (sample.width === null) {
    lines.push("    # bar 部材の width は省略可（原材幅がそのまま実効幅になる）。");
  } else {
    lines.push(`    width: ${fmt(sample.width)}`);
  }
  lines.push("    features:");
  lines.push("      # 溝の例: 幅方向（across）に貫通する通し溝。止め溝なら end: stopped と from/to を使う。");
  lines.push(
    `      - { type: groove, face: front, dir: across, pos: ${fmt(sample.groovePos)}, ` +
      `width: ${fmt(sample.grooveWidth)}, depth: ${fmt(sample.grooveDepth)}, end: through }`,
  );
  lines.push('      # 丸穴の例（depth を省略すると貫通。先頭の "# " を外して有効化する）:');
  lines.push(
    `      # - { type: hole, face: front, x: ${fmt(sample.holeX)}, y: ${fmt(sample.holeY)}, ` +
      `dia: ${fmt(sample.holeDia)}, depth: ${fmt(sample.grooveDepth)} }`,
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

/**
 * kidori ファイルの雛形1枚を生成する（`kidori new` / 「kidori: New Cutting Plan」）。
 *
 * @param filePath 生成先。kidori サフィックスが無ければ `.kidori.yaml` を付与する。
 * @throws ScaffoldError 生成先が既に存在する／未知のプリセットキー／JSON 生成の要求。
 */
export function createScaffold(filePath: string, options: ScaffoldOptions): ScaffoldResult {
  const target = resolve(resolveScaffoldPath(filePath));

  if (target.endsWith(".json")) {
    throw new ScaffoldError(
      "雛形はコメント注釈付きの YAML として生成します" +
        `（指定: ${basename(target)}）。拡張子を .kidori.yaml にしてください` +
        "（JSON 入力自体はビルドで受理されます）。",
    );
  }
  if (existsSync(target)) {
    throw new ScaffoldError(
      `既にファイルが存在します: ${target}。` +
        "上書きはしません（別の名前を指定するか、既存ファイルを退避してください）。",
    );
  }

  const dir = dirname(target);
  const available = availablePresets(options.rootPath, target);

  const requested = options.presets ?? [];
  let active: ResolvedStock[];
  let commented: ResolvedStock[];
  if (requested.length > 0) {
    active = resolvePresets(requested, available);
    commented = [];
  } else {
    const bar = pickDefault(available, DEFAULT_BAR_PRESET, "bar");
    const sheet = pickDefault(available, DEFAULT_SHEET_PRESET, "sheet");
    active = bar ? [bar] : [];
    commented = sheet ? [sheet] : [];
  }

  const modelineEnabled = existsSync(join(dir, BASE_SCHEMA_FILENAME));
  const text = renderScaffold({
    project: projectStem(target),
    stem: projectStem(target),
    active,
    commented,
    modelineEnabled,
  });

  mkdirSync(dir, { recursive: true });
  // wx: 生成先の存在チェックと書き込みの間に割り込まれても上書きしない。
  writeFileSync(target, text, { encoding: "utf-8", flag: "wx" });

  return {
    path: target,
    presetKeys: [...active, ...commented].map((s) => s.key),
    modelineEnabled,
  };
}
