/**
 * 寸法ミニ式の字句・文法・評価エンジン（SPECS.md §4d「寸法エイリアス・名前付き設計値・
 * ミニ式」）。
 *
 * 単位: U-EXPR（式解決器コア）。後続ユニット（U-PIPE: loader 統合／スキーマ union、
 * U-HINT: `Issue.severity` への hint 配線、拡張のホバー）の土台となる、依存の少ない
 * 純粋なエンジンを提供する。**Project・loader・schema・errors.ts のいずれにも依存しない**
 * （D7）。`Project` は解決後もすべて `number` のまま（D1）であり、このモジュールは
 * 「原式 → 解決値」の対応表（`ResolutionTrace`）を副産物として返すことで、
 * 導出過程を正本に残すという意図（SPECS.md §4d 冒頭）を支える。
 *
 * 式は2種類（SPECS.md §4d:240-242）:
 *   - 文脈非依存式: 数値リテラル・`$vars` 参照・`+`/`-` のみ。
 *   - 位置式: 文脈非依存式に、対象軸の揃えエイリアスを加えたもの。初回実装では
 *     `marks[].x`/`marks[].y` のみに限定する。
 *
 * 文脈非依存式か位置式かは**型ではなく実行時**に、単一のフィールド能力テーブル
 * （{@link fieldExprCapability}）で判定する（D3）。
 */

// ---------------------------------------------------------------------------
// 微小許容差
// ---------------------------------------------------------------------------

/**
 * 等値・範囲比較に用いる微小許容差（SPECS.md §4d:260「実装で定めた微小許容差」）。
 *
 * `src/core/packing/common.ts` の `EPS = 1e-9`（同ファイル18行「浮動小数の等号成立
 * 判定は EPS = 1e-9 で許容する」）と同じ値に揃える。ただし依存の少ないエンジンに
 * するため（このファイルは Project 関連モジュールに一切依存しない）、import はせず
 * 同値を独立定義する。エンジン自体は加減算のみで比較を行わないため内部では未使用だが、
 * 評価結果を用いて意味検証（負値・範囲チェック等、D4 により U-PIPE の担当）を行う
 * 下流のための公開定数として export する。
 */
export const EPS = 1e-9;

// ---------------------------------------------------------------------------
// 診断（D7: Issue に依存しない自前の型。hint を表現できる）
// ---------------------------------------------------------------------------

/** このモジュールが返す診断の重大度。`Issue.severity`（"error"|"warning"）と異なり
 * "hint" を持つ（未使用変数用。D7）。"error"|"warning" への写像は U-PIPE/U-HINT が行う。
 */
export type ExprSeverity = "error" | "hint";

/**
 * 式解決で検出された1件の問題。
 *
 * `path` は D2 の方針により `formatJsonPath`（`src/core/loader.ts:157-167`）と
 * 同じ文法（`ident(.ident|[int])*`）に厳密に一致させる。`vars.<名前>` も
 * ドット・角括弧を含み得ない（変数名は `[A-Za-z_][A-Za-z0-9_]*` に制限されるため）
 * ので path に載せて安全（D2）。ただし字句規則に違反する変数名それ自体は
 * path に載せず、`"vars"`（区画名のみ）を使う。
 */
export interface ExprDiagnostic {
  path: string;
  message: string;
  severity: ExprSeverity;
}

// ---------------------------------------------------------------------------
// AST（D4: 字句・文法）
// ---------------------------------------------------------------------------

/** X 軸の揃えエイリアス（SPECS.md §4d:254）。 */
export type XAlignAlias = "left" | "center" | "right";
/** Y 軸の揃えエイリアス（SPECS.md §4d:255）。 */
export type YAlignAlias = "bottom" | "center" | "top";
/** 揃えエイリアス全体（軸を問わない字句上の集合）。 */
export type AlignAlias = XAlignAlias | YAlignAlias;

const X_ALIASES: ReadonlySet<AlignAlias> = new Set<AlignAlias>(["left", "center", "right"]);
const Y_ALIASES: ReadonlySet<AlignAlias> = new Set<AlignAlias>(["bottom", "center", "top"]);
/** 字句として認識する揃えエイリアス語の全体集合（軸を区別しない）。 */
const ALIAS_WORDS: ReadonlySet<string> = new Set<string>([...X_ALIASES, ...Y_ALIASES]);

