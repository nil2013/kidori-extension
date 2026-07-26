/**
 * kidori ファイル（*.kidori.yaml / *.kidori.json 等）用 JSON Schema の生成。
 *
 * **単一ソース原則**: ここで組み立てるスキーマは、
 * 1. 拡張層がファイルごとにメモリ上で合成して YAML/JSON 言語サービスへ供給する
 *    スキーマ（SPECS.md §4b。ディスクへの再生成は v0.6 で廃止）
 * 2. `kidori init` が書き出す基底スキーマ `kidori.schema.json`
 *    （動的 enum なし。モードライン参照用。§3a）
 * 3. loader.ts の層1（スキーマ検証）
 *
 * のすべてに使われる唯一の定義である。検証ロジックを2箇所に書かない。
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
import { join } from "node:path";

import { BASE_SCHEMA_FILENAME } from "./kidorifile";

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
  stocksFile:
    "外部 stocks ファイル（例: 同居プロジェクト間で共有する ./stocks.yaml）への参照。" +
    "相対パス限定とし、参照先は正本セットの一部（一緒にコミットする前提）。" +
    "参照先はトップレベル stocks: リストを持つ1段のみのファイルで、" +
    "インラインの stocks と id が衝突した場合はインラインが勝つ。",
  "stocks.id":
    "原材 ID。parts[].stock から参照される。出力ファイル名に使用するため、" +
    "英数字で始まり英数字・「.」「_」「-」のみ使用できる。",
  "stocks.preset":
    "規格材マスタ側のキー（来歴メタデータ。任意）。補完確定時に自動挿入される。" +
    "ビルドは preset を一切解決せず、実値フィールドは preset があっても全て必須のまま" +
    "（正本の自己完結性を維持）。マスタへの追従をやめたいときはキーを消すだけでよい。",
  "stocks.label": '表示ラベル（例: "1×4材 6F"）。',
  "stocks.kind": "bar（1D割付・長さのみ使用）または sheet（2D割付・長さ×幅を使用）。",
  "stocks.length": "原材の長さ（mm）。",
  "stocks.width": "原材の幅（mm）。bar の場合は部材の実効幅として使われる。",
  "stocks.thickness": "原材の厚み（mm）。",
  "stocks.price": "単価（円）。省略可。省略時は費用計算で price 欠落として扱われる。",
  "parts.id":
    "部材 ID。出力ファイル名（<stem>.out/parts/{id}.svg）に使われるため、" +
    "英数字で始まり英数字・「.」「_」「-」のみ使用できる。",
  "parts.label": "表示ラベル。",
  "parts.qty":
    "必要数量。assemblies を使う場合は省略でき、全構成の contains 合計から導出される。" +
    "併記して合計と食い違う場合は warning。どの構成にも含まれない形状で省略すると" +
    "必要数を導出できないため error になる。",
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
  "groove.face":
    "加工面。front は木表・木裏を区別しない幅広の加工基準面（length × width。" +
    "完成品の世界座標における正面や、樹皮側を意味する木表そのものではない）。" +
    "面内座標系は左下原点・X右・Y上で、X は length 方向、Y は width 方向。" +
    "front は実線＋薄塗り、back はその対向面を front の加工指示図カード上に" +
    "破線（隠れ線規約）で投影して描画する。",
  "groove.dir": "溝の走行方向。across（幅方向）または along（長さ方向）。",
  "groove.pos":
    "基準端（部材ローカル原点側の端）から溝中心までの距離（mm）。" +
    "across は左端からの X 座標、along は下端からの Y 座標。寸法線抽出でも中心基準として扱う。",
  "groove.width": "溝幅（mm）。",
  "groove.depth": "溝深さ（mm）。stock.thickness 以下でなければならない（意味検証層）。",
  "groove.end": "through（通し）または stopped（止め、止めの場合 from/to を追加）。",
  "groove.from":
    "end: stopped の場合のみ使用する、走行軸上の絶対座標（mm）の開始側。" +
    "across では下端からの Y 座標、along では左端からの X 座標とし、" +
    "0 ≤ from < to ≤ 走行軸の面寸法（across は実効幅、along は部材長）を満たす。" +
    "end: through への from/to 併記はエラー。",
  "groove.to":
    "end: stopped の場合のみ使用する、走行軸上の絶対座標（mm）の終了側。" +
    "across では下端からの Y 座標、along では左端からの X 座標とし、" +
    "0 ≤ from < to ≤ 走行軸の面寸法（across は実効幅、along は部材長）を満たす。" +
    "end: through への from/to 併記はエラー。",
  "hole.face": "加工面。front または back。",
  "hole.x": "部材ローカル座標系での中心 X 座標（mm）。",
  "hole.y": "部材ローカル座標系での中心 Y 座標（mm）。",
  "hole.dia": "径（mm）。",
  "hole.depth": "深さ（mm）。省略時は貫通を表す。",
  assemblies:
    "構成グルーピング（任意区画）。「どの形状の部材が何個でひと組か」の宣言と、" +
    "取り付けシロ（marks）を置く。割付は導出後の合計数だけを見るため、" +
    "構成の区別が木取り図・歩留まりに影響することはない。",
  "assemblies.id":
    "構成 ID。マークを持つ形状の変種面ファイル名（<stem>.out/parts/{assembly}-{形状id}.svg）" +
    "に使われるため、英数字で始まり英数字・「.」「_」「-」のみ使用できる。",
  "assemblies.label": '表示ラベル（例: "ウマ1号機"）。省略可。',
  "assemblies.contains":
    "形状 id → 個数（1以上の整数）のマップ。部材必要数は全 assembly の合計から" +
    "導出され、parts[].qty は省略できる。同一形状は構成をまたいでまとめて割り付けられる。",
  "assemblies.marks":
    "取り付けシロ（非切削マーク）の配列。相手部材が当たる領域を示すだけで切削は伴わない。" +
    "描画は加工指示図のみ（木取り図には描かない）。割付エンジンには一切影響しない" +
    "（材を消費せず、kerf・歩留まり計算にも入らない）。",
  "marks.on":
    "マークを付ける対象形状（parts[].id）。その構成の contains に含まれる形状でなければならない。",
  "marks.face":
    "加工面。front は木表・木裏を区別しない幅広の加工基準面（length × width。" +
    "完成品の世界座標における正面や、樹皮側を意味する木表そのものではない）。" +
    "面内座標系は左下原点・X右・Y上で、X は length 方向、Y は width 方向。" +
    "front は実線、back はその対向面を front の加工指示図カード上に破線" +
    "（隠れ線規約）で投影して描画する。",
  "marks.x":
    "マーク領域の左下角（部材ローカル原点側の角）の X 座標（mm）。省略時 0。" +
    '数値の代わりに端揃えエイリアス "left"（0）/ "right"（part.length − w。w は' +
    'rot 適用後の値）/ "center"（矩形領域では (part.length − w) / 2。w は rot 適用後' +
    "の値。領域全体を中央に揃えるための解決規則であり、軸長の 1/2 ではないことに" +
    "注意）も指定できる。解決順序は ref 導出 → rot 適用 → x/y のエイリアス解決" +
    "（このエイリアスが参照する w は rot 適用後の値）。" +
    "hole の x（中心基準）とは基準が異なるので注意すること。",
  "marks.y":
    "マーク領域の左下角（部材ローカル原点側の角）の Y 座標（mm）。省略時 0。" +
    '数値の代わりに端揃えエイリアス "bottom"（0）/ "top"（実効幅 − h。h は' +
    'rot 適用後の値）/ "center"（矩形領域では (実効幅 − h) / 2。h は rot 適用後の値。' +
    "領域全体を中央に揃えるための解決規則であり、軸長の 1/2 ではないことに注意）も" +
    "指定できる。解決順序は ref 導出 → rot 適用 → x/y のエイリアス解決" +
    "（このエイリアスが参照する h は rot 適用後の値）。" +
    "hole の y（中心基準）とは基準が異なるので注意すること。",
  "marks.w":
    "マーク領域の幅（mm、X 方向）。h とセットで指定する。ref とは排他" +
    "（併記も、ref・w/h ともに無いのも error）。rot: 90 を指定すると h と入れ替わる" +
    "（rot は w/h 直接指定にも一様に適用される）。",
  "marks.h":
    "マーク領域の高さ（mm、Y 方向）。w とセットで指定する。ref とは排他" +
    "（併記も、ref・w/h ともに無いのも error）。rot: 90 を指定すると w と入れ替わる" +
    "（rot は w/h 直接指定にも一様に適用される）。",
  "marks.ref":
    "相手形状（parts[].id）の木口寸法（width × thickness）から領域寸法を導出する。" +
    "w = 相手形状が使う原材の thickness、h = 相手形状の実効幅（bar なら原材幅、" +
    "sheet なら part.width）（例: ref: leg → 2×4 の木口 38×89（w×h））。" +
    "参照先の寸法変更に自動追従する。" +
    "w/h とは排他（併記は error）。相手部材を 90° 倒して当てる場合は rot: 90 を" +
    "指定する（w/h の直接指定に頼らなくてよい。rot は当たり面の面内回転として" +
    "w/h 直接指定にも一様に適用されるため、面ごとに導出値を変える特別扱いは不要）。",
  "marks.rot":
    "当たり面の面内回転。0（既定）または 90。ref 導出時に断面の幅・厚みを w/h の" +
    "どちらに割り当てるかを確定するほか、w/h 直接指定にも一様に適用される" +
    "（90 なら w/h が入れ替わる）。解決順序は ref 導出 → rot 適用 → x/y の端揃え" +
    "エイリアス解決であり、エイリアスが参照する w/h は rot 適用後の値。矩形領域では" +
    "180/270 は 0/90 と同値のため 2 値で足りる。",
  "marks.note": '図に添える注記（例: "足当たり面"）。省略可。',
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

/**
 * marks[] の1要素（SPECS.md §4c）。
 *
 * 領域寸法の指定は `ref`（相手形状の断面寸法から導出）と `w`/`h`（直接指定）の
 * **排他**であり、`additionalProperties: false` を持つ2形式の `oneOf` で表現する
 * （併記は一致0件になり、エディタ上でも即座に赤線になる）。
 * 排他規則の権威は層2（意味検証）にある（parts[].stock の enum と
 * checkStockReferences の関係と同じ役割分担）。
 */
