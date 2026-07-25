/**
 * 規格材マスタの4層カスケード（SPECS.md §4b）。エディタ非依存（SPECS.md §3）。
 *
 * 補完候補は次の4層から供給し、マスタキーでマージして「近い層が勝つ」:
 *   1. ビルトイン: 拡張・CLI 同梱の assets/stock-presets.json
 *   2. ユーザー  : $XDG_CONFIG_HOME/kidori/stocks.yaml（未設定時 ~/.config/…）
 *   3. ディレクトリ: 対象ファイルと同居する stocks.yaml
 *      （SPECS.md §4b: `stocksFile:` の参照先と兼用可）
 *   4. ファイル内: 対象ファイルの `stocks:` インライン定義
 *
 * マスタキーは `preset` キー文字列（SPECS.md §4 が「規格材マスタ側のキー」と
 * 定義している唯一の識別子）。層2〜4 は `preset` が無ければ `id` を fallback
 * キーとして使い、ユーザー独自材もカスケードに載せられるようにする。
 *
 * **カスケードは補完候補の供給構造であり、ビルドの解決機構ではない**
 * （SPECS.md §4b）。したがってビルド経路（build.ts / loader.ts）は本モジュールを
 * import してはならない（test/core/stocks.test.ts で固定）。補完確定時・
 * 雛形生成時に実値と `preset:` キーが正本へ実体化される（materialize.ts）ことで、
 * 正本の自己完結性が保たれる。
 *
 * 層2・3 のファイル形式は正本の stocks エントリと同一形（トップレベル
 * `stocks:` のリスト）。§4b がディレクトリ層の stocks.yaml を `stocksFile:`
 * の参照先と兼用可としている以上、ビルドが読める形でなければならない。
 *
 * 本モジュールは `vscode` を import しない（拡張・CLI の双方から使うため。
 * SPECS.md §4b「拡張・CLI が同じファイルを読む」）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export type StockKind = "bar" | "sheet";

/** 正本 stocks エントリと同一形（すべて任意。壊れた入力も部分的に拾うため）。 */
export interface StockEntry {
  id?: string;
  preset?: string;
  label?: string;
  kind?: StockKind;
  length?: number;
  width?: number;
  thickness?: number;
  price?: number;
}

/** カスケードの層。配列順（builtin → file）がそのまま「遠い層 → 近い層」。 */
export type LayerId = "builtin" | "user" | "directory" | "file";

export const LAYER_LABEL: Record<LayerId, string> = {
  builtin: "ビルトイン",
  user: "ユーザー",
  directory: "ディレクトリ",
  file: "ファイル内",
};

/** 1エントリと、その YAML 上の位置（診断の位置決め用。JSON・ビルトインは無し）。 */
export interface SourcedEntry {
  entry: StockEntry;
  /** [開始オフセット, 終了オフセット]（文字オフセット）。 */
  offsets?: [number, number];
}

export interface LayerSource {
  layer: LayerId;
  /** 由来（ファイルパス。ファイル層は対象ドキュメントのパス）。 */
  origin: string;
  entries: SourcedEntry[];
  /**
   * 定尺の値リスト。これを持てるのはビルトイン層だけ（層2・3 のファイルは
   * 正本 stocks 形）。最終的な値候補は mergeLayers がこのリストと
   * 勝ち残りエントリの実値の和集合として導出する。
   */
  lengths: number[];
  widths: number[];
}

/** マージ後に勝ち残ったエントリ。 */
export interface ResolvedStock {
  key: string;
  layer: LayerId;
  origin: string;
  entry: StockEntry;
  offsets?: [number, number];
}

/** 同一キーが近い層に隠された記録。 */
export interface Shadow {
  key: string;
  winner: ResolvedStock;
  shadowed: ResolvedStock;
  /** 値が異なるフィールド（空なら値は同一）。 */
  differences: (keyof StockEntry)[];
}

