/**
 * project.yaml / project.json 用 JSON Schema の生成（設計正本 §7）。
 *
 * **単一ソース原則**: ここで組み立てるスキーマは、
 * 1. VS Code の YAML/JSON 拡張が補完・検証・ホバー説明に使うファイル（project.schema.json）
 * 2. loader.ts の層1（スキーマ検証）
 *
 * の両方に使われる唯一の定義である。検証ロジックを2箇所に書かない。
 *
 * 役割分担（設計正本 §2・§7 に明記）:
 * - スキーマ検証（本モジュール・層1）が担うのは型・必須キー・enum・数値範囲・
 *   additionalProperties: false という「機械的な形」のみ。
 * - bar/sheet の条件分岐（sheet 部材の width 必須等）・相互参照・物理的整合性・
 *   meta.units の固定値チェック・ID 安全性（pattern の権威判定と Windows 予約名）等は
 *   JSON Schema では表現しきれない、または設計上あえて層2（loader.ts の意味検証）に
 *   委ねている。stocks[].id / parts[].id の pattern はエディタ支援（赤線表示）の
 *   ために書き出すが、権威は層2にある（層1は pattern を検証しない）。
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Draft 2020-12 の $schema URI。 */
export const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * stocks[].id / parts[].id に許容するパターン（出力ファイル名に使用するため）。
 * 英数字で始まり、英数字・「.」「_」「-」のみで構成する。
 */
export const ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";

/**
 * 各フィールドの説明文（日本語、SPECS.md §4 の定義文をそのまま採用）。
 * schema 組み立てはすべてこの辞書を参照し、description を二重管理しない。
 */
export const DESCRIPTIONS: Record<string, string> = {
  "meta.project": 'プロジェクト名（例: "書棚"）。',
  "meta.units": "単位。mm 固定（他の値は loader の意味検証で error になる）。",
  "meta.schemaVersion":
    "正本のスキーマバージョン表記。想定バージョンと不一致の場合はloader が warning を出す。",
  "settings.kerf": "鋸刃厚（mm）。割付時に切断ごとに消費される。デフォルト 3。",
  "settings.edgeTrim": "原材の端の捨て代（mm）。荒れた木口を落とす分。デフォルト 5。",
  "settings.candidates":
    "生成する割付候補数（デフォルト 3）。1〜3 にクランプされる（4 以上の指定は loader が warning を出す）。",
  "settings.rank":
    '推奨案の評価優先順。"cost"（概算費用）・"waste"（歩留まり）・"cuts"（カット回数）を' +
    '優先順に並べる。デフォルト ["cost", "waste", "cuts"]。重複・空配列は error になる。',
  "settings.exact":
    "厳密探索モード。auto（既定）は部材数が小さいとき（目安 15 以下）のみ全探索" +
    "（分枝限定）を実行し、真に最適な構成を候補 X として加える。on は常に実行、off は実行しない。",
  "settings.selectedPlan":
    '採用した案の ID（"A"/"B"/"C"/"X"。X は厳密探索案）。null の間は全案を出力する。',
  "stocks.id":
    "原材 ID。parts[].stock から参照される。出力ファイル名に使用するため、" +
    "英数字で始まり英数字・「.」「_」「-」のみ使用できる。",
  "stocks.label": '表示ラベル（例: "1×4材 6F"）。',
  "stocks.kind": "bar（1D割付・長さのみ使用）または sheet（2D割付・長さ×幅を使用）。",
  "stocks.length": "原材の長さ（mm）。",
  "stocks.width": "原材の幅（mm）。bar の場合は部材の実効幅として使われる。",
  "stocks.thickness": "原材の厚み（mm）。",
  "stocks.price": "単価（円）。省略可。省略時は費用計算で price 欠落として扱われる。",
  "parts.id":
    "部材 ID。出力ファイル名（out/parts/{id}.svg）に使われるため、" +
    "英数字で始まり英数字・「.」「_」「-」のみ使用できる。",
  "parts.label": "表示ラベル。",
  "parts.qty": "必要数量。",
  "parts.stock":
    "使用する原材の id 参照。stocks の id が補完候補になる（存在しない id はここでエラーになる）。",
  "parts.length": "部材の長さ（mm）。",
  "parts.width":
    "部材の幅（mm）。bar 部材では省略可（省略時、または指定時も stock.width と同値のみ許容）。" +
    "sheet 部材では必須。",
  "parts.rot":
    "2D割付時の90度回転可否。デフォルト true。木目を通したい部材は false。" +
    "bar 部材では意味を持たない（指定すると loader が warning を出す）。",
  "parts.features": "加工フィーチャ（溝・丸穴）の配列。",
  "features.type": "フィーチャ種別。groove（溝）または hole（丸穴）。",
  "groove.face": "加工面。front は実線＋薄塗り、back は破線（隠れ線規約）で描画される。",
  "groove.dir": "溝の走行方向。across（幅方向）または along（長さ方向）。",
  "groove.pos": "基準端から溝中心までの距離（mm）。寸法線抽出でも中心基準として扱う。",
  "groove.width": "溝幅（mm）。",
  "groove.depth": "溝深さ（mm）。stock.thickness 以下でなければならない（意味検証層）。",
  "groove.end": "through（通し）または stopped（止め、止めの場合 from/to を追加）。",
  "groove.from": "end: stopped の場合のみ使用する、走行方向の開始座標（mm）。",
  "groove.to": "end: stopped の場合のみ使用する、走行方向の終了座標（mm）。",
  "hole.face": "加工面。front または back。",
  "hole.x": "部材ローカル座標系での中心 X 座標（mm）。",
  "hole.y": "部材ローカル座標系での中心 Y 座標（mm）。",
  "hole.dia": "径（mm）。",
  "hole.depth": "深さ（mm）。省略時は貫通を表す。",
};

function grooveSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "face", "dir", "pos", "width", "depth", "end"],
    properties: {
      type: { const: "groove", description: DESCRIPTIONS["features.type"] },
      face: { enum: ["front", "back"], description: DESCRIPTIONS["groove.face"] },
      dir: { enum: ["across", "along"], description: DESCRIPTIONS["groove.dir"] },
      pos: { type: "number", minimum: 0, description: DESCRIPTIONS["groove.pos"] },
      width: {
        type: "number",
        exclusiveMinimum: 0,
        description: DESCRIPTIONS["groove.width"],
      },
      depth: {
        type: "number",
        exclusiveMinimum: 0,
        description: DESCRIPTIONS["groove.depth"],
      },
      end: { enum: ["through", "stopped"], description: DESCRIPTIONS["groove.end"] },
      from: { type: "number", minimum: 0, description: DESCRIPTIONS["groove.from"] },
      to: { type: "number", minimum: 0, description: DESCRIPTIONS["groove.to"] },
    },
  };
}

function holeSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "face", "x", "y", "dia"],
    properties: {
      type: { const: "hole", description: DESCRIPTIONS["features.type"] },
      face: { enum: ["front", "back"], description: DESCRIPTIONS["hole.face"] },
      x: { type: "number", minimum: 0, description: DESCRIPTIONS["hole.x"] },
      y: { type: "number", minimum: 0, description: DESCRIPTIONS["hole.y"] },
      dia: { type: "number", exclusiveMinimum: 0, description: DESCRIPTIONS["hole.dia"] },
      depth: {
        type: ["number", "null"],
        exclusiveMinimum: 0,
        description: DESCRIPTIONS["hole.depth"],
      },
    },
  };
}

function stockSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["id", "label", "kind", "length", "width", "thickness"],
    properties: {
      id: { type: "string", pattern: ID_PATTERN, description: DESCRIPTIONS["stocks.id"] },
      label: { type: "string", description: DESCRIPTIONS["stocks.label"] },
      kind: { enum: ["bar", "sheet"], description: DESCRIPTIONS["stocks.kind"] },
      length: {
        type: "number",
        exclusiveMinimum: 0,
        description: DESCRIPTIONS["stocks.length"],
      },
      width: {
        type: "number",
        exclusiveMinimum: 0,
        description: DESCRIPTIONS["stocks.width"],
      },
      thickness: {
        type: "number",
        exclusiveMinimum: 0,
        description: DESCRIPTIONS["stocks.thickness"],
      },
      price: {
        type: ["number", "null"],
        minimum: 0,
        description: DESCRIPTIONS["stocks.price"],
      },
    },
  };
}