function markSchema(): Record<string, unknown> {
  const common = {
    on: { type: "string", description: DESCRIPTIONS["marks.on"] },
    face: { enum: ["front", "back"], description: DESCRIPTIONS["marks.face"] },
    x: {
      default: 0,
      description: DESCRIPTIONS["marks.x"],
      oneOf: [{ type: "number", minimum: 0 }, { enum: ["left", "right", "center"] }],
    },
    y: {
      default: 0,
      description: DESCRIPTIONS["marks.y"],
      oneOf: [{ type: "number", minimum: 0 }, { enum: ["bottom", "top", "center"] }],
    },
    rot: {
      enum: [0, 90],
      default: 0,
      description: DESCRIPTIONS["marks.rot"],
    },
    note: { type: "string", description: DESCRIPTIONS["marks.note"] },
  };
  return {
    title: "取り付けシロ（ref で断面寸法を導出、または w・h を直接指定）",
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["on", "face", "ref"],
        properties: {
          ...common,
          ref: { type: "string", description: DESCRIPTIONS["marks.ref"] },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        // w/h を required にしない: 「ref も w/h も無い（領域寸法が決まらない）」は
        // 層2（意味検証）が具体的なメッセージで error にする。ここで required に
        // すると層1の oneOf 不一致で潰れ、層2の診断に到達しなくなる。
        required: ["on", "face"],
        properties: {
          ...common,
          w: {
            type: "number",
            exclusiveMinimum: 0,
            description: DESCRIPTIONS["marks.w"],
          },
          h: {
            type: "number",
            exclusiveMinimum: 0,
            description: DESCRIPTIONS["marks.h"],
          },
        },
      },
    ],
  };
}

