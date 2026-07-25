/**
 * kidori ファイル判定と、Red Hat YAML 拡張への動的スキーマ供給（SPECS.md §3・§4b）。
 *
 * kidori 拡張は redhat.vscode-yaml を依存拡張（extensionDependencies）とし、
 * その registerContributor API へスキーマを供給する。ユーザー側の設定・
 * モードラインは不要（モードラインは VS Code 以外の環境向けの代替手段）。
 * **スキーマファイルのディスク再生成は v0.6 で廃止**され、供給は常に
 * メモリ上の合成で行う（SPECS.md §4b）。
 *
 * 判定（SPECS.md §3「kidori ファイルの判定」）は core の `kidorifile.ts` に
 * 委ねる（命名規約 `*.kidori.{yaml,yml,json}` ＋ 内容判定の両対応）。本モジュールは
 * その結果を **URI ごとにキャッシュ**する役目を持つ:
 *   - 編集途中のパース失敗（`"unknown"`）では**直前の判定を維持**する。
 *     維持しないと、編集のたびにファイルが kidori ファイルでなくなり、
 *     補完・検証が明滅する。
 *   - キャッシュは `update()` でのみ更新し、`requestSchema()`（YAML 拡張からの
 *     問い合わせ）は state が無ければ `undefined` を返す（＝スキーマを供給しない）。
 *     問い合わせの側で state を作ると、未判定のファイルにスキーマが付いてしまう。
 *
 * 動的補完: 編集中のドキュメント内容から `stocks[].id`（＋ `stocksFile:` 参照先の
 * id。SPECS.md §4b が明示要求）を抽出し、`parts[].stock` の enum に埋め込んだ
 * スキーマを都度生成する。スキーマ URI に世代番号を含めることで、id が変わる
 * たびに YAML 拡張へ「別のスキーマになった」と認識させ、ビルドを待たずに
 * 補完・赤線を更新する。
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as vscode from "vscode";
import { parse } from "yaml";

import { classifyKidoriFile, classifyKidoriPath, hasKidoriSuffix } from "../core/kidorifile";
import { extractStockIds, extractStocksFileRef, loadStocksFile } from "../core/loader";
import { schemaJson } from "../core/schema";

const SCHEMA_SCHEME = "kidori";

/**
 * 判定・スキーマ合成に必要な TextDocument の最小面。
 *
 * `vscode.TextDocument` そのものを要求せず構造的に受けることで、拡張ホストの
 * 無い環境（テスト）からも判定ロジックを直接実行できるようにする。
 */
export interface KidoriDocumentLike {
  uri: { fsPath: string };
  getText(): string;
}

/** 内容判定の対象になりうる拡張子か（無関係なファイルをディスクから読まないための前置フィルタ）。 */
const CANDIDATE_EXT_RE = /\.(ya?ml|json)$/i;

/**
 * kidori ファイルでありうるパスか（YAML/JSON のみ）。
 *
 * SPECS.md §3 の判定は命名規約 `*.kidori.{yaml,yml,json}` と、素の
 * `*.yaml` / `*.json` の内容判定の2系統だけであり、いずれも YAML/JSON に閉じる。
 * 編集イベントのたびに無関係なバッファ（.ts など）を YAML としてパースしない
 * ための前置フィルタとして使う。
 */
export function isKidoriCandidatePath(fsPath: string): boolean {
  return hasKidoriSuffix(fsPath) || CANDIDATE_EXT_RE.test(fsPath);
}

/**
 * YAML 拡張・JSON 言語サービスが渡してくる **URI 文字列**を fsPath へ変換する。
 *
 * core の判定関数（`classifyKidoriFile` 等）はファイルシステムパスを期待するため、
 * `file:///...` をそのまま渡してはならない（パーセントエンコードされた日本語
 * ファイル名などで基底名の判定が壊れる）。`file:` 以外のスキーム（untitled: 等）は
 * ディスク上のパスを持たないため null を返し、スキーマ供給の対象外とする。
 *
 * `vscode.Uri.parse` ではなく node の `fileURLToPath` を使うのは、本モジュールを
 * 拡張ホスト非依存に保つため（テストから直接呼べる）。
 */
export function resourceToFsPath(resource: string): string | null {
  if (resource.startsWith("file:")) {
    try {
      return fileURLToPath(resource);
    } catch {
      return null;
    }
  }
  // スキーム無し（すでに fsPath）はそのまま通す。他スキームは対象外。
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(resource) ? null : resource;
}

interface SchemaState {
  /** 直近に確定した kidori ファイル判定（`"unknown"` のときは更新しない）。 */
  isKidori: boolean;
  /** 最後に抽出できた stocks[].id（パース不能時は直前の値を維持する）。 */
  stockIds: string[];
  /** stocks[].id が変わるたびに増える世代番号（スキーマ URI に埋め込む）。 */
  generation: number;
}

/**
 * ドキュメント内容から `parts[].stock` の enum に載せる id 一覧を集める。
 *
 * インラインの `stocks[].id` に加えて `stocksFile:` 参照先の id も含める
 * （SPECS.md §4b「`stocks[].id`（および `stocksFile:` 参照先）の変化のたびに」）。
 * `extractStockIds` は設計上インライン限定なので、参照先は `loadStocksFile` で
 * 別途読む。参照先が壊れている・存在しない場合の診断はビルド側の責務なので、
 * ここでは黙って「インラインだけ」に縮退する（補完が消えるより出過ぎない方を採る）。
 */
