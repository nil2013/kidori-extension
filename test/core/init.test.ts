/**
 * `kidori init` のディレクトリ初期化（SPECS.md §3a）の検証。
 *
 * 対象: src/core/init.ts
 *   - 生成物4種（AGENTS.md / .gitignore / kidori.schema.json / stocks.yaml）
 *   - **冪等性**（2回実行しても既存ファイルを壊さない）
 *   - `.gitignore` は既存なら追記のみ（既存行を保持する）
 *   - `kidori.schema.json` が `baseSchemaJson()` と一致すること
 *     （手書きコピーでないことの回帰検知。単一ソースは core/schema.ts）
 *   - `--with-stocks` の生成物が `stocksFile:` の参照先として実際に使えること
 *   - AGENTS.md が形式仕様の本文を複製せず、スキーマを参照していること
 *
 * --- テスト環境の約束 ---
 * `XDG_CONFIG_HOME` をテンポラリへ向ける（実ユーザーの ~/.config を読まない）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { build } from "../../src/core/build";
import { loadStocksFile } from "../../src/core/loader";
import { baseSchemaJson } from "../../src/core/schema";
import {
  AGENTS_FILENAME,
  OUT_IGNORE_PATTERN,
  SHARED_STOCKS_FILENAME,
  initDirectory,
} from "../../src/core/init";
import { BASE_SCHEMA_FILENAME } from "../../src/core/kidorifile";
import { createScaffold } from "../../src/core/scaffold";

const repoRoot = path.resolve(__dirname, "../..");

let dir: string;
let xdg: string;
let savedXdg: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-init-"));
  xdg = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-xdg-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
});

afterEach(() => {
  if (savedXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = savedXdg;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(xdg, { recursive: true, force: true });
});

function init(withStocks = false) {
  return initDirectory(dir, { rootPath: repoRoot, withStocks });
}

function read(name: string): string {
  return fs.readFileSync(path.join(dir, name), "utf-8");
}

function statusOf(
  result: ReturnType<typeof initDirectory>,
  file: string,
): string | undefined {
  return result.actions.find((a) => a.file === file)?.status;
}

const silent = (): void => {};

describe("initDirectory（生成物）", () => {
  it("AGENTS.md / .gitignore / kidori.schema.json を生成する（stocks.yaml は既定で作らない）", () => {
    const result = init();
    expect(result.dir).toBe(path.resolve(dir));
    expect(result.actions.map((a) => a.file)).toEqual([
      AGENTS_FILENAME,
      ".gitignore",
      BASE_SCHEMA_FILENAME,
    ]);
    expect(result.actions.every((a) => a.status === "created")).toBe(true);
    expect(fs.existsSync(path.join(dir, SHARED_STOCKS_FILENAME))).toBe(false);
  });

  it("存在しないディレクトリは作成する", () => {
    const nested = path.join(dir, "a", "b");
    const result = initDirectory(nested, { rootPath: repoRoot });
    expect(fs.existsSync(path.join(nested, AGENTS_FILENAME))).toBe(true);
    expect(result.actions).toHaveLength(3);
  });

  it("kidori.schema.json は baseSchemaJson() と完全一致する（手書きコピーを作らない）", () => {
    init();
    expect(read(BASE_SCHEMA_FILENAME)).toBe(baseSchemaJson());
    // 生成物が実際に JSON Schema として読めること。
    const schema = JSON.parse(read(BASE_SCHEMA_FILENAME)) as Record<string, unknown>;
    expect(schema.title).toBe("kidori project");
    // 動的 enum（parts[].stock）は含まない基底スキーマである
    // （face/dir/end 等の静的 enum は含む）。
    const stockProp = (
      (
        ((schema.properties as Record<string, any>).parts.items as Record<string, any>)
          .properties as Record<string, any>
      ).stock as Record<string, unknown>
    );
    expect(stockProp.enum).toBeUndefined();
  });

  it(".gitignore を新規作成する場合は *.out/ を含む", () => {
    init();
    const text = read(".gitignore");
    expect(text.split(/\r?\n/)).toContain(OUT_IGNORE_PATTERN);
  });
});

describe("AGENTS.md（SPECS.md §3b「薄いポインタ方針」のエージェント導線）", () => {
  it("コマンド一覧（new/init/build/select/check/schema）を含む", () => {
    init();
    const text = read(AGENTS_FILENAME);
    for (const cmd of [
      "kidori new",
      "kidori init",
      "kidori build",
      "kidori select",
      "kidori check",
      "kidori schema",
    ]) {
      expect(text).toContain(cmd);
    }
  });

  it("PATH 非依存の実行方法（KIDORI_CLI 経由）を含む", () => {
    init();
    const text = read(AGENTS_FILENAME);
    expect(text).toContain("KIDORI_CLI");
    expect(text).toContain("npm link");
  });

  it("絶対パスを埋め込まない（端末ごとに異なるパスをコミットしない）", () => {
    init();
    const text = read(AGENTS_FILENAME);
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\/);
  });

  it("探索を促す記述を含まない（CWD 脱出の指示を書かない）", () => {
    init();
    const text = read(AGENTS_FILENAME);
    expect(text).not.toContain(".vscode/extensions");
  });

  it("「形式仕様は kidori schema で取得する」旨を含む", () => {
    init();
    const text = read(AGENTS_FILENAME);
    expect(text).toMatch(/kidori schema <ファイル名>/);
  });

  it("出力物（<ファイル名>.out/ 配下。schema.json を含む）の説明を含む", () => {
    init();
    const text = read(AGENTS_FILENAME);
    expect(text).toContain(".out/");
    expect(text).toContain("schema.json");
    expect(text).toContain("summary.json");
  });

  it("assembly ごとの変種面（marks を持つ場合のファイル名規則）の説明を含む", () => {
    init();
    const text = read(AGENTS_FILENAME);
    expect(text).toContain("parts/<assembly id>-<部材 id>.svg");
    expect(text).toContain("変種面");
  });

  it("形式仕様の要約を複製しない（旧: kidori.schema.json が正本／最小サンプル YAML／データモデルの解説）", () => {
    init();
    const text = read(AGENTS_FILENAME);
    // 旧テンプレートの「kidori.schema.json が正本」という静的ファイル参照方式は
    // 撤回されている（SPECS.md §3b: 問い合わせ方式へ置き換え）。
    expect(text).not.toMatch(/`kidori\.schema\.json`.*正本/);
    // 形式仕様の要約（データモデルの説明・最小サンプル YAML）を複製していない。
    expect(text).not.toContain("```yaml");
    expect(text).not.toContain("meta.schemaVersion");
    expect(text).not.toContain("左下原点");
    expect(text).not.toContain("トップレベルは");
    expect(text).not.toContain("来歴キー");
    // スキーマの description 本文の丸写し（drift 経路）になっていないこと。
    expect(text).not.toContain("1〜3 にクランプされる");
    expect(text).not.toContain("挽き割り");
  });
});

describe("initDirectory（冪等性）", () => {
  it("2回実行しても既存ファイルを壊さず exit 相当の結果は成功のまま", () => {
    init(true);
    const before = {
      agents: read(AGENTS_FILENAME),
      gitignore: read(".gitignore"),
      schema: read(BASE_SCHEMA_FILENAME),
      stocks: read(SHARED_STOCKS_FILENAME),
    };

    const second = init(true);
    expect(second.actions.map((a) => a.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(read(AGENTS_FILENAME)).toBe(before.agents);
    expect(read(".gitignore")).toBe(before.gitignore);
    expect(read(BASE_SCHEMA_FILENAME)).toBe(before.schema);
    expect(read(SHARED_STOCKS_FILENAME)).toBe(before.stocks);
  });

  it("ユーザーが書き換えた AGENTS.md は上書きしない", () => {
    fs.writeFileSync(path.join(dir, AGENTS_FILENAME), "# 独自のメモ\n", "utf-8");
    const result = init();
    expect(statusOf(result, AGENTS_FILENAME)).toBe("skipped");
    expect(read(AGENTS_FILENAME)).toBe("# 独自のメモ\n");
  });

  it("陳腐化した kidori.schema.json はスキップしつつ相違を報告する", () => {
    fs.writeFileSync(path.join(dir, BASE_SCHEMA_FILENAME), "{}\n", "utf-8");
    const result = init();
    const action = result.actions.find((a) => a.file === BASE_SCHEMA_FILENAME);
    expect(action?.status).toBe("skipped");
    expect(action?.message).toContain("現行の基底スキーマと異なります");
    expect(read(BASE_SCHEMA_FILENAME)).toBe("{}\n");
  });
});

describe(".gitignore（追記のみ）", () => {
  it("既存ファイルに *.out/ が無ければ追記し、既存行は保持する", () => {
    const existing = "node_modules/\n*.log\n";
    fs.writeFileSync(path.join(dir, ".gitignore"), existing, "utf-8");

    const result = init();
    expect(statusOf(result, ".gitignore")).toBe("appended");

    const text = read(".gitignore");
    expect(text.startsWith(existing)).toBe(true);
    expect(text.split(/\r?\n/)).toContain(OUT_IGNORE_PATTERN);
    expect(text.split(/\r?\n/)).toContain("node_modules/");
    expect(text.split(/\r?\n/)).toContain("*.log");
  });

  it("末尾に改行が無い既存ファイルでも最終行を壊さない", () => {
    fs.writeFileSync(path.join(dir, ".gitignore"), "dist/", "utf-8");
    init();
    const lines = read(".gitignore").split("\n");
    expect(lines[0]).toBe("dist/");
    expect(lines).toContain(OUT_IGNORE_PATTERN);
  });

  it("既に *.out/ があれば追記しない（重複行を作らない）", () => {
    const existing = `# 既存\n${OUT_IGNORE_PATTERN}\n`;
    fs.writeFileSync(path.join(dir, ".gitignore"), existing, "utf-8");
    const result = init();
    expect(statusOf(result, ".gitignore")).toBe("skipped");
    expect(read(".gitignore")).toBe(existing);
  });

  it("*.out（スラッシュ無し）でも除外済みとみなす", () => {
    fs.writeFileSync(path.join(dir, ".gitignore"), "*.out\n", "utf-8");
    expect(statusOf(init(), ".gitignore")).toBe("skipped");
    expect(read(".gitignore")).toBe("*.out\n");
  });
});

describe("--with-stocks（共有 stocks.yaml）", () => {
  it("正本の stocks エントリと同一形で生成する", () => {
    init(true);
    const data = parse(read(SHARED_STOCKS_FILENAME)) as {
      stocks: { id: string; preset: string; kind: string }[];
    };
    expect(Object.keys(data)).toEqual(["stocks"]);
    expect(data.stocks.length).toBeGreaterThanOrEqual(2);
    expect(data.stocks.map((s) => s.kind)).toContain("bar");
    expect(data.stocks.map((s) => s.kind)).toContain("sheet");
    for (const s of data.stocks) {
      expect(s.preset).toBeTruthy();
    }
  });

  it("stocksFile: の参照先として実際に使える（core の loadStocksFile を通る）", () => {
    init(true);
    const result = loadStocksFile(dir, `./${SHARED_STOCKS_FILENAME}`);
    expect(result.issues).toEqual([]);
    expect(result.stocks.length).toBeGreaterThanOrEqual(2);
    expect(result.resolvedPath).toBe(path.join(dir, SHARED_STOCKS_FILENAME));
  });

  it("stocksFile: 経由で参照した正本がビルドできる", () => {
    init(true);
    const p = path.join(dir, "shared.kidori.yaml");
    const stocks = (
      parse(read(SHARED_STOCKS_FILENAME)) as { stocks: { id: string }[] }
    ).stocks;
    fs.writeFileSync(
      p,
      [
        'meta: { project: 共有, units: mm, schemaVersion: "0.5" }',
        `stocksFile: ./${SHARED_STOCKS_FILENAME}`,
        "stocks: []",
        "parts:",
        `  - { id: p1, label: 部材, qty: 2, stock: ${stocks[0].id}, length: 500 }`,
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = build(p, { png: false, log: silent });
    expect(result.warnings).toEqual([]);
    expect(result.planIds.length).toBeGreaterThan(0);
  });

  it("生成した stocks.yaml はカスケードのディレクトリ層としても効く（kidori new --preset）", () => {
    init(true);
    const stocks = (
      parse(read(SHARED_STOCKS_FILENAME)) as { stocks: { preset: string }[] }
    ).stocks;
    const p = createScaffold(path.join(dir, "from-dir"), {
      rootPath: repoRoot,
      presets: [stocks[0].preset],
    }).path;
    expect(fs.readFileSync(p, "utf-8")).toContain(`preset: ${stocks[0].preset}`);
  });
});
