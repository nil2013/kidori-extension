/**
 * 補完確定時の実体化（SPECS.md §4b）の検証。
 *
 * 対象: src/extension/completion.ts（core の実体化を VS Code スニペットに
 * 載せる薄いラッパ）。
 *   - core の `materializeFields` の出力に、`id` の値だけ tabstop が付くこと
 *   - スニペット予約文字（`$` `}` `\`）がエスケープされること
 *   - stocks 区画の新規エントリ位置でカスケードの候補が出ること
 *   - 層4（ファイル内定義）が挿入候補から外れること
 *   - length / width の値位置で定尺候補が出ること
 *
 * 実体化そのもの（フィールド順・`preset` の位置・`price` の条件・YAML
 * エスケープ）は vscode 非依存なので test/core/stocks.test.ts が受け持つ。
 *
 * --- このテストが検証しないこと ---
 *   - VS Code 本体が補完をトリガし、SnippetString を実際に展開する挙動。
 *     ここでは provideCompletionItems() を直接呼び、返る CompletionItem の
 *     内容（insertText の本文）までを検証する。
 *   - CompletionItemProvider の登録（extension.ts の責務）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

// completion.ts は vscode.CompletionItem / SnippetString / MarkdownString を
// 使うが、共有スタブ（vscode-mock.ts）はそれらを持たない（変更禁止）。
// このテストファイル内でだけ補って差し替える。
vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    CompletionItemKind: { Value: 11, Struct: 21, Variable: 5, EnumMember: 19 },
    CompletionItem: class {
      detail?: string;
      documentation?: unknown;
      insertText?: unknown;
      filterText?: string;
      sortText?: string;
      range?: unknown;
      constructor(
        public label: string,
        public kind?: number,
      ) {}
    },
    SnippetString: class {
      constructor(public value: string) {}
    },
    MarkdownString: class {
      constructor(public value: string) {}
    },
  };
});

const { createCompletionProvider, isOfferable, stockSnippetBody } = await import(
  "../../src/extension/completion"
);
const { loadBuiltinLayer, materializeEntry, resolveCascade, userStocksPath } =
  await import("../../src/core/stocks");
type StockMaster = import("../../src/core/stocks").StockMaster;
type ResolvedStock = import("../../src/core/stocks").ResolvedStock;

const repoRoot = path.resolve(__dirname, "../..");

function stock(entry: ResolvedStock["entry"], key = "spf/1x4/6f"): ResolvedStock {
  return { key, layer: "builtin", origin: "<test>", entry };
}

/** provideCompletionItems に渡す最小の TextDocument。 */
function fakeDocument(fsPath: string, text: string) {
  const lines = text.split("\n");
  return {
    uri: { fsPath, toString: () => `file://${fsPath}` },
    fileName: fsPath,
    getText: () => text,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
  };
}

async function complete(
  master: StockMaster,
  fsPath: string,
  text: string,
  line: number,
  character: number,
) {
  const provider = createCompletionProvider(() => master);
  const items = await provider.provideCompletionItems(
    fakeDocument(fsPath, text) as never,
    { line, character } as never,
    {} as never,
    {} as never,
  );
  return (items ?? []) as unknown as {
    label: string;
    detail?: string;
    filterText?: string;
    insertText?: { value: string };
  }[];
}

// ---------------------------------------------------------------------------

