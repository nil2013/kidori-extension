/**
 * kidori ファイル（*.kidori.yaml / *.kidori.json 等）の読込・検証（設計正本 §2）。
 *
 * 読込パイプライン:
 * 1. `readRaw` — YAML（`.json` 以外）/ JSON（`.json`）を素のオブジェクトに読み込む。
 * 1.5. `stocksFile:`（SPECS.md §4）の解決。参照先の stocks を読み込み、
 *    parts[].stock の enum 注入にもその id を含める。**単段のみ**で、
 *    絶対パス・不在・パース不能・検証エラー・多段参照はいずれも error。
 * 2. 層1: スキーマ検証（`schema.ts` の `buildSchema` を単一ソースとして再利用）。
 *    型・必須キー・enum・数値範囲・additionalProperties: false という
 *    「機械的な形」を検証する。ここでエラーがあればモデル構築に進まない
 *    （型・必須キーが壊れた状態では層2の相互参照チェックが安全に実行できないため）。
 * 3. モデル構築（YAML キー → TypeScript プロパティ名の対応をここで完結させる。
 *    キーはキャメルケースのまま。Groove の "from" もそのまま `from` に格納する）。
 * 4. 層2: 意味検証（設計正本 §2 の9項目 ＋ v0.4 追加の rank / exact /
 *    selectedPlan "X" / ID 安全性 ＋ v0.7 追加の assemblies / marks / qty 導出。
 *    相互参照・物理条件などスキーマでは表現しきれない検証）。
 *
 * `loadProject(filePath)` はこのパイプライン全体を実行し、error があれば
 * `ProjectError` を送出、warning のみなら `{ project, warnings }` を返す。
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";

import { Issue, ProjectError } from "./errors";
import { markVariantStem } from "./marks";
import { EPS } from "./packing/common";
import { ID_PATTERN, buildSchema, buildStocksFileSchema } from "./schema";
import {
  Assembly,
  DEFAULT_RANK,
  ExactMode,
  Feature,
  Groove,
  Hole,
  Mark,
  Meta,
  Part,
  Project,
  RankKey,
  Settings,
  Stock,
  effectiveWidth,
} from "./types";

/**
 * meta.schemaVersion の想定値（SPECS.md v0.7 で 0.4）。
 *
 * 不一致は warning のまま維持する（設計正本 §2 層2 項目7）。旧版（"0.2"/"0.3"）の
 * 既存ファイルもそのままビルドできる＝仕様自身の救済経路であり、専用の
 * レガシー変換経路は設けない（0.4 で追加された assemblies は任意区画なので、
 * 構造上 0.3 のファイルはそのまま有効な 0.4 のファイルでもある）。
 */
