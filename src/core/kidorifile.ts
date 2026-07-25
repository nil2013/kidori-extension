/**
 * kidori ファイルの判定と出力先の導出（SPECS.md §3）。
 *
 * v0.6 で「1ディレクトリ=1プロジェクト」から **1ファイル=1プロジェクト** に
 * 変わったため、任意の YAML/JSON ファイルが単体の正本になりうる。判定は
 * 両対応（SPECS.md §3「kidori ファイルの判定」）:
 *
 * 1. **命名規約**（`hasKidoriSuffix`）: 基底名が `*.kidori.yaml` / `*.kidori.yml`
 *    / `*.kidori.json`。**正規表現をフルパスに当ててはならない**
 *    （`/home/me/kidori.yaml/myproject.yaml` のような誤マッチを避けるため、
 *    判定は必ず `path.basename` に対して行う）。
 * 2. **内容判定**（`detectKidoriContent`）: 素の `*.yaml` / `*.json` の救済用。
 *    (i) 先頭行がモードラインで `$schema=` の値の基底名が `kidori.schema.json`、
 *    または (ii) パース結果のトップレベルに `meta.schemaVersion` が存在する。
 *    無条件のモードライン判定にはしない（無関係な YAML を巻き込むため）。
 *
 * パース不能な入力では例外を投げず `"unknown"` を返す。呼び出し側（拡張層）は
 * 編集途中の不正な YAML に対して「直前の判定結果を維持」できる。
 *
 * 出力先（§3 ディレクトリ構成例）: 既定は `<正本のディレクトリ>/<stem>.out/`。
 * stem は `.kidori.{yaml,yml,json}` ならサフィックス全体を、それ以外は最終拡張子
 * のみを落としたもの（`bookshelf.kidori.yaml` → `bookshelf.out/`、
 * `foo.yaml` → `foo.out/`）。
 */

import { readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parse } from "yaml";

/** 命名規約のサフィックス（推奨。グロブで即判定でき、無関係な YAML を巻き込まない）。 */
export const KIDORI_SUFFIXES = [".kidori.yaml", ".kidori.yml", ".kidori.json"] as const;

/**
 * 基底名から `.kidori.{yaml,yml,json}` サフィックスを剥がすための正規表現。
 * 先頭の `(.+)` により、`.kidori.yaml` のようなステム無しの名前は非該当になる。
 */
const KIDORI_BASENAME_RE = /^(.+)\.kidori\.(?:yaml|yml|json)$/;

/** `kidori init` が書き出す基底スキーマのファイル名（SPECS.md §3a・§4b）。 */
export const BASE_SCHEMA_FILENAME = "kidori.schema.json";

/** モードライン（YAML 先頭行）の想定プレフィックス。 */
export const MODELINE_PREFIX = "# yaml-language-server: $schema=";

/** 出力ディレクトリのサフィックス（`<stem>.out/`）。 */
export const OUT_DIR_SUFFIX = ".out";

/**
 * kidori ファイル判定の結果。
 *
 * - `"yes"` / `"no"`: 判定が確定した。
 * - `"unknown"`: 判定不能（読み込み不可・パース不能）。呼び出し側は直前の判定を維持する。
 */
export type KidoriVerdict = "yes" | "no" | "unknown";

/**
 * 基底名が命名規約 `*.kidori.{yaml,yml,json}` に一致するか。
 *
 * @param filePath ファイルシステム上のパス（URI 文字列ではなく `fsPath` を渡すこと）。
 */
export function hasKidoriSuffix(filePath: string): boolean {
  return KIDORI_BASENAME_RE.test(basename(filePath));
}

/**
 * 正本の stem（出力ディレクトリ名の元）を返す。
 *
 * - `.kidori.{yaml,yml,json}` で終わる基底名: サフィックスを丸ごと落とす。
 * - それ以外: 最終拡張子のみ落とす（拡張子が無ければ基底名そのまま）。
 */
export function projectStem(filePath: string): string {
  const base = basename(filePath);
  const m = KIDORI_BASENAME_RE.exec(base);
  if (m !== null) {
    return m[1];
  }
  const ext = extname(base);
  return ext === "" ? base : base.slice(0, -ext.length);
}