describe("実体化スニペットの形", () => {
  it("preset は id の直後に置かれ、実値一式が並ぶ", () => {
    const builtin = loadBuiltinLayer(repoRoot);
    const entry = builtin.entries.find((e) => e.entry.preset === "spf/1x4/6f")!.entry;
    const body = stockSnippetBody(stock(entry), true);
    expect(body).toBe(
      '- { id: ${1:1x4-6f}, preset: spf/1x4/6f, label: "1×4材 6F", ' +
        "kind: bar, length: 1820, width: 89, thickness: 19 }",
    );
    // id → preset の順（SPECS.md §4 の例と同順）。
    expect(/\{ id: \$\{1:[^}]*\}, preset: /.test(body)).toBe(true);
  });

  it("needsDash=false ではダッシュを付けない", () => {
    const body = stockSnippetBody(
      stock({ id: "a", kind: "bar", length: 1, width: 2, thickness: 3 }),
      false,
    );
    expect(body.startsWith("{ id:")).toBe(true);
  });

  it("core の実体化に tabstop を足しただけであること（実体化の単一ソース）", () => {
    for (const { entry } of loadBuiltinLayer(repoRoot).entries) {
      const plain = materializeEntry(stock(entry));
      const body = stockSnippetBody(stock(entry), false);
      // tabstop を剥がすと core のプレーン出力と一致する。
      expect(body.replace(/\$\{1:([^}]*)\}/, "$1")).toBe(plain);
    }
  });

  it("ビルトイン由来の挿入には price が付かない（S-06 の趣旨の回帰検知）", () => {
    for (const { entry } of loadBuiltinLayer(repoRoot).entries) {
      expect(stockSnippetBody(stock(entry), true)).not.toContain("price");
    }
  });

  it("価格つきエントリでは price も挿入される（S-06 の精密化）", () => {
    const withPrice = stockSnippetBody(
      stock({ id: "a", kind: "bar", length: 1, width: 2, thickness: 3, price: 382 }),
      true,
    );
    expect(withPrice.endsWith(", price: 382 }")).toBe(true);
  });

  it("スニペット予約文字（$ } \\）をエスケープする（YAML エスケープの上に重ねる）", () => {
    const body = stockSnippetBody(
      stock({ id: "a", label: '$100 の材} "特価"', kind: "bar", length: 1, width: 2, thickness: 3 }),
      false,
    );
    // YAML 側で `"` → `\"`、その上にスニペット側で `\` → `\\`、`$` → `\$`、`}` → `\}`。
    expect(body).toContain('label: "\\$100 の材\\} \\\\"特価\\\\""');
  });

  it("層4（ファイル内）だけが挿入候補から外れる", () => {
    const entry = { id: "a", kind: "bar" as const, length: 1, width: 2, thickness: 3 };
    expect(isOfferable({ key: "k", layer: "builtin", origin: "", entry })).toBe(true);
    expect(isOfferable({ key: "k", layer: "user", origin: "", entry })).toBe(true);
    expect(isOfferable({ key: "k", layer: "directory", origin: "", entry })).toBe(true);
    expect(isOfferable({ key: "k", layer: "file", origin: "", entry })).toBe(false);
  });
});