/** 被演算子（SPECS.md §4d:258-261）。 */
export type ExprOperand =
  | { kind: "number"; value: number }
  | { kind: "var"; name: string }
  | { kind: "alias"; name: AlignAlias };

/** 二項演算子。`+`/`-` のみ（D4）。先頭項の `op` は常に `"+"`（符号なしの意味）。 */
export type ExprOp = "+" | "-";

/** `operand ((+ | -) operand)*` の1項（演算子＋被演算子）。 */
export interface ExprTerm {
  op: ExprOp;
  operand: ExprOperand;
}

/** パース済み式（同順位・左結合。SPECS.md §4d:260「左から順に評価」）。 */
export interface ParsedExpr {
  /** パース元の原式文字列（トレース・エラーメッセージ用）。 */
  raw: string;
  /** 項の並び（先頭項の `op` は常に `"+"`）。長さは必ず1以上。 */
  terms: ExprTerm[];
}

export type ParseExprResult =
  | { ok: true; expr: ParsedExpr }
  | { ok: false; message: string };

// ---------------------------------------------------------------------------
// パーサ本体
// ---------------------------------------------------------------------------

interface Cursor {
  readonly s: string;
  i: number;
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_]/.test(ch);
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function skipWs(c: Cursor): void {
  while (c.i < c.s.length && /\s/.test(c.s[c.i])) {
    c.i++;
  }
}

/**
 * 数値リテラルを解釈する。`c.i` は解析開始位置（`-` または数字の先頭）を指している。
 *
 * D4（Supervisor 裁定・実装コメントとして記録）: 指数表記（`1e3` 等）は明示的に
 * 拒否する。「有限の10進数（整数・小数）」（SPECS.md §4d:260）という記述に指数表記を
 * 含めるかは SPECS 上未規定だが、(a) 寸法値の記述として指数表記の実用上の必要性が薄い、
 * (b) 単純な字句規則（整数部＋任意の小数部のみ）の方が実装・テストが単純、という
 * 判断で拒否する側に倒した。将来必要になれば緩和は非破壊的な拡張として行える。
 */
function lexNumber(c: Cursor): { value: number } | { error: string } {
  const start = c.i;
  if (c.s[c.i] === "-") {
    c.i++;
  }
  const digitsStart = c.i;
  while (isDigit(c.s[c.i])) {
    c.i++;
  }
  if (c.i === digitsStart) {
    c.i = start;
    return { error: `数値の解析に失敗しました（位置 ${start}）` };
  }
  if (c.s[c.i] === ".") {
    c.i++;
    const fracStart = c.i;
    while (isDigit(c.s[c.i])) {
      c.i++;
    }
    if (c.i === fracStart) {
      return { error: `小数点の後に数字が必要です（位置 ${fracStart}）` };
    }
  }
  if (c.s[c.i] === "e" || c.s[c.i] === "E") {
    return { error: `指数表記（例: "1e3"）は使用できません（位置 ${start}）` };
  }
  const text = c.s.slice(start, c.i);
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { error: `数値が大きすぎるか不正です: '${text}'（位置 ${start}）` };
  }
  return { value };
}

/**
 * 被演算子1個を解析する（数値リテラル／`$vars` 参照／揃えエイリアス語）。
 * どの被演算子かは軸コンテキストに関係なくパース時点で受理する（D3: 文脈適合性は
 * 実行時に判定する。パース時には「揃えエイリアス語として字句上妥当か」だけを見る）。
 */
