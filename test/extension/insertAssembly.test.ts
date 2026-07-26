/**
 * `kidori.insertAssembly`（「kidori: 構成を挿入（parts＋assembly の雛形）」。
 * SPECS.md §4c「一括挿入」）のテスト。
 *
 * 検証する契約:
 *   1. 挿入されるスニペット本文（tabstop を既定値に解決した状態）が、
 *      実際にスキーマ検証・意味検証（`loadProjectFromRaw`）を通ること
 *      （「'assemblies' という文字列を含む」だけの弱い検証にしない。本ファイルの
 *      価値の中心）。
 *   2. コマンドが activate() で登録されること（"command not found" の回帰検知。
 *      newInitCommands.test.ts と同じ流儀）。
 *   3. kidori ファイルを開いていない（or アクティブエディタが無い）ときは
 *      発動しない（`SchemaContributor.isKidoriDocument` によるゲート）。
 */

import * as path from "node:path";

import { describe, expect, it, beforeEach } from "vitest";
import { parse } from "yaml";

import { assemblyTemplateBody } from "../../src/extension/assemblySnippet";
import { loadProjectFromRaw } from "../../src/core/loader";
import { activate } from "../../src/extension/extension";
import {
  __isCommandRegistered,
  __resetCommands,
  __resetWindowMocks,
  __setActiveTextEditor,
  __resetConfig,
  __resetPanels,
  __resetSaveListeners,
  __resetCloseListeners,
  __resetChannels,
  __recordedWindowCalls,
  commands,
  Uri,
} from "./vscode-mock";

const repoRoot = path.resolve(__dirname, "../..");

/**
 * VS Code のスニペット構文を「tabstop を既定値のまま確定したときのテキスト」へ
 * 解決する（test/extension/completion.test.ts の `resolveSnippet` と同じ発想。
 * ただし本スニペットは同一 tabstop 番号を複数箇所で共有する＝ミラー編集を使うため、
 * 「最初に出た ${N:default} を正として、以降の裸の $N はそれへ解決する」処理を足す）。
 */
function resolveTemplateDefaults(body: string): string {
  const defaults = new Map<string, string>();
  for (const m of body.matchAll(/\$\{(\d+):([^}]*)\}/g)) {
    if (!defaults.has(m[1])) {
      defaults.set(m[1], m[2]);
    }
  }
  return body
    .replace(/\$\{(\d+):([^}]*)\}/g, (_all, n: string) => defaults.get(n) ?? "")
    .replace(/\$(\d+)/g, (_all, n: string) => defaults.get(n) ?? "");
}