function partSchema(stockIds: readonly string[]): Record<string, unknown> {
  const stockProp: Record<string, unknown> = {
    type: "string",
    description: DESCRIPTIONS["parts.stock"],
  };
  // enum: [] は全入力を弾くため禁止（設計正本 §7）。空なら type: string のみ。
  if (stockIds.length > 0) {
    stockProp.enum = [...stockIds];
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["id", "label", "qty", "stock", "length"],
    properties: {
      id: { type: "string", pattern: ID_PATTERN, description: DESCRIPTIONS["parts.id"] },
      label: { type: "string", description: DESCRIPTIONS["parts.label"] },
      qty: {
        type: "integer",
        exclusiveMinimum: 0,
        description: DESCRIPTIONS["parts.qty"],
      },
      stock: stockProp,
      length: {
        type: "number",
        exclusiveMinimum: 0,
        description: DESCRIPTIONS["parts.length"],
      },
      width: {
        type: "number",
        exclusiveMinimum: 0,
        description: DESCRIPTIONS["parts.width"],
      },
      rot: { type: "boolean", default: true, description: DESCRIPTIONS["parts.rot"] },
      features: {
        type: "array",
        default: [],
        description: DESCRIPTIONS["parts.features"],
        items: { oneOf: [grooveSchema(), holeSchema()] },
      },
    },
  };
}

/**
 * project.yaml / project.json の JSON Schema（Draft 2020-12）を組み立てて返す。
 *
 * @param stockIds その時点で読み取れた stocks[].id の一覧。parts[].stock の
 *   enum 動的注入に使う（設計正本 §7）。空配列なら enum を付与しない
 *   （enum: [] は全入力を弾いてしまうため）。
 * @returns JSON Schema（プレーンオブジェクト）。additionalProperties: false を
 *   全階層で強制する。
 */
export function buildSchema(stockIds: readonly string[]): Record<string, unknown> {
  return {
    $schema: DRAFT_2020_12,
    title: "kidori project",
    description:
      "kidori project.yaml / project.json のスキーマ（kidori build 実行時に自動再生成される）。",
    type: "object",
    additionalProperties: false,
    required: ["meta", "stocks", "parts"],
    properties: {
      meta: {
        type: "object",
        additionalProperties: false,
        required: ["project", "units", "schemaVersion"],
        properties: {
          project: { type: "string", description: DESCRIPTIONS["meta.project"] },
          // units の値そのものが "mm" であることの強制は、設計正本 §2
          // 層2（意味検証）が担う。ここでは型のみを検証する。
          units: { type: "string", description: DESCRIPTIONS["meta.units"] },
          schemaVersion: {
            type: "string",
            description: DESCRIPTIONS["meta.schemaVersion"],
          },
        },
      },
      settings: {
        type: "object",
        additionalProperties: false,
        properties: {
          kerf: {
            type: "number",
            minimum: 0,
            default: 3.0,
            description: DESCRIPTIONS["settings.kerf"],
          },
          edgeTrim: {
            type: "number",
            minimum: 0,
            default: 5.0,
            description: DESCRIPTIONS["settings.edgeTrim"],
          },
          candidates: {
            type: "integer",
            default: 3,
            description: DESCRIPTIONS["settings.candidates"],
          },
          rank: {
            type: "array",
            items: { enum: ["cost", "waste", "cuts"] },
            uniqueItems: true,
            default: ["cost", "waste", "cuts"],
            description: DESCRIPTIONS["settings.rank"],
          },
          exact: {
            enum: ["auto", "on", "off"],
            default: "auto",
            description: DESCRIPTIONS["settings.exact"],
          },
          selectedPlan: {
            default: null,
            description: DESCRIPTIONS["settings.selectedPlan"],
            anyOf: [{ type: "null" }, { enum: ["A", "B", "C", "X"] }],
          },
        },
      },
      stocks: {
        type: "array",
        items: stockSchema(),
      },
      parts: {
        type: "array",
        items: partSchema(stockIds),
      },
    },
  };
}

/**
 * スキーマの JSON 文字列表現を返す（インデント2・末尾改行付き）。
 */
export function schemaJson(stockIds: readonly string[]): string {
  return JSON.stringify(buildSchema(stockIds), null, 2) + "\n";
}

/**
 * projectPath の隣に project.schema.json を書き出す。
 *
 * kidori build / watch の毎回、検証より先に呼び出される想定（設計正本 §7）。
 * stocks が読み取れない不正なドキュメントでも、stockIds に空配列を渡せば
 * enum なしのスキーマを書き出せる。
 *
 * @param projectPath project.yaml（または project.json）のパス。
 * @param stockIds parts[].stock の enum に注入する原材 id 一覧。
 * @returns 書き出した project.schema.json のパス。
 */
export function writeSchema(projectPath: string, stockIds: readonly string[]): string {
  const schemaPath = join(dirname(projectPath), "project.schema.json");
  writeFileSync(schemaPath, schemaJson(stockIds), "utf-8");
  return schemaPath;
}
