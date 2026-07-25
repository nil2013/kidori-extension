/**
 * 割付フィンガープリント（SPECS.md §5「採用後の設計変更」）。
 *
 * `settings.selectedPlan` に案を採用したあと、割付へ影響する編集があった場合は
 * 採用案の配置を無効とみなす必要がある。その判定のために「配置を決定する入力」
 * だけを抽出して canonical JSON（キーソート）にし、SHA-256 を取る。
 *
 * 対象（配置を決定する入力のみ）:
 *   - `parts[]`  の `{id, qty, stock, length, width, rot}`
 *   - `stocks[]` の `{id, kind, length, width, thickness}`
 *   - `settings` の `{kerf, edgeTrim}`
 *
 * 除外（配置に無関係、または無効化のトリガにすべきでないもの）:
 *   - `label`: 表示のみ。
 *   - `features`: 加工指示図は毎ビルド再生成され、割付には関与しない。
 *   - `price`: 費用表示のみ。SPECS §8 が「price は変動が本質」と明言しており、
 *     価格改定で採用案が無効化される設計は §7 の価格ログ連携と衝突する。
 *   - `preset`: 来歴メタデータ（ビルドは解決しない。§4）。
 *   - `candidates` / `rank` / `exact`: 採用後は採用案のみ再生成するため、
 *     候補生成パラメータは採用済み配置の妥当性に影響しない。
 *
 * `stocks[].thickness` は配置幾何には効かないが「材の同一性」なので含める
 * （誤無効化のコストは警告1本で済む安い側に倒す）。
 *
 * bar 部材のフィールドは実配置に対応する形へ正規化してから取り込む
 * （「配置を決定する入力のみ」という定義原則の直接適用であり、指定の有無で
 * フィンガープリントが割れるのを防ぐ）:
 *   - `parts[].width`: bar では省略可なので実効幅（stock.width）に置き換える。
 *   - `parts[].rot`: 1D割付は回転を扱わず `pack1d` は rot を参照しない
 *     （loader も bar への rot 指定を warning にして無視する）。したがって
 *     bar 部材の rot は配置を決定しないため、固定値に潰す。
 * stock が未解決（検証エラー時）の場合はどちらも素の値をそのまま使う。
 *
 * 配列の順序は保持する（`parts` の並び替えはヒューリスティクスのタイブレークを
 * 通じて実配置を変えうるため、順序も配置を決定する入力の一部である）。
 */

import { createHash } from "node:crypto";

import type { Project } from "./types";

/** 採用案の記録（`<stem>.out/summary.json` の `adopted`）。 */
export interface AdoptionRecord {
  /** 採用された案 ID（"A"/"B"/"C"/"X"）。 */
  plan: string;
  /** 採用時点の割付フィンガープリント。 */
  fingerprint: string;
}

/**
 * キーをソートした決定的な JSON 文字列表現を返す。
 *
 * `JSON.stringify` はオブジェクトの挿入順を保つため、生成順の揺れが
 * フィンガープリントに漏れないよう自前で正規化する。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

/**
 * フィンガープリントの対象となる入力だけを抜き出した素のオブジェクトを返す
 * （テストと差分調査のために公開する）。
 */
export function layoutFingerprintPayload(project: Project): Record<string, unknown> {
  const stocksById = new Map(project.stocks.map((s) => [s.id, s]));
  return {
    parts: project.parts.map((p) => {
      const stock = stocksById.get(p.stock);
      // stock 未解決（検証エラー時）は素の値をそのまま使う。
      const isBar = stock !== undefined && stock.kind === "bar";
      // bar 部材の width は省略可（実効幅は stock.width）。省略と明示が別値に
      // ならないよう実効幅へ正規化する。
      const width = isBar ? stock.width : p.width;
      // bar 部材の rot は配置を決定しない（pack1d は参照せず、loader も
      // warning を出して無視する）ため固定値へ潰す。
      const rot = isBar ? false : p.rot;
      return {
        id: p.id,
        qty: p.qty,
        stock: p.stock,
        length: p.length,
        width,
        rot,
      };
    }),
    stocks: project.stocks.map((s) => ({
      id: s.id,
      kind: s.kind,
      length: s.length,
      width: s.width,
      thickness: s.thickness,
    })),
    settings: {
      kerf: project.settings.kerf,
      edgeTrim: project.settings.edgeTrim,
    },
  };
}

/** 割付フィンガープリント（canonical JSON の SHA-256、hex）。 */
export function layoutFingerprint(project: Project): string {
  return createHash("sha256")
    .update(canonicalJson(layoutFingerprintPayload(project)), "utf-8")
    .digest("hex");
}
