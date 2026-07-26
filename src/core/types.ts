/**
 * kidori の正本データモデル（内部表現）。
 *
 * kidori ファイル（*.kidori.yaml / *.kidori.json 等。SPECS.md §3）を読み込み・
 * 検証した後の内部データモデルを定義する。
 * 読込後は不変として扱う（build 処理中に変更しない）。
 *
 * 単位は mm 固定。部材ローカル座標系は左下原点・X 右・Y 上（SPECS.md §4a）。
 * YAML キーはキャメルケースのまま TypeScript プロパティ名に対応させる。
 */

/** 正本の meta 区画。 */
export interface Meta {
  /** プロジェクト名（例: "書棚"）。 */
  project: string;
  /** 単位。v1 では "mm" 固定（他値は loader が意味検証で error にする）。 */
  units: "mm";
  /** 正本のスキーマバージョン表記（YAML キー schemaVersion）。 */
  schemaVersion: string;
}

/** 推奨案ランキングの評価キー（SPECS.md §5）。 */
export type RankKey = "cost" | "waste" | "cuts";

/** 厳密探索モード（SPECS.md §4・§5）。 */
export type ExactMode = "auto" | "on" | "off";

/** 正本の settings 区画。割付・出力の全体設定。 */
export interface Settings {
  /** 鋸刃厚（mm）。割付時に切断ごとに消費される。デフォルト 3。 */
  kerf: number;
  /** 原材の端の捨て代（mm）。デフォルト 5。 */
  edgeTrim: number;
  /** 生成する割付候補数。1〜3 にクランプする。デフォルト 3。 */
  candidates: number;
  /**
   * 推奨案の評価優先順。デフォルト ["cost", "waste", "cuts"]
   * （概算費用 → 歩留まり → カット回数）。
   */
  rank: RankKey[];
  /**
   * 厳密探索モード。"auto"（既定）は部材数が小さいとき（目安 15 以下）のみ
   * 全探索（分枝限定）を実行し、真に最適な構成を候補 X として加える。
   */
  exact: ExactMode;
  /** 採用した案の ID（"A"/"B"/"C"/"X"）。null の間は全案を出力する。 */
  selectedPlan: string | null;
}

/** stocks[] の1要素。原材（規格材）マスタの定義。 */
export interface Stock {
  /** 原材 ID。parts[].stock から参照される。 */
  id: string;
  /**
   * 規格材マスタ側のキー（来歴メタデータ。任意。SPECS.md §4）。
   * 補完確定時に自動挿入される。**ビルドは preset を一切解決しない**
   * （実値フィールドは preset があっても全て必須のまま＝正本の自己完結性）。
   */
  preset?: string;
  /** 表示ラベル（例: "1×4材 6F"）。 */
  label: string;
  /** "bar"（1D割付・長さのみ使用）または "sheet"（2D割付・長さ×幅を使用）。 */
  kind: "bar" | "sheet";
  /** 原材の長さ（mm）。 */
  length: number;
  /** 原材の幅（mm）。bar の場合は部材の実効幅として使われる。 */
  width: number;
  /** 原材の厚み（mm）。 */
  thickness: number;
  /** 単価（円）。省略時は null（費用計算では price 欠落として扱う）。 */
  price: number | null;
}

/** 部材の加工フィーチャ: 溝。 */
export interface Groove {
  type: "groove";
  /** 加工面。"front" は実線＋薄塗り、"back" は破線（隠れ線規約）で描画される。 */
  face: "front" | "back";
  /** 溝の走行方向。"across"（幅方向）または "along"（長さ方向）。 */
  dir: "across" | "along";
  /** 基準端から溝中心までの距離（mm）。寸法線抽出でも中心基準として扱う。 */
  pos: number;
  /** 溝幅（mm）。 */
  width: number;
  /** 溝深さ（mm）。stock.thickness 以下でなければならない（意味検証層）。 */
  depth: number;
  /** "through"（通し）または "stopped"（止め）。 */
  end: "through" | "stopped";
  /**
   * end="stopped" の場合のみ使用する、走行方向の開始座標（mm）。
   * end="through" では null でなければならない。YAML キーは "from"。
   */
  from: number | null;
  /** end="stopped" の場合のみ使用する、走行方向の終了座標（mm）。 */
  to: number | null;
}