describe("CompletionItemProvider", () => {
  let tmpDir: string;
  let projectDir: string;
  let projectPath: string;
  let master: StockMaster;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-completion-"));
    projectDir = path.join(tmpDir, "diy");
    fs.mkdirSync(projectDir, { recursive: true });
    projectPath = path.join(projectDir, "bookshelf.kidori.yaml");
    master = {
      builtin: loadBuiltinLayer(repoRoot),
      // 実ユーザーの ~/.config を読まないよう、存在しないパスへ固定する。
      userStocksPath: userStocksPath({
        XDG_CONFIG_HOME: path.join(tmpDir, "config"),
      } as NodeJS.ProcessEnv),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stocks 区画の新規エントリ位置でカスケードの候補を返す", async () => {
    const text = "stocks:\n  - ";
    const items = await complete(master, projectPath, text, 1, 4);
    expect(items.length).toBe(master.builtin.entries.length);
    const item = items.find((i) => i.label.startsWith("1×4材 6F"))!;
    expect(item.insertText?.value).toContain("preset: spf/1x4/6f");
    expect(item.insertText?.value.startsWith("- {")).toBe(true);
  });

  it("ディレクトリ層の上書きが候補の実値に反映される（近い層が勝つ）", async () => {
    fs.writeFileSync(
      path.join(projectDir, "stocks.yaml"),
      `stocks:\n  - { id: 1x4-6f, preset: spf/1x4/6f, label: "1×4材 6F（実測）", kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }\n`,
      "utf-8",
    );
    const items = await complete(master, projectPath, "stocks:\n  - ", 1, 4);
    const item = items.find((i) => i.label.startsWith("1×4材 6F（実測）"))!;
    expect(item.insertText?.value).toContain(", price: 382 }");
    expect(item.detail).toContain("ディレクトリ");
  });

  it("ユーザー独自材（id fallback）も候補になる", async () => {
    fs.writeFileSync(
      path.join(projectDir, "stocks.yaml"),
      `stocks:\n  - { id: my-oak, label: "オーク集成材", kind: sheet, length: 1800, width: 900, thickness: 20 }\n`,
      "utf-8",
    );
    const items = await complete(master, projectPath, "stocks:\n  - ", 1, 4);
    const item = items.find((i) => i.label.startsWith("オーク集成材"))!;
    expect(item.insertText?.value).toContain("preset: my-oak");
    expect(item.insertText?.value).toContain("id: ${1:my-oak}");
  });

  it("length の値位置では定尺候補（カスケードの lengths）を返す", async () => {
    const text = "stocks:\n  - { id: a, length: ";
    const items = await complete(master, projectPath, text, 1, text.split("\n")[1].length);
    const cascade = resolveCascade(master, {
      documentPath: projectPath,
      documentText: text,
    });
    expect(items.map((i) => i.label)).toEqual(cascade.lengths.map(String));
    for (const v of master.builtin.lengths) {
      expect(items.map((i) => i.label)).toContain(String(v));
    }
  });

  it("層2の独自材の寸法も定尺候補に載る（FIX-1）", async () => {
    fs.mkdirSync(path.dirname(master.userStocksPath), { recursive: true });
    fs.writeFileSync(
      master.userStocksPath,
      `stocks:\n  - { id: hc-oak, label: "近所のHCのオーク", kind: sheet, length: 2101, width: 951, thickness: 21 }\n`,
      "utf-8",
    );
    const text = "stocks:\n  - { id: a, length: ";
    const items = await complete(master, projectPath, text, 1, text.split("\n")[1].length);
    expect(items.map((i) => i.label)).toContain("2101");
  });

  it("層4（ファイル内定義）は挿入候補に出さないが、カスケードには残る（FIX-2）", async () => {
    const text =
      "stocks:\n" +
      `  - { id: my-oak, label: "オーク集成材", kind: sheet, length: 1800, width: 900, thickness: 20 }\n` +
      "  - ";
    const items = await complete(master, projectPath, text, 2, 4);

    // 自分のファイルの既存エントリは再挿入候補にしない。
    expect(items.some((i) => i.label.startsWith("オーク集成材"))).toBe(false);
    expect(items.length).toBe(master.builtin.entries.length);

    // ただしカスケード上には残る（シャドウ判定・parts[].stock の enum 供給用）。
    const cascade = resolveCascade(master, {
      documentPath: projectPath,
      documentText: text,
    });
    const own = cascade.entries.find((e) => e.key === "my-oak")!;
    expect(own.layer).toBe("file");
  });

  it("ファイル内定義が下層を隠す場合、そのキーは挿入候補から外れる一方でシャドウは検出される（FIX-2）", async () => {
    const text =
      "stocks:\n" +
      `  - { id: 1x4-6f, preset: spf/1x4/6f, label: "1×4材 6F", kind: bar, length: 1800, width: 89, thickness: 19 }\n` +
      "  - ";
    const items = await complete(master, projectPath, text, 2, 4);
    expect(items.some((i) => i.insertText?.value.includes("preset: spf/1x4/6f"))).toBe(
      false,
    );
    expect(items.length).toBe(master.builtin.entries.length - 1);

    const cascade = resolveCascade(master, {
      documentPath: projectPath,
      documentText: text,
    });
    expect(cascade.shadows).toHaveLength(1);
    expect(cascade.shadows[0].winner.layer).toBe("file");
    expect(cascade.shadows[0].shadowed.layer).toBe("builtin");
    expect(cascade.shadows[0].differences).toContain("length");
  });

  it("stocks 区画の外・エントリ途中では候補を出さない", async () => {
    expect(await complete(master, projectPath, "parts:\n  - ", 1, 4)).toEqual([]);
    expect(
      await complete(master, projectPath, "stocks:\n  - { id: a", 1, 12),
    ).toEqual([]);
  });
});

