# kidori

規格材（1×4材・2×4材・サブロク合板など）から部材を切り出すための木取り図・加工指示図ジェネレータ（Python CLI）。

## 1. 概要

DIY設計では、寸法を変更するたびに木取り図・加工指示図を描き直す作業が発生する。kidori は、この描き直しコストを解消するためのツールである。

部材・原材・加工フィーチャを `project.yaml`（正本データ）に記述すると、木取り図（SVG/PNG）・加工指示図（SVG/PNG）・集計（`summary.json`）を自動生成する。図は正本から再生成される派生物であり、寸法変更後の再描画は `kidori build` の再実行だけで完了する。

割付（どの原材にどの部材を詰めるか）は一発最適化ではなく、FFD/BFD/同種部材グループ化など複数のヒューリスティクスで案A/B/Cを生成し、人が歩留まり・カット回数・費用を比較して選ぶ（詳細仕様は SPECS.md を参照。※仕様書は別管理でありリポジトリには同梱されない）。

## 2. 前提環境

- OS: macOS または Linux（本書の実機確認は macOS で実施）
- [uv](https://docs.astral.sh/uv/)（Python バージョン管理・パッケージ管理）
- Python 3.12 以上（`pyproject.toml` の `requires-python = ">=3.12"`。uv が自動で用意するため事前インストールは不要）
- PNG 出力用のシステムライブラリ: **cairo**
  - kidori は PNG 変換に `cairosvg` を使用する。`cairosvg` は内部で `cairocffi`（cffi 経由で libcairo を呼び出す）に依存するため、OS 側に cairo 本体（共有ライブラリ）が必要（実機確認: macOS + Homebrew 版 cairo 1.18.4 で PNG 出力が正常動作することを確認済み）。
  - macOS（Homebrew）: `brew install cairo`
  - Debian/Ubuntu 系: `apt install libcairo2`
  - cairo が無い環境でも `--no-png` を付ければ SVG のみで build できる（§7 参照）。

## 3. インストール

以下の2方式はいずれも本書作成時に実機で実行し、動作を確認済み。

### (a) リポジトリを clone して `uv run` で使う

```bash
git clone <このリポジトリのURL> kidori-extension
cd kidori-extension
uv sync
uv run kidori build examples/bookshelf/project.yaml
```

`uv sync` は `pyproject.toml` / `uv.lock` に基づき `.venv/` を作成し、依存関係（`cairosvg` / `jsonschema` / `ruamel-yaml`）を解決する。以後は `uv run kidori ...` の形でサブコマンドを実行する。

実機確認結果: `uv sync` は数秒で完了し、`uv run kidori build` は exit code 0 で `out/` 配下に `plan-A.svg` `plan-A.png` `plan-B.*` `plan-C.*` `parts/*.svg` `parts/*.png` `summary.json` を生成した。

### (b) `uv tool install` でグローバルコマンド化する

リポジトリ内で開発する場合は (a) で十分だが、複数プロジェクトの `project.yaml` を横断的に `kidori` コマンドで扱いたい場合は以下でグローバルインストールできる。

```bash
uv tool install --from . kidori
```

実機確認結果: リポジトリのローカルパスから `kidori==0.1.0` としてインストールされ、`~/.local/share/uv/tools/kidori/` に専用の venv が作られた。実行ファイルは `~/.local/bin/kidori` に配置される。

**注意（実機確認済みの既知の挙動）**: `~/.local/bin` が `PATH` に無い環境では、インストール直後は `uv` 自身が次の警告を出し、`kidori` コマンドがそのままでは見つからない。

```
warning: `/Users/xxx/.local/bin` is not on your PATH. To use installed tools, run
`export PATH="/Users/xxx/.local/bin:$PATH"` or `uv tool update-shell`.
```

対応（どちらか一方でよい）:

```bash
uv tool update-shell   # シェル設定ファイルに PATH 追記（要シェル再起動 or 再読込）
# または
export PATH="$HOME/.local/bin:$PATH"
```

アンインストールは次の通り（実機確認済み）:

```bash
uv tool uninstall kidori
```

## 4. クイックスタート

同梱の `examples/bookshelf/` を build して成果物を確認する。

```bash
cd examples/bookshelf
uv run kidori build   # 引数省略時は ./project.yaml を対象にする
```

`out/` に以下が生成される。

```
out/
├── plan-A.svg / plan-A.png   # 案A（1D: FFD / 2D: MaxRects-BSSF）
├── plan-B.svg / plan-B.png   # 案B（1D: BFD  / 2D: MaxRects-BAF）
├── plan-C.svg / plan-C.png   # 案C（1D: 同種グループ化 / 2D: MaxRects-BL）
├── parts/
│   ├── side-0.svg / .png     # 部材ごとの加工指示図
│   └── shelf-0.svg / .png
└── summary.json              # 各案の機械可読サマリ
```

### summary.json の見方

各案（`plans[]`）ごとに、原材種別（`stocks[]`）と全体集計（`totals`）を持つ。

```json
{
  "id": "A",
  "method": { "1d": "ffd", "2d": "maxrects-bssf" },
  "stocks": [
    { "stockId": "pine-18", "kind": "sheet", "count": 1, "unitPrice": 6356.0,
      "subtotal": 6356.0, "yield": 0.2717, "cutCount": 7, "units": [ ... ] }
  ],
  "totals": {
    "cost": 6738.0,
    "costComplete": true,
    "yield": 0.3311,
    "cutCount": 11,
    "stockCounts": { "pine-18": 1, "1x4-6f": 1 }
  }
}
```

- `totals.cost` / `stocks[].subtotal`: 概算費用（`stocks[].price` が全て設定されている場合のみ `costComplete: true`）。
- `totals.yield`: 歩留まり（使用長 or 使用面積 ÷ 購入原材全体）。
- `totals.cutCount`: 案全体のカット回数（`kerf` を消費する切断の回数）。
- `totals.stockCounts`: 原材IDごとの必要本数/枚数。
- 3案を比較し、採用する案を決める。

### `kidori select` の使い方

採用案が決まったら、`settings.selectedPlan` を書き換えて再ビルドする。

```bash
uv run kidori select A          # ./project.yaml の selectedPlan を "A" にして build
uv run kidori select A path/to/project.yaml
uv run kidori select none       # 選択解除（全案を再び出力）
```

実機確認結果: `select A` 実行後、`project.yaml` は `settings.selectedPlan: A` に書き換わり（YAMLのコメント・キー順は保持される）、`out/` は plan-A系のみ（`plan-A.svg` `plan-A.png` `summary.json`。`plan-B.*` `plan-C.*` は削除）に絞られることを確認した。`--no-png` を付けた場合は同じ build で PNG が一切生成されない（既存 PNG も含め `out/` 直下は都度再生成されるため、前回生成された PNG は残らない）ことも確認した。

## 5. VS Code への導入

SPECS.md §3 が想定する操作フロー「`project.yaml` を編集 → 保存 → SVG 自動再生成 → プレビューで確認」を VS Code 上で成立させるための拡張構成。

**前提の明記（SPECS.md §8）**: プレビュー方式（使用拡張の選定）は SPECS.md §8 で「暫定」と明記されている未確定事項である。以下は現時点（2026-07-22）での推奨であり、代替案を併記する。特に SVG プレビュー拡張は決定版と呼べるものが見当たらなかった（§5-3 参照）。

### 5-1. YAML 補完・検証（確定：Red Hat YAML）

- 拡張ID: `redhat.vscode-yaml`（Marketplace: [YAML Language Support by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)）
- 確認内容（VS Code Marketplace Gallery API を直接クエリして確認。ページのHTML表示ではなく `extensionquery` API のレスポンスで裏取り）:
  - インストール数 約2,825万、直近更新日 2026-07-21（本書作成の前日。継続的にメンテナンスされている）。
  - `# yaml-language-server: $schema=<path>` のモードラインでスキーマを紐付けられる（`examples/bookshelf/project.yaml` の1行目と同じ書式。これは kidori 側で既に採用済み）。
  - `.json` 入力には VS Code 標準の `json.schemas` 設定が効く（§6 参照）。

`project.yaml` 側は変更不要（モードラインが既に入っている）。VS Code 側でこの拡張をインストールするだけでよい。

### 5-2. 保存時自動ビルド

2通りの実現方法がある。どちらも実機で `kidori build` 相当のコマンドが動くことは確認済みだが、拡張自体の動作は VS Code GUI 上での実地確認まではしていない（§8 検証状態を参照）。

**方法A（推奨）: Run on Save 系拡張 — `emeraldwalk.RunOnSave`**

- 拡張ID: `emeraldwalk.RunOnSave`（Marketplace 表示名 "Run on Save"）
- 確認内容（Marketplace Gallery API + 公式 GitHub README [emeraldwalk/vscode-runonsave](https://github.com/emeraldwalk/vscode-runonsave/blob/main/README.md) を直接取得して確認）:
  - インストール数 約73万、直近更新日 2026-01-09。
  - 設定キーは `emeraldwalk.runonsave`、コマンド配列は `commands`、各エントリは `match`（正規表現）/ `cmd` / `isAsync` を持つ。

`.vscode/settings.json` 例:

```json
{
  "emeraldwalk.runonsave": {
    "commands": [
      {
        "match": "project\\.(yaml|yml|json)$",
        "cmd": "uv run kidori build ${file}",
        "isAsync": false
      }
    ]
  }
}
```

**方法B（代替）: `kidori watch` を VS Code Task で回す**

拡張を増やしたくない場合は、kidori 自身の `watch` サブコマンド（ポーリング間隔0.5秒、200msデバウンス。実装は `src/kidori/watch.py`）を VS Code の統合ターミナル or バックグラウンドタスクとして起動する。

`.vscode/tasks.json` 例（VS Code 公式ドキュメント記載のバックグラウンドタスク書式に準拠。`isBackground: true` を指定。`problemMatcher` は kidori が構造化ログを出さないため空にしている）:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "kidori: watch",
      "type": "shell",
      "command": "uv run kidori watch project.yaml",
      "isBackground": true,
      "problemMatcher": [],
      "presentation": { "reveal": "always", "panel": "dedicated" },
      "runOptions": { "runOn": "folderOpen" }
    }
  ]
}
```

`runOptions.runOn: folderOpen` を付けるとフォルダを開いた時に自動起動する（初回はVS Codeが確認ダイアログを出す。`task.allowAutomaticTasks` 設定で恒常許可も可能）。手動起動でよければ `runOptions` を削除し、コマンドパレットから `Tasks: Run Task` → `kidori: watch` を実行する。

### 5-3. SVG プレビュー（未確定・比較検討中）

kidori workflow の要件は「外部プロセス（`kidori build`／`kidori watch`）が書き換えた SVG を、VS Code 上のプレビューに自動反映させる」こと。この「外部で書き換えたファイルをプレビューに自動反映する」という点について、公式ドキュメント上で明確に保証している VS Code 拡張は見つからなかった。

裏取りした事実（VS Code Marketplace Gallery API 直接クエリ、および該当拡張の GitHub リポジトリを直接確認）:

| 拡張ID | 表示名 | インストール数 | 直近更新 | 備考 |
| --- | --- | --- | --- | --- |
| `jock.svg` | SVG | 約244万 | 2024-06-30 | ライブプレビュー・PNG書き出し・補完等を統合。ただし作者自身がREADMEに「2023-04-15付けで開発を一時停止（pausing update）、三度目の書き直しまで待つ」と明記している。外部プロセスによるファイル変更時の自動反映は未文書化。 |
| `vitaliymaz.vscode-svg-previewer` | SVG Previewer | 約35万 | 2021-02-16（実質メンテ終了） | GitHub 上の最終コミットも2021-02-16で、以後更新なし。**非推奨**。 |

（参考: `MadsKristensen.SvgViewer` は候補として名前が挙がりやすいが、実体を確認したところ **Visual Studio（Windows版フルIDE）用の拡張であり VS Code 用ではない**ため対象から除外した。誤って VS Code に導入しても動作しない。）

**推奨（暫定）**: `jock.svg`（SVG）を使う。インストール数・機能面で最も実用的だが、開発停止宣言がある点は認識した上で使うこと。

**代替案**:
1. VS Code 標準の画像プレビュー（PNGファイルをそのまま開く）を使う。ただし、外部プロセスがファイルを書き換えた際の自動リロードは VS Code 本体側でも既知の制限があり、`microsoft/vscode` リポジトリの Issue #146680（"Provide a way to manually refresh image files"）としてオープンのまま残っている（公式Issueで裏取り）。自動反映を過度に期待しない。
2. 汎用の自動リロード系拡張（`sebastian-lay.auto-reload` 等、2025-06更新・実機未検証）と `jock.svg` を併用し、ファイル変更検知→再読込→プレビュー再描画のチェーンを補強する。
3. 手動運用に倒す: `kidori build`/`kidori watch` 実行後、SVGタブを閉じて開き直す（最も確実だが手間がかかる）。

`.vscode/extensions.json`（拡張の推奨リストとして共有する場合）:

```json
{
  "recommendations": [
    "redhat.vscode-yaml",
    "emeraldwalk.RunOnSave",
    "jock.svg"
  ]
}
```

## 6. JSON 入力・スキーマ連携

`project.json`（`.json` 拡張子）を正本にする場合、`kidori` はそのまま `json.load` で読み込む（`src/kidori/loader.py` の `read_raw` が拡張子で分岐）。YAML のモードラインに相当するものが無いため、VS Code 標準の `json.schemas` 設定でスキーマを紐付ける。

`.vscode/settings.json` 例:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["project.json"],
      "url": "./project.schema.json"
    }
  ]
}
```

