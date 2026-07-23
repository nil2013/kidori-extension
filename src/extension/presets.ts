/**
 * 規格材マスタ（プリセット）の読み込み。
 *
 * 拡張同梱の assets/stock-presets.json を基本とし、ワークスペース直下の
 * kidori.presets.json（任意）をマージする（同名 name のプリセットは上書き、
 * lengths / widths は和集合）。SPECS.md §4b「ユーザー追記可」に対応する。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export interface StockPreset {
  name: string;
  id: string;
  kind: "bar" | "sheet";
  length: number;
  width: number;
  thickness: number;
}

export interface Presets {
  stocks: StockPreset[];
  lengths: number[];
  widths: number[];
}

const EMPTY: Presets = { stocks: [], lengths: [], widths: [] };

function readPresetFile(filePath: string): Partial<Presets> | null {
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(text) as Partial<Presets>;
  } catch {
    return null;
  }
}

/**
 * 同梱プリセット＋ワークスペースの kidori.presets.json をマージして返す。
 */
export function loadPresets(context: vscode.ExtensionContext): Presets {
  const bundled =
    readPresetFile(
      path.join(context.extensionPath, "assets", "stock-presets.json"),
    ) ?? EMPTY;

  const merged: Presets = {
    stocks: [...(bundled.stocks ?? [])],
    lengths: [...(bundled.lengths ?? [])],
    widths: [...(bundled.widths ?? [])],
  };

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const user = readPresetFile(
      path.join(folder.uri.fsPath, "kidori.presets.json"),
    );
    if (!user) {
      continue;
    }
    for (const stock of user.stocks ?? []) {
      const i = merged.stocks.findIndex((s) => s.name === stock.name);
      if (i >= 0) {
        merged.stocks[i] = stock;
      } else {
        merged.stocks.push(stock);
      }
    }
    merged.lengths = [...new Set([...merged.lengths, ...(user.lengths ?? [])])];
    merged.widths = [...new Set([...merged.widths, ...(user.widths ?? [])])];
  }

  merged.lengths.sort((a, b) => a - b);
  merged.widths.sort((a, b) => a - b);
  return merged;
}
