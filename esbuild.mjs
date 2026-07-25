import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));

// 拡張本体と CLI の2エントリをバンドルする。
// vscode は拡張ホストが提供、@resvg/resvg-js はネイティブモジュールのため external。
const common = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: true,
  external: ["vscode", "@resvg/resvg-js"],
  logLevel: "info",
};

await esbuild.build({
  ...common,
  entryPoints: ["src/extension/extension.ts"],
  outfile: "dist/extension.js",
});

await esbuild.build({
  ...common,
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
});

// ---------------------------------------------------------------------------
// 基底スキーマの静的同梱（SPECS.md §3a・§4b）
//
// `assets/kidori.schema.json` は src/core/schema.ts の `baseSchemaJson()`
// （動的 enum なし）から**生成する**。手書きのコピーは置かない（drift 経路に
// なるため）。スキーマの単一ソースは src/core/schema.ts のままで、拡張は
// contributes.jsonValidation（`*.kidori.json`）と実行時の json.schemas 登録
// （内容判定で拾った素の *.json の救済経路）からこのファイルを参照する。
// ---------------------------------------------------------------------------
const schemaBundle = path.join(root, "dist", ".schema-gen.cjs");
await esbuild.build({
  ...common,
  sourcemap: false,
  logLevel: "warning",
  entryPoints: ["src/core/schema.ts"],
  outfile: schemaBundle,
});
const require = createRequire(import.meta.url);
const { baseSchemaJson } = require(schemaBundle);
fs.rmSync(schemaBundle, { force: true });

const assetsDir = path.join(root, "assets");
fs.mkdirSync(assetsDir, { recursive: true });
const schemaAsset = path.join(assetsDir, "kidori.schema.json");
fs.writeFileSync(schemaAsset, baseSchemaJson(), "utf-8");
console.log(
  `\n  assets/kidori.schema.json  ${fs.statSync(schemaAsset).size}b  (src/core/schema.ts より生成)\n`,
);
