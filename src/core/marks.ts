/**
 * 取り付けシロ（marks）の解決（SPECS.md §4c）。
 *
 * `Mark`（正本に書かれたままの形）から `ResolvedMark`（領域寸法 w/h が確定した形）
 * への変換を、拡張の検証・CLI の `kidori check`・`kidori build` の三者が共有する
 * 単一実装として提供する。描画層（加工指示図）は `ResolvedMark` だけを受け取る。
 *
 * `ref` による断面寸法の導出（SPECS.md §4c「相手部材の断面寸法（幅×厚み）から導出」）:
 *   - `w` = 参照先形状が使う原材の `thickness`
 *   - `h` = 参照先形状の実効幅（`effectiveWidth`。bar なら stock.width、
 *     sheet なら part.width）
 * SPF 2×4（thickness 38 / width 89）を `ref` した場合 (w, h) = (38, 89) となり、
 * SPECS.md §4c の例「`ref: leg` → 2×4 の 38×89」の数値・順序と一致する。
 * `face` には依存しない（面ごとに導出値が変わると同一マークの意味が割れるため）。
 * 相手部材を 90° 倒して当てる場合は `w`/`h` の直接指定で書く（`rotated` 等の
 * 仕様にない拡張は設けない）。
 */

import type { Assembly, Mark, Part, Project, ResolvedMark, Stock } from "./types";
import { effectiveWidth } from "./types";

/**
 * assembly ごとの変種面（`parts/{assembly}-{形状id}.svg`）1件分。
 *
 * 同一形状でも assembly ごとにマーク位置が異なりうるため、マークを持つ形状は
 * assembly ごとの変種面として出力される（SPECS.md §4c）。
 */
export interface MarkVariant {
  /** マークの持ち主となる構成。 */
  assembly: Assembly;
  /** マーク対象の形状。 */
  part: Part;
  /** 出力ファイル名の stem（`{assembly.id}-{part.id}`）。 */
  stem: string;
  /** その (assembly, part) に属する解決済みマーク（正本の記述順）。 */
  marks: ResolvedMark[];
}

/**
 * 変種面の出力ファイル名 stem を返す（SPECS.md §4c の `<assembly名>-<形状id>`）。
 *
 * 意味検証層（loader の衝突検査）と描画層が同じ規則を使うための単一ソース。
 */
export function markVariantStem(assemblyId: string, partId: string): string {
  return `${assemblyId}-${partId}`;
}

/**
 * `ref` 先の形状から断面寸法 (w, h) を導出する。
 *
 * @throws Error 参照先の形状・原材が見つからない場合（意味検証層を経ていない入力）。
 */
function refSection(
  project: Project,
  refId: string,
): { w: number; h: number } {
  const part = project.parts.find((p) => p.id === refId);
  if (part === undefined) {
    throw new Error(
      `mark の ref が参照する形状 '${refId}' が parts にありません` +
        "（意味検証層を経ていない入力の可能性があります）。",
    );
  }
  const stock: Stock | undefined = project.stocks.find((s) => s.id === part.stock);
  if (stock === undefined) {
    throw new Error(
      `mark の ref 先 '${refId}' が参照する原材 '${part.stock}' が stocks にありません` +
        "（意味検証層を経ていない入力の可能性があります）。",
    );
  }
  return { w: stock.thickness, h: effectiveWidth(part, stock) };
}

/**
 * 1件の Mark を解決する（`ref` があれば断面寸法を導出、無ければ w/h を採用）。
 *
 * @throws Error `ref` と `w`/`h` のどちらからも領域寸法が決まらない場合、または
 *   `ref` 先が解決できない場合（いずれも意味検証層が error にする入力）。
 */
export function resolveMark(project: Project, mark: Mark): ResolvedMark {
  let w: number;
  let h: number;
  if (mark.ref !== null) {
    const section = refSection(project, mark.ref);
    w = section.w;
    h = section.h;
  } else if (mark.w !== null && mark.h !== null) {
    w = mark.w;
    h = mark.h;
  } else {
    throw new Error(
      `形状 '${mark.on}' の mark は ref も w/h も持たないため領域寸法を決められません` +
        "（意味検証層を経ていない入力の可能性があります）。",
    );
  }
  return {
    on: mark.on,
    face: mark.face,
    x: mark.x,
    y: mark.y,
    w,
    h,
    ref: mark.ref,
    note: mark.note,
  };
}

/** 1つの assembly が持つ marks をすべて解決する（正本の記述順を保つ）。 */
export function resolveMarks(project: Project, assembly: Assembly): ResolvedMark[] {
  return assembly.marks.map((m) => resolveMark(project, m));
}

/**
 * assembly × 形状ごとの変種面一覧を返す（加工指示図の出力単位。SPECS.md §4c）。
 *
 * マークを1つも持たない形状はここに現れない（従来どおり形状ごとに1面を出力する）。
 * 並びは assemblies の記述順 × 各 assembly 内で marks が最初に現れた形状の順。
 */
export function collectMarkVariants(project: Project): MarkVariant[] {
  const partsById = new Map(project.parts.map((p) => [p.id, p]));
  const variants: MarkVariant[] = [];
  for (const assembly of project.assemblies) {
    const byPart = new Map<string, ResolvedMark[]>();
    for (const mark of assembly.marks) {
      const list = byPart.get(mark.on) ?? [];
      list.push(resolveMark(project, mark));
      byPart.set(mark.on, list);
    }
    for (const [partId, marks] of byPart) {
      const part = partsById.get(partId);
      if (part === undefined) {
        throw new Error(
          `mark の on が参照する形状 '${partId}' が parts にありません` +
            "（意味検証層を経ていない入力の可能性があります）。",
        );
      }
      variants.push({
        assembly,
        part,
        stem: markVariantStem(assembly.id, part.id),
        marks,
      });
    }
  }
  return variants;
}