`project.schema.json` は `kidori build`/`select` のたびに自動再生成される（`$schema: "https://json-schema.org/draft/2020-12/schema"`、`stocks[].id` を `parts[].stock` の enum に反映。実機生成物で確認済み）。`.gitignore` で除外されているため、初回 clone 直後はファイルが無い。最初に一度 `kidori build` を実行してから VS Code を開くこと。

## 7. トラブルシューティング

### cairo が無い場合

`cairosvg` の import に失敗する、または PNG 生成時にエラーになる場合は cairo 未インストールが疑われる。`--no-png` を付ければ SVG のみで build できる。

```bash
uv run kidori build project.yaml --no-png
```

macOS では `brew install cairo`、Debian/Ubuntu では `apt install libcairo2` を実行してから再試行する。

### PNG の日本語フォント

kidori の PNG 出力は `cairosvg` によるラスタライズであり、部材ラベル等の日本語文字列を含む。表示先OSに日本語表示可能なフォントが入っていない環境では文字化け・字形欠けが起きうる（本書作成時の macOS 実機ではHomebrew版cairo + OS標準の日本語フォントで文字化けは確認されなかったが、Linux配布版など他環境でのフォント有無までは検証していない — 未検証）。

### 検証エラーの読み方（exit code 1 / 2）

