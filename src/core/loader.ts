/**
 * project.yaml / project.json の読込・検証（設計正本 §2）。
 *
 * 読込パイプライン:
 * 1. `readRaw` — YAML（`.json` 以外）/ JSON（`.json`）を素のオブジェクトに読み込む。
 * 2. 層1: スキーマ検証（`schema.ts` の `buildSchema` を単一ソースとして再利用）。
 *    型・必須キー・enum・数値範囲・additionalProperties: false という
 *    「機械的な形」を検証する。ここでエラーがあればモデル構築に進まない
 *    （型・必須キーが壊れた状態では層2の相互参照チェックが安全に実行できないため）。
 * 3. モデル構築（YAML キー → TypeScript プロパティ名の対応をここで完結させる。
 *    キーはキャメルケースのまま。Groove の "from" もそのまま `from` に格納する）。
 * 4. 層2: 意味検証（設計正本 §2 の9項目 ＋ v0.4 追加の rank / exact /
 *    selectedPlan "X" / ID 安全性。相互参照・物理条件などスキーマでは
 *    表現しきれない検証）。
 *
 * `loadProject(filePath)` はこのパイプライン全体を実行し、error があれば
 * `ProjectError` を送出、warning のみなら `{ project, warnings }` を返す。
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";

import { Issue, ProjectError } from "./errors";
import { EPS } from "./packing/common";
import { ID_PATTERN, buildSchema } from "./schema";
import {
  DEFAULT_RANK,
  ExactMode,
  Feature,
  Groove,
  Hole,
  Meta,
  Part,
  Project,
  RankKey,
  Settings,
  Stock,
  effectiveWidth,
} from "./types";

/** meta.schemaVersion の想定値。不一致は warning（設計正本 §2 層2 項目7）。 */
export const SUPPORTED_SCHEMA_VERSION = "0.2";

/**
 * スキーマ検証 keyword → 日本語ラベルの対応表。
 * 層1（スキーマ検証）のエラーメッセージを日本語化する際に使う。
 * 未知の keyword はラベル無しでフォールバックする。
 */
const VALIDATOR_JA: Record<string, string> = {
  required: "必須キーが不足しています",
  type: "型が不正です",
  enum: "許可されていない値です",
  const: "固定値と一致しません",
  additionalProperties: "未知のキーが含まれています",
  minimum: "値が小さすぎます",
  exclusiveMinimum: "値は正の数でなければなりません",
  maximum: "値が大きすぎます",
  uniqueItems: "配列の要素が重複しています",
  oneOf: "溝（groove）または丸穴（hole）のいずれの形式にも一致しません",
  anyOf: "許可されている形式のいずれにも一致しません",
};

/** stocks[].id / parts[].id の許容パターン（schema.ts の ID_PATTERN と同一ソース）。 */
const ID_PATTERN_RE = new RegExp(ID_PATTERN);

/**
 * Windows の予約デバイス名（大文字小文字を区別しない）。
 * 最初の "." より前の部分がこれらと一致する ID は出力ファイル名に使用できない。
 */
