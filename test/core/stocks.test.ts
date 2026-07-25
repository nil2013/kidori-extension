/**
 * 規格材マスタの4層カスケード（SPECS.md §4b）の検証。
 *
 * 対象: src/core/stocks/（cascade.ts / materialize.ts）
 *   - 4層（ビルトイン → ユーザー → ディレクトリ → ファイル内）のマージで
 *     「近い層が勝つ」こと（層1のみ／層1+2／層1+2+3／全4層の各段階）
 *   - マスタキーの解決（preset があればそれ、なければ id を fallback）
 *   - XDG_CONFIG_HOME の有無でユーザー層のパスが変わること
 *   - 定尺候補（ビルトインの定尺リスト ∪ 勝ち残りエントリの実値）
 *   - ビルトイン層に price が無いこと（S-06 の趣旨の回帰検知）
 *   - 実体化（materializeEntry）が正本 stocks エントリの形になること
 *   - 層の切り分けを守る2つの不変条件（下記）
 *
 * --- このテストが守る不変条件 ---
 *   1. src/core/stocks/ は `vscode` を import しない
 *      （拡張・CLI の双方から使う。SPECS.md §3・§4b）
 *   2. ビルド経路（core/build.ts・core/loader.ts）はカスケードを import しない
 *      （SPECS.md §4b「カスケードは補完候補の供給構造であり、ビルドの解決
 *      機構ではない」＝正本の自己完結性）
 *
 * --- このテストが検証しないこと ---
 *   - シャドウの通知先の振り分け（vscode 依存。test/extension/stockShadow.test.ts）
 *   - CompletionItemProvider の挙動（test/extension/completion.test.ts）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  LayerSource,
  ResolvedStock,
  StockMaster,
  defaultStockId,
  isInsertable,
  loadBuiltinLayer,
  loadStockMasterFrom,
  masterKey,
  materializeEntry,
  materializeFields,
  mergeLayers,
  parseStocksText,
  resolveCascade,
  shadowMessage,
  userStocksPath,
} from "../../src/core/stocks";

const repoRoot = path.resolve(__dirname, "../..");

function keys(entries: ResolvedStock[]): string[] {
  return entries.map((e) => e.key);
}

function find(entries: ResolvedStock[], key: string): ResolvedStock {
  const found = entries.find((e) => e.key === key);
  if (!found) {
    throw new Error(`key ${key} が見つかりません`);
  }
  return found;
}

// ---------------------------------------------------------------------------

describe("ビルトイン層", () => {
  it("assets/stock-presets.json を新形式（presets/lengths/widths）で読む", () => {
    const layer = loadBuiltinLayer(repoRoot);
    expect(layer.layer).toBe("builtin");
    expect(layer.entries.length).toBeGreaterThan(0);
    expect(layer.lengths).toContain(1820);
    expect(layer.widths).toContain(89);
    // 全エントリが preset（マスタキー）を持つ。
    for (const { entry } of layer.entries) {
      expect(entry.preset, JSON.stringify(entry)).toBeTruthy();
      expect(entry.kind === "bar" || entry.kind === "sheet").toBe(true);
    }
  });

  it("price を一切持たない（S-06: ゼロ既定値・推測価格を正本へ混入させない）", () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "assets/stock-presets.json"), "utf-8"),
    ) as { presets: Record<string, unknown>[] };
    for (const p of raw.presets) {
      expect(Object.prototype.hasOwnProperty.call(p, "price"), JSON.stringify(p)).toBe(
        false,
      );
    }
    for (const { entry } of loadBuiltinLayer(repoRoot).entries) {
      expect(entry.price).toBeUndefined();
    }
  });

  it("preset の無い要素は無視する（ビルトインは preset 必須）", () => {
    const layer = loadBuiltinLayer(path.join(__dirname, "no-such-dir"));
    expect(layer.entries).toEqual([]);
  });
});

describe("マスタキーの解決", () => {
  it("ビルトイン層は preset のみをキーにする（id は fallback にならない）", () => {
    expect(masterKey({ preset: "spf/1x4/6f", id: "x" }, "builtin")).toBe("spf/1x4/6f");
    expect(masterKey({ id: "x" }, "builtin")).toBeNull();
  });

  it("層2〜4 は preset があればそれ、無ければ id を fallback キーにする", () => {
    expect(masterKey({ preset: "spf/1x4/6f", id: "x" }, "user")).toBe("spf/1x4/6f");
    expect(masterKey({ id: "my-oak" }, "user")).toBe("my-oak");
    expect(masterKey({ id: "my-oak" }, "directory")).toBe("my-oak");
    expect(masterKey({ id: "my-oak" }, "file")).toBe("my-oak");
    expect(masterKey({ label: "名無し" }, "file")).toBeNull();
  });
});

describe("XDG によるユーザー層のパス解決", () => {
  it("XDG_CONFIG_HOME が設定されていればそれを使う", () => {
    expect(userStocksPath({ XDG_CONFIG_HOME: "/xdg/conf" } as NodeJS.ProcessEnv)).toBe(
      path.join("/xdg/conf", "kidori", "stocks.yaml"),
    );
  });

  it("未設定なら ~/.config にフォールバックする", () => {
    expect(userStocksPath({} as NodeJS.ProcessEnv)).toBe(
      path.join(os.homedir(), ".config", "kidori", "stocks.yaml"),
    );
  });

  it("空文字・相対パスは無効として ~/.config にフォールバックする", () => {
    const home = path.join(os.homedir(), ".config", "kidori", "stocks.yaml");
    expect(userStocksPath({ XDG_CONFIG_HOME: "" } as NodeJS.ProcessEnv)).toBe(home);
    expect(userStocksPath({ XDG_CONFIG_HOME: "rel/conf" } as NodeJS.ProcessEnv)).toBe(
      home,
    );
  });
});

describe("4層カスケード（近い層が勝つ）", () => {
  let tmpDir: string;
  let xdgDir: string;
  let projectDir: string;
  let projectPath: string;
  let master: StockMaster;

  const KEY = "spf/1x4/6f";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-cascade-"));
    xdgDir = path.join(tmpDir, "config");
    projectDir = path.join(tmpDir, "diy");
    projectPath = path.join(projectDir, "bookshelf.kidori.yaml");
    fs.mkdirSync(path.join(xdgDir, "kidori"), { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    master = {
      builtin: loadBuiltinLayer(repoRoot),
      userStocksPath: userStocksPath({
        XDG_CONFIG_HOME: xdgDir,
      } as NodeJS.ProcessEnv),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeUser(body: string): void {
    fs.writeFileSync(path.join(xdgDir, "kidori", "stocks.yaml"), body, "utf-8");
  }
  function writeDirectory(body: string): void {
    fs.writeFileSync(path.join(projectDir, "stocks.yaml"), body, "utf-8");
  }

  it("層1のみ: ビルトインがそのまま候補になる", () => {
    const cascade = resolveCascade(master, {});
    expect(find(cascade.entries, KEY).layer).toBe("builtin");
    expect(find(cascade.entries, KEY).entry.length).toBe(1820);
    expect(cascade.shadows).toEqual([]);
  });

  it("層1+2: ユーザー層がビルトインを上書きする", () => {
    writeUser(
      `stocks:\n  - { id: 1x4-6f, preset: ${KEY}, label: "1×4材 6F", kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }\n`,
    );
    const cascade = resolveCascade(master, {});
    const win = find(cascade.entries, KEY);
    expect(win.layer).toBe("user");
    expect(win.entry.price).toBe(382);
    expect(cascade.shadows).toHaveLength(1);
    expect(cascade.shadows[0].winner.layer).toBe("user");
    expect(cascade.shadows[0].shadowed.layer).toBe("builtin");
    expect(cascade.shadows[0].differences).toContain("price");
  });

  it("層1+2+3: ディレクトリ層がユーザー層に勝つ", () => {
    writeUser(
      `stocks:\n  - { id: 1x4-6f, preset: ${KEY}, kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }\n`,
    );
    writeDirectory(
      `stocks:\n  - { id: 1x4-6f, preset: ${KEY}, kind: bar, length: 1820, width: 89, thickness: 19, price: 450 }\n`,
    );
    const cascade = resolveCascade(master, { documentPath: projectPath });
    const win = find(cascade.entries, KEY);
    expect(win.layer).toBe("directory");
    expect(win.entry.price).toBe(450);
    // ユーザー→ビルトイン、ディレクトリ→ユーザー の2件。
    expect(cascade.shadows.map((s) => `${s.shadowed.layer}<${s.winner.layer}`)).toEqual([
      "builtin<user",
      "user<directory",
    ]);
  });

  it("全4層: ファイル内定義が最終的に勝つ", () => {
    writeUser(
      `stocks:\n  - { id: 1x4-6f, preset: ${KEY}, kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }\n`,
    );
    writeDirectory(
      `stocks:\n  - { id: 1x4-6f, preset: ${KEY}, kind: bar, length: 1820, width: 89, thickness: 19, price: 450 }\n`,
    );
    const text = `stocks:\n  - { id: 1x4-6f, preset: ${KEY}, kind: bar, length: 1800, width: 89, thickness: 19, price: 500 }\n`;
    const cascade = resolveCascade(master, {
      documentPath: projectPath,
      documentText: text,
    });
    const win = find(cascade.entries, KEY);
    expect(win.layer).toBe("file");
    expect(win.entry.length).toBe(1800);
    expect(win.entry.price).toBe(500);
    expect(cascade.shadows.map((s) => s.winner.layer)).toEqual([
      "user",
      "directory",
      "file",
    ]);
  });

  it("id fallback のユーザー独自材もカスケード候補になり、ファイル層に上書きされる", () => {
    writeUser(
      `stocks:\n  - { id: my-oak, label: "オーク集成材", kind: sheet, length: 1800, width: 900, thickness: 20 }\n`,
    );
    const cascade = resolveCascade(master, {
      documentPath: projectPath,
      documentText:
        `stocks:\n  - { id: my-oak, label: "オーク集成材", kind: sheet, length: 1820, width: 910, thickness: 20 }\n`,
    });
    const win = find(cascade.entries, "my-oak");
    expect(win.layer).toBe("file");
    expect(win.entry.length).toBe(1820);
    expect(cascade.shadows).toHaveLength(1);
    expect(cascade.shadows[0].differences).toEqual(["length", "width"]);
  });

  it("並び順はビルトイン順を保ち、新規キーだけが末尾に追加される", () => {
    const builtinKeys = keys(resolveCascade(master, {}).entries);
    writeUser(
      `stocks:\n  - { preset: ${KEY}, kind: bar, length: 1820, width: 89, thickness: 19 }\n` +
        `  - { id: my-oak, kind: sheet, length: 1800, width: 900, thickness: 20 }\n`,
    );
    const after = keys(resolveCascade(master, {}).entries);
    expect(after).toEqual([...builtinKeys, "my-oak"]);
  });

  it("編集中ファイル自身がディレクトリ層の stocks.yaml のときは二重計上しない", () => {
    const stocksPath = path.join(projectDir, "stocks.yaml");
    const text = `stocks:\n  - { id: my-oak, kind: sheet, length: 1800, width: 900, thickness: 20 }\n`;
    fs.writeFileSync(stocksPath, text, "utf-8");
    const cascade = resolveCascade(master, {
      documentPath: stocksPath,
      documentText: text,
    });
    expect(cascade.shadows).toEqual([]);
    expect(find(cascade.entries, "my-oak").layer).toBe("file");
  });

  it("層ファイルが無い・壊れていても落ちない", () => {
    writeUser("これは: [壊れた\n  yaml");
    expect(() =>
      resolveCascade(master, { documentPath: projectPath, documentText: "stocks: 3" }),
    ).not.toThrow();
  });

  it("定尺候補は「ビルトインの定尺リスト ∪ 勝ち残りエントリの実値」", () => {
    const cascade = resolveCascade(master, { documentPath: projectPath });
    const expectedLengths = [
      ...new Set([
        ...master.builtin.lengths,
        ...master.builtin.entries.map((e) => e.entry.length as number),
      ]),
    ].sort((a, b) => a - b);
    const expectedWidths = [
      ...new Set([
        ...master.builtin.widths,
        ...master.builtin.entries.map((e) => e.entry.width as number),
      ]),
    ].sort((a, b) => a - b);
    expect(cascade.lengths).toEqual(expectedLengths);
    expect(cascade.widths).toEqual(expectedWidths);
    // ビルトインの定尺リストは全て残る（和集合であって置換ではない）。
    for (const v of master.builtin.lengths) {
      expect(cascade.lengths).toContain(v);
    }
  });

  it("層2に独自材を定義すると、その寸法が定尺・幅の値候補に載る", () => {
    const before = resolveCascade(master, { documentPath: projectPath });
    expect(before.lengths).not.toContain(2101);
    expect(before.widths).not.toContain(951);

    writeUser(
      `stocks:\n  - { id: hc-oak, label: "近所のHCのオーク", kind: sheet, length: 2101, width: 951, thickness: 21 }\n`,
    );
    const after = resolveCascade(master, { documentPath: projectPath });
    expect(after.lengths).toContain(2101);
    expect(after.widths).toContain(951);
    // 昇順・重複なしを保つ。
    expect(after.lengths).toEqual([...new Set(after.lengths)].sort((a, b) => a - b));
    expect(after.widths).toEqual([...new Set(after.widths)].sort((a, b) => a - b));
  });

  it("層3・層4 の上書きで勝った実値が値候補に反映される", () => {
    writeDirectory(
      `stocks:\n  - { id: 1x4-6f, preset: ${KEY}, kind: bar, length: 2102, width: 89, thickness: 19 }\n`,
    );
    const cascade = resolveCascade(master, {
      documentPath: projectPath,
      documentText: `stocks:\n  - { id: my-oak, kind: sheet, length: 2103, width: 952, thickness: 20 }\n`,
    });
    expect(cascade.lengths).toContain(2102);
    expect(cascade.lengths).toContain(2103);
    expect(cascade.widths).toContain(952);
  });
});

describe("正本 stocks 形のパース", () => {
  it("YAML のエントリ位置（オフセット）を保持する", () => {
    const text = `stocks:\n  - { id: a, kind: bar, length: 1, width: 2, thickness: 3 }\n`;
    const parsed = parseStocksText(text, false);
    expect(parsed).toHaveLength(1);
    const [start, end] = parsed[0].offsets as [number, number];
    expect(text.slice(start, end).trim()).toBe(
      "{ id: a, kind: bar, length: 1, width: 2, thickness: 3 }",
    );
  });

  it("JSON も同じデータモデルで読む（SPECS.md §4a）", () => {
    const parsed = parseStocksText(
      JSON.stringify({ stocks: [{ id: "a", kind: "bar", length: 1 }] }),
      true,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].entry.id).toBe("a");
    expect(parsed[0].offsets).toBeUndefined();
  });

  it("型の合わないフィールドは落とす（壊れた入力でも読める範囲を拾う）", () => {
    const parsed = parseStocksText(
      `stocks:\n  - { id: a, kind: plank, length: "long", width: 2, thickness: 3 }\n`,
      false,
    );
    expect(parsed[0].entry.kind).toBeUndefined();
    expect(parsed[0].entry.length).toBeUndefined();
    expect(parsed[0].entry.width).toBe(2);
  });
});


describe("シャドウの検出とメッセージ（通知先の振り分けは拡張側）", () => {
  function layer(
    id: LayerSource["layer"],
    origin: string,
    entries: LayerSource["entries"],
  ): LayerSource {
    return { layer: id, origin, entries, lengths: [], widths: [] };
  }

  it("同一層内の重複はシャドウとして扱わない（正本 id 重複はコア検証の担当）", () => {
    const cascade = mergeLayers([
      layer("file", "/x/a.yaml", [
        { entry: { id: "dup", kind: "bar", length: 1, width: 2, thickness: 3 } },
        { entry: { id: "dup", kind: "bar", length: 9, width: 2, thickness: 3 } },
      ]),
    ]);
    expect(cascade.shadows).toEqual([]);
    expect(cascade.entries).toHaveLength(1);
    expect(cascade.entries[0].entry.length).toBe(9);
  });

  it("値が異なる場合は両層の値を併記する", () => {
    const cascade = mergeLayers([
      layer("builtin", "/x/builtin.json", [
        { entry: { preset: "k", kind: "bar", length: 1820, width: 2, thickness: 3 } },
      ]),
      layer("user", "/x/user.yaml", [
        { entry: { preset: "k", kind: "bar", length: 1800, width: 2, thickness: 3 } },
      ]),
    ]);
    const message = shadowMessage(cascade.shadows[0]);
    expect(message).toContain("キー k");
    expect(message).toContain("ユーザー層の定義");
    expect(message).toContain("ビルトイン層を隠しています");
    expect(message).toContain("1800");
    expect(message).toContain("1820");
  });

  it("値が同一なら値の併記はしない", () => {
    const entry = { preset: "k", kind: "bar" as const, length: 1, width: 2, thickness: 3 };
    const cascade = mergeLayers([
      layer("builtin", "/x/builtin.json", [{ entry }]),
      layer("user", "/x/user.yaml", [{ entry: { ...entry } }]),
    ]);
    expect(shadowMessage(cascade.shadows[0])).toContain("値は同一");
  });
});

describe("実体化（materialize）", () => {
  function stock(entry: ResolvedStock["entry"], key = "spf/1x4/6f"): ResolvedStock {
    return { key, layer: "builtin", origin: "<test>", entry };
  }

  it("正本 stocks エントリの形になり、preset は id の直後に来る", () => {
    const builtin = loadBuiltinLayer(repoRoot);
    const entry = builtin.entries.find((e) => e.entry.preset === "spf/1x4/6f")!.entry;
    expect(materializeEntry(stock(entry))).toBe(
      '{ id: 1x4-6f, preset: spf/1x4/6f, label: "1×4材 6F", ' +
        "kind: bar, length: 1820, width: 89, thickness: 19 }",
    );
    expect(materializeFields(stock(entry)).map((f) => f.key)).toEqual([
      "id",
      "preset",
      "label",
      "kind",
      "length",
      "width",
      "thickness",
    ]);
  });

  it("tabstop 等のエディタ固有構文を一切含まない（CLI からも使えること）", () => {
    for (const { entry } of loadBuiltinLayer(repoRoot).entries) {
      const text = materializeEntry(stock(entry));
      expect(text).not.toContain("${");
      expect(text).not.toContain("\\");
    }
  });

  it("price はマスタエントリに実在する場合のみ書き出す（S-06 の精密化）", () => {
    const base = { id: "a", kind: "bar" as const, length: 1, width: 2, thickness: 3 };
    expect(materializeEntry(stock(base))).not.toContain("price");
    expect(materializeEntry(stock({ ...base, price: 382 }))).toContain(", price: 382 }");
    // 「ゼロ既定値の捏造」ではなく利用者が書いた実値なので 0 も通す。
    expect(materializeEntry(stock({ ...base, price: 0 }))).toContain(", price: 0 }");
  });

  it("label は YAML の二重引用符スカラーとしてエスケープする", () => {
    const text = materializeEntry(
      stock({ id: "a", label: 'HC「特価」 12" \\ 材', kind: "bar", length: 1, width: 2, thickness: 3 }),
    );
    expect(text).toContain('label: "HC「特価」 12\\" \\\\ 材"');
  });

  it("id が無いマスタエントリはキーから既定 id を導出する", () => {
    expect(defaultStockId(stock({ kind: "bar" }, "spf/1x4/6f"))).toBe("spf-1x4-6f");
    expect(defaultStockId(stock({ id: "1x4-6f" }, "spf/1x4/6f"))).toBe("1x4-6f");
  });

  it("実値の欠けたエントリは実体化の対象にしない", () => {
    expect(isInsertable(stock({ id: "a", kind: "bar", length: 1, width: 2, thickness: 3 }))).toBe(
      true,
    );
    expect(isInsertable(stock({ id: "a", kind: "bar", length: 1 }))).toBe(false);
  });
});

describe("層の切り分け（不変条件）", () => {
  function sourceFiles(dir: string): string[] {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? sourceFiles(path.join(dir, e.name))
          : e.name.endsWith(".ts")
            ? [path.join(dir, e.name)]
            : [],
      );
  }

  function importsOf(file: string): string[] {
    const source = fs.readFileSync(file, "utf-8");
    return [...source.matchAll(/(?:^import[^;]*from\s*|\brequire\()\s*["']([^"']+)["']/gm)].map(
      (m) => m[1],
    );
  }

  it("src/core/stocks/ は vscode を import しない（CLI から使えること）", () => {
    const files = sourceFiles(path.join(repoRoot, "src/core/stocks"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(importsOf(file), file).not.toContain("vscode");
    }
  });

  it("ビルド経路（core/build.ts・core/loader.ts）はカスケードを import しない", () => {
    // SPECS.md §4b: カスケードは補完候補の供給構造であって、ビルドの解決機構
    // ではない。ビルドが層2〜3 を読みにいくと、環境ごとに図が変わり正本の
    // 自己完結性が壊れる。
    for (const file of ["src/core/build.ts", "src/core/loader.ts"]) {
      const imports = importsOf(path.join(repoRoot, file));
      expect(
        imports.filter((i) => /stocks\/|\/stocks$|^\.\/stocks/.test(i)),
        file,
      ).toEqual([]);
    }
  });

  it("loadStockMasterFrom はパス文字列だけで規格材マスタを読める（CLI 経路）", () => {
    const master = loadStockMasterFrom(repoRoot);
    expect(master.builtin.entries.length).toBeGreaterThan(0);
    expect(master.userStocksPath.endsWith(path.join("kidori", "stocks.yaml"))).toBe(true);
  });
});

describe("カスケードの解決は読み取り専用", () => {
  it("正本にもディレクトリにも書き込まない（補完・診断の副作用ゼロ）", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-readonly-"));
    const docPath = path.join(tmp, "a.kidori.yaml");
    const text = "stocks:\n  - { id: a, kind: bar, length: 1, width: 2, thickness: 3 }\n";
    fs.writeFileSync(docPath, text, "utf-8");
    const before = fs.readdirSync(tmp);
    resolveCascade(
      {
        builtin: loadBuiltinLayer(repoRoot),
        userStocksPath: path.join(tmp, "nonexistent", "stocks.yaml"),
      },
      { documentPath: docPath, documentText: text },
    );
    expect(fs.readdirSync(tmp)).toEqual(before);
    expect(fs.readFileSync(docPath, "utf-8")).toBe(text);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("実体化 → 正本 → パースの往復（FIX-3）", () => {
  function stock(entry: ResolvedStock["entry"], key = "spf/1x4/6f"): ResolvedStock {
    return { key, layer: "user", origin: "<test>", entry };
  }

  /** 実体化した1エントリを正本の stocks リストに埋め、YAML としてパースする。 */
  function roundTrip(entry: ResolvedStock["entry"]): Record<string, unknown> {
    const document = `stocks:\n  - ${materializeEntry(stock(entry))}\n`;
    const parsed = parse(document) as { stocks: Record<string, unknown>[] };
    expect(Array.isArray(parsed.stocks), document).toBe(true);
    expect(parsed.stocks).toHaveLength(1);
    return parsed.stocks[0];
  }

  it("引用符・ドル記号・バックスラッシュを含む label が往復で失われない", () => {
    const label = '12" 材 $100 \\ 端材';
    const parsed = roundTrip({
      id: "hc-12",
      label,
      kind: "sheet",
      length: 1820,
      width: 910,
      thickness: 12,
      price: 1980,
    });
    expect(parsed.label).toBe(label);
    expect(parsed).toEqual({
      id: "hc-12",
      preset: "spf/1x4/6f",
      label,
      kind: "sheet",
      length: 1820,
      width: 910,
      thickness: 12,
      price: 1980,
    });
  });

  it("波括弧・カンマ・コロン・改行・タブを含む label も往復する", () => {
    for (const label of [
      "{ 中括弧 }",
      "カンマ, と コロン: を含む",
      "改行\nを含む",
      "タブ\tを含む",
      "全部 {a}, b: c\td\\e\"f$g",
    ]) {
      const parsed = roundTrip({
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

  it("ビルトインの全エントリが往復する", () => {
    for (const { entry } of loadBuiltinLayer(repoRoot).entries) {
      const parsed = roundTrip(entry);
      expect(parsed.label).toBe(entry.label);
      expect(parsed.length).toBe(entry.length);
      expect(parsed.width).toBe(entry.width);
      expect(parsed.thickness).toBe(entry.thickness);
      expect(parsed.kind).toBe(entry.kind);
      expect("price" in parsed).toBe(false);
    }
  });
});