function parseOperand(c: Cursor): { operand: ExprOperand } | { error: string } {
  skipWs(c);
  if (c.i >= c.s.length) {
    return { error: "被演算子が必要です（式の終端に達しました）" };
  }
  const ch = c.s[c.i];

  if (ch === "-" || isDigit(ch)) {
    const r = lexNumber(c);
    if ("error" in r) {
      return { error: r.error };
    }
    return { operand: { kind: "number", value: r.value } };
  }

  if (ch === "$") {
    c.i++;
    const start = c.i;
    while (isIdentChar(c.s[c.i])) {
      c.i++;
    }
    const name = c.s.slice(start, c.i);
    if (name.length === 0 || !isIdentStart(name[0])) {
      return { error: `不正な変数参照です: '$${name}'（変数名は [A-Za-z_][A-Za-z0-9_]* に一致する必要があります）` };
    }
    if (c.s[c.i] === "." || c.s[c.i] === "[") {
      return {
        error:
          `変数参照 '$${name}' の後にドット・角括弧は使用できません` +
          "（他部材フィールドの直接参照は許可されません。SPECS.md §4d:261）",
      };
    }
    return { operand: { kind: "var", name } };
  }

  if (ch === "(" || ch === ")") {
    return { error: `括弧は使用できません（乗除・括弧は未対応。SPECS.md §4d:261。位置 ${c.i}）` };
  }

  if (isIdentStart(ch)) {
    const start = c.i;
    while (isIdentChar(c.s[c.i])) {
      c.i++;
    }
    const word = c.s.slice(start, c.i);
    if (c.s[c.i] === "(") {
      return { error: `関数呼び出しは使用できません: '${word}(...)'（SPECS.md §4d:261。位置 ${start}）` };
    }
    if (!ALIAS_WORDS.has(word)) {
      return {
        error:
          `不明な識別子です: '${word}'` +
          "（揃えエイリアスとして有効な値は left/center/right/bottom/top のみ）",
      };
    }
    return { operand: { kind: "alias", name: word as AlignAlias } };
  }

  return { error: `予期しない文字です: '${ch}'（位置 ${c.i}）` };
}

/**
 * ミニ式の文字列をパースする（SPECS.md §4d:258-261）。
 *
 * 文法: `operand ((+ | -) operand)*`。空白は演算子の前後で任意。
 * 文脈非依存式か位置式かはここでは判定しない（D3）。揃えエイリアス語（このパーサが
 * 受理するのは字句上の5語のみ）が実際にどの軸で有効かは {@link evaluateExpr} が
 * 実行時に判定する。
 */
export function parseExpr(raw: string): ParseExprResult {
  const c: Cursor = { s: raw, i: 0 };
  skipWs(c);
  if (c.i >= c.s.length) {
    return { ok: false, message: "式が空です" };
  }

  const first = parseOperand(c);
  if ("error" in first) {
    return { ok: false, message: first.error };
  }
  const terms: ExprTerm[] = [{ op: "+", operand: first.operand }];

  for (;;) {
    skipWs(c);
    if (c.i >= c.s.length) {
      break;
    }
    const opCh = c.s[c.i];
    if (opCh !== "+" && opCh !== "-") {
      return {
        ok: false,
        message: `予期しないトークンです: '${opCh}'（演算子は + / - のみ使用できます。位置 ${c.i}）`,
      };
    }
    c.i++;
    const operand = parseOperand(c);
    if ("error" in operand) {
      return { ok: false, message: operand.error };
    }
    terms.push({ op: opCh, operand: operand.operand });
  }

  return { ok: true, expr: { raw, terms } };
}

// ---------------------------------------------------------------------------
// フィールド能力テーブル（D3: SPECS.md §4d:244-245 の完全列挙の単一ソース）
// ---------------------------------------------------------------------------

/** 位置式の軸（marks の x/y のみ。SPECS.md §4d:242,245）。 */
export type ExprAxis = "x" | "y";

/** 1フィールドの式受け入れ能力。 */
export type ExprFieldCapability =
  | { readonly kind: "context-free" }
  | { readonly kind: "positional"; readonly axis: ExprAxis };

/**
 * フィールド path パターン → 式可否＋エイリアス軸の単一テーブル（D3）。
 *
 * SPECS.md §4d:244「文脈非依存式を受け付けるフィールド（完全列挙）」・245
 * 「位置式（marks[].x、marks[].y のみ）」を**逐語的に転写**したもの。
 *
 * path パターンは D2 に従い `formatJsonPath`（`src/core/loader.ts:157-167`）が
 * 生成する実 path から配列添字を `[]` に正規化した形（{@link toFieldExprPattern}）。
 * `vars.*` のみ特別扱い（変数名は可変のため）。
 *
 * `groove`/`hole` は `parts[].features[]`（判別共用体の配列）に格納されるため、
 * 実 path は `parts[].features[].pos` のような形になる（`groove`固有:
 * pos/width/from/to、`hole`固有: x/y/dia、共通: depth）。`hole.x`/`hole.y` は
 * SPECS.md §4d:242「穴・溝では中心と外形のどちらを揃えるかが異なり得るため、
 * `hole.x`/`hole.y`・`groove.pos` には揃えエイリアスを許可しない」により
 * **`context-free`**（`marks[].x`/`marks[].y` の `positional` とは異なる）。
 *
 * `parts[].thickness` は SPECS.md §4d:244 に「既存スキーマにフィールドがある場合の
 * み同様に扱い、本仕様によって新設しない」とあるが、`src/core/types.ts` の `Part`
 * インタフェース（117-146行）には `thickness` フィールドが存在しない
 * （`length`/`width`/`qty`/`stock`/`rot`/`features` のみ）ため、本テーブルには
 * **含めない**（存在しないフィールドを式対応と偽らない）。
 *
 * SPECS.md §4d:246 が挙げるリテラル限定の例（`stocks[].price`、`parts[].qty`、
 * `assemblies[].contains` の個数、`settings.candidates`、`rot`、ID・ラベル・enum・
 * `selectedPlan`）は「上記（244・245）以外は式不可」という**既定の拒否**で表現され、
 * このテーブルには**含めない**（244・245 の完全列挙のみを転写する。246 は例示であり
 * 完全列挙ではないため、テーブルに含めると「244/245 と完全一致すること」を検証する
 * テストの意図がぼやける）。
 */