export const SUPPORTED_SCHEMA_VERSION = "0.4";

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
  minLength: "文字列が短すぎます",
  minimum: "値が小さすぎます",
  exclusiveMinimum: "値は正の数でなければなりません",
  maximum: "値が大きすぎます",
  uniqueItems: "配列の要素が重複しています",
  oneOf: "排他的な形式のいずれにも一致しません",
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
 * 正本ファイル（*.kidori.yaml / *.kidori.json 等）を素の値に読み込む（検証・変換なし）。
 *
 * `.json` 拡張子なら `JSON.parse`、それ以外は yaml パッケージの `parse` で
 * 読み込む（設計正本 §2）。拡張層の動的スキーマ合成など「stocks だけ拾いたい」
 * 用途の補助関数でもあるため、スキーマ検証・意味検証は一切行わない。
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
 * stocks 部分だけでも読めれば parts[].stock の enum 合成に使えるようにするため
 * （SPECS.md §4b。stocks すら読めない場合は enum なしスキーマになる）、
 * 型が不正な要素は無視して読み取れるものだけ集める。
 *
 * `stocksFile:` 参照先の id は含まない（必要なら `loadStocksFile` を併用する）。
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
 * 解釈するキーワード: type / enum / const / minLength / minimum /
 * exclusiveMinimum / maximum / required / properties /
 * additionalProperties（false またはサブスキーマ）/ items / uniqueItems /
 * oneOf / anyOf / title（oneOf 不一致メッセージの文脈表示にのみ使う）。
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

  if (typeof value === "string" && typeof schema.minLength === "number") {
    if (value.length < schema.minLength) {
      out.push({
        path,
        keyword: "minLength",
        detail: `${shortRepr(value)} は ${schema.minLength} 文字以上でなければなりません。`,
      });
    }
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
    } else if (isPlainObject(schema.additionalProperties)) {
      // 自由キーのマップ（assemblies[].contains 等）の値をサブスキーマで検証する。
      // **キーは Issue.path に載せない**: キーはユーザー制御の文字列（形状 id は
      // 「.」を含みうる）であり、path のセグメントに混ぜると path → YAML 行の
      // 写像が壊れるため。キー名はメッセージ側に書く（意味検証層と同じ規約）。
      const subSchema = schema.additionalProperties as SchemaNode;
      for (const [key, v] of Object.entries(value)) {
        if (key in props) {
          continue;
        }
        const sub: RawSchemaError[] = [];
        validateNode(v, subSchema, [], sub);
        for (const e of sub) {
          out.push({ path, keyword: e.keyword, detail: `キー '${key}': ${e.detail}` });
        }
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
      // title があれば文脈（どの排他形式の話か）を添える。keyword → 日本語ラベルの
      // 対応表は1本しかないため、形式の説明はスキーマ側（title）に持たせる。
      const context = typeof schema.title === "string" ? `${schema.title}: ` : "";
      out.push({
        path,
        keyword: "oneOf",
        detail: `${context}一致した形式は ${matched} 件です（ちょうど1件必要）。`,
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

/** stocks[] の1要素を素の値から構築する（正本インライン・stocksFile 参照先で共通）。 */
function buildStock(s: Record<string, any>): Stock {
  const stock: Stock = {
    id: s.id,
    label: s.label,
    kind: s.kind,
    length: Number(s.length),
    width: Number(s.width),
    thickness: Number(s.thickness),
    price: s.price !== null && s.price !== undefined ? Number(s.price) : null,
  };
  // preset は来歴メタデータ。loader は受理して素通しするだけで、ビルドは解決しない。
  if (typeof s.preset === "string") {
    stock.preset = s.preset;
  }
  return stock;
}

/**
 * marks[].x / marks[].y の素の値を Mark のフィールド型（`number | エイリアス2種`）に
 * 変換する。省略時は 0（領域の左下角＝部材ローカル原点側の角が基準。SPECS.md §4c）。
 * エイリアス自体の解決（0 や `面寸法 - w/h` への変換）は `resolveMark`（marks.ts）が
 * `rot` 適用後に行う（層1 のスキーマ検証を通過済みの前提のため、near/far 以外の
 * 文字列は来ない）。
 */
function buildMarkCoord<Near extends string, Far extends string>(
  v: unknown,
  near: Near,
  far: Far,
): number | Near | Far {
  if (v === near || v === far) {
    return v as Near | Far;
  }
  if (v === null || v === undefined) {
    return 0;
  }
  return Number(v);
}

/** assemblies[].marks[] の1要素を素の値から構築する（ref/w/h の排他は層2が検証）。 */
function buildMark(m: Record<string, any>): Mark {
  return {
    on: m.on,
    face: m.face,
    x: buildMarkCoord(m.x, "left", "right"),
    y: buildMarkCoord(m.y, "bottom", "top"),
    w: m.w !== null && m.w !== undefined ? Number(m.w) : null,
    h: m.h !== null && m.h !== undefined ? Number(m.h) : null,
    ref: typeof m.ref === "string" ? m.ref : null,
    // rot の 0/90 以外の値は層1（スキーマの enum）が既に error にしているため、
    // ここに到達する時点では 90 かそれ以外（省略含む）のいずれかとみなしてよい。
    rot: m.rot === 90 ? 90 : 0,
    note: typeof m.note === "string" ? m.note : null,
  };
}

/** assemblies[] の1要素を素の値から構築する。 */
function buildAssembly(a: Record<string, any>): Assembly {
  const contains: Record<string, number> = {};
  if (isPlainObject(a.contains)) {
    for (const [partId, n] of Object.entries(a.contains)) {
      contains[partId] = Math.trunc(Number(n));
    }
  }
  return {
    id: a.id,
    label: typeof a.label === "string" ? a.label : null,
    contains,
    marks: ((a.marks ?? []) as Record<string, any>[]).map(buildMark),
  };
}

/**
 * 形状 id に対する contains 合計を返す（どの構成にも現れなければ null）。
 *
 * SPECS.md §4c: 部材必要数は**全 assembly の合計**から導出される。
 * 「1件も現れない」と「合計 0」を区別するため、非所属は null で返す。
 */
export function containedQty(
  assemblies: readonly Assembly[],
  partId: string,
): number | null {
  let total = 0;
  let found = false;
  for (const a of assemblies) {
    const n = a.contains[partId];
    if (typeof n === "number" && Number.isFinite(n)) {
      found = true;
      total += n;
    }
  }
  return found ? total : null;
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

  const stocks: Stock[] = ((raw.stocks ?? []) as Record<string, any>[]).map(buildStock);

  const assemblies: Assembly[] = ((raw.assemblies ?? []) as Record<string, any>[]).map(
    buildAssembly,
  );

  const parts: Part[] = ((raw.parts ?? []) as Record<string, any>[]).map((p) => {
    // qty の導出（SPECS.md §4c）:
    //   1. いずれかの構成の contains に現れる → 全構成の合計が勝つ
    //      （qty 併記との食い違いは checkQtyDerivation が warning にする）。
    //   2. どの構成にも現れない → 明記された qty を使う。無ければ導出不能で
    //      checkQtyDerivation が error にする（ここでは 0 を置くが、error のため
    //      Project は組み上がらず下流には渡らない）。
    const derived = containedQty(assemblies, p.id);
    const declared =
      p.qty !== null && p.qty !== undefined ? Math.trunc(Number(p.qty)) : null;
    return {
      id: p.id,
      label: p.label,
      qty: derived ?? declared ?? 0,
      stock: p.stock,
      length: Number(p.length),
      width: p.width !== null && p.width !== undefined ? Number(p.width) : null,
      rot: p.rot !== undefined ? Boolean(p.rot) : true,
      features: ((p.features ?? []) as Record<string, any>[]).map(buildFeature),
    };
  });

  return { meta, settings, stocks, parts, assemblies };
}

// ---------------------------------------------------------------------------
// 層2: 意味検証（設計正本 §2 の9項目 ＋ v0.4 追加検証）
// ---------------------------------------------------------------------------

/** 項目1: stocks[].id / parts[].id の重複。 */
function checkDuplicateIds(project: Project): Issue[] {
  const issues: Issue[] = [];

  const collect = (
    entries: readonly { id: string }[],
    section: "stocks" | "parts" | "assemblies",
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
  // v0.7: assemblies[].id も変種面のファイル名に入るため一意でなければならない。
  collect(project.assemblies, "assemblies");
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
  // v0.7: assembly id は変種面 parts/{assembly}-{形状id}.svg のファイル名に入る。
  project.assemblies.forEach((a, i) => check(a.id, `assemblies[${i}].id`, "構成"));
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

// ---------------------------------------------------------------------------
// v0.7: assemblies（構成グルーピング）・marks（取り付けシロ）の意味検証（SPECS.md §4c）
//
// Issue.path の規約: `assemblies[0].contains` のように**固定キー名＋数値添字だけ**で
// 構成し、ユーザー制御の文字列（形状 id 等）はメッセージ側に書く。形状 id は「.」を
// 含みうるため、path のセグメントに混ぜると path → YAML 行の写像が壊れる
// （既存診断が `parts[3].stock` と書いて id をメッセージに回しているのと同じ規約）。
// ---------------------------------------------------------------------------

/** v0.7: assemblies[].contains のキーが parts に存在すること。 */
function checkAssemblyContains(project: Project): Issue[] {
  const partIds = new Set(project.parts.map((p) => p.id));
  const issues: Issue[] = [];
  project.assemblies.forEach((a, i) => {
    for (const partId of Object.keys(a.contains)) {
      if (!partIds.has(partId)) {
        issues.push({
          path: `assemblies[${i}].contains`,
          message:
            `構成 '${a.id}' の contains が存在しない形状 id を参照しています: '${partId}'。`,
          severity: "error",
        });
      }
    }
  });
  return issues;
}

/**
 * v0.7: marks[] の参照整合と領域寸法指定の排他。
 *
 * - `on` は parts に存在し、かつその構成の contains に含まれること
 *   （含まれなければマークを適用する部材の実体が構成内に無い）。
 * - `ref` は parts に存在すること。
 * - `ref` と `w`/`h` は排他（併記は error。どちらも無ければ領域寸法が決まらず error）。
 *   併記の側はスキーマの oneOf（層1）でも弾かれるが、権威はこちらに置く
 *   （parts[].stock の enum と checkStockReferences の関係と同じ）。
 */
function checkMarks(project: Project): Issue[] {
  const partIds = new Set(project.parts.map((p) => p.id));
  const issues: Issue[] = [];
  project.assemblies.forEach((a, i) => {
    a.marks.forEach((m, j) => {
      const mpath = `assemblies[${i}].marks[${j}]`;

      if (!partIds.has(m.on)) {
        issues.push({
          path: `${mpath}.on`,
          message:
            `構成 '${a.id}' の mark が存在しない形状 id を参照しています: '${m.on}'。`,
          severity: "error",
        });
        // contains は自前のキーだけを見る（Object.prototype 由来のキー名
        // （"toString" 等）を形状 id にしたときに検査がすり抜けないように）。
      } else if (!Object.prototype.hasOwnProperty.call(a.contains, m.on)) {
        issues.push({
          path: `${mpath}.on`,
          message:
            `mark の対象形状 '${m.on}' が構成 '${a.id}' の contains に含まれていません` +
            "（マークを適用する部材がこの構成に存在しません）。",
          severity: "error",
        });
      }

      if (m.ref !== null && !partIds.has(m.ref)) {
        issues.push({
          path: `${mpath}.ref`,
          message:
            `構成 '${a.id}' の mark の ref が存在しない形状 id を参照しています: '${m.ref}'。`,
          severity: "error",
        });
      }

      const hasSize = m.w !== null || m.h !== null;
      if (m.ref !== null && hasSize) {
        issues.push({
          path: `${mpath}.ref`,
          message:
            "mark の ref と w/h は排他です（ref は相手形状の断面寸法から領域寸法を" +
            "導出するため、w/h を併記できません）。",
          severity: "error",
        });
      } else if (m.ref === null && (m.w === null || m.h === null)) {
        issues.push({
          path: `${mpath}.w`,
          message:
            "mark の領域寸法が決まりません（ref で相手形状の断面寸法から導出するか、" +
            "w と h の両方を指定してください）。",
          severity: "error",
        });
      }
    });
  });
  return issues;
}

/**
 * v0.7: 変種面の出力ファイル名（`parts/{assembly}-{形状id}.svg`）の衝突。
 *
 * assembly id・形状 id はいずれも「-」を含みうるため、合成名が別の形状 id や
 * 別の変種面の名前と一致しうる。上書きで図が静かに消えるのを防ぐため error。
 */
function checkMarkVariantCollisions(project: Project): Issue[] {
  const partIds = new Set(project.parts.map((p) => p.id));
  const issues: Issue[] = [];
  const seen = new Map<string, { assemblyId: string; partId: string }>();

  project.assemblies.forEach((a, i) => {
    // マークを持つ形状だけが変種面として出力される（マーク無しは形状ごとに1面）。
    for (const partId of new Set(a.marks.map((m) => m.on))) {
      if (!partIds.has(partId)) {
        continue; // checkMarks が既に error 報告済み
      }
      const stem = markVariantStem(a.id, partId);
      if (partIds.has(stem)) {
        issues.push({
          path: `assemblies[${i}].id`,
          message:
            `構成 '${a.id}' × 形状 '${partId}' の変種面の出力名 '${stem}' が` +
            `部材 id '${stem}' と衝突します（加工指示図が上書きされます）。` +
            "どちらかの id を変更してください。",
          severity: "error",
        });
        continue;
      }
      const prev = seen.get(stem);
      if (prev !== undefined) {
        issues.push({
          path: `assemblies[${i}].id`,
          message:
            `構成 '${a.id}' × 形状 '${partId}' の変種面の出力名 '${stem}' が` +
            `構成 '${prev.assemblyId}' × 形状 '${prev.partId}' の変種面と衝突します` +
            "（加工指示図が上書きされます）。どちらかの id を変更してください。",
          severity: "error",
        });
        continue;
      }
      seen.set(stem, { assemblyId: a.id, partId });
    }
  });
  return issues;
}

/**
 * v0.7: parts[].qty の導出（SPECS.md §4c）。
 *
 * 1. いずれかの構成の contains に現れる形状 → **全構成の合計が勝つ**。
 *    qty が併記されていて合計と食い違えば warning（割付は導出後の合計だけを見る）。
 * 2. どの構成にも現れない形状 → 明記された qty を使う。無ければ必要数を導出できず
 *    error（qty=0 として黙って木取りから消すと、鋸を入れる部材が静かに失われる）。
 */
function checkQtyDerivation(project: Project, raw: Record<string, unknown>): Issue[] {
  const rawParts = Array.isArray(raw.parts) ? (raw.parts as unknown[]) : [];
  const issues: Issue[] = [];
  project.parts.forEach((p, i) => {
    const rawPart =
      i < rawParts.length && isPlainObject(rawParts[i])
        ? (rawParts[i] as Record<string, unknown>)
        : {};
    const declared =
      "qty" in rawPart && rawPart.qty !== null && rawPart.qty !== undefined
        ? Math.trunc(Number(rawPart.qty))
        : null;
    const derived = containedQty(project.assemblies, p.id);

    if (derived === null) {
      if (declared === null) {
        issues.push({
          path: `parts[${i}].qty`,
          message:
            `形状 '${p.id}' の必要数を導出できません（どの assembly の contains にも` +
            "含まれておらず、qty も指定されていません）。qty を明記するか、" +
            "いずれかの構成の contains に含めてください。",
          severity: "error",
        });
      }
      return;
    }

    if (declared !== null && declared !== derived) {
      issues.push({
        path: `parts[${i}].qty`,
        message:
          `形状 '${p.id}' の qty が assemblies からの導出値と一致しません` +
          `（宣言値 ${declared} / 導出値 ${derived}）。割付は導出値 ${derived} を使います。`,
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
  // v0.7: assemblies / marks（SPECS.md §4c）
  issues.push(...checkAssemblyContains(project));
  issues.push(...checkMarks(project));
  issues.push(...checkMarkVariantCollisions(project));
  issues.push(...checkQtyDerivation(project, raw));
  return issues;
}

// ---------------------------------------------------------------------------
// stocksFile: 外部 stocks 参照（SPECS.md §4）
// ---------------------------------------------------------------------------

/** stocksFile 由来の Issue はすべてこのパスに載せる（正本側の当該行を指す）。 */
const STOCKS_FILE_PATH = "stocksFile";

function stocksFileIssue(message: string, severity: "error" | "warning"): Issue {
  return { path: STOCKS_FILE_PATH, message, severity };
}

/** `loadStocksFile` の結果。 */
export interface StocksFileResult {
  /** 参照先から読み取れた stocks（error 時は空配列）。 */
  stocks: Stock[];
  /** 検出された Issue（path はすべて "stocksFile"）。 */
  issues: Issue[];
  /** 解決できた参照先の絶対パス（解決前に失敗した場合は null）。 */
  resolvedPath: string | null;
}

/**
 * raw から `stocksFile:` の値を取り出す（文字列でなければ null）。
 *
 * 型が不正な場合は層1のスキーマ検証が error を出すため、ここでは黙って
 * 「参照なし」として扱う（同じ誤りを二重に報告しない）。
 */
export function extractStocksFileRef(raw: unknown): string | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const ref = raw.stocksFile;
  return typeof ref === "string" && ref !== "" ? ref : null;
}

/**
 * `stocksFile:` の参照先を読み込み、stocks エントリ一覧を返す（SPECS.md §4）。
 *
 * 規則:
 * - **相対パス限定**。絶対パスは error（`~` は展開しない＝そのまま相対名として
 *   解決を試み、通常は不在 error になる）。`..` は許可する
 *   （リポジトリ内の兄弟ディレクトリ共有は正当な用途）。symlink 検査はしない。
 * - **単段のみ**。参照先に `stocksFile` キーがあれば error
 *   （多段を許さないので循環は構造的に起こりえず、検出は不要）。
 * - **不在・パース不能・検証エラーはすべて error（ビルド失敗）**。参照先は
 *   正本セットの一部（一緒にコミットする前提）であり、欠落を warning で流すと
 *   stocks 集合が静かに変わって異なる木取り図が黙って生成されてしまう。
 *
 * @param baseDir 相対パスの解決基準（通常は正本の所在ディレクトリ）。
 * @param ref `stocksFile:` の値。
 */
export function loadStocksFile(baseDir: string, ref: string): StocksFileResult {
  const fail = (message: string): StocksFileResult => ({
    stocks: [],
    issues: [stocksFileIssue(message, "error")],
    resolvedPath: null,
  });

  if (isAbsolute(ref)) {
    return fail(
      `stocksFile は相対パスで指定してください（指定値: '${ref}'）。` +
        "参照先は正本セットの一部として一緒にコミットする前提のため、" +
        "絶対パスは使用できません。",
    );
  }

  const resolvedPath = resolve(baseDir, ref);

  let text: string;
  try {
    text = readFileSync(resolvedPath, "utf-8");
  } catch (e) {
    return fail(
      `stocksFile の参照先を読み込めませんでした: '${ref}'` +
        `（${e instanceof Error ? e.message : String(e)}）。`,
    );
  }

  let data: unknown;
  try {
    data = (ref.endsWith(".json") ? JSON.parse(text) : parse(text)) ?? {};
  } catch (e) {
    return fail(
      `stocksFile の参照先を解析できませんでした: '${ref}'` +
        `（${e instanceof Error ? e.message : String(e)}）。`,
    );
  }

  if (!isPlainObject(data)) {
    return {
      stocks: [],
      issues: [
        stocksFileIssue(
          `stocksFile の参照先 '${ref}' のトップレベルは ` +
            "stocks: リストを持つオブジェクト（マップ）でなければなりません。",
          "error",
        ),
      ],
      resolvedPath,
    };
  }

  if ("stocksFile" in data) {
    return {
      stocks: [],
      issues: [
        stocksFileIssue(
          `stocksFile の多段参照は許可されていません（参照先 '${ref}' が` +
            "さらに stocksFile を持っています）。参照は1段だけにしてください。",
          "error",
        ),
      ],
      resolvedPath,
    };
  }

  const schemaIssues = validateAgainstSchema(data, buildStocksFileSchema()).map(
    (i): Issue =>
      stocksFileIssue(
        `stocksFile の参照先 '${ref}' の ${i.path}: ${i.message}`,
        i.severity,
      ),
  );
  if (schemaIssues.some((i) => i.severity === "error")) {
    return { stocks: [], issues: schemaIssues, resolvedPath };
  }

  const stocks = ((data.stocks ?? []) as Record<string, any>[]).map(buildStock);
  return { stocks, issues: schemaIssues, resolvedPath };
}

/**
 * stocksFile 由来の stocks をインラインの stocks の後ろへマージする。
 *
 * id が衝突した場合は**インラインが勝つ**（SPECS.md §4「近い方が勝つ」）。
 * 衝突は warning で通知する（Issue path は該当インラインエントリの id）。
 *
 * インラインのエントリを配列の先頭側に残すことで、意味検証層が発行する
 * `stocks[i]` 形式のパスがインライン側では正本の記述位置と一致する。
 */
function mergeExternalStocks(project: Project, external: readonly Stock[]): Issue[] {
  const inlineIndexById = new Map<string, number>();
  project.stocks.forEach((s, i) => {
    if (!inlineIndexById.has(s.id)) {
      inlineIndexById.set(s.id, i);
    }
  });

  const issues: Issue[] = [];
  for (const s of external) {
    const inlineIdx = inlineIndexById.get(s.id);
    if (inlineIdx !== undefined) {
      issues.push({
        path: `stocks[${inlineIdx}].id`,
        message:
          `原材 id '${s.id}' は stocksFile の参照先にも定義されています。` +
          "インラインの定義が優先されます（近い方が勝つ）。",
        severity: "warning",
      });
      continue;
    }
    project.stocks.push(s);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/** `loadProjectFromRaw` のオプション。 */
export interface LoadOptions {
  /**
   * `stocksFile:` の相対パス解決の基準ディレクトリ（通常は正本の所在ディレクトリ）。
   * 省略した状態で `stocksFile:` が指定されていると、参照を解決できないため
   * warning を出して無視する（`loadProject` は常に正本のディレクトリを渡す）。
   */
  baseDir?: string;
}

/**
 * raw 値に対して構造検証（層1）＋意味検証（層2）を throw なしで実行する。
 *
 * severity "error" の Issue が1件でもあれば project は null。
 * 層1でエラーがあればモデル構築・層2には進まない（その時点の Issue のみ返す）。
 */
export function loadProjectFromRaw(
  raw: unknown,
  options: LoadOptions = {},
): {
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
            "kidori ファイルのトップレベルはオブジェクト（マップ）でなければなりません。",
          severity: "error",
        },
      ],
    };
  }

  // 1.5. stocksFile 解決（層1より先。参照先の id も parts[].stock の enum に含める）。
  const ref = extractStocksFileRef(normalized);
  let external: Stock[] = [];
  const externalIssues: Issue[] = [];
  if (ref !== null) {
    if (options.baseDir === undefined) {
      externalIssues.push(
        stocksFileIssue(
          `stocksFile: '${ref}' を解決できません（相対パスの基準ディレクトリが` +
            "不明なため無視します）。ファイルパス経由の読込では解決されます。",
          "warning",
        ),
      );
    } else {
      const result = loadStocksFile(options.baseDir, ref);
      external = result.stocks;
      externalIssues.push(...result.issues);
    }
  }
  if (externalIssues.some((i) => i.severity === "error")) {
    return { project: null, issues: externalIssues };
  }

  const stockIds = [
    ...new Set([...extractStockIds(normalized), ...external.map((s) => s.id)]),
  ];
  const schema = buildSchema(stockIds);

  const schemaIssues = validateAgainstSchema(normalized, schema);
  if (schemaIssues.some((i) => i.severity === "error")) {
    return { project: null, issues: [...externalIssues, ...schemaIssues] };
  }

  const project = buildProject(normalized);
  const mergeIssues = mergeExternalStocks(project, external);
  const semanticIssues = semanticValidate(project, normalized);

  const allIssues = [
    ...externalIssues,
    ...schemaIssues,
    ...mergeIssues,
    ...semanticIssues,
  ];
  if (allIssues.some((i) => i.severity === "error")) {
    return { project: null, issues: allIssues };
  }
  return { project, issues: allIssues };
}

/**
 * kidori ファイル（正本）を読み込み、検証済みの Project を返す。
 *
 * パイプライン: raw 読込 → stocksFile 解決 → 層1（スキーマ検証） →
 * モデル構築＋外部 stocks マージ → 層2（意味検証）。
 *
 * @returns `{ project, warnings }`。warnings には層2で検出された warning のみが
 *   含まれる（error が1件でもあれば ProjectError を送出するため）。
 * @throws ProjectError 層1または層2で severity "error" の Issue が1件以上
 *   検出された場合。`ProjectError.issues` には検出された全 Issue
 *   （error・warning 双方）を含む。
 */
export function loadProject(filePath: string): { project: Project; warnings: Issue[] } {
  const raw = readRaw(filePath);
  const { project, issues } = loadProjectFromRaw(raw, {
    baseDir: dirname(resolve(filePath)),
  });
  if (project === null) {
    throw new ProjectError(issues);
  }
  return { project, warnings: issues };
}