function collectStockIds(raw: unknown, fsPath: string): string[] {
  const ids = extractStockIds(raw);
  const ref = extractStocksFileRef(raw);
  if (ref !== null) {
    try {
      const result = loadStocksFile(path.dirname(fsPath), ref);
      for (const stock of result.stocks) {
        ids.push(stock.id);
      }
    } catch {
      // 参照先の読み込み失敗は補完の質の問題にとどめる。
    }
  }
  return [...new Set(ids)];
}

export class SchemaContributor {
  /** キーは **fsPath**（URI 文字列ではない）。 */
  private readonly states = new Map<string, SchemaState>();

  /**
   * ドキュメントを再判定し、kidori ファイルなら stocks[].id を再抽出する。
   *
   * @returns このドキュメントが kidori ファイルか（判定不能かつ前歴無しなら false）。
   */
  update(document: KidoriDocumentLike): boolean {
    const fsPath = document.uri.fsPath;
    if (!isKidoriCandidatePath(fsPath)) {
      return false;
    }
    const text = document.getText();
    const verdict = classifyKidoriFile(fsPath, text);
    const previous = this.states.get(fsPath);

    let isKidori: boolean;
    if (verdict === "unknown") {
      if (previous === undefined) {
        // 判定不能かつ前歴なし。state を作らない（requestSchema は undefined を返す）。
        return false;
      }
      isKidori = previous.isKidori;
    } else {
      isKidori = verdict === "yes";
    }

    const state: SchemaState = previous ?? { isKidori, stockIds: [], generation: 0 };
    state.isKidori = isKidori;
    this.states.set(fsPath, state);
    if (!isKidori) {
      return false;
    }

    let ids: string[] | null;
    try {
      const raw =
        fsPath.endsWith(".json") ? JSON.parse(text) : parse(text);
      ids = collectStockIds(raw, fsPath);
    } catch {
      // 編集途中の不正な YAML/JSON。直前の stockIds を維持する
      // （enum が一時的に消えて全 parts が赤線になるのを防ぐ）。
      ids = null;
    }
    if (ids !== null && JSON.stringify(ids) !== JSON.stringify(state.stockIds)) {
      state.stockIds = ids;
      state.generation += 1;
    }
    return true;
  }

  /** キャッシュ済みの判定（未判定なら undefined）。 */
  verdictFor(fsPath: string): boolean | undefined {
    return this.states.get(fsPath)?.isKidori;
  }

  /** ドキュメントが kidori ファイルか（キャッシュのみを見る。補完のゲート用）。 */
  isKidoriDocument(document: KidoriDocumentLike): boolean {
    const cached = this.verdictFor(document.uri.fsPath);
    if (cached !== undefined) {
      return cached;
    }
    // 未判定（開いた直後にイベントが届く前など）はその場で判定してキャッシュする。
    return this.update(document);
  }

  /**
   * ディスク上の内容でパス単位に判定する（保存・ビルド対象の決定用）。
   *
   * 判定不能（読めない・パース不能）ならキャッシュ済みの判定にフォールバックする。
   */
  isKidoriPath(fsPath: string): boolean {
    if (hasKidoriSuffix(fsPath)) {
      return true;
    }
    if (!CANDIDATE_EXT_RE.test(fsPath)) {
      return false;
    }
    const verdict = classifyKidoriPath(fsPath);
    if (verdict === "unknown") {
      return this.verdictFor(fsPath) ?? false;
    }
    return verdict === "yes";
  }

  /** ドキュメントを閉じた等でキャッシュを破棄する。 */
  forget(fsPath: string): void {
    this.states.delete(fsPath);
  }

  /** YAML 拡張から呼ばれる: リソース（URI 文字列）→ スキーマ URI。 */
  requestSchema = (resource: string): string | undefined => {
    const fsPath = resourceToFsPath(resource);
    if (fsPath === null) {
      return undefined;
    }
    const state = this.states.get(fsPath);
    if (state === undefined || !state.isKidori) {
      return undefined;
    }
    return `${SCHEMA_SCHEME}://schema/g${state.generation}/${encodeURIComponent(fsPath)}`;
  };

  /** YAML 拡張から呼ばれる: スキーマ URI → スキーマ本文。 */
  requestSchemaContent = (schemaUri: string): string | undefined => {
    const m = /^kidori:\/\/schema\/g\d+\/(.+)$/.exec(schemaUri);
    if (!m) {
      return undefined;
    }
    const fsPath = decodeURIComponent(m[1]);
    const state = this.states.get(fsPath);
    if (state === undefined || !state.isKidori) {
      return undefined;
    }
    return schemaJson(state.stockIds);
  };
}

/**
 * redhat.vscode-yaml の API を取得してコントリビュータを登録する。
 * 失敗時（依存拡張が無効化されている等）は false を返す。
 */
export async function registerYamlSchemaContributor(
  contributor: SchemaContributor,
): Promise<boolean> {
  const yamlExt = vscode.extensions.getExtension("redhat.vscode-yaml");
  if (!yamlExt) {
    return false;
  }
  try {
    const api = await yamlExt.activate();
    api.registerContributor(
      SCHEMA_SCHEME,
      contributor.requestSchema,
      contributor.requestSchemaContent,
    );
    return true;
  } catch {
    return false;
  }
}