/** assemblies[] の1要素（SPECS.md §4c）。 */
function assemblySchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["id", "contains"],
    properties: {
      id: {
        type: "string",
        pattern: ID_PATTERN,
        description: DESCRIPTIONS["assemblies.id"],
      },
      label: { type: "string", description: DESCRIPTIONS["assemblies.label"] },
      contains: {
        type: "object",
        description: DESCRIPTIONS["assemblies.contains"],
        // 形状 id は任意の文字列キーなので、値の型だけを additionalProperties で縛る。
        additionalProperties: { type: "integer", minimum: 1 },
      },
      marks: {
        type: "array",
        default: [],
        description: DESCRIPTIONS["assemblies.marks"],
        items: markSchema(),
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
      // preset にパターン制約は課さない: マスタキーの命名体系は SPECS §8 で未確定であり、
      // いま文字種を固定すると移行負債になる（ビルドは値を解釈しない）。
      preset: {
        type: "string",
        minLength: 1,
        description: DESCRIPTIONS["stocks.preset"],
      },
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
  // enum: [] は全入力を弾くため禁止（SPECS.md §4b）。空なら type: string のみ。
  if (stockIds.length > 0) {
    stockProp.enum = [...stockIds];
  }

  return {
    type: "object",
    additionalProperties: false,
    // qty は必須ではない: assemblies の contains 合計から導出できるため（§4c）。
    // 「導出もできず明記も無い」場合の error は意味検証層（loader）が出す。
    required: ["id", "label", "stock", "length"],
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
        items: {
          title: "加工フィーチャ（溝 groove / 丸穴 hole）",
          oneOf: [grooveSchema(), holeSchema()],
        },
      },
    },
  };
}

