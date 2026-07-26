/**
 * 取り付けシロ（marks）の解決（SPECS.md §4c）。
 *
 * `Mark`（正本に書かれたままの形）から `ResolvedMark`（領域寸法・位置が確定した形）
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
 *
 * 解決順序（この順序を守らないと `rot: 90` と `y: top` を組み合わせた SPECS.md §4c
 * の例そのものが壊れる。`y: top` は「面寸法 − h」に解決され、その h は rot に
 * よって決まるため）:
 *   1. `ref`（または直接指定の `w`/`h`）から領域寸法を導出する。
 *   2. `rot: 90` なら w/h を入れ替える（**ref 導出・直接指定のどちらにも一様に適用**。
 *      これは「当たり面の面内回転」というマーク自身の性質として定義されているため、
 *      寸法の指定方法によって同じ `rot: 90` が別の意味になる実装は避ける
 *      設計判断。SPECS.md 自体は ref 導出への言及に留まる）。
 *   3. `x`/`y` の端揃えエイリアス（`left`/`right`/`bottom`/`top`/`center`）を、
 *      2. で確定した w/h を使って解決する。基準面寸法は X 軸 = `part.length`、
 *      Y 軸 = `effectiveWidth(part, stock)`（`extractChainPoints`・`checkGroove`
 *      と同じ軸割当。新しい規約は作らない）。`center` は矩形領域（marks の
 *      領域全体）を中央に揃えるための解決規則であり `(axisSpan - size) / 2` に
 *      解決する（軸長の 1/2 ではない）。
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
 * `on` が指す対象形状とその原材を引く（x/y の端揃えエイリアス解決に使う面寸法の
 * 算出元。`part.length`・`effectiveWidth(part, stock)` を得るためだけの内部ヘルパ）。
 *
 * @throws Error 対象形状・原材が見つからない場合（意味検証層を経ていない入力）。
 */
function onSection(project: Project, onId: string): { part: Part; stock: Stock } {
  const part = project.parts.find((p) => p.id === onId);
  if (part === undefined) {
    throw new Error(
      `mark の on が参照する形状 '${onId}' が parts にありません` +
        "（意味検証層を経ていない入力の可能性があります）。",
    );
  }
  const stock = project.stocks.find((s) => s.id === part.stock);
  if (stock === undefined) {
    throw new Error(
      `mark の対象形状 '${onId}' が参照する原材 '${part.stock}' が stocks にありません` +
        "（意味検証層を経ていない入力の可能性があります）。",
    );
  }
  return { part, stock };
}

/**
 * 端揃えエイリアス（`near`/`far`/`center`）または数値の座標を数値に解決する。
 *
 * `center` は矩形領域（marks の領域全体）を中央に揃えるための解決規則であり
 * `(axisSpan - size) / 2` に解決する（軸長の 1/2 ではない）。SPECS.md §4d の
 * 位置式（揃えエイリアス）は marks の x/y にのみ限定され、`hole.x`/`hole.y`・
 * `groove.pos` では揃えエイリアス自体が許可されない。marks の x/y は領域寸法
 * size を持つ矩形領域であるため、`center` は軸長の単純な 1/2 ではなくこの
 * 解決規則になる。
 *
 * @param value 素の座標値（数値またはエイリアス文字列）。
 * @param near `"left"`/`"bottom"` に対応する文字列（解決値は常に 0）。
 * @param far `"right"`/`"top"` に対応する文字列（解決値は `axisSpan - size`）。
 * @param center `"center"` に対応する文字列（解決値は `(axisSpan - size) / 2`）。
 * @param axisSpan 軸方向の面寸法（X 軸なら `part.length`、Y 軸なら `effectiveWidth`）。
 * @param size マーク領域の当該軸方向の寸法（**rot 適用後**の w または h）。
 */
function resolveAliasCoord(
  value: number | string,
  near: string,
  far: string,
  center: string,
  axisSpan: number,
  size: number,
): number {
  if (value === near) {
    return 0;
  }
  if (value === far) {
    return axisSpan - size;
  }
  if (value === center) {
    return (axisSpan - size) / 2;
  }
  return value as number;
}

/**
 * 1件の Mark を解決する。
 *
 * 解決順序（モジュール doc コメント参照）: 1. `ref`（または直接指定の `w`/`h`）から
 * 領域寸法を導出 → 2. `rot: 90` なら w/h を入れ替え → 3. `x`/`y` の端揃えエイリアス
 * を、2. で確定した w/h を使って解決。
 *
 * @throws Error `ref` と `w`/`h` のどちらからも領域寸法が決まらない場合、`ref`/`on`
 *   先が解決できない場合（いずれも意味検証層が error にする入力）。
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

  // D2: rot は ref 導出・w/h 直接指定のどちらにも一様に適用する（swap）。
  if (mark.rot === 90) {
    [w, h] = [h, w];
  }

  // D3: エイリアス解決の基準面寸法は extractChainPoints/checkGroove と同じ軸割当
  // （X = part.length、Y = effectiveWidth）。size は rot 適用後の w/h を使う。
  const { part, stock } = onSection(project, mark.on);
  const x = resolveAliasCoord(mark.x, "left", "right", "center", part.length, w);
  const y = resolveAliasCoord(mark.y, "bottom", "top", "center", effectiveWidth(part, stock), h);

  return {
    on: mark.on,
    face: mark.face,
    x,
    y,
    w,
    h,
    rot: mark.rot,
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