const WINDOWS_RESERVED = new Set<string>([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

// ---------------------------------------------------------------------------
// raw 読込
// ---------------------------------------------------------------------------

/**
 * project.yaml / project.json を素の値に読み込む（検証・変換なし）。
 *
 * `.json` 拡張子なら `JSON.parse`、それ以外は yaml パッケージの `parse` で
 * 読み込む（設計正本 §2）。build 側が「schema 書き出し用の stocks 抽出」に
 * 使う想定の補助関数のため、スキーマ検証・意味検証は一切行わない。
 * トップレベルが空ファイル（null）の場合は空オブジェクトを返す。
 * YAML/JSON の構文エラー・I/O エラーはそのまま伝播する。
 */
export function readRaw(filePath: string): unknown {
  const text = readFileSync(filePath, "utf-8");
  const data: unknown = filePath.endsWith(".json") ? JSON.parse(text) : parse(text);
  return data ?? {};
}

/**
 * raw から stocks[].id の一覧を抽出する（壊れた入力でも可能な範囲で拾う）。
 *
 * stocks 部分だけでも読めればスキーマの enum 更新に使えるようにするため
 * （設計正本 §7: 「stocks すら読めない場合は enum なしスキーマを書く」）、
 * 型が不正な要素は無視して読み取れるものだけ集める。
 */
export function extractStockIds(raw: unknown): string[] {
  if (!isPlainObject(raw)) {
    return [];
  }
  const stocks = raw.stocks;
  if (!Array.isArray(stocks)) {
    return [];
  }
  const ids: string[] = [];
  for (const s of stocks) {
    if (isPlainObject(s) && typeof s.id === "string") {
      ids.push(s.id);
    }
  }
  return ids;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// 層1: スキーマ検証（buildSchema が返すスキーマの必要キーワードのみを解釈する
// 最小バリデータ。単一ソース原則により、検証規則はスキーマ側にだけ書く）
// ---------------------------------------------------------------------------

type Segment = string | number;

interface RawSchemaError {
  path: Segment[];
  keyword: string;
  detail: string;
}

/** パス配列を `parts[2].features[0].pos` 形式にする（ルートは "<root>"）。 */
function formatJsonPath(segments: Segment[]): string {
  let out = "";
  for (const seg of segments) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else {
      out += out ? `.${seg}` : seg;
    }
  }
  return out || "<root>";
}

function shortRepr(v: unknown): string {
  const s = v === undefined ? "undefined" : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case "object":
      return isPlainObject(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      return true;
  }
}

type SchemaNode = Record<string, any>;

/**
 * buildSchema が返すスキーマで value を再帰検証する。
 *
 * 解釈するキーワード: type / enum / const / minimum / exclusiveMinimum /
 * maximum / required / properties / additionalProperties: false / items /
 * uniqueItems / oneOf / anyOf。
 *
 * `pattern` は意図的に解釈しない: stocks[].id / parts[].id の pattern は
 * エディタ支援（VS Code 上の赤線）用であり、ID 安全性の権威判定は層2
 * （意味検証、Windows 予約名チェックを含む）が担うため（meta.units と同じ
 * 役割分担）。
 */
function validateNode(
  value: unknown,
  schema: SchemaNode,
  path: Segment[],
  out: RawSchemaError[],
): void {
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      out.push({
        path,
        keyword: "type",
        detail: `${shortRepr(value)} は型 ${types.join(" / ")} ではありません。`,
      });
      // 型が違う値に対する後続キーワードの検証は無意味なため打ち切る。
      return;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    out.push({
      path,
      keyword: "const",
      detail: `${shortRepr(value)} は固定値 ${shortRepr(schema.const)} と一致しません。`,
    });
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    out.push({
      path,
      keyword: "enum",
      detail: `${shortRepr(value)} は ${JSON.stringify(schema.enum)} のいずれでもありません。`,
    });
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      out.push({
        path,
        keyword: "minimum",
        detail: `${value} は最小値 ${schema.minimum} を下回っています。`,
      });
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      out.push({
        path,
        keyword: "exclusiveMinimum",
        detail: `${value} は ${schema.exclusiveMinimum} より大きい必要があります。`,
      });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      out.push({
        path,
        keyword: "maximum",
        detail: `${value} は最大値 ${schema.maximum} を超えています。`,
      });
    }
  }

  if (Array.isArray(value)) {
    if (schema.uniqueItems === true) {
      const seen = new Map<string, number>();
      for (let i = 0; i < value.length; i++) {
        const key = JSON.stringify(value[i]);
        const prev = seen.get(key);
        if (prev !== undefined) {
          out.push({
            path,
            keyword: "uniqueItems",
            detail: `インデックス ${prev} と ${i} の要素が重複しています（${shortRepr(value[i])}）。`,
          });
          break;
        }
        seen.set(key, i);
      }
    }
    if (isPlainObject(schema.items)) {
      value.forEach((item, i) => {
        validateNode(item, schema.items as SchemaNode, [...path, i], out);
      });
    }
  }

  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in value)) {
          out.push({
            path,
            keyword: "required",
            detail: `必須キー '${key}' がありません。`,
          });
        }
      }
    }
    const props: Record<string, SchemaNode> = isPlainObject(schema.properties)
      ? (schema.properties as Record<string, SchemaNode>)
      : {};
    if (schema.additionalProperties === false) {
      const unknownKeys = Object.keys(value).filter((k) => !(k in props));
      if (unknownKeys.length > 0) {
        out.push({
          path,
          keyword: "additionalProperties",
          detail: `未知のキー: ${unknownKeys.map((k) => `'${k}'`).join(", ")}。`,
        });
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) {
        validateNode(value[key], sub, [...path, key], out);
      }
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const matched = (schema.oneOf as SchemaNode[]).filter((sub) => {
      const errs: RawSchemaError[] = [];
      validateNode(value, sub, [], errs);
      return errs.length === 0;
    }).length;
    if (matched !== 1) {
      out.push({
        path,
        keyword: "oneOf",
        detail: `一致した形式は ${matched} 件です（ちょうど1件必要）。`,
      });
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const anyMatched = (schema.anyOf as SchemaNode[]).some((sub) => {
      const errs: RawSchemaError[] = [];
      validateNode(value, sub, [], errs);
      return errs.length === 0;
    });
    if (!anyMatched) {
      out.push({
        path,
        keyword: "anyOf",
        detail: `${shortRepr(value)} は許可されている形式のいずれにも一致しません。`,
      });
    }
  }
}

