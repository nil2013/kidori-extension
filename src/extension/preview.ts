/**
 * 拡張内 Webview プレビュー（SPECS.md §3）。
 *
 * 木取り図タブ／加工指示図タブを持つ WebviewPanel。ビルドのたびに
 * postMessage で最新の SVG・メトリクスを流し込み、即時更新する。
 * 「この案を採用」ボタンで selectedPlan の書き換え（→保存→再ビルド）を
 * 拡張側へ依頼する。
 */

import * as vscode from "vscode";
import type { Summary } from "../core/metrics";

export interface PreviewData {
  summary: Summary;
  plans: { id: string; svg: string }[];
  parts: { id: string; label: string; svg: string }[];
}

export type PlanAction =
  | { command: "selectPlan"; planId: string }
  | { command: "clearSelection" }
  | { command: "rebuild" };

export class KidoriPreview {
  private panel: vscode.WebviewPanel | null = null;
  private lastData: PreviewData | null = null;

  constructor(private readonly onAction: (action: PlanAction) => void) {}

  get visible(): boolean {
    return this.panel !== null;
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "kidoriPreview",
      "kidori プレビュー",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel.webview.onDidReceiveMessage((msg: PlanAction) => {
      this.onAction(msg);
    });
    this.panel.webview.html = this.html();
    if (this.lastData) {
      void this.panel.webview.postMessage({ command: "update", data: this.lastData });
    }
  }

  update(data: PreviewData): void {
    this.lastData = data;
    if (this.panel) {
      void this.panel.webview.postMessage({ command: "update", data });
    }
  }