export const EXPR_FIELD_CAPABILITIES: Readonly<Record<string, ExprFieldCapability>> = {
  "vars.*": { kind: "context-free" },
  "settings.kerf": { kind: "context-free" },
  "settings.edgeTrim": { kind: "context-free" },
  "stocks[].length": { kind: "context-free" },
  "stocks[].width": { kind: "context-free" },
  "stocks[].thickness": { kind: "context-free" },
  "parts[].length": { kind: "context-free" },
  "parts[].width": { kind: "context-free" },
  "parts[].features[].pos": { kind: "context-free" }, // groove.pos
  "parts[].features[].width": { kind: "context-free" }, // groove.width
  "parts[].features[].depth": { kind: "context-free" }, // groove.depth / hole.depth
  "parts[].features[].from": { kind: "context-free" }, // groove.from
  "parts[].features[].to": { kind: "context-free" }, // groove.to
  "parts[].features[].x": { kind: "context-free" }, // hole.x（エイリアス不可）
  "parts[].features[].y": { kind: "context-free" }, // hole.y（エイリアス不可）
  "parts[].features[].dia": { kind: "context-free" }, // hole.dia
  "assemblies[].marks[].x": { kind: "positional", axis: "x" },
  "assemblies[].marks[].y": { kind: "positional", axis: "y" },
  "assemblies[].marks[].w": { kind: "context-free" },
  "assemblies[].marks[].h": { kind: "context-free" },
};

/**
 * 実 path（`formatJsonPath` 形式、例: `"parts[2].features[0].pos"`）を
 * {@link EXPR_FIELD_CAPABILITIES} のキー形式に正規化する。
 *
 * - `vars.<名前>` は `"vars.*"` に正規化する（変数名は可変のため）。
 * - それ以外は配列添字 `[n]` を `[]` に正規化する。
 */
export function toFieldExprPattern(path: string): string {
  if (/^vars\.[A-Za-z_][A-Za-z0-9_]*$/.test(path)) {
    return "vars.*";
  }
  return path.replace(/\[\d+\]/g, "[]");
}

/**
 * 指定した実 path のフィールドが式を受け付けるか、受け付けるならどの能力かを返す。
 * `undefined` は「テーブルに存在しない＝式不可・リテラル限定」を意味する
 * （SPECS.md §4d:246「上記以外は式不可」）。
 */
export function fieldExprCapability(path: string): ExprFieldCapability | undefined {
  return EXPR_FIELD_CAPABILITIES[toFieldExprPattern(path)];
}

// ---------------------------------------------------------------------------
// 評価
// ---------------------------------------------------------------------------

/**
 * 位置式の軸コンテキスト（D5）。軸長と w/h は呼び出し側が与える
 * （`ref`/`rot` の解決は U-PIPE の担当。このエンジンは受け取った値をそのまま使う）。
 */
export interface AxisEvalContext {
  /** 対象軸。 */
  axis: ExprAxis;
  /** 対象面の軸長（X 軸なら `part.length`、Y 軸なら実効幅。SPECS.md §4d:256）。 */
  axisSpan: number;
  /** マーク領域の当該軸方向の寸法（`rot` 適用後の `w` または `h`）。 */
  size: number;
}

/** 変数解決済み環境（`$` 抜きの変数名 → 数値）。 */
export type ExprEnv = Readonly<Record<string, number>>;