/**
 * 層1: buildSchema が生成したスキーマで raw を検証し、Issue（error）一覧を返す。
 *
 * schema.ts のテストからも直接利用する（Python 版で jsonschema の
 * Draft202012Validator を直接使っていた箇所に対応する公開 API）。
 */
export function validateAgainstSchema(
  raw: unknown,
  schema: Record<string, unknown>,
): Issue[] {
  const errors: RawSchemaError[] = [];
  validateNode(raw, schema as SchemaNode, [], errors);
  const issues = errors.map(
    (e): Issue => ({
      path: formatJsonPath(e.path),
      message: `${VALIDATOR_JA[e.keyword] ?? "スキーマ検証エラー"}: ${e.detail}`,
      severity: "error",
    }),
  );
  issues.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return issues;
}

// ---------------------------------------------------------------------------
// モデル構築（キー名の対応はここで完結させる）
// ---------------------------------------------------------------------------

function buildFeature(rawFeature: Record<string, any>): Feature {
  if (rawFeature.type === "groove") {
    const groove: Groove = {
      type: "groove",
      face: rawFeature.face,
      dir: rawFeature.dir,
      pos: Number(rawFeature.pos),
      width: Number(rawFeature.width),
      depth: Number(rawFeature.depth),
      end: rawFeature.end,
      from: rawFeature.from !== null && rawFeature.from !== undefined
        ? Number(rawFeature.from)
        : null,
      to: rawFeature.to !== null && rawFeature.to !== undefined
        ? Number(rawFeature.to)
        : null,
    };
    return groove;
  }
  // スキーマ検証(oneOf: groove/hole)を通過している前提のため、それ以外は hole。
  const hole: Hole = {
    type: "hole",
    face: rawFeature.face,
    x: Number(rawFeature.x),
    y: Number(rawFeature.y),
    dia: Number(rawFeature.dia),
    depth: rawFeature.depth !== null && rawFeature.depth !== undefined
      ? Number(rawFeature.depth)
      : null,
  };
  return hole;
}

function buildProject(raw: Record<string, any>): Project {
  const rawMeta = raw.meta as Record<string, any>;
  const meta: Meta = {
    project: rawMeta.project,
    units: rawMeta.units,
    schemaVersion: String(rawMeta.schemaVersion),
  };

  const rawSettings: Record<string, any> = isPlainObject(raw.settings) ? raw.settings : {};
  const settings: Settings = {
    kerf: "kerf" in rawSettings ? Number(rawSettings.kerf) : 3.0,
    edgeTrim: "edgeTrim" in rawSettings ? Number(rawSettings.edgeTrim) : 5.0,
    candidates: "candidates" in rawSettings ? Math.trunc(rawSettings.candidates) : 3,
    rank:
      "rank" in rawSettings
        ? ([...rawSettings.rank] as RankKey[])
        : ([...DEFAULT_RANK] as RankKey[]),
    exact: "exact" in rawSettings ? (rawSettings.exact as ExactMode) : "auto",
    selectedPlan: "selectedPlan" in rawSettings ? rawSettings.selectedPlan : null,
  };

  const stocks: Stock[] = ((raw.stocks ?? []) as Record<string, any>[]).map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    length: Number(s.length),
    width: Number(s.width),
    thickness: Number(s.thickness),
    price: s.price !== null && s.price !== undefined ? Number(s.price) : null,
  }));

  const parts: Part[] = ((raw.parts ?? []) as Record<string, any>[]).map((p) => ({
    id: p.id,
    label: p.label,
    qty: Math.trunc(p.qty),
    stock: p.stock,
    length: Number(p.length),
    width: p.width !== null && p.width !== undefined ? Number(p.width) : null,
    rot: p.rot !== undefined ? Boolean(p.rot) : true,
    features: ((p.features ?? []) as Record<string, any>[]).map(buildFeature),
  }));

  return { meta, settings, stocks, parts };
}