`src/kidori/cli.py` の実装に基づく（実機確認済み）:

- **exit code 1**: `project.yaml`/`project.json` の意味検証エラー（`ProjectError`）。例えば `parts[].stock` に存在しない原材IDを指定すると次のように出力される。

  ```
  [エラー] parts[0].stock: 許可されていない値です: 'nonexistent-stock' is not one of ['pine-18', '1x4-6f']
  project の検証エラーにより build を中止しました。上記のメッセージを修正して再実行してください。
  ```

  メッセージの `path`（例: `parts[0].stock`）を手がかりに該当フィールドを修正する。

- **exit code 2**: ファイルが存在しない・YAML/JSON構文エラーなどの入出力エラー。例えば存在しないパスを指定すると次のように出力される。

  ```
  build に失敗しました: [Errno 2] No such file or directory: '...'
  ```

### スキーマ補完が効かない場合

- YAML: ファイル先頭に `# yaml-language-server: $schema=./project.schema.json` のモードラインがあるか確認する（`examples/bookshelf/project.yaml` 1行目参照）。`project.schema.json` が同じディレクトリに存在しない（一度も `kidori build` していない）場合も補完は効かない。
- JSON: `.vscode/settings.json` の `json.schemas`（§6）が正しいパスを指しているか確認する。
- どちらの場合も Red Hat YAML 拡張（YAML側）または VS Code 本体のJSON言語機能（JSON側）が有効化されているか、拡張が無効化されていないかを確認する。

