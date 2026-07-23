# kidori

規格材（1×4材・2×4材・サブロク合板など）から部材を切り出すための木取り図・加工指示図ジェネレータ（VS Code 拡張）。

## 1. 概要

DIY設計では、寸法を変更するたびに木取り図・加工指示図を描き直す作業が発生する。kidori は、この描き直しコストを解消するためのツールである。

部材・原材・加工フィーチャを `project.yaml`（正本データ）に記述して保存すると、拡張が自動でビルドを実行し、木取り図（SVG/PNG）・加工指示図（SVG/PNG）・集計（`summary.json`）を再生成する。結果は拡張内の Webview プレビュー（木取り図タブ／加工指示図タブ）で即時確認できる。

割付（どの原材にどの部材を詰めるか）は、FFD / BFD / 同種部材グループ化などのヒューリスティクスで案 A/B/C を生成し、`settings.rank` の優先順（既定: 概算費用 → 歩留まり → カット回数）で自動ランク付けして最上位を推奨案（★）として提示する。部材数が少ない場合は厳密探索（`settings.exact`）で真の最適構成も確認し、ヒューリスティック案が最適に一致すればその旨を表示する。最終選択は人が行う（プレビューの「この案を採用」／コマンドパレット／`kidori select A`）。

構成は2層:

- **コアエンジン**（`src/core/`）: パース・検証・スキーマ生成・割付・SVG/PNG 生成を担う、エディタ非依存の TypeScript ライブラリ
- **拡張層**（`src/extension/`）: 保存監視・補完/検証・Webview プレビュー・コマンド

補助として、同一コアを薄くラップした CLI `kidori`（`dist/cli.js`）も同梱する（バッチ処理・VS Code のない環境向け。主経路は拡張）。

## 2. 前提環境

- VS Code 1.90 以降
- 依存拡張: [Red Hat YAML](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)（`.vsix` インストール時に extensionDependencies として要求される。キー名補完・型検証・ホバー説明はこの拡張がスキーマを解釈して提供し、スキーマ自体は kidori が動的に登録する）
- ビルド（開発時）: Node.js 18 以降

Python・cairo 等の追加ランタイムは不要。PNG 変換は拡張内の resvg-js（ネイティブモジュール）で行う。

## 3. インストール

### (a) `.vsix` をビルドしてインストール

```bash
git clone <このリポジトリのURL> kidori-extension
cd kidori-extension
npm install
npm run package        # dist/ をビルドして kidori-0.4.0.vsix を生成
code --install-extension kidori-0.4.0.vsix
```

注意: resvg-js はプラットフォーム別のネイティブバイナリを含むため、`.vsix` は生成したマシンと同じ OS/アーキテクチャでのみ PNG 出力が有効になる。他プラットフォームでは PNG 生成が自動スキップされ、SVG と summary.json は通常どおり生成される。

### (b) 開発モード（拡張開発ホスト）

VS Code で本リポジトリを開き、`npm install && npm run build` の後に F5（拡張のデバッグ実行）で起動する。

## 4. 使い方

1. 作業フォルダに `project.yaml` を作成する（`examples/bookshelf/project.yaml` を雛形にできる）。
2. VS Code で開くと、kidori 拡張が編集中の内容からスキーマを動的に登録する。キー名・enum の補完、型検証、日本語ホバー説明が有効になる。`stocks[].id` を書き換えると、ビルドを待たずに `parts[].stock` の補完候補・検証が追従する。
3. `stocks:` 配下で補完（Ctrl+Space）すると規格材プリセット（「1×4材 6F（1820×89×19）」等）が候補に出て、確定と同時に寸法一式が挿入される。`length:` / `width:` の値位置では定尺候補（910 / 1820 / 2440 …）が出る。
4. コマンドパレットから「kidori: プレビューを開く」を実行する。
5. `project.yaml` を保存するたびに自動ビルドが走り、`out/` 配下の SVG/PNG/summary.json とプレビューが更新される。
6. 案を比較し、プレビューの「この案を採用」（またはコマンド「kidori: 案を採用する」）で `settings.selectedPlan` を書き込む。以後は採用案のみ再生成され、加工指示図に配置番号が連動する。

### コマンド一覧

| コマンド | 内容 |
| --- | --- |
| kidori: ビルド（木取り図・加工指示図を再生成） | 手動ビルド |
| kidori: プレビューを開く | Webview プレビュー（木取り図／加工指示図） |
| kidori: 案を採用する | QuickPick で案を選択して selectedPlan を書き込み |