// ---------------------------------------------------------------------------
// 層2: 意味検証（設計正本 §2 の9項目 ＋ v0.4 追加検証）
// ---------------------------------------------------------------------------

/** 項目1: stocks[].id / parts[].id の重複。 */
function checkDuplicateIds(project: Project): Issue[] {
  const issues: Issue[] = [];

  const collect = (
    entries: readonly { id: string }[],
    section: "stocks" | "parts",
  ): void => {
    const seen = new Map<string, number[]>();
    entries.forEach((e, i) => {
      const idxs = seen.get(e.id) ?? [];
      idxs.push(i);
      seen.set(e.id, idxs);
    });
    for (const [id, idxs] of seen) {
      if (idxs.length > 1) {
        issues.push({
          path: `${section}[${idxs[idxs.length - 1]}].id`,
          message: `${section}[].id が重複しています: '${id}'（インデックス [${idxs.join(", ")}]）。`,
          severity: "error",
        });
      }
    }
  };

  collect(project.stocks, "stocks");
  collect(project.parts, "parts");
  return issues;
}

/** v0.4: ID 安全性（出力ファイル名に使用するためのパターン・Windows 予約名）。 */
function checkIdSafety(project: Project): Issue[] {
  const issues: Issue[] = [];

  const check = (id: string, path: string, kind: string): void => {
    if (!ID_PATTERN_RE.test(id)) {
      issues.push({
        path,
        message:
          `${kind} ID '${id}' は不正です。出力ファイル名に使用するため、` +
          "英数字で始まり英数字・「.」「_」「-」のみで構成しなければなりません。",
        severity: "error",
      });
      return;
    }
    const stem = id.split(".")[0].toUpperCase();
    if (WINDOWS_RESERVED.has(stem)) {
      issues.push({
        path,
        message:
          `${kind} ID '${id}' は Windows の予約デバイス名（${stem}）と衝突するため、` +
          "出力ファイル名に使用できません。",
        severity: "error",
      });
    }
  };

  project.stocks.forEach((s, i) => check(s.id, `stocks[${i}].id`, "原材"));
  project.parts.forEach((p, i) => check(p.id, `parts[${i}].id`, "部材"));
  return issues;
}

/** 項目2: parts[].stock の参照整合（スキーマの enum と重複するが権威はこちら）。 */
function checkStockReferences(project: Project): Issue[] {
  const stockIds = new Set(project.stocks.map((s) => s.id));
  const issues: Issue[] = [];
  project.parts.forEach((p, i) => {
    if (!stockIds.has(p.stock)) {
      issues.push({
        path: `parts[${i}].stock`,
        message: `存在しない原材 id を参照しています: '${p.stock}'。`,
        severity: "error",
      });
    }
  });
  return issues;
}

/** 項目3: 物理的事前チェック（bar/sheet それぞれの詰め込み可否）。 */
function checkPhysicalFit(project: Project, stocksById: Map<string, Stock>): Issue[] {
  const issues: Issue[] = [];
  const e = project.settings.edgeTrim;
  project.parts.forEach((p, i) => {
    const stock = stocksById.get(p.stock);
    if (stock === undefined) {
      return; // 項目2で既にエラー報告済み
    }

    if (stock.kind === "bar") {
      const limit = stock.length - 2.0 * e;
      if (p.length > limit + EPS) {
        const over = p.length - limit;
        issues.push({
          path: `parts[${i}].length`,
          message:
            `部材長 ${p.length}mm が原材 '${stock.id}' の使用可能長 ` +
            `${limit}mm（length ${stock.length} − 2×edgeTrim ${e}）を ` +
            `${over.toFixed(3)}mm 超過しています。`,
          severity: "error",
        });
      }
    } else {
      // sheet
      if (p.width === null) {
        return; // 項目4で別途エラーになる
      }
      const lu = stock.length - 2.0 * e;
      const wu = stock.width - 2.0 * e;
      const fitsNoRot = p.length <= lu + EPS && p.width <= wu + EPS;
      const fitsRot = p.rot && p.width <= lu + EPS && p.length <= wu + EPS;
      if (!(fitsNoRot || fitsRot)) {
        issues.push({
          path: `parts[${i}].length`,
          message:
            `部材 ${p.length}×${p.width}mm が原材 '${stock.id}' の使用可能領域 ` +
            `${lu}×${wu}mm に収まりません（rot=${p.rot} を考慮しても不可）。`,
          severity: "error",
        });
      }
    }
  });
  return issues;
}