/**
 * 正本パスから既定の出力先ディレクトリ `<正本のディレクトリ>/<stem>.out/` を導出する。
 *
 * `BuildOptions.outDir` による明示上書きが無い場合に `build()` が使う規則であり、
 * CLI・拡張層も同じ関数を使って出力先を求めること（規則を二重に持たない）。
 *
 * @returns 絶対パス（入力は相対パスでもよい）。
 */
export function defaultOutDir(filePath: string): string {
  const abs = resolve(filePath);
  return join(dirname(abs), `${projectStem(abs)}${OUT_DIR_SUFFIX}`);
}

/**
 * 先頭行のモードライン `# yaml-language-server: $schema=<値>` から値を取り出す。
 * モードラインでなければ null。
 */
export function modelineSchemaRef(text: string): string | null {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const trimmed = firstLine.trim();
  if (!trimmed.startsWith(MODELINE_PREFIX)) {
    return null;
  }
  // 値の後ろに空白区切りで別のディレクティブが続く可能性を考慮して先頭トークンを取る。
  const value = trimmed.slice(MODELINE_PREFIX.length).trim().split(/\s+/, 1)[0] ?? "";
  return value === "" ? null : value;
}

/** モードラインの $schema 値が kidori の基底スキーマを指しているか。 */
function pointsAtKidoriSchema(ref: string): boolean {
  // クエリ・フラグメントを落としてから基底名を比較する（./kidori.schema.json、
  // ../shared/kidori.schema.json、file:///abs/kidori.schema.json のいずれも許容）。
  const bare = ref.split(/[?#]/, 1)[0] ?? "";
  return basename(bare) === BASE_SCHEMA_FILENAME;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * ファイル内容から kidori ファイルか判定する（素の `*.yaml` / `*.json` の救済）。
 *
 * (i) 先頭行がモードラインで `$schema=` の値の基底名が `kidori.schema.json`、または
 * (ii) パース結果のトップレベルに `meta.schemaVersion` が存在する、のいずれか。
 *
 * @param text ファイル内容。
 * @param filePath パース方式の判定にのみ使う（`.json` なら JSON.parse）。省略時は YAML。
 * @returns パース不能なら `"unknown"`（モードライン一致が先に成立した場合は `"yes"`）。
 */
export function detectKidoriContent(text: string, filePath?: string): KidoriVerdict {
  const ref = modelineSchemaRef(text);
  if (ref !== null && pointsAtKidoriSchema(ref)) {
    return "yes";
  }

  let data: unknown;
  try {
    data = filePath !== undefined && filePath.endsWith(".json")
      ? JSON.parse(text)
      : parse(text);
  } catch {
    // 編集途中の不正な YAML/JSON。判定を確定させない。
    return "unknown";
  }

  if (!isPlainObject(data)) {
    return "no";
  }
  const meta = data.meta;
  if (isPlainObject(meta) && "schemaVersion" in meta) {
    return "yes";
  }
  return "no";
}

/**
 * パスと内容から kidori ファイルか判定する（命名規約 → 内容判定の順）。
 *
 * @param filePath ファイルシステム上のパス。
 * @param text ファイル内容。null（＝読み込めなかった）なら命名規約のみで判定し、
 *   一致しなければ `"unknown"` を返す。
 */
export function classifyKidoriFile(
  filePath: string,
  text: string | null,
): KidoriVerdict {
  if (hasKidoriSuffix(filePath)) {
    return "yes";
  }
  if (text === null) {
    return "unknown";
  }
  return detectKidoriContent(text, filePath);
}

/**
 * ディスク上のファイルを読んで kidori ファイルか判定する（CLI 向けの便宜関数）。
 * 読み込みに失敗した場合は `"unknown"`。
 */
export function classifyKidoriPath(filePath: string): KidoriVerdict {
  if (hasKidoriSuffix(filePath)) {
    return "yes";
  }
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return "unknown";
  }
  return detectKidoriContent(text, filePath);
}