describe("式を受け付けるフィールドの $vars 名・揃えエイリアス補完（SPECS.md §4b:189・§4d）", () => {
  let tmpDir: string;
  let projectPath: string;
  let master: StockMaster;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-completion-expr-"));
    projectPath = path.join(tmpDir, "uma.kidori.yaml");
    master = {
      builtin: loadBuiltinLayer(repoRoot),
      userStocksPath: userStocksPath({
        XDG_CONFIG_HOME: path.join(tmpDir, "config"),
      } as NodeJS.ProcessEnv),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const VARS_HEADER = "vars:\n  inset: 50\n  matingAllowance: 38\n";

  it("settings.kerf の値位置で $vars 名を候補に出す（vars が定義されていれば）", async () => {
    const text = `${VARS_HEADER}settings:\n  kerf: `;
    const line = text.split("\n").length - 1;
    const character = text.split("\n")[line].length;
    const items = await complete(master, projectPath, text, line, character);
    expect(items.map((i) => i.label)).toEqual(["$inset", "$matingAllowance"]);
  });

  it("vars が定義されていなければ $vars 補完は出ない（式受け入れフィールドでも）", async () => {
    const text = "settings:\n  kerf: ";
    const line = 1;
    const character = text.split("\n")[1].length;
    expect(await complete(master, projectPath, text, line, character)).toEqual([]);
  });

  it("assemblies[].marks[].x では $vars 名に加えて X 軸の揃えエイリアスを出す", async () => {
    const text =
      `${VARS_HEADER}assemblies:\n` + "  - id: uma-1\n" + "    marks:\n" + "      - x: ";
    const lines = text.split("\n");
    const line = lines.length - 1;
    const character = lines[line].length;
    const items = await complete(master, projectPath, text, line, character);
    expect(items.map((i) => i.label)).toEqual([
      "$inset",
      "$matingAllowance",
      "left",
      "center",
      "right",
    ]);
  });

  it("assemblies[].marks[].y では Y 軸の揃えエイリアス（bottom/center/top）を出す", async () => {
    const text =
      `${VARS_HEADER}assemblies:\n` + "  - id: uma-1\n" + "    marks:\n" + "      - y: ";
    const lines = text.split("\n");
    const line = lines.length - 1;
    const character = lines[line].length;
    const items = await complete(master, projectPath, text, line, character);
    expect(items.map((i) => i.label)).toEqual([
      "$inset",
      "$matingAllowance",
      "bottom",
      "center",
      "top",
    ]);
  });

  it("parts[].features[].x（hole.x）では $vars 名のみで、揃えエイリアスは出さない", async () => {
    const text =
      `${VARS_HEADER}parts:\n` +
      "  - id: p\n" +
      "    features:\n" +
      "      - type: hole\n" +
      "        x: ";
    const lines = text.split("\n");
    const line = lines.length - 1;
    const character = lines[line].length;
    const items = await complete(master, projectPath, text, line, character);
    // 揃えエイリアス（left/center/right 等）を含まない。
    expect(items.map((i) => i.label)).toEqual(["$inset", "$matingAllowance"]);
  });

  it("式を受け付けないフィールド（id・qty 等）では何も出さない", async () => {
    const text = `${VARS_HEADER}parts:\n  - id: `;
    const lines = text.split("\n");
    const line = lines.length - 1;
    const character = lines[line].length;
    expect(await complete(master, projectPath, text, line, character)).toEqual([]);
  });

  it("length/width の値位置では定尺候補に加えて $vars 名も出る（既存補完の拡張）", async () => {
    const text = `${VARS_HEADER}stocks:\n  - { id: a, length: `;
    const lines = text.split("\n");
    const line = lines.length - 1;
    const character = lines[line].length;
    const items = await complete(master, projectPath, text, line, character);
    const cascade = resolveCascade(master, { documentPath: projectPath, documentText: text });
    expect(items.map((i) => i.label)).toEqual([
      ...cascade.lengths.map(String),
      "$inset",
      "$matingAllowance",
    ]);
  });
});

describe("マスタ → 補完挿入 → 正本 → パースの往復（FIX-3）", () => {
  /**
   * VS Code のスニペット構文を「展開後のテキスト」に解決する。
   *
   * 実際の拡張ホストが insertText: SnippetString をどう展開するかの再現:
   *   - `\` は次の1文字をリテラル化する（`\$` → `$`、`\}` → `}`、`\\` → `\`）
   *   - `${N:default}` は default を挿入する（既定値のまま確定した場合）
   * これを通した結果が「正本ファイルに書き込まれる文字列」に相当する。
   */
  function resolveSnippet(body: string): string {
    let out = "";
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === "\\") {
        out += body[++i] ?? "";
        continue;
      }
      const tabstop = /^\$\{\d+:/.exec(body.slice(i));
      if (tabstop) {
        let j = i + tabstop[0].length;
        let depth = 1;
        let inner = "";
        for (; j < body.length; j++) {
          const d = body[j];
          if (d === "\\") {
            inner += body[++j] ?? "";
            continue;
          }
          if (d === "{") {
            depth += 1;
          } else if (d === "}") {
            depth -= 1;
            if (depth === 0) {
              break;
            }
          }
          inner += d;
        }
        out += inner;
        i = j;
        continue;
      }
      out += c;
    }
    return out;
  }

  /** 「stocks 区画で補完を確定した後のファイル内容」を組み立ててパースする。 */
  function insertAndParse(entry: ResolvedStock["entry"]): Record<string, unknown> {
    const resolved: ResolvedStock = {
      key: "hc/oak/1820",
      layer: "user",
      origin: "<test>",
      entry,
    };
    const inserted = resolveSnippet(stockSnippetBody(resolved, true));
    const document = `stocks:\n  ${inserted}\n`;
    const parsed = parse(document) as { stocks: Record<string, unknown>[] };
    expect(Array.isArray(parsed.stocks), document).toBe(true);
    expect(parsed.stocks).toHaveLength(1);
    return parsed.stocks[0];
  }

  it("二重引用符・ドル記号・バックスラッシュを含む label が正本まで無傷で届く", () => {
    const label = '12" 材 $100 \\ 端材';
    const parsed = insertAndParse({
      id: "hc-oak",
      label,
      kind: "sheet",
      length: 1820,
      width: 910,
      thickness: 20,
      price: 4980,
    });
    // YAML エスケープ（core）の上にスニペットエスケープ（拡張）が正しく
    // 重なっていれば、パース結果は元の文字列と完全一致する。
    expect(parsed.label).toBe(label);
    expect(parsed).toEqual({
      id: "hc-oak",
      preset: "hc/oak/1820",
      label,
      kind: "sheet",
      length: 1820,
      width: 910,
      thickness: 20,
      price: 4980,
    });
  });

  it("スニペット予約文字・YAML 特殊文字の組み合わせでも往復する", () => {
    for (const label of [
      "$1",
      "}",
      "\\",
      '"',
      "${1:tabstop に見える文字列}",
      "全部 {a}, b: c\td\\e\"f$g",
    ]) {
      const parsed = insertAndParse({
        id: "a",
        label,
        kind: "bar",
        length: 1,
        width: 2,
        thickness: 3,
      });
      expect(parsed.label, label).toBe(label);
    }
  });

  it("id の tabstop を既定値のまま確定しても正本が壊れない", () => {
    const parsed = insertAndParse({ kind: "bar", length: 1, width: 2, thickness: 3 });
    // マスタ側に id が無いケース。キーから導出した既定 id が入る。
    expect(parsed.id).toBe("hc-oak-1820");
    expect(parsed.preset).toBe("hc/oak/1820");
  });

  it("ビルトイン由来の候補も往復する", () => {
    for (const { entry } of loadBuiltinLayer(repoRoot).entries) {
      const resolved: ResolvedStock = {
        key: entry.preset as string,
        layer: "builtin",
        origin: "<test>",
        entry,
      };
      const document = `stocks:\n  ${resolveSnippet(stockSnippetBody(resolved, true))}\n`;
      const parsed = parse(document) as { stocks: Record<string, unknown>[] };
      expect(parsed.stocks[0].label, document).toBe(entry.label);
      expect(parsed.stocks[0].preset).toBe(entry.preset);
      expect("price" in parsed.stocks[0]).toBe(false);
    }
  });
});