/** 項目4: bar 部材の width は省略か stock.width と同値のみ許容。sheet 部材は width 必須。 */
function checkWidthConsistency(project: Project, stocksById: Map<string, Stock>): Issue[] {
  const issues: Issue[] = [];
  project.parts.forEach((p, i) => {
    const stock = stocksById.get(p.stock);
    if (stock === undefined) {
      return;
    }
    if (stock.kind === "bar") {
      if (p.width !== null && Math.abs(p.width - stock.width) > EPS) {
        issues.push({
          path: `parts[${i}].width`,
          message:
            "bar 部材の width は省略するか原材幅と同値でなければなりません" +
            `（指定値 ${p.width}mm、原材幅 ${stock.width}mm）。` +
            "挽き割り指定は v1 対象外です。",
          severity: "error",
        });
      }
    } else {
      // sheet
      if (p.width === null) {
        issues.push({
          path: `parts[${i}].width`,
          message: "sheet 部材には width が必須です。",
          severity: "error",
        });
      }
    }
  });
  return issues;
}

/** 項目5・項目6（溝）: pos±width/2 の範囲、depth、end/from/to の整合。 */
function checkGroove(
  fpath: string,
  g: Groove,
  part: Part,
  stock: Stock,
  effWidth: number,
): Issue[] {
  const issues: Issue[] = [];
  const half = g.width / 2.0;
  let axisMax: number;
  let runningDim: number;
  if (g.dir === "across") {
    axisMax = part.length;
    runningDim = effWidth;
  } else {
    // along
    axisMax = effWidth;
    runningDim = part.length;
  }

  const lo = g.pos - half;
  const hi = g.pos + half;
  if (lo < -EPS || hi > axisMax + EPS) {
    issues.push({
      path: `${fpath}.pos`,
      message:
        `溝の位置 pos=${g.pos}mm・width=${g.width}mm が部材範囲 [0, ${axisMax}] を` +
        `超えています（占有範囲 [${lo}, ${hi}]）。`,
      severity: "error",
    });
  }

  if (g.depth > stock.thickness + EPS) {
    issues.push({
      path: `${fpath}.depth`,
      message: `溝深さ ${g.depth}mm が原材厚み ${stock.thickness}mm を超えています。`,
      severity: "error",
    });
  } else if (Math.abs(g.depth - stock.thickness) <= EPS) {
    issues.push({
      path: `${fpath}.depth`,
      message:
        `溝深さ ${g.depth}mm が原材厚み ${stock.thickness}mm と同値です` +
        "（実質貫通になります）。",
      severity: "warning",
    });
  }

  if (g.end === "through") {
    if (g.from !== null || g.to !== null) {
      issues.push({
        path: `${fpath}.end`,
        message: "end: through の溝に from/to を指定することはできません。",
        severity: "error",
      });
    }
  } else {
    // stopped
    if (g.from === null || g.to === null) {
      issues.push({
        path: `${fpath}.end`,
        message: "end: stopped の溝には from・to が必須です。",
        severity: "error",
      });
    } else {
      const valid = g.from >= -EPS && g.from + EPS < g.to && g.to <= runningDim + EPS;
      if (!valid) {
        issues.push({
          path: `${fpath}.from`,
          message:
            `止め溝の範囲 from=${g.from}・to=${g.to} が走行方向の部材寸法 ` +
            `[0, ${runningDim}] 内で 0 ≤ from < to を満たしていません。`,
          severity: "error",
        });
      }
    }
  }
  return issues;
}