## 8. 検証状態

Artifact Write Gate に基づき、本書の事実的主張の裏取り状況を区分する。

**(a) 実機確認済み（本環境で実際にコマンドを実行して確認）**

- `uv sync` によるセットアップ、`uv run kidori build` の成功・成果物一覧（SVG/PNG/summary.json）。
- `uv tool install --from . kidori` によるグローバルインストールと `~/.local/bin` 未設定時の警告メッセージ、フルパス実行での動作確認、`uv tool uninstall kidori` による復元。
- `kidori select A` による `settings.selectedPlan` の書き換え（コメント・キー順保持）と `out/` の絞り込み（旧案のSVG/PNGが削除される）。
- `--no-png` 指定時にPNGが一切生成されないこと。
- exit code 1（検証エラー: 存在しない `stock` ID を指定して再現）/ exit code 2（存在しないパスを指定して再現）。
- `project.schema.json` の自動生成内容（`$schema` が draft 2020-12、`stocks[].id` が enum に反映されること）。
- macOS 環境（Homebrew）で cairo 1.18.4 が導入済みであり、PNG 出力が実際に成功すること。
- `.json` 拡張子で JSON パースに分岐する実装（`src/kidori/loader.py` のコード読み取りによる確認。実行テストは未実施）。

**(b) 公式ドキュメント確認済み（一次資料を直接参照）**

