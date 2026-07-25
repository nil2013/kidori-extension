# kidori プロジェクト（エージェント向けガイド）

このディレクトリは **kidori**（規格材の木取り図・加工指示図ツール）の作業ディレクトリ。
正本は機械可読なテキスト（YAML／JSON）であり、図面はそこから自動生成される派生物。
図（SVG／PNG）を直接編集しないこと。編集するのは常に正本で、図はビルドで再生成する。

## 正本ファイル

- **1ファイル = 1プロジェクト**。`*.kidori.yaml` が推奨の命名（同一ディレクトリに複数同居できる）。
- 素の `*.yaml` / `*.json` でも、トップレベルに `meta.schemaVersion` があれば正本として認識される。
- 単位は **mm 固定**。部材ローカル座標系は左下原点・X 右・Y 上。
- トップレベルは `meta` / `settings` / `stocks`（原材＝規格材）/ `parts`（切り出す部材）の4区画に、
  任意の `stocksFile`（外部 stocks ファイルへの相対パス参照）を加えた構成。
- `parts` は「どの形状のパーツが何個」の**宣言形式**。1エントリ＝1形状（寸法＋加工）× `qty` 個であり、
  同じ形状の実体を個別に列挙しない。
- `stocks[].preset` は規格材マスタの**来歴キー**（任意のメタデータ）。**ビルドは preset を解決しない**ため、
  `length` などの実値は preset があっても全て必須。正本はそれ単体で完結する。

### 最小サンプル

```yaml
# yaml-language-server: $schema=./kidori.schema.json
meta: { project: 書棚, units: mm, schemaVersion: "0.4" }

settings:
  kerf: 3                     # 鋸刃厚（mm）。切断ごとに消費される
  edgeTrim: 5                 # 木口の捨て代（mm）
  candidates: 3               # 生成する割付候補数（1〜3）
  rank: [cost, waste, cuts]   # 推奨案の評価優先順
  exact: auto                 # 部材数が少ないときは厳密探索（案 X）も行う
  selectedPlan: null          # 採用案の ID。null の間は全案を出力する

stocks:
  - { id: 1x4-6f, preset: spf/1x4/6f, label: "1×4材 6F", kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }
  - { id: pine-18, label: "パイン集成材 18mm", kind: sheet, length: 1820, width: 910, thickness: 18 }

parts:
  - id: side-0
    label: 側板
    qty: 2
    stock: pine-18
    length: 900
    width: 250
    features:
      - { type: groove, face: front, dir: across, pos: 200, width: 7, depth: 6, end: through }
      - { type: hole,   face: front, x: 450, y: 50, dia: 5 }
```

### 完全な形式仕様

**全フィールドの定義・型・必須／任意・既定値は `kidori.schema.json` が正本**
（日本語の `description` 付き。`kidori init` が書き出す）。
上の記述は要約であり、仕様の複製ではない。フィールドを追加・変更する前に必ず `kidori.schema.json` を参照すること。

VS Code では kidori 拡張がファイルごとにスキーマを供給するため、`# yaml-language-server:` モードラインは無くてもよい。
VS Code 以外のエディタ・エージェントで補完・検証を効かせる場合にモードラインを書く。

## コマンド

| コマンド | 用途 |
| --- | --- |
| `kidori new <ファイル名> [--preset <キー>]...` | 正本ファイル1枚の雛形を生成する（着手の主経路）。`--preset` は反復指定できる |
| `kidori init [ディレクトリ] [--with-stocks]` | ディレクトリを初期化する（本ファイル・`.gitignore`・`kidori.schema.json`・共有 `stocks.yaml`） |
| `kidori build [ファイル] [--out DIR] [--no-png] [--scale N]` | 木取り図・加工指示図・`summary.json` を生成する |
| `kidori watch [ファイル]` | 保存を監視して自動ビルドする |
| `kidori select <A\|B\|C\|X\|null> [ファイル]` | 割付案を採用する（`settings.selectedPlan` を書き換えて再ビルド） |

`--preset` に指定できるキーの一覧は、存在しないキーを渡すとエラーメッセージに列挙される
（例: `kidori new tmp.kidori.yaml --preset ?`）。

## 出力物

ビルド出力は正本の隣に `<ファイル名>.out/` として生成される
（例: `bookshelf.kidori.yaml` → `bookshelf.out/`）。プロジェクト間で衝突しない。

- `plan-A.svg` / `plan-B.svg` / `plan-C.svg`（＋厳密探索案 `plan-X.svg`）: 木取り図。原材1本（1枚）ごとに1面
- `parts/<部材 id>.svg`: 加工指示図。部材1点ごとに1面（溝・丸穴と寸法線）
- 上記と同名の `.png`（印刷・現場での参照用）
- `summary.json`: 各案の必要原材本数・概算費用・歩留まり・カット回数と、推奨案（★）の機械可読サマリ
- `BUILD-FAILED.txt`: 直近のビルドが失敗したときだけ存在する。**あればこのディレクトリの図面は最新の正本を反映していない**

出力は正本から再生成される派生物なのでバージョン管理から除外する（`.gitignore` の `*.out/`）。