/** 項目5（丸穴）: x±dia/2, y±dia/2 の範囲、depth。 */
function checkHole(
  fpath: string,
  h: Hole,
  part: Part,
  stock: Stock,
  effWidth: number,
): Issue[] {
  const issues: Issue[] = [];
  const half = h.dia / 2.0;

  const xLo = h.x - half;
  const xHi = h.x + half;
  if (xLo < -EPS || xHi > part.length + EPS) {
    issues.push({
      path: `${fpath}.x`,
      message:
        `穴の位置 x=${h.x}mm・dia=${h.dia}mm が部材範囲 [0, ${part.length}] を` +
        "超えています。",
      severity: "error",
    });
  }

  const yLo = h.y - half;
  const yHi = h.y + half;
  if (yLo < -EPS || yHi > effWidth + EPS) {
    issues.push({
      path: `${fpath}.y`,
      message:
        `穴の位置 y=${h.y}mm・dia=${h.dia}mm が部材範囲 [0, ${effWidth}] を` +
        "超えています。",
      severity: "error",
    });
  }

  if (h.depth !== null) {
    if (h.depth > stock.thickness + EPS) {
      issues.push({
        path: `${fpath}.depth`,
        message: `穴深さ ${h.depth}mm が原材厚み ${stock.thickness}mm を超えています。`,
        severity: "error",
      });
    } else if (Math.abs(h.depth - stock.thickness) <= EPS) {
      issues.push({
        path: `${fpath}.depth`,
        message:
          `穴深さ ${h.depth}mm が原材厚み ${stock.thickness}mm と同値です` +
          "（実質貫通になります）。",
        severity: "warning",
      });
    }
  }
  return issues;
}

/** 項目5・項目6: features の境界・整合チェック（checkGroove / checkHole に委譲）。 */
function checkFeatureBounds(project: Project, stocksById: Map<string, Stock>): Issue[] {
  const issues: Issue[] = [];
  project.parts.forEach((p, i) => {
    const stock = stocksById.get(p.stock);
    if (stock === undefined) {
      return;
    }
    let effWidth: number;
    try {
      effWidth = effectiveWidth(p, stock);
    } catch {
      return; // 項目4で既にエラー報告済み（sheet 部材の width 欠落）
    }

    p.features.forEach((feat, j) => {
      const fpath = `parts[${i}].features[${j}]`;
      if (feat.type === "groove") {
        issues.push(...checkGroove(fpath, feat, p, stock, effWidth));
      } else {
        issues.push(...checkHole(fpath, feat, p, stock, effWidth));
      }
    });
  });
  return issues;
}

/** 項目7: meta.units は mm 固定。meta.schemaVersion 不一致は warning。 */
function checkMeta(project: Project): Issue[] {
  const issues: Issue[] = [];
  const units: string = project.meta.units;
  if (units !== "mm") {
    issues.push({
      path: "meta.units",
      message: `units は mm 固定です（指定値: '${units}'）。`,
      severity: "error",
    });
  }
  if (project.meta.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    issues.push({
      path: "meta.schemaVersion",
      message:
        `schemaVersion が想定バージョン '${SUPPORTED_SCHEMA_VERSION}' と` +
        `一致しません（指定値: '${project.meta.schemaVersion}'）。`,
      severity: "warning",
    });
  }
  return issues;
}

/**
 * 項目8: settings.selectedPlan の範囲（candidates 依存）。
 *
 * あわせて Settings.candidates 契約（「4以上の指定は loader が warning を出す」）
 * に基づき、candidates が 1〜3 の範囲外の場合の warning もここで発行する。
 *
 * v0.4: selectedPlan "X"（厳密探索案）は candidates 範囲検証の対象外とし、
 * 代わりに exact: "off" との組み合わせを error にする（exact: off のため
 * 厳密探索案 X は生成されないため）。
 */
function checkSelectedPlan(project: Project): Issue[] {
  const issues: Issue[] = [];
  const candidates = project.settings.candidates;
  if (candidates < 1 || candidates > 3) {
    issues.push({
      path: "settings.candidates",
      message:
        `candidates は 1〜3 の範囲で指定してください（指定値: ${candidates}）。` +
        "生成時は範囲内にクランプされます。",
      severity: "warning",
    });
  }

  const clamped = Math.max(1, Math.min(3, candidates));
  const validIds = ["A", "B", "C"].slice(0, clamped);
  const sp = project.settings.selectedPlan;
  if (sp === "X") {
    if (project.settings.exact === "off") {
      issues.push({
        path: "settings.selectedPlan",
        message:
          "exact: off のため厳密探索案 X は生成されません" +
          "（selectedPlan に 'X' を指定するには exact を auto または on にしてください）。",
        severity: "error",
      });
    }
  } else if (sp !== null && !validIds.includes(sp)) {
    issues.push({
      path: "settings.selectedPlan",
      message:
        `selectedPlan='${sp}' は生成される案 ID の範囲外です` +
        `（有効値: [${validIds.map((v) => `'${v}'`).join(", ")}]）。`,
      severity: "error",
    });
  }
  return issues;
}