describe("assemblyTemplateBody の既定値展開が検証を通る（SPECS.md §4c）", () => {
  it("meta/stocks を補った完全な正本として loadProjectFromRaw がエラー無しで通す", () => {
    const resolved = resolveTemplateDefaults(assemblyTemplateBody());

    // §4c の実例（test/core/assemblies.test.ts の SPECS_4C_YAML）と同じ
    // meta/stocks を補う。スニペットの既定 stock id "2x4-6f" と一致させる。
    const fullYaml =
      'meta: { project: テスト, units: mm, schemaVersion: "0.5" }\n\n' +
      "stocks:\n" +
      '  - { id: 2x4-6f, preset: spf/2x4/6f, label: "2×4材 6F", kind: bar, length: 1820, width: 89, thickness: 38, price: 598 }\n\n' +
      resolved +
      "\n";

    const raw = parse(fullYaml);
    const { project, issues } = loadProjectFromRaw(raw);

    expect(
      issues.filter((i) => i.severity === "error"),
      `error になった issues: ${JSON.stringify(issues)}`,
    ).toEqual([]);
    expect(project).not.toBeNull();

    // 「'assemblies' という文字列が含まれる」だけでなく、実際に導出された
    // モデルの中身（qty 導出・contains・marks の ref 解決）まで見る。
    const partIds = project!.parts.map((p) => p.id);
    expect(partIds).toEqual(["leg", "beam-top", "beam-foot"]);
    // qty はスニペットに書かないので、contains 合計から導出されているはず。
    const leg = project!.parts.find((p) => p.id === "leg")!;
    const beamTop = project!.parts.find((p) => p.id === "beam-top")!;
    const beamFoot = project!.parts.find((p) => p.id === "beam-foot")!;
    expect(leg.qty).toBe(2);
    expect(beamTop.qty).toBe(1);
    expect(beamFoot.qty).toBe(1);

    expect(project!.assemblies).toHaveLength(1);
    const assembly = project!.assemblies[0];
    expect(assembly.id).toBe("assembly-1");
    expect(assembly.contains).toEqual({ leg: 2, "beam-top": 1, "beam-foot": 1 });
    expect(assembly.marks).toHaveLength(1);
    expect(assembly.marks[0]).toMatchObject({
      on: "beam-top",
      face: "front",
      ref: "leg",
      x: 50,
      note: "足当たり面",
    });
  });

  it("マクロ的な参照・独自構文を残さない（展開後はただの YAML）", () => {
    const resolved = resolveTemplateDefaults(assemblyTemplateBody());
    // VS Code スニペット構文（$1, ${1:...}）が残っていないこと。
    expect(resolved).not.toMatch(/\$\{?\d/);
  });
});

describe("kidori.insertAssembly の配線（activate() での登録・ゲート）", () => {
  async function activateExtension(): Promise<void> {
    const context = {
      extensionPath: repoRoot,
      subscriptions: [] as { dispose(): void }[],
    };
    await activate(context as unknown as Parameters<typeof activate>[0]);
  }

  interface FakeEditor {
    document: { uri: { fsPath: string }; getText(): string };
    insertSnippet(snippet: { value: string }): Thenable<boolean>;
    inserted: { value: string }[];
  }

  function fakeEditor(fsPath: string, text: string): FakeEditor {
    const inserted: { value: string }[] = [];
    return {
      document: { uri: Uri.file(fsPath), getText: () => text },
      insertSnippet(snippet: { value: string }) {
        inserted.push(snippet);
        return Promise.resolve(true);
      },
      inserted,
    };
  }

  beforeEach(() => {
    __resetPanels();
    __resetConfig();
    __resetCommands();
    __resetSaveListeners();
    __resetCloseListeners();
    __resetWindowMocks();
    __resetChannels();
    __setActiveTextEditor(undefined);
  });

  it("kidori.insertAssembly が commands レジストリに存在する", async () => {
    expect(__isCommandRegistered("kidori.insertAssembly")).toBe(false);
    await activateExtension();
    expect(__isCommandRegistered("kidori.insertAssembly")).toBe(true);
  });

  it("kidori ファイル（命名規約）を開いているとき、既定値解決済みの本文を挿入する", async () => {
    const editor = fakeEditor("/tmp/bookshelf.kidori.yaml", "meta: {}\n");
    __setActiveTextEditor(editor);

    await activateExtension();
    await commands.executeCommand("kidori.insertAssembly");

    expect(editor.inserted).toHaveLength(1);
    expect(editor.inserted[0].value).toBe(assemblyTemplateBody());
  });

  it("アクティブエディタが無いときは挿入せず、警告を出す", async () => {
    __setActiveTextEditor(undefined);

    await activateExtension();
    await commands.executeCommand("kidori.insertAssembly");

    const warnings = __recordedWindowCalls().filter((c) => c.kind === "showWarningMessage");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("kidori ファイルでない（命名規約外・内容判定も該当しない）場合は挿入しない", async () => {
    const editor = fakeEditor("/tmp/notes.txt", "hello world\n");
    __setActiveTextEditor(editor);

    await activateExtension();
    await commands.executeCommand("kidori.insertAssembly");

    expect(editor.inserted).toHaveLength(0);
    const warnings = __recordedWindowCalls().filter((c) => c.kind === "showWarningMessage");
    expect(warnings.length).toBeGreaterThan(0);
  });
});