  showError(message: string): void {
    if (this.panel) {
      void this.panel.webview.postMessage({ command: "error", message });
    }
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    return /* html */ `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<style>
  body { font-family: var(--vscode-font-family); padding: 0 12px 12px; }
  .tabs { position: sticky; top: 0; background: var(--vscode-editor-background);
          padding: 10px 0 8px; display: flex; gap: 8px; z-index: 10; }
  .tab { border: 1px solid var(--vscode-panel-border); background: transparent;
         color: var(--vscode-foreground); padding: 4px 14px; cursor: pointer; border-radius: 3px; }
  .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .plan-chips { display: flex; gap: 6px; margin: 8px 0; flex-wrap: wrap; }
  .chip { border: 1px solid var(--vscode-panel-border); padding: 3px 10px;
          border-radius: 12px; cursor: pointer; background: transparent;
          color: var(--vscode-foreground); }
  .chip.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .metrics { font-size: 12px; opacity: .9; margin: 6px 0 10px; line-height: 1.7; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 8px; font-size: 11px;
           margin-left: 6px; background: var(--vscode-badge-background);
           color: var(--vscode-badge-foreground); }
  .badge.star { background: #b8860b; color: #fff; }
  .svgbox { background: #fff; border: 1px solid var(--vscode-panel-border);
            overflow: auto; margin-bottom: 16px; }
  .svgbox svg { display: block; max-width: none; }
  .actions { margin: 8px 0 14px; display: flex; gap: 8px; }
  .btn { border: none; background: var(--vscode-button-background);
         color: var(--vscode-button-foreground); padding: 5px 14px; cursor: pointer;
         border-radius: 3px; }
  .btn.secondary { background: var(--vscode-button-secondaryBackground);
                   color: var(--vscode-button-secondaryForeground); }
  .part-title { font-weight: 600; margin: 14px 0 4px; }
  .error { color: var(--vscode-errorForeground); white-space: pre-wrap; margin: 10px 0; }
  .empty { opacity: .7; margin-top: 30px; }
</style>
</head>
<body>
  <div class="tabs">
    <button class="tab active" id="tab-plans">木取り図</button>
    <button class="tab" id="tab-parts">加工指示図</button>
  </div>
  <div id="error" class="error" hidden></div>
  <div id="view-plans"><div class="empty">ビルド待ち（project.yaml を保存すると更新されます）</div></div>
  <div id="view-parts" hidden></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let data = null;
  let activePlanId = null;

  const el = (id) => document.getElementById(id);

  el("tab-plans").addEventListener("click", () => switchTab("plans"));
  el("tab-parts").addEventListener("click", () => switchTab("parts"));

  function switchTab(which) {
    el("tab-plans").classList.toggle("active", which === "plans");
    el("tab-parts").classList.toggle("active", which === "parts");
    el("view-plans").hidden = which !== "plans";
    el("view-parts").hidden = which !== "parts";
  }

  function fmtYield(y) { return (y * 100).toFixed(1) + "%"; }
  function fmtCost(c) { return c === null ? "—" : c.toLocaleString("ja-JP") + " 円"; }

  function renderPlans() {
    const view = el("view-plans");
    view.textContent = "";
    if (!data || data.plans.length === 0) {
      view.innerHTML = '<div class="empty">割付案がありません</div>';
      return;
    }
    const summary = data.summary;
    if (!activePlanId || !data.plans.some(p => p.id === activePlanId)) {
      activePlanId = summary.recommendedPlan ?? data.plans[0].id;
    }

    const chips = document.createElement("div");
    chips.className = "plan-chips";
    for (const plan of data.plans) {
      const ps = summary.plans.find(p => p.id === plan.id);
      const chip = document.createElement("button");
      chip.className = "chip" + (plan.id === activePlanId ? " active" : "");
      let label = "案 " + plan.id;
      if (ps && ps.recommended) label += " ★";
      if (summary.selectedPlan === plan.id) label += "【採用】";
      chip.textContent = label;
      chip.addEventListener("click", () => { activePlanId = plan.id; renderPlans(); });
      chips.appendChild(chip);
    }
    view.appendChild(chips);

    const ps = summary.plans.find(p => p.id === activePlanId);
    if (ps) {
      const m = document.createElement("div");
      m.className = "metrics";
      const hasSheet = ps.stocks.some(s => s.kind === "sheet");
      const cutLabel = hasSheet ? "カット回数（概算）" : "カット回数";
      const counts = Object.entries(ps.totals.stockCounts)
        .map(([id, n]) => id + " × " + n).join("、 ");
      let badges = "";
      if (ps.recommended) badges += '<span class="badge star">★ 推奨案</span>';
      if (ps.exactMatch) badges += '<span class="badge">厳密解と一致</span>';
      if (summary.selectedPlan === ps.id) badges += '<span class="badge">採用済み</span>';
      m.innerHTML =
        "必要本数: " + counts + "<br>" +
        "概算費用: " + fmtCost(ps.totals.cost) +
        " ／ 歩留まり: " + fmtYield(ps.totals.yield) +
        " ／ " + cutLabel + ": " + ps.totals.cutCount +
        (ps.rank ? " ／ 順位: " + ps.rank + " 位" : "") + badges;
      view.appendChild(m);

      const exact = summary.exact;
      if (exact && (exact.reason || exact.matchesPlan)) {
        const e = document.createElement("div");
        e.className = "metrics";
        e.textContent = exact.matchesPlan
          ? "厳密探索: 案 " + exact.matchesPlan + " が最適構成と一致しました"
          : "厳密探索: " + exact.reason;
        view.appendChild(e);
      }
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    if (summary.selectedPlan === activePlanId) {
      const btn = document.createElement("button");
      btn.className = "btn secondary";
      btn.textContent = "採用を解除（全案を再生成）";
      btn.addEventListener("click", () => vscode.postMessage({ command: "clearSelection" }));
      actions.appendChild(btn);
    } else {
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = "この案を採用";
      btn.addEventListener("click", () =>
        vscode.postMessage({ command: "selectPlan", planId: activePlanId }));
      actions.appendChild(btn);
    }
    view.appendChild(actions);

    const plan = data.plans.find(p => p.id === activePlanId);
    if (plan) {
      const box = document.createElement("div");
      box.className = "svgbox";
      box.innerHTML = plan.svg;
      view.appendChild(box);
    }
  }

  function renderParts() {
    const view = el("view-parts");
    view.textContent = "";
    if (!data || data.parts.length === 0) {
      view.innerHTML = '<div class="empty">加工指示図がありません</div>';
      return;
    }
    for (const part of data.parts) {
      const title = document.createElement("div");
      title.className = "part-title";
      title.textContent = part.id + "（" + part.label + "）";
      view.appendChild(title);
      const box = document.createElement("div");
      box.className = "svgbox";
      box.innerHTML = part.svg;
      view.appendChild(box);
    }
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.command === "update") {
      data = msg.data;
      el("error").hidden = true;
      renderPlans();
      renderParts();
    } else if (msg.command === "error") {
      el("error").textContent = msg.message;
      el("error").hidden = false;
    }
  });
</script>
</body>
</html>`;
  }
}