export interface StockCascade {
  /** 表示順（ビルトインの並び順 → 以降の層で新規に現れたキーの順）。 */
  entries: ResolvedStock[];
  lengths: number[];
  widths: number[];
  shadows: Shadow[];
}

/**
 * 常駐部分（ビルトイン層＋ユーザー層ファイルの位置）。
 * 層3・4 は対象ドキュメントに依存するため resolveCascade で都度解決する。
 */
export interface StockMaster {
  builtin: LayerSource;
  /** ユーザー層ファイルの絶対パス（存在しないこともある）。 */
  userStocksPath: string;
}

// ---------------------------------------------------------------------------
// 層の読み込み
// ---------------------------------------------------------------------------

function emptyLayer(layer: LayerId, origin: string): LayerSource {
  return { layer, origin, entries: [], lengths: [], widths: [] };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 素の値を StockEntry に整形する（型が合わないフィールドは落とす）。 */
export function coerceEntry(value: unknown): StockEntry | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const kind = str(value.kind);
  return {
    id: str(value.id),
    preset: str(value.preset),
    label: str(value.label),
    kind: kind === "bar" || kind === "sheet" ? kind : undefined,
    length: num(value.length),
    width: num(value.width),
    thickness: num(value.thickness),
    price: num(value.price),
  };
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/**
 * ビルトイン層（同梱 JSON）を読む。
 *
 * 形式: `{ presets: [{ preset, id, label, kind, length, width, thickness }],
 *          lengths: number[], widths: number[] }`
 * - `preset`（マスタキー）は必須。欠けている要素は無視する。
 * - `price` は載せない（S-06 の趣旨: 実勢価格を知らない既定値が費用計算へ
 *   混入するのを防ぐ）。materialize は price が実在するときだけ書き出す。
 * - `lengths`/`widths` は定尺の値リスト（SPECS.md §4b「910 / 1820 / 2440 …」）。
 *   層2〜4 のファイルは正本 stocks 形（トップレベル `stocks:` のみ）で
 *   定尺リストを持てないが、それらの層も自分が供給する規格材の実値を通じて
 *   値候補に寄与する（mergeLayers で和集合を取る）。
 *
 * @param rootPath assets/ を含むインストールルート（拡張なら extensionPath）。
 */
export function loadBuiltinLayer(rootPath: string): LayerSource {
  const filePath = path.join(rootPath, "assets", "stock-presets.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return emptyLayer("builtin", filePath);
  }
  if (!isPlainObject(raw)) {
    return emptyLayer("builtin", filePath);
  }
  const entries: SourcedEntry[] = [];
  for (const item of Array.isArray(raw.presets) ? raw.presets : []) {
    const entry = coerceEntry(item);
    if (!entry || !entry.preset) {
      continue;
    }
    entries.push({ entry });
  }
  return {
    layer: "builtin",
    origin: filePath,
    entries,
    lengths: [...numberArray(raw.lengths)].sort((a, b) => a - b),
    widths: [...numberArray(raw.widths)].sort((a, b) => a - b),
  };
}

/**
 * ユーザー層ファイルのパス（SPECS.md §4b「~/.config/kidori/stocks.yaml（XDG 配置）」）。
 *
 * XDG Base Directory 仕様に従い `XDG_CONFIG_HOME` を尊重し、未設定
 * （または空文字・相対パス）のときだけ `~/.config` にフォールバックする。
 * macOS でも同じ規則を使う（拡張と CLI が同じファイルを読むため）。
 */
export function userStocksPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XDG_CONFIG_HOME;
  const base =
    configured && path.isAbsolute(configured)
      ? configured
      : path.join(os.homedir(), ".config");
  return path.join(base, "kidori", "stocks.yaml");
}

/**
 * 正本 stocks 形のテキストから stocks エントリを取り出す。
 * 編集途中の壊れた YAML でも読める範囲を拾う（parseDocument は寛容）。
 */