export type EvaluateExprResult = { ok: true; value: number } | { ok: false; message: string };

function resolveAliasValue(alias: AlignAlias, axisSpan: number, size: number): number {
  if (alias === "left" || alias === "bottom") {
    return 0;
  }
  if (alias === "right" || alias === "top") {
    return axisSpan - size;
  }
  return (axisSpan - size) / 2; // "center"
}

/**
 * パース済み式を1つ評価する。
 *
 * - `axis` 省略時（文脈非依存式としての評価）: 被演算子に揃えエイリアスが
 *   含まれていれば必ずエラー（D3・D5。`vars`・`hole.x`・`groove.pos` 等での
 *   使用を拒否するのはここ）。
 * - `axis` 指定時（位置式としての評価）: 揃えエイリアスは指定軸で有効なもの
 *   （X: left/center/right、Y: bottom/center/top）のみ許可し、軸に対応しない
 *   語（例: X 軸で `bottom`）はエラーにする（SPECS.md §4d:253-255）。
 *
 * 左から順に加減算する（同順位・左結合。SPECS.md §4d:260）。
 */
export function evaluateExpr(
  expr: ParsedExpr,
  env: ExprEnv,
  axis?: AxisEvalContext,
): EvaluateExprResult {
  let total = 0;
  for (const term of expr.terms) {
    let v: number;
    switch (term.operand.kind) {
      case "number":
        v = term.operand.value;
        break;
      case "var": {
        const name = term.operand.name;
        if (!Object.prototype.hasOwnProperty.call(env, name)) {
          return { ok: false, message: `未定義の変数です: '$${name}'` };
        }
        v = env[name];
        break;
      }
      case "alias": {
        const alias = term.operand.name;
        if (axis === undefined) {
          return {
            ok: false,
            message: `揃えエイリアス '${alias}' は位置式（marks[].x/marks[].y）でのみ使用できます`,
          };
        }
        const validSet = axis.axis === "x" ? X_ALIASES : Y_ALIASES;
        if (!validSet.has(alias)) {
          const axisLabel = axis.axis === "x" ? "X" : "Y";
          const validWords = axis.axis === "x" ? "left/center/right" : "bottom/center/top";
          return {
            ok: false,
            message: `揃えエイリアス '${alias}' は${axisLabel}軸では使用できません（有効な値: ${validWords}）`,
          };
        }
        v = resolveAliasValue(alias, axis.axisSpan, axis.size);
        break;
      }
    }
    total += term.op === "+" ? v : -v;
  }
  return { ok: true, value: total };
}

// ---------------------------------------------------------------------------
// ResolutionTrace（D1）
// ---------------------------------------------------------------------------

/**
 * 解決の副産物として返す「原式 → 解決値」の対応表（D1）。
 *
 * `Project` はすべて `number` のまま保つ（下流の packing/render/metrics/
 * fingerprint への影響を避けるため。D1 の裁定根拠）。`unit: "mm"` は出力時に
 * 呼び出し側（CLI/拡張）が付与するため、ここには持たせない。
 *
 * key は D2 の path 文法（`formatJsonPath` と同じ）。**式の解決に成功したものだけ**
 * を持ち、失敗は呼び出し側が {@link ExprDiagnostic} から `Issue` を組み立てる。
 */
export type ResolutionTrace = Record<string, { expression: string; value: number }>;

// ---------------------------------------------------------------------------
// 単一フィールドの解決（パース＋評価＋path 付き診断のショートカット）
// ---------------------------------------------------------------------------

export type ResolveFieldExprResult =
  | { ok: true; value: number; trace: { expression: string; value: number } }
  | { ok: false; diagnostics: ExprDiagnostic[] };

/**
 * 1フィールドぶんの式文字列をパース＋評価し、成功時は解決値と trace エントリを、
 * 失敗時は path 付きの {@link ExprDiagnostic} を返す。
 *
 * U-PIPE がパイプライン各段（SPECS.md §4d:262-273 の 3.〜7.）でフィールドごとに
 * 呼び出すことを想定した薄いラッパ（`parseExpr` + `evaluateExpr` の組み合わせを
 * 毎回書かずに済むようにするための便宜 API）。フィールドが位置式（marks[].x/y）
 * かどうかの判定・`axis` 引数の組み立ては呼び出し側が {@link fieldExprCapability}
 * を見て行う。
 */