- VS Code Marketplace Gallery API（`extensionquery` エンドポイント）を直接クエリし、`redhat.vscode-yaml` / `emeraldwalk.RunOnSave` / `jock.svg` / `vitaliymaz.vscode-svg-previewer` / `MadsKristensen.SvgViewer` の直近更新日・インストール数を取得。
- `redhat.vscode-yaml` のモードライン方式（`# yaml-language-server: $schema=...`）と `yaml.schemas` 設定。
- `emeraldwalk.RunOnSave` の設定キー（`emeraldwalk.runonsave` / `commands[].match` / `cmd` / `isAsync`）を公式GitHub README から確認。
- `jock.svg` の README内「開発一時停止」宣言（2023-04-15付け記載）を配布アセットから直接取得して確認。
- `vitaliymaz/vscode-svg-previewer` の GitHub リポジトリの最終コミットが2021-02-16であること（GitHub API `commits` エンドポイントで確認）。
- `MadsKristensen.SvgViewer` が Visual Studio（Windows版フルIDE）用拡張であり VS Code 用ではないこと（配布アセット内の説明文とソース構成 `src/Adornments/*.cs` から確認）。
- VS Code公式ドキュメントの `tasks.json` バックグラウンドタスク書式（`isBackground` / `problemMatcher.background` 等）。
- VS Code本体の画像プレビュー自動リロードに関する既知の制限（`microsoft/vscode` Issue #146680 がオープンのまま残っている点）。

**(c) 未検証（本環境では実測できなかった範囲）**

- VS Code GUI 上での実際の拡張動作（`redhat.vscode-yaml` の補完・ホバー、`emeraldwalk.RunOnSave` の保存時コマンド実行、`jock.svg` のプレビュー描画・自動リロード）。本環境はGUIレスであり、拡張のインストール・実地操作までは確認していない。
- 「外部プロセスが書き換えたSVGファイルをプレビューが自動的に再読込する」という、SPECS.md §3のループの要である挙動そのもの。ドキュメント上の明記も見つからず、実地確認もできていない。§5-3の推奨はこの理由で「暫定」である。
- Linux環境（Debian/Ubuntu 等）でのインストール手順・cairo導入・PNG日本語フォント表示。本書の実機確認はすべてmacOS上で実施した。
- `sebastian-lay.auto-reload` 等、代替案として名前のみ挙げた拡張の実際の動作。
