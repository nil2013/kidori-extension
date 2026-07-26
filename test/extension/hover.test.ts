/**
 * ホバー provider の vscode モック経由の smoke テスト（U-EXT・設計裁定 D4）。
 *
 * 「登録されたことの確認」だけでは不十分（本エンゲージメントで過去に
 * 「記述の存在は確認したが、記述されたことが成立するかは確認していない」
 * という事故があったのと同型の穴になる、とブリーフが明示的に警告している）
 * ため、ここでは:
 *   1. `activate()` が実際に `vscode.languages.registerHoverProvider` を
 *      呼ぶこと（selector に yaml/json 双方が含まれること）
 *   2. 登録された provider（`extension.ts` の `gatedHover`。kidori ファイル
 *      判定のゲート込み）へサンプル文書＋位置を渡し、**期待文字列を含む
 *      Hover が実際に返ること**
 *   3. kidori ファイルでない文書では `undefined`（ゲートが効くこと）
 * まで検証する。
 *
 * 本体の計算（位置→path・解決値の整形）は exprHover.test.ts が値まで
 * 直接検証済みのため、ここでは「配線が正しく繋がっているか」に絞る。
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

let capturedSelector: unknown;
let capturedHoverProvider:
  | { provideHover(document: unknown, position: unknown): unknown }
  | undefined;

vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    languages: {
      ...(actual.languages as Record<string, unknown>),
      registerHoverProvider(selector: unknown, provider: unknown) {
        capturedSelector = selector;
        capturedHoverProvider = provider as typeof capturedHoverProvider;
        return { dispose() {} };
      },
    },
    Hover: class {
      constructor(public contents: unknown) {}
    },
  };
});

const { activate } = await import("../../src/extension/extension");
const { __resetCommands, __resetConfig, __resetPanels, __setWorkspaceFolders, Uri } =
  await import("./vscode-mock");

const repoRoot = new URL("../../", import.meta.url).pathname;

/** provideHover に渡す最小の TextDocument。 */
function fakeDocument(fsPath: string, text: string) {
  return {
    uri: { fsPath, toString: () => `file://${fsPath}` },
    fileName: fsPath,
    getText: () => text,
  };
}

const KIDORI_YAML =
  'meta: { project: ウマ, units: mm, schemaVersion: "0.5" }\n' +
  "vars:\n" +
  "  inset: 50\n" +
  "  matingAllowance: 38\n" +
  "stocks:\n" +
  "  - { id: 2x4-6f, label: 2x4材, kind: bar, length: 1820, width: 89, thickness: 38 }\n" +
  "parts:\n" +
  "  - { id: leg,      label: 足,   qty: 2, stock: 2x4-6f, length: 800 }\n" +
  "  - { id: beam-top, label: 天板, qty: 1, stock: 2x4-6f, length: 850 }\n" +
  "assemblies:\n" +
  "  - id: uma-1\n" +
  "    contains: { leg: 2, beam-top: 1 }\n" +
  "    marks:\n" +
  '      - { on: beam-top, face: front, ref: leg, x: "$inset + $matingAllowance" }\n';

describe("ホバー provider の配線（U-EXT・D4 smoke）", () => {
  beforeAll(async () => {
    __resetPanels();
    __resetConfig();
    __resetCommands();
    __setWorkspaceFolders([{ uri: Uri.file(repoRoot), name: "test", index: 0 }]);

    const context = { extensionPath: repoRoot, subscriptions: [] as { dispose(): void }[] };
    await activate(context as unknown as Parameters<typeof activate>[0]);
  });

  it("activate() が yaml/json 双方に registerHoverProvider する", () => {
    expect(capturedHoverProvider).toBeDefined();
    expect(capturedSelector).toEqual([
      { language: "yaml", scheme: "file" },
      { language: "json", scheme: "file" },
    ]);
  });

  it("kidori ファイルの式位置で、期待文字列を含む Hover を実際に返す", () => {
    const doc = fakeDocument("/tmp/uma.kidori.yaml", KIDORI_YAML);
    const idx = KIDORI_YAML.indexOf("$inset");
    const before = KIDORI_YAML.slice(0, idx).split("\n");
    const position = { line: before.length - 1, character: before[before.length - 1].length };

    const hover = capturedHoverProvider!.provideHover(doc, position) as
      | { contents: string }
      | undefined;

    expect(hover).toBeDefined();
    expect(hover!.contents).toContain('"$inset + $matingAllowance" → 88 mm');
  });

  it("kidori ファイルではない文書では undefined を返す（ゲートが効く）", () => {
    const doc = fakeDocument("/tmp/plain-notes.yaml", "note: これはただのメモです\n");
    const hover = capturedHoverProvider!.provideHover(doc, { line: 0, character: 0 });
    expect(hover).toBeUndefined();
  });
});