export function resolveFieldExpr(
  path: string,
  raw: string,
  env: ExprEnv,
  axis?: AxisEvalContext,
): ResolveFieldExprResult {
  const parsed = parseExpr(raw);
  if (!parsed.ok) {
    return { ok: false, diagnostics: [{ path, message: parsed.message, severity: "error" }] };
  }
  const evaluated = evaluateExpr(parsed.expr, env, axis);
  if (!evaluated.ok) {
    return { ok: false, diagnostics: [{ path, message: evaluated.message, severity: "error" }] };
  }
  return {
    ok: true,
    value: evaluated.value,
    trace: { expression: raw, value: evaluated.value },
  };
}

// ---------------------------------------------------------------------------
// vars の依存解決（D6）
// ---------------------------------------------------------------------------

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** {@link resolveVars} の結果。 */
export interface VarsResolution {
  /** 変数名 → 解決済み数値。パース・評価に失敗した変数は含まれない。 */
  values: Record<string, number>;
  /** `vars.<名前>` → 原式・解決値（文字列で宣言された変数のみ。数値直書きは対象外）。 */
  trace: ResolutionTrace;
  /** error（構文・未定義参照・循環参照・不正な変数名） / hint（未使用変数）。 */
  diagnostics: ExprDiagnostic[];
}

/**
 * パース済み式が参照する変数名の集合を返す（ネストのないフラットな項リストなので
 * 全項を舐めるだけでよい）。
 *
 * vars 同士の依存グラフ構築（内部使用）に加え、U-PIPE が「vars 以外のフィールド式
 * からの `$var` 参照」も収集して {@link resolveVars} の `usedElsewhere` に渡すための
 * 公開ユーティリティ。未使用変数 hint はこのモジュール単体では vars 区画内の
 * 相互参照しか見えない（他フィールドの式は U-PIPE 側でパースされるため）。
 * 「ファイル全体でどこからも参照されていない」という判定を正しく行うには、
 * U-PIPE が全フィールド式に対して本関数を呼び、その結果の和集合を `usedElsewhere`
 * として渡す必要がある（呼ばなかった場合、vars 同士でのみ参照される変数以外は
 * 誤って「未使用」と hint されうる。これは実装上のスコープ境界であり、報告に明記する）。
 */
export function collectVarRefs(expr: ParsedExpr): Set<string> {
  const refs = new Set<string>();
  for (const term of expr.terms) {
    if (term.operand.kind === "var") {
      refs.add(term.operand.name);
    }
  }
  return refs;
}

/**
 * `vars` 区画を解決する（SPECS.md §4d:257,262-265）。
 *
 * - 変数名は `[A-Za-z_][A-Za-z0-9_]*` に一致しなければならない。不一致は error
 *   （trace には載せない。path は区画名のみの `"vars"`。D2）。
 * - 同名変数の検出について: JSON 入力は `JSON.parse` の時点で重複キーが
 *   silently 上書きされ（実機確認: `JSON.parse('{"a":1,"a":2}')` → `{a:2}`）、
 *   本関数が受け取る時点では既に情報が失われているため検出不能。YAML 入力は
 *   `yaml` パッケージ（`kidorifile.ts` が使用）の既定 `uniqueKeys: true` が
 *   `parse()` の時点で `YAMLParseError` を投げることを実機確認済み
 *   （`yaml.parse("vars:\n  a: 1\n  a: 2\n")` → `Map keys must be unique`）。
 *   したがって「同名変数はエラー」（SPECS.md §4d:259）は YAML では既に上流で
 *   保証されており、JSON では本質的に検出不能（kidori 全体に共通する JSON の
 *   一般的制約であり、本モジュール固有の欠落ではない）。この理由により
 *   `resolveVars` は `Record<string, number | string>` を受け取る単純な形とし、
 *   重複検出は実装しない（詳細は報告参照）。
 * - vars の値は文脈非依存式に限る（`axis` を渡さずに評価する）。位置エイリアスの
 *   使用は error になる（`evaluateExpr` が `axis` 未指定時に揃えエイリアスを
 *   一律拒否することで実現）。
 * - 循環検出付きトポロジカル順で評価する（DFS ベース）。循環に関与する変数は
 *   評価をスキップする（誤って派生した「未定義」diagnostic の重複を避けるため）。
 * - 未使用変数は hint。ただし {@link collectVarRefs} のコメントの通り、vars 内部の
 *   相互参照のみで判定するとフィールド式からの参照を見落とす。`options.usedElsewhere`
 *   に、フィールド式から参照された変数名の集合を渡すことで正しい判定にできる
 *   （渡さない場合は vars 内部参照のみで判定する＝過剰検出の可能性がある）。
 */
