/**
 * Red Hat YAML 拡張への動的スキーマ登録（SPECS.md §4b）。
 *
 * kidori 拡張は redhat.vscode-yaml を依存拡張（extensionDependencies）とし、
 * その registerContributor API へスキーマを供給する。ユーザー側の設定・
 * モードラインは不要（モードラインは VS Code 以外の環境向けの代替手段）。
 *
 * 動的補完: 編集中のドキュメント内容から stocks[].id を抽出し、
 * parts[].stock の enum に埋め込んだスキーマを都度生成する。スキーマ URI に
 * 世代番号を含めることで、stocks[].id が変わるたびに YAML 拡張へ
 * 「別のスキーマになった」と認識させ、ビルドを待たずに補完・赤線を更新する。
 */

import * as vscode from "vscode";
import { parse } from "yaml";
import { extractStockIds } from "../core/loader";
import { schemaJson } from "../core/schema";

const SCHEMA_SCHEME = "kidori";

/** project.yaml / project.json とみなすファイル名か。 */
export function isProjectFile(fsPathOrUri: string): boolean {
  return /project\.(ya?ml|json)$/.test(fsPathOrUri);
}

interface SchemaState {
  /** 最後に抽出できた stocks[].id（パース不能時は直前の値を維持する）。 */
  stockIds: string[];
  /** stocks[].id が変わるたびに増える世代番号（スキーマ URI に埋め込む）。 */
  generation: number;
}

export class SchemaContributor {
  private readonly states = new Map<string, SchemaState>();

  /** ドキュメント内容から stocks[].id を再抽出し、変化があれば世代を進める。 */
  update(document: vscode.TextDocument): void {
    if (!isProjectFile(document.uri.toString())) {
      return;
    }
    let ids: string[] | null = null;
    try {
      const raw = document.languageId === "json" || document.fileName.endsWith(".json")
        ? JSON.parse(document.getText())
        : parse(document.getText());
      ids = extractStockIds(raw);
    } catch {
      // 編集途中の不正な YAML/JSON。直前の stockIds を維持する
      // （enum が一時的に消えて全 parts が赤線になるのを防ぐ）。
      ids = null;
    }
    const key = document.uri.toString();
    const state = this.states.get(key) ?? { stockIds: [], generation: 0 };
    if (ids !== null && JSON.stringify(ids) !== JSON.stringify(state.stockIds)) {
      state.stockIds = ids;
      state.generation += 1;
    }
    this.states.set(key, state);
  }

  /** YAML 拡張から呼ばれる: リソース → スキーマ URI。 */
  requestSchema = (resource: string): string | undefined => {
    if (!isProjectFile(resource)) {
      return undefined;
    }
    const state = this.states.get(resource) ?? { stockIds: [], generation: 0 };
    this.states.set(resource, state);
    return `${SCHEMA_SCHEME}://schema/g${state.generation}/${encodeURIComponent(resource)}`;
  };

  /** YAML 拡張から呼ばれる: スキーマ URI → スキーマ本文。 */
  requestSchemaContent = (schemaUri: string): string | undefined => {
    const m = /^kidori:\/\/schema\/g\d+\/(.+)$/.exec(schemaUri);
    if (!m) {
      return undefined;
    }
    const resource = decodeURIComponent(m[1]);
    const state = this.states.get(resource);
    return schemaJson(state?.stockIds ?? []);
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