/**
 * kidori ファイル（正本）の JSON Schema（Draft 2020-12）を組み立てて返す。
 *
 * @param stockIds その時点で読み取れた stocks[].id の一覧（stocksFile 参照先の
 *   id を含めてよい）。parts[].stock の enum 動的注入に使う（SPECS.md §4b）。
 *   空配列なら enum を付与しない（enum: [] は全入力を弾いてしまうため）。
 * @returns JSON Schema（プレーンオブジェクト）。additionalProperties: false を
 *   全階層で強制する。
 */
export function buildSchema(stockIds: readonly string[]): Record<string, unknown> {
  return {
    $schema: DRAFT_2020_12,
    title: "kidori project",
    description:
      "kidori ファイル（*.kidori.yaml / *.kidori.json 等）のスキーマ。" +
      "拡張はファイルごとにメモリ上で合成して供給し、kidori init は動的 enum なしの" +
      "基底スキーマを kidori.schema.json として書き出す（SPECS.md §3a・§4b）。",
    type: "object",
    additionalProperties: false,
    required: ["meta", "stocks", "parts"],
    properties: {
      stocksFile: {
        type: "string",
        minLength: 1,
        description: DESCRIPTIONS["stocksFile"],
      },
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
      assemblies: {
        type: "array",
        description: DESCRIPTIONS["assemblies"],
        items: assemblySchema(),
      },
    },
  };
}

/**
 * `stocksFile:` の参照先ファイルのスキーマ（SPECS.md §4）。
 *
 * 参照先はトップレベル `stocks:` リストのみを持つ**単段**のファイルであり、
 * 正本のエントリと同一形（stockSchema）を使う。`additionalProperties: false` に
 * より多段参照（参照先の `stocksFile:`）も構造的に弾かれる
 * （loader は専用のエラーメッセージを出すため、その前に自前で検出する）。
 */
export function buildStocksFileSchema(): Record<string, unknown> {
  return {
    $schema: DRAFT_2020_12,
    title: "kidori stocks file",
    description:
      "kidori の外部 stocks ファイル（stocksFile: の参照先。SPECS.md §4）。",
    type: "object",
    additionalProperties: false,
    required: ["stocks"],
    properties: {
      stocks: {
        type: "array",
        items: stockSchema(),
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
 * 基底スキーマ（動的 enum なし）の JSON 文字列表現（SPECS.md §3a・§4b）。
 *
 * ビルド時のディスク再生成は v0.6 で廃止された。この文字列を使うのは
 * `kidori init` による `kidori.schema.json` の書き出しと、VS Code 外の環境向けの
 * モードライン参照だけである。
 */
export function baseSchemaJson(): string {
  return schemaJson([]);
}

/**
 * ディレクトリ直下に基底スキーマ `kidori.schema.json` を書き出す（`kidori init` 用）。
 *
 * 動的 enum（parts[].stock）は含めない。ファイルごとの enum 合成は拡張層が
 * メモリ上で行う（SPECS.md §4b）。
 *
 * @param dir 書き出し先ディレクトリ。
 * @returns 書き出した kidori.schema.json の絶対パス（dir が相対なら dir 基準）。
 */
export function writeBaseSchema(dir: string): string {
  const schemaPath = join(dir, BASE_SCHEMA_FILENAME);
  writeFileSync(schemaPath, baseSchemaJson(), "utf-8");
  return schemaPath;
}
