import * as esbuild from "esbuild";

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