/** v0.4: settings.rank の空配列禁止（許容値・重複は層1のスキーマ検証が担う）。 */
function checkRank(project: Project): Issue[] {
  if (project.settings.rank.length === 0) {
    return [
      {
        path: "settings.rank",
        message:
          "rank は空配列にできません" +
          '（"cost"・"waste"・"cuts" を優先順に1つ以上指定してください）。',
        severity: "error",
      },
    ];
  }
  return [];
}

/** 項目9: bar 部材への rot 指定は無意味 → warning で無視。 */
function checkBarRot(
  project: Project,
  raw: Record<string, unknown>,
  stocksById: Map<string, Stock>,
): Issue[] {
  const issues: Issue[] = [];
  const rawParts = Array.isArray(raw.parts) ? (raw.parts as unknown[]) : [];
  project.parts.forEach((p, i) => {
    const stock = stocksById.get(p.stock);
    if (stock === undefined || stock.kind !== "bar") {
      return;
    }
    const rawPart = i < rawParts.length && isPlainObject(rawParts[i]) ? (rawParts[i] as Record<string, unknown>) : {};
    if ("rot" in rawPart) {
      issues.push({
        path: `parts[${i}].rot`,
        message:
          "bar 部材への rot 指定は無意味です（1D割付では回転を扱いません）。" +
          "この指定は無視されます。",
        severity: "warning",
      });
    }
  });
  return issues;
}

/** 層2: 意味検証をすべて実行する。 */
function semanticValidate(project: Project, raw: Record<string, unknown>): Issue[] {
  const stocksById = new Map(project.stocks.map((s) => [s.id, s]));

  const issues: Issue[] = [];
  issues.push(...checkDuplicateIds(project));
  issues.push(...checkIdSafety(project));
  issues.push(...checkStockReferences(project));
  issues.push(...checkPhysicalFit(project, stocksById));
  issues.push(...checkWidthConsistency(project, stocksById));
  issues.push(...checkFeatureBounds(project, stocksById));
  issues.push(...checkMeta(project));
  issues.push(...checkSelectedPlan(project));
  issues.push(...checkRank(project));
  issues.push(...checkBarRot(project, raw, stocksById));
  return issues;
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * raw 値に対して構造検証（層1）＋意味検証（層2）を throw なしで実行する。
 *
 * severity "error" の Issue が1件でもあれば project は null。
 * 層1でエラーがあればモデル構築・層2には進まない（その時点の Issue のみ返す）。
 */
export function loadProjectFromRaw(raw: unknown): {
  project: Project | null;
  issues: Issue[];
} {
  const normalized = raw ?? {};
  if (!isPlainObject(normalized)) {
    return {
      project: null,
      issues: [
        {
          path: "<root>",
          message:
            "project ファイルのトップレベルはオブジェクト（マップ）でなければなりません。",
          severity: "error",
        },
      ],
    };
  }

  const stockIds = extractStockIds(normalized);
  const schema = buildSchema(stockIds);

  const schemaIssues = validateAgainstSchema(normalized, schema);
  if (schemaIssues.some((i) => i.severity === "error")) {
    return { project: null, issues: schemaIssues };
  }

  const project = buildProject(normalized);
  const semanticIssues = semanticValidate(project, normalized);

  const allIssues = [...schemaIssues, ...semanticIssues];
  if (allIssues.some((i) => i.severity === "error")) {
    return { project: null, issues: allIssues };
  }
  return { project, issues: allIssues };
}

/**
 * project.yaml / project.json を読み込み、検証済みの Project を返す。
 *
 * パイプライン: raw 読込 → 層1（スキーマ検証） → モデル構築 → 層2（意味検証）。
 *
 * @returns `{ project, warnings }`。warnings には層2で検出された warning のみが
 *   含まれる（error が1件でもあれば ProjectError を送出するため）。
 * @throws ProjectError 層1または層2で severity "error" の Issue が1件以上
 *   検出された場合。`ProjectError.issues` には検出された全 Issue
 *   （error・warning 双方）を含む。
 */
export function loadProject(filePath: string): { project: Project; warnings: Issue[] } {
  const raw = readRaw(filePath);
  const { project, issues } = loadProjectFromRaw(raw);
  if (project === null) {
    throw new ProjectError(issues);
  }
  return { project, warnings: issues };
}