export function resolveVars(
  vars: Readonly<Record<string, number | string>>,
  options?: { usedElsewhere?: ReadonlySet<string> },
): VarsResolution {
  const diagnostics: ExprDiagnostic[] = [];
  const trace: ResolutionTrace = {};
  const values: Record<string, number> = {};

  const validNames: string[] = [];
  for (const name of Object.keys(vars)) {
    if (!VAR_NAME_RE.test(name)) {
      diagnostics.push({
        path: "vars",
        message: `変数名 '${name}' は不正です（[A-Za-z_][A-Za-z0-9_]* に一致する必要があります）`,
        severity: "error",
      });
      continue;
    }
    validNames.push(name);
  }

  const parsedByName = new Map<string, ParsedExpr>();
  for (const name of validNames) {
    const raw = vars[name];
    if (typeof raw === "number") {
      parsedByName.set(name, {
        raw: String(raw),
        terms: [{ op: "+", operand: { kind: "number", value: raw } }],
      });
      continue;
    }
    const parsed = parseExpr(raw);
    if (!parsed.ok) {
      diagnostics.push({ path: `vars.${name}`, message: parsed.message, severity: "error" });
      continue;
    }
    parsedByName.set(name, parsed.expr);
  }

  const deps = new Map<string, Set<string>>();
  for (const [name, expr] of parsedByName) {
    deps.set(name, collectVarRefs(expr));
  }

  // 未定義参照の検出（vars として宣言されていない変数の参照）。
  for (const [name, refs] of deps) {
    for (const dep of refs) {
      if (!parsedByName.has(dep) && !validNames.includes(dep)) {
        diagnostics.push({
          path: `vars.${name}`,
          message: `未定義の変数です: '$${dep}'`,
          severity: "error",
        });
      }
    }
  }

  // 循環検出付き DFS トポロジカル順。
  const state = new Map<string, "visiting" | "done">();
  const order: string[] = [];
  const cyclic = new Set<string>();

  function visit(name: string, stack: readonly string[]): void {
    if (state.get(name) === "done") {
      return;
    }
    if (state.get(name) === "visiting") {
      const cycleStart = stack.indexOf(name);
      const cycle = [...stack.slice(cycleStart), name];
      for (const n of cycle) {
        cyclic.add(n);
      }
      diagnostics.push({
        path: `vars.${name}`,
        message: `循環参照が検出されました: ${cycle.join(" → ")}`,
        severity: "error",
      });
      return;
    }
    state.set(name, "visiting");
    for (const dep of deps.get(name) ?? []) {
      if (parsedByName.has(dep)) {
        visit(dep, [...stack, name]);
      }
    }
    state.set(name, "done");
    order.push(name);
  }
  for (const name of parsedByName.keys()) {
    visit(name, []);
  }

  // トポロジカル順に評価する。循環に関与する変数はスキップする（重複診断を避ける）。
  for (const name of order) {
    if (cyclic.has(name)) {
      continue;
    }
    const expr = parsedByName.get(name)!;
    const result = evaluateExpr(expr, values, undefined);
    if (!result.ok) {
      diagnostics.push({ path: `vars.${name}`, message: result.message, severity: "error" });
      continue;
    }
    values[name] = result.value;
    if (typeof vars[name] === "string") {
      trace[`vars.${name}`] = { expression: expr.raw, value: result.value };
    }
  }

  // 未使用変数の hint（SPECS.md §4d:259「未使用変数は hint」）。
  // スコープ境界: vars 内部の相互参照 + options.usedElsewhere（フィールド式からの
  // 参照。呼び出し側が collectVarRefs で集めて渡す）のみを見る。
  for (const name of parsedByName.keys()) {
    const referencedByOtherVar = [...deps.entries()].some(
      ([other, refs]) => other !== name && refs.has(name),
    );
    const referencedElsewhere = options?.usedElsewhere?.has(name) ?? false;
    if (!referencedByOtherVar && !referencedElsewhere) {
      diagnostics.push({
        path: `vars.${name}`,
        message: `変数 '$${name}' はどこからも参照されていません`,
        severity: "hint",
      });
    }
  }

  return { values, trace, diagnostics };
}
