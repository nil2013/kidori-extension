/**
 * `kidori new` の雛形生成（SPECS.md §3a「① 着手」）の検証。
 *
 * 対象: src/core/scaffold.ts
 *   - **生成した雛形がそのままビルドを通ること**（「これだけで作業を開始できる」の実証）
 *   - 生成した雛形がスキーマ検証（層1）を通ること
 *   - ファイル名の kidori サフィックス自動付与
 *   - 既存ファイルへの上書き拒否
 *   - 未知のプリセットキーでエラーになり、利用可能キーが列挙されること
 *   - モードラインの条件分岐（`kidori.schema.json` の有無）
 *   - `--preset` の反復指定（bar / sheet / 複数）
 *   - AGENTS.md 不在時の併せ生成（薄いポインタ方針。既存ファイルは上書きしない）
 *
 * --- テスト環境の約束 ---
 * カスケードのユーザー層（$XDG_CONFIG_HOME/kidori/stocks.yaml）を読むため、
 * `XDG_CONFIG_HOME` を必ずテンポラリへ向ける（実ユーザーの ~/.config を
 * 読まない。test/core/stocks.test.ts と同じ扱い）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { build } from "../../src/core/build";
import { loadProjectFromRaw, validateAgainstSchema } from "../../src/core/loader";
import { buildSchema, writeBaseSchema } from "../../src/core/schema";
import {
  AGENTS_FILENAME,
  DEFAULT_BAR_PRESET,
  DEFAULT_SHEET_PRESET,
  ScaffoldError,
  createScaffold,
  ensureAgentsFile,
  resolveScaffoldPath,
} from "../../src/core/scaffold";

const repoRoot = path.resolve(__dirname, "../..");

let dir: string;
let xdg: string;
let savedXdg: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kidori-scaffold-"));
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

function scaffold(name: string, presets?: string[]): string {
  const result = createScaffold(path.join(dir, name), {
    rootPath: repoRoot,
    presets,
  });
  return result.path;
}

const silent = (): void => {};

describe("resolveScaffoldPath（ファイル名の解決）", () => {
  it("kidori サフィックスが無ければ .kidori.yaml を付与する", () => {
    expect(resolveScaffoldPath("bookshelf")).toBe("bookshelf.kidori.yaml");
    expect(resolveScaffoldPath("/tmp/a/desk")).toBe("/tmp/a/desk.kidori.yaml");
  });

  it("素の .yaml/.yml/.json は .kidori.yaml に置き換える（二重拡張子を作らない）", () => {
    expect(resolveScaffoldPath("bookshelf.yaml")).toBe("bookshelf.kidori.yaml");
    expect(resolveScaffoldPath("bookshelf.yml")).toBe("bookshelf.kidori.yaml");
    expect(resolveScaffoldPath("bookshelf.json")).toBe("bookshelf.kidori.yaml");
  });

  it("既に kidori サフィックスが付いていればそのまま", () => {
    expect(resolveScaffoldPath("bookshelf.kidori.yaml")).toBe("bookshelf.kidori.yaml");
    expect(resolveScaffoldPath("bookshelf.kidori.yml")).toBe("bookshelf.kidori.yml");
  });
});

describe("createScaffold（既定の雛形）", () => {
  it("サフィックス無しの指定で <name>.kidori.yaml を生成する", () => {
    const p = scaffold("bookshelf");
    expect(p).toBe(path.join(dir, "bookshelf.kidori.yaml"));
    expect(fs.existsSync(p)).toBe(true);
  });

  it("bar 材はアクティブ、sheet 材はコメントアウトで載る（いずれも preset キー付き）", () => {
    const text = fs.readFileSync(scaffold("bookshelf"), "utf-8");
    expect(text).toContain(`preset: ${DEFAULT_BAR_PRESET}`);
    expect(text).toMatch(new RegExp(`^  - \\{ id: .*preset: ${DEFAULT_BAR_PRESET}`, "m"));
    expect(text).toMatch(
      new RegExp(`^  # - \\{ id: .*preset: ${DEFAULT_SHEET_PRESET.replace(/\//g, "/")}`, "m"),
    );

    const data = parse(text) as { stocks: unknown[] };
    // コメントアウトされた sheet 材はパース結果に現れない。
    expect(data.stocks).toHaveLength(1);
  });

  it("meta.project は正本の stem、schemaVersion は 0.4", () => {
    const data = parse(fs.readFileSync(scaffold("bookshelf"), "utf-8")) as {
      meta: { project: string; units: string; schemaVersion: string };
    };
    expect(data.meta).toEqual({
      project: "bookshelf",
      units: "mm",
      schemaVersion: "0.4",
    });
  });

  it("生成した雛形がスキーマ検証（層1）を通る", () => {
    const raw = parse(fs.readFileSync(scaffold("bookshelf"), "utf-8")) as Record<
      string,
      unknown
    >;
    const stockIds = (raw.stocks as { id: string }[]).map((s) => s.id);
    expect(validateAgainstSchema(raw, buildSchema(stockIds))).toEqual([]);
  });

  it("生成した雛形が意味検証（層2）も警告なしで通る", () => {
    const raw = parse(fs.readFileSync(scaffold("bookshelf"), "utf-8"));
    const { project, issues } = loadProjectFromRaw(raw, { baseDir: dir });
    expect(issues).toEqual([]);
    expect(project).not.toBeNull();
  });

  it("生成した雛形がそのままビルドを通る（着手できることの実証）", () => {
    const p = scaffold("bookshelf");
    const result = build(p, { png: false, log: silent });
    expect(result.planIds).toEqual(["A", "B", "C"]);
    expect(result.warnings).toEqual([]);
    expect(result.outDir).toBe(path.join(dir, "bookshelf.out"));
    expect(fs.existsSync(path.join(result.outDir, "plan-A.svg"))).toBe(true);
    expect(fs.existsSync(path.join(result.partsDir, "part-0.svg"))).toBe(true);
    expect(fs.existsSync(path.join(result.outDir, "BUILD-FAILED.txt"))).toBe(false);
  });

  it("コメントアウトされた例（sheet 材・丸穴）を有効化してもビルドが通る", () => {
    const p = scaffold("bookshelf");
    const text = fs.readFileSync(p, "utf-8");
    // 先頭の "# " を外す規則どおりにアンコメントする。
    const enabled = text
      .split("\n")
      .map((line) => (/^(\s*)# (- \{|\{)/.test(line) ? line.replace("# ", "") : line))
      .join("\n");
    fs.writeFileSync(p, enabled, "utf-8");

    const raw = parse(enabled) as { stocks: unknown[]; parts: { features: unknown[] }[] };
    expect(raw.stocks).toHaveLength(2);
    expect(raw.parts[0].features).toHaveLength(2);

    const result = build(p, { png: false, log: silent });
    expect(result.warnings).toEqual([]);
  });

  it("既存ファイルは上書きせずエラーにする", () => {
    const p = scaffold("bookshelf");
    const before = fs.readFileSync(p, "utf-8");
    expect(() => scaffold("bookshelf")).toThrow(ScaffoldError);
    expect(() => scaffold("bookshelf.kidori.yaml")).toThrow(/既にファイルが存在します/);
    expect(fs.readFileSync(p, "utf-8")).toBe(before);
  });

  it(".kidori.json は雛形の生成先にできない（雛形はコメント注釈付き YAML）", () => {
    expect(() => scaffold("bookshelf.kidori.json")).toThrow(/\.kidori\.yaml/);
  });
});

describe("createScaffold（--preset）", () => {
  it("指定したプリセットを実体化して載せる（コメントアウト例は付けない）", () => {
    const p = scaffold("desk", ["spf/2x4/6f", "gouhan/12mm/sabroku"]);
    const text = fs.readFileSync(p, "utf-8");
    expect(text).toContain("preset: spf/2x4/6f");
    expect(text).toContain("preset: gouhan/12mm/sabroku");
    // コメントアウトされた規格材（既定雛形の sheet 材）は付かない。
    expect(text).not.toMatch(/^ {2}# - \{ id:/m);

    const data = parse(text) as { stocks: { id: string; preset: string }[] };
    expect(data.stocks.map((s) => s.preset)).toEqual([
      "spf/2x4/6f",
      "gouhan/12mm/sabroku",
    ]);
    // サンプル部材は先頭の規格材を参照する。
    expect((parse(text) as { parts: { stock: string }[] }).parts[0].stock).toBe(
      data.stocks[0].id,
    );
    expect(build(p, { png: false, log: silent }).warnings).toEqual([]);
  });

  it("sheet 材だけを指定してもビルドが通る（width を書き出す）", () => {
    const p = scaffold("panel", ["shina/4mm/sabroku"]);
    const data = parse(fs.readFileSync(p, "utf-8")) as {
      parts: { width?: number; features: { depth: number }[] }[];
    };
    expect(data.parts[0].width).toBeGreaterThan(0);
    // 溝深さは原材厚み（4mm）の半分に丸められ、貫通 warning にならない。
    expect(data.parts[0].features[0].depth).toBe(2);
    expect(build(p, { png: false, log: silent }).warnings).toEqual([]);
  });

  it("同じキーを重複指定しても1件にまとめる", () => {
    const p = scaffold("dup", ["spf/1x4/6f", "spf/1x4/6f"]);
    const data = parse(fs.readFileSync(p, "utf-8")) as { stocks: unknown[] };
    expect(data.stocks).toHaveLength(1);
  });

  it("未知のキーはエラーにし、利用可能なキーを一覧表示する", () => {
    let message = "";
    try {
      scaffold("bad", ["spf/9x9/99f"]);
    } catch (e) {
      expect(e).toBeInstanceOf(ScaffoldError);
      message = (e as Error).message;
    }
    expect(message).toContain("spf/9x9/99f");
    // ビルトインの全キーが列挙される（十数件程度なので一覧表示で足りる）。
    const builtin = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "assets", "stock-presets.json"), "utf-8"),
    ) as { presets: { preset: string }[] };
    for (const { preset } of builtin.presets) {
      expect(message).toContain(preset);
    }
    // 失敗時はファイルを作らない。
    expect(fs.existsSync(path.join(dir, "bad.kidori.yaml"))).toBe(false);
  });

  it("ディレクトリ層の stocks.yaml で追加した独自材も --preset に使える", () => {
    fs.writeFileSync(
      path.join(dir, "stocks.yaml"),
      'stocks:\n  - { id: my-bar, label: "自前の角材", kind: bar, length: 1000, width: 45, thickness: 45 }\n',
      "utf-8",
    );
    const p = scaffold("custom", ["my-bar"]);
    const text = fs.readFileSync(p, "utf-8");
    expect(text).toContain("preset: my-bar");
    expect(text).toContain('label: "自前の角材"');
    expect(build(p, { png: false, log: silent }).warnings).toEqual([]);
  });
});

describe("モードライン（SPECS.md §4b）", () => {
  it("kidori.schema.json が無ければコメントアウトし、有効化のヒントを添える", () => {
    const text = fs.readFileSync(scaffold("bookshelf"), "utf-8");
    const first = text.split("\n")[0];
    expect(first.startsWith("# yaml-language-server:")).toBe(false);
    expect(text).toContain("# # yaml-language-server: $schema=./kidori.schema.json");
    expect(text).toContain("`kidori init`");
  });

  it("kidori.schema.json が有れば先頭行を有効なモードラインにする", () => {
    writeBaseSchema(dir);
    const text = fs.readFileSync(scaffold("bookshelf"), "utf-8");
    expect(text.split("\n")[0]).toBe(
      "# yaml-language-server: $schema=./kidori.schema.json",
    );
  });

  it("コメントアウト形は先頭の \"# \" を1つ外すと有効なモードラインになる", () => {
    const text = fs.readFileSync(scaffold("bookshelf"), "utf-8");
    const line = text
      .split("\n")
      .find((l) => l.startsWith("# # yaml-language-server:")) as string;
    expect(line.replace("# ", "")).toBe(
      "# yaml-language-server: $schema=./kidori.schema.json",
    );
  });
});

describe("createScaffold（AGENTS.md の併せ生成。SPECS.md §3a）", () => {
  it("AGENTS.md が不在なら、雛形と同じディレクトリに併せて生成する", () => {
    expect(fs.existsSync(path.join(dir, AGENTS_FILENAME))).toBe(false);
    const result = createScaffold(path.join(dir, "bookshelf"), { rootPath: repoRoot });
    expect(result.agentsCreated).toBe(true);
    expect(result.agentsPath).toBe(path.join(dir, AGENTS_FILENAME));
    expect(fs.existsSync(path.join(dir, AGENTS_FILENAME))).toBe(true);
    // kidori init と同一のテンプレート（薄いポインタ方針）。
    const text = fs.readFileSync(path.join(dir, AGENTS_FILENAME), "utf-8");
    expect(text).toContain("kidori schema");
    expect(text).toContain("node dist/cli.js");
  });

  it("既存の AGENTS.md は絶対に上書きしない（内容が保存される）", () => {
    const custom = "# 独自のメモ\nこの内容は保持されるべき\n";
    fs.writeFileSync(path.join(dir, AGENTS_FILENAME), custom, "utf-8");

    const result = createScaffold(path.join(dir, "bookshelf"), { rootPath: repoRoot });
    expect(result.agentsCreated).toBe(false);
    expect(fs.readFileSync(path.join(dir, AGENTS_FILENAME), "utf-8")).toBe(custom);
  });

  it("「ディレクトリ直下」は生成した kidori ファイルと同じディレクトリを指す（ネストしたパス）", () => {
    const nested = path.join(dir, "sub", "deep");
    const result = createScaffold(path.join(nested, "desk"), { rootPath: repoRoot });
    expect(fs.existsSync(path.join(nested, AGENTS_FILENAME))).toBe(true);
    expect(result.agentsPath).toBe(path.join(nested, AGENTS_FILENAME));
    // 親ディレクトリ（dir 直下）には生成されない。
    expect(fs.existsSync(path.join(dir, AGENTS_FILENAME))).toBe(false);
  });

  it("2回 new しても2回目は AGENTS.md を壊さない（同一ディレクトリへの複数プロジェクト同居）", () => {
    createScaffold(path.join(dir, "bookshelf"), { rootPath: repoRoot });
    const before = fs.readFileSync(path.join(dir, AGENTS_FILENAME), "utf-8");

    const result = createScaffold(path.join(dir, "desk"), { rootPath: repoRoot });
    expect(result.agentsCreated).toBe(false);
    expect(fs.readFileSync(path.join(dir, AGENTS_FILENAME), "utf-8")).toBe(before);
  });
});

describe("ensureAgentsFile（kidori new / kidori init 共有ヘルパ）", () => {
  it("不在なら作成し created: true を返す", () => {
    const result = ensureAgentsFile(dir, repoRoot);
    expect(result.created).toBe(true);
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it("既存なら書き換えず created: false を返す", () => {
    const custom = "# 独自のメモ\n";
    fs.writeFileSync(path.join(dir, AGENTS_FILENAME), custom, "utf-8");
    const result = ensureAgentsFile(dir, repoRoot);
    expect(result.created).toBe(false);
    expect(fs.readFileSync(result.path, "utf-8")).toBe(custom);
  });
});