/** 部材の加工フィーチャ: 丸穴。 */
export interface Hole {
  type: "hole";
  /** 加工面。"front" または "back"。 */
  face: "front" | "back";
  /** 部材ローカル座標系での中心 X 座標（mm）。 */
  x: number;
  /** 部材ローカル座標系での中心 Y 座標（mm）。 */
  y: number;
  /** 径（mm）。 */
  dia: number;
  /** 深さ（mm）。null の場合は貫通を表す。 */
  depth: number | null;
}

/** 部材の加工フィーチャは Groove（溝）または Hole（丸穴）のいずれか。 */
export type Feature = Groove | Hole;

/** parts[] の1要素。切り出す部材の定義（1エントリ＝1形状 × qty 個）。 */
export interface Part {
  /**
   * 部材 ID。出力ファイル名（<stem>.out/parts/{id}.svg）に使われるため、
   * `^[A-Za-z0-9][A-Za-z0-9._-]*$` に一致しなければならない（意味検証層で担保。
   * パストラバーサル・OS 予約名は error）。
   */
  id: string;
  /** 表示ラベル。 */
  label: string;
  /**
   * 必要数量。正本では `assemblies` を使う場合に省略でき、その場合は全構成の
   * `contains` 合計から導出される（SPECS.md §4c）。**このモデルの上では常に
   * 確定した数値**であり、下流（割付エンジン・描画）は無条件に読んでよい
   * （導出できない場合は loader が error を出し Project が組み上がらない）。
   */
  qty: number;
  /** 使用する原材の id 参照。 */
  stock: string;
  /** 部材の長さ（mm）。 */
  length: number;
  /**
   * 部材の幅（mm）。bar 部材では省略可（省略時、または指定時も stock.width と
   * 同値のみ許容）。sheet 部材では必須（意味検証層で担保）。
   */
  width: number | null;
  /** 2D割付時の90°回転可否。デフォルト true。bar 部材では意味を持たない。 */
  rot: boolean;
  /** 加工フィーチャ（Groove/Hole）の配列。 */
  features: Feature[];
}

/**
 * assemblies[].marks[] の1要素（正本に書かれたままの形。SPECS.md §4c）。
 *
 * 非切削マーク（取り付けシロ）。相手部材が当たる領域を加工指示図にだけ描く。
 * 割付エンジンには一切影響しない（材を消費せず、kerf・歩留まりにも入らない）。
 *
 * 領域寸法の指定は排他の2形式（意味検証層で担保）:
 * - `ref`: 相手形状の断面寸法（w=厚み・h=実効幅）から導出する（`resolveMark`）。
 * - `w`/`h`: 直接指定する。
 */
export interface Mark {
  /** マークを付ける対象形状（parts[].id）。その assembly の contains に含まれること。 */
  on: string;
  /** 加工面。"front" または "back"。 */
  face: "front" | "back";
  /**
   * 領域の左下角（部材ローカル原点側の角）の X 座標（mm）。省略時 0。
   * 数値の代わりに端揃えエイリアス `"left"`（0）/`"right"`（`part.length - w`。
   * `w` は `rot` 適用後）/`"center"`（`(part.length - w) / 2`。矩形領域を中央に
   * 揃えるための解決規則であり「軸長の 1/2」ではない）を指定できる
   * （`resolveMark` が解決する）。
   */
  x: number | "left" | "right" | "center";
  /**
   * 領域の左下角（部材ローカル原点側の角）の Y 座標（mm）。省略時 0。
   * 数値の代わりに端揃えエイリアス `"bottom"`（0）/`"top"`（`effectiveWidth - h`。
   * `h` は `rot` 適用後）/`"center"`（`(effectiveWidth - h) / 2`。矩形領域を中央に
   * 揃えるための解決規則であり「軸長の 1/2」ではない）を指定できる
   * （`resolveMark` が解決する）。
   */
  y: number | "bottom" | "top" | "center";
  /** 領域の幅（mm、X 方向）。`ref` 指定時は null。 */
  w: number | null;
  /** 領域の高さ（mm、Y 方向）。`ref` 指定時は null。 */
  h: number | null;
  /** 断面寸法の導出元となる相手形状（parts[].id）。`w`/`h` と排他。 */
  ref: string | null;
  /**
   * 当たり面の面内回転。`0`（既定）または `90`。`ref` 導出時に断面の幅・厚みを
   * w/h のどちらに割り当てるかを確定するほか、`w`/`h` 直接指定にも一様に適用される
   * （swap する）。これは「当たり面の面内回転」というマーク自身の性質として定義
   * されているため、寸法の指定方法によって同じ `rot: 90` が別の意味にならないための
   * 実装判断（SPECS.md §4c は ref 導出への言及に留まる）。
   */
  rot: 0 | 90;
  /** 図に添える注記（例: "足当たり面"）。省略時は null。 */
  note: string | null;
}