### 設定

| 設定 | 既定値 | 内容 |
| --- | --- | --- |
| `kidori.buildOnSave` | true | project.yaml / project.json 保存時の自動ビルド |
| `kidori.png.enabled` | true | PNG も生成する |
| `kidori.png.scale` | 2 | PNG のスケール倍率 |

### 規格材プリセットの追記

ワークスペース直下に `kidori.presets.json` を置くと、同梱プリセット（`assets/stock-presets.json`）にマージされる（同名 `name` は上書き、`lengths` / `widths` は和集合）。

```json
{
  "stocks": [
    { "name": "杉野地板", "id": "sugi-noji", "kind": "bar", "length": 2000, "width": 180, "thickness": 12 }
  ],
  "lengths": [2000]
}
```

## 5. 正本データ（project.yaml）

トップレベルは `meta` / `settings` / `stocks` / `parts` の4区画。単位は mm 固定。詳細は SPECS.md §4 を参照。

```yaml
meta: { project: 書棚, units: mm, schemaVersion: "0.2" }

settings:
  kerf: 3                    # 鋸刃厚（mm）
  edgeTrim: 5                # 木口の捨て代（mm）
  candidates: 3
  rank: [cost, waste, cuts]  # 推奨案の評価優先順
  exact: auto                # 厳密探索（auto/on/off）
  selectedPlan: null

stocks:
  - { id: 1x4-6f,  label: "1×4材 6F",        kind: bar,   length: 1820, width: 89,  thickness: 19, price: 382 }
  - { id: pine-18, label: "パイン集成材18mm", kind: sheet, length: 1820, width: 910, thickness: 18, price: 6356 }

parts:
  - id: side-0
    label: 側板
    qty: 2                   # 1エントリ＝1形状 × qty 個
    stock: pine-18
    length: 900
    width: 250
    features:
      - { type: groove, face: front, dir: across, pos: 200, width: 7, depth: 6, end: through }
      - { type: hole,   face: front, x: 450, y: 50, dia: 5 }
```

v0.4 の追加フィールド:

- `settings.rank`: 推奨案の評価優先順。`cost`（概算費用）・`waste`（歩留まり）・`cuts`（カット回数）の並び。
- `settings.exact`: 厳密探索モード。`auto`（既定。部材数が目安 15 以下のときのみ実行）／`on`／`off`。厳密解がヒューリスティック案より少ない本数を要する場合は案 X として候補に加わる。
- `settings.selectedPlan`: `"A"`〜`"C"` に加えて `"X"`（厳密解）を指定できる。

注意: 2D（sheet）のカット回数は「概算」であり（共線カットの1パス統合を行わない）、図・プレビューでも「カット回数（概算）」と表記される。2D 厳密探索の最適性は、面積下界と一致した場合のみ「証明あり」として summary.json に記録される（`exact.proven`）。

## 6. CLI（補助経路）

```bash
node dist/cli.js build  [project.yaml] [--out DIR] [--no-png] [--scale N]
node dist/cli.js watch  [project.yaml]     # 変更監視して自動再ビルド
node dist/cli.js select <A|B|C|X|null> [project.yaml]
```

`npm install -g` 相当で `kidori` コマンドとして使う場合は `npm link`。

## 7. 出力

```
out/
├── plan-A.svg / plan-A.png   # 木取り図（案ごと。ヘッダに ★ 推奨案・厳密解一致を表示）
├── plan-B.* / plan-C.* / plan-X.*
├── parts/
│   └── <部材ID>.svg / .png    # 加工指示図（チェーン寸法・溝/穴の注記）
└── summary.json               # 必要本数・概算費用・歩留まり・カット回数・
                               # rank / recommendedPlan / rankedPlans / exact
project.schema.json            # ビルドごとに再生成（VS Code 以外のエディタ向け）
```

## 8. 開発

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest（コアエンジンの単体テスト）
npm run build       # esbuild で dist/extension.js と dist/cli.js を生成
npm run package     # .vsix を生成
```

## 9. ライセンス・参考

詳細仕様は SPECS.md（v0.4）を参照。アルゴリズムの参照実装として使用した旧 Python CLI 版は git 履歴（コミット `39116a3` 以前）にある。