export function parseStocksText(text: string, asJson: boolean): SourcedEntry[] {
  if (asJson) {
    try {
      const raw: unknown = JSON.parse(text);
      const stocks = isPlainObject(raw) && Array.isArray(raw.stocks) ? raw.stocks : [];
      return stocks
        .map((item) => coerceEntry(item))
        .filter((e): e is StockEntry => e !== null)
        .map((entry) => ({ entry }));
    } catch {
      return [];
    }
  }
  try {
    const doc = parseDocument(text);
    const seq = doc.get("stocks", true);
    if (!isSeq(seq)) {
      return [];
    }
    const out: SourcedEntry[] = [];
    for (const item of seq.items) {
      if (!isMap(item)) {
        continue;
      }
      const entry = coerceEntry(item.toJSON());
      if (!entry) {
        continue;
      }
      const range = (item as { range?: [number, number, number] }).range;
      out.push({
        entry,
        offsets: range ? [range[0], range[1]] : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** 正本 stocks 形のファイル（ユーザー層・ディレクトリ層）を読む。 */
export function loadStocksFile(layer: LayerId, filePath: string): LayerSource {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return emptyLayer(layer, filePath);
  }
  return {
    layer,
    origin: filePath,
    entries: parseStocksText(text, filePath.endsWith(".json")),
    lengths: [],
    widths: [],
  };
}

/** ディレクトリ層のファイルパス（対象ファイルと同居する stocks.yaml）。 */
export function directoryStocksPath(documentPath: string): string {
  return path.join(path.dirname(documentPath), "stocks.yaml");
}

// ---------------------------------------------------------------------------
// マージ
// ---------------------------------------------------------------------------

/**
 * マスタキー。ビルトイン層は `preset` 必須、それ以外は `preset` があればそれ、
 * 無ければ `id` を fallback とする（ユーザー独自材もカスケード候補になれる）。
 */
export function masterKey(entry: StockEntry, layer: LayerId): string | null {
  if (layer === "builtin") {
    return entry.preset ?? null;
  }
  return entry.preset ?? entry.id ?? null;
}

const COMPARED_FIELDS: (keyof StockEntry)[] = [
  "label",
  "kind",
  "length",
  "width",
  "thickness",
  "price",
];

function differences(a: StockEntry, b: StockEntry): (keyof StockEntry)[] {
  return COMPARED_FIELDS.filter((f) => a[f] !== b[f]);
}

/**
 * 遠い層 → 近い層の順に並べた層集合をマージする（近い層が勝つ）。
 * 表示順は最初にキーが現れた位置で固定し、上書きされても並びは変えない。
 */
export function mergeLayers(layers: LayerSource[]): StockCascade {
  const order: string[] = [];
  const winners = new Map<string, ResolvedStock>();
  const shadows: Shadow[] = [];
  const lengths = new Set<number>();
  const widths = new Set<number>();

  for (const source of layers) {
    // 定尺リストを持てるのはビルトイン層だけ（層2・3 のファイルは正本
    // stocks 形＝トップレベル `stocks:` のみ。core/schema.ts の
    // buildStocksFileSchema が additionalProperties: false のため）。
    for (const v of source.lengths) {
      lengths.add(v);
    }
    for (const v of source.widths) {
      widths.add(v);
    }
    for (const sourced of source.entries) {
      const key = masterKey(sourced.entry, source.layer);
      if (!key) {
        continue;
      }
      const resolved: ResolvedStock = {
        key,
        layer: source.layer,
        origin: source.origin,
        entry: sourced.entry,
        offsets: sourced.offsets,
      };
      const prev = winners.get(key);
      if (!prev) {
        order.push(key);
      } else if (prev.layer !== resolved.layer) {
        // 同一層内の重複は「シャドウ」ではなく正本側の id 重複（コア検証の担当）。
        shadows.push({
          key,
          winner: resolved,
          shadowed: prev,
          differences: differences(prev.entry, resolved.entry),
        });
      }
      winners.set(key, resolved);
    }
  }

  const entries = order.map((key) => winners.get(key) as ResolvedStock);

  // 定尺候補は「ビルトインの定尺リスト ∪ 勝ち残りエントリの実値」。
  // ファイル形式として定尺リストを持てない層（2・3）からも、その層が
  // 供給する規格材の寸法という形で値候補が供給される（SPECS.md §4b の
  // 「ドメイン値の補完（規格材マスタの4層カスケード駆動）」の帰結）。
  for (const { entry } of entries) {
    if (entry.length !== undefined) {
      lengths.add(entry.length);
    }
    if (entry.width !== undefined) {
      widths.add(entry.width);
    }
  }

  return {
    entries,
    lengths: [...lengths].sort((a, b) => a - b),
    widths: [...widths].sort((a, b) => a - b),
    shadows,
  };
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

/**
 * 常駐部分（ビルトイン層・ユーザー層の位置）を読み込む。
 *
 * `rootPath` は assets/ を含むインストールルート。SPECS.md §4b は
 * 「拡張・CLI が同じファイルを読む」ことを要求するため、入口をパス文字列に
 * しておく（拡張は extensionPath、CLI はインストールルートを渡す）。
 */
export function loadStockMasterFrom(rootPath: string): StockMaster {
  return {
    builtin: loadBuiltinLayer(rootPath),
    userStocksPath: userStocksPath(),
  };
}

export interface CascadeContext {
  /** 対象ファイルの絶対パス（層3・4 の起点）。省略時は層1・2 のみ。 */
  documentPath?: string;
  /** 対象ファイルの内容（層4）。省略時は層4 を空とする。 */
  documentText?: string;
}

/**
 * 4層をその場で解決してカスケードを得る。
 *
 * 層2・3 は補完・診断のたびにディスクから読み直す（ユーザー層は
 * ワークスペース外にあり FileSystemWatcher の対象外のため。ファイルは
 * 小さく、読み直しのコストより陳腐化のリスクを避ける方を採る）。
 */
export function resolveCascade(master: StockMaster, ctx: CascadeContext): StockCascade {
  const layers: LayerSource[] = [master.builtin];
  layers.push(loadStocksFile("user", master.userStocksPath));

  const docPath = ctx.documentPath;
  if (docPath) {
    const dirPath = directoryStocksPath(docPath);
    // 対象ファイル自身がディレクトリ層の stocks.yaml の場合は二重計上しない。
    if (path.resolve(dirPath) !== path.resolve(docPath)) {
      layers.push(loadStocksFile("directory", dirPath));
    }
  }
  if (ctx.documentText !== undefined) {
    layers.push({
      layer: "file",
      origin: docPath ?? "<document>",
      entries: parseStocksText(ctx.documentText, (docPath ?? "").endsWith(".json")),
      lengths: [],
      widths: [],
    });
  }
  return mergeLayers(layers);
}

// ---------------------------------------------------------------------------
// シャドウ（SPECS.md §4b「同一キーのシャドウ時は診断で通知」）
// ---------------------------------------------------------------------------

function fmtValue(v: unknown): string {
  return v === undefined ? "（なし）" : String(v);
}

/** シャドウ1件のメッセージ本文（値が異なる場合は両層の値を併記）。 */
export function shadowMessage(shadow: Shadow): string {
  const head =
    `規格材マスタ: キー ${shadow.key} は${LAYER_LABEL[shadow.winner.layer]}層の定義が` +
    `${LAYER_LABEL[shadow.shadowed.layer]}層を隠しています`;
  if (shadow.differences.length === 0) {
    return `${head}（値は同一）`;
  }
  const diff = shadow.differences
    .map(
      (f) =>
        `${f}: ${fmtValue(shadow.winner.entry[f])}（${LAYER_LABEL[shadow.winner.layer]}）` +
        ` ↔ ${fmtValue(shadow.shadowed.entry[f])}（${LAYER_LABEL[shadow.shadowed.layer]}）`,
    )
    .join(", ");
  return `${head}。値の相違: ${diff}`;
}