/**
 * `ref`・`rot`・端揃えエイリアス（`x`/`y`）をすべて解決し、領域寸法・位置が
 * 確定した Mark（描画層が受け取る形）。
 *
 * `resolveMarks`（marks.ts）が Mark から生成する。描画層は x/y/w/h が数値である
 * ことを無条件に前提にしてよい。**`w`/`h` は `rot` 適用後の値**（`rot: 90` なら
 * `ref` 導出値・直接指定値のどちらであっても幅と厚みが入れ替わっている）。
 * `x`/`y` も端揃えエイリアス解決後の数値であり、その解決はこの `rot` 適用後の
 * `w`/`h` を使って行われている（解決順序: `ref` 導出 → `rot` 適用 → エイリアス解決）。
 */
export interface ResolvedMark {
  /** マークを付ける対象形状（parts[].id）。 */
  on: string;
  /** 加工面。"front" または "back"。 */
  face: "front" | "back";
  /** 領域の左下角の X 座標（mm）。エイリアス解決後の値。 */
  x: number;
  /** 領域の左下角の Y 座標（mm）。エイリアス解決後の値。 */
  y: number;
  /** 領域の幅（mm、X 方向）。`rot` 適用後の値。 */
  w: number;
  /** 領域の高さ（mm、Y 方向）。`rot` 適用後の値。 */
  h: number;
  /** 当たり面の面内回転。`0` または `90`。追跡可能性のため解決後も保持する。 */
  rot: 0 | 90;
  /** 寸法の導出元（`ref` 指定だった場合の形状 id。直接指定なら null）。 */
  ref: string | null;
  /** 図に添える注記。無ければ null。 */
  note: string | null;
}

/** assemblies[] の1要素。構成グルーピングと取り付けシロ（SPECS.md §4c）。 */
export interface Assembly {
  /**
   * 構成 ID。変種面の出力ファイル名（parts/{assembly}-{形状id}.svg）に
   * 使われるため、parts[].id と同じ ID 安全性検査を受ける（意味検証層）。
   */
  id: string;
  /** 表示ラベル（例: "ウマ1号機"）。省略時は null。 */
  label: string | null;
  /** 形状 id → 個数のマップ。部材必要数はこの合計から導出される（§4c）。 */
  contains: Record<string, number>;
  /** 取り付けシロ（非切削マーク）の配列。 */
  marks: Mark[];
}

/** 正本ファイル読込・検証後のトップレベルモデル。 */
export interface Project {
  meta: Meta;
  settings: Settings;
  stocks: Stock[];
  parts: Part[];
  /** 構成グルーピング（任意区画。区画不在なら空配列。SPECS.md §4c）。 */
  assemblies: Assembly[];
}

/** settings.rank のデフォルト値。 */
export const DEFAULT_RANK: RankKey[] = ["cost", "waste", "cuts"];

/**
 * 割付・描画で使う部材の実効幅を返す。
 *
 * - stock.kind === "sheet": part.width をそのまま返す（sheet 部材は width 必須）。
 * - stock.kind === "bar": stock.width を返す。
 *
 * sheet 部材で part.width が null の場合は例外を投げる
 * （意味検証層を経ていない不整合な入力）。
 */
export function effectiveWidth(part: Part, stock: Stock): number {
  if (stock.kind === "bar") {
    return stock.width;
  }
  if (part.width === null) {
    throw new Error(
      `sheet 部材 '${part.id}' には width が必須です` +
        "（意味検証層を経ていない入力の可能性があります）",
    );
  }
  return part.width;
}
