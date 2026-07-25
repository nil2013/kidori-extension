# kidori

規格材（1×4材・2×4材・サブロク合板など）から部材を切り出すための木取り図・加工指示図ジェネレータ（VS Code 拡張）。

## 1. 概要

DIY設計では、寸法を変更するたびに木取り図・加工指示図を描き直す作業が発生する。CutList Optimizer や OpenCutList のような既存ツールは多機能だが、そこまでの多機能さは求めていない。欲しいのは「規格材（1×4・2×4・サブロク合板等）から自分の部材を切り出す」という自分の用途と作業の流れにちょうど合ったツールである。kidori はこの前提から、部材リストをテキストで宣言し、図はそこから派生的に得るという書き方に絞って作られている。

部材・原材・加工フィーチャを `*.kidori.yaml`（正本データ。**1ファイル=1プロジェクト**）に記述して保存すると、拡張が自動でビルドを実行し、木取り図（SVG/PNG）・加工指示図（SVG/PNG）・集計（`summary.json`）を再生成する。結果は拡張内の Webview プレビュー（木取り図タブ／加工指示図タブ）で即時確認できる。

割付（どの原材にどの部材を詰めるか）は、FFD / BFD / 同種部材グループ化などのヒューリスティクスで案 A/B/C を生成し、`settings.rank` の優先順（既定: 概算費用 → 歩留まり → カット回数）で自動ランク付けして最上位を推奨案（★）として提示する。部材数が少ない場合は厳密探索（`settings.exact`）で真の最適構成も確認し、ヒューリスティック案が最適に一致すればその旨を表示する。最終選択は人が行う（プレビューの「この案を採用」／コマンドパレット／`kidori select A`）。

構成は2層:

- **コアエンジン**（`src/core/`）: パース・検証・スキーマ生成・割付・SVG/PNG 生成を担う、エディタ非依存の TypeScript ライブラリ
- **拡張層**（`src/extension/`）: 保存監視・kidori ファイル判定・補完/検証・Webview プレビュー・コマンド

補助として、同一コアを薄くラップした CLI `kidori`（`dist/cli.js`）も同梱する（バッチ処理・VS Code のない環境向け。主経路は拡張）。

## 2. 前提環境

- VS Code 1.90 以降
- 依存拡張: [Red Hat YAML](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)（`.vsix` インストール時に extensionDependencies として要求される。キー名補完・型検証・ホバー説明はこの拡張がスキーマを解釈して提供し、スキーマ自体は kidori が**ファイルごとにメモリ上で**動的に登録する。ディスクへのスキーマファイル再生成はしない）
- ビルド（開発時）: Node.js 18 以降

Python・cairo 等の追加ランタイムは不要。PNG 変換は拡張内の resvg-js（ネイティブモジュール）で行う。

## 3. インストール

### (a) `.vsix` をビルドしてインストール

```bash
git clone <このリポジトリのURL> kidori-extension
cd kidori-extension
npm install
npm run package        # dist/ をビルドして kidori-0.5.0.vsix を生成
code --install-extension kidori-0.5.0.vsix
```

ファイル名のバージョン番号は `package.json` の `version` に追従する（現行 0.5.0）。

注意: resvg-js はプラットフォーム別のネイティブバイナリを含むため、`.vsix` は生成したマシンと同じ OS/アーキテクチャでのみ PNG 出力が有効になる。**PNG は確定要件**であり、既定設定（`kidori.png.enabled: true` / CLI 既定）のまま resvg-js が利用できない環境では、SVG すら生成せずビルド全体をエラーにする（古い図面が最新のように残るのを防ぐため）。その環境で図面だけ生成したい場合は PNG を無効化する（CLI: `--no-png`、拡張: 設定 `kidori.png.enabled: false`）。

### (b) 開発モード（拡張開発ホスト）

VS Code で本リポジトリを開き、`npm install && npm run build` の後に F5（拡張のデバッグ実行）で起動する。

### (c) CLI を PATH に通す（任意）

拡張本体とは別に、CLI（`dist/cli.js`）単体を `kidori` コマンドとして PATH から呼びたい場合は次のいずれかを行う。

```bash
npm link              # このリポジトリの bin 宣言（kidori）をグローバルにリンクする
kidori new my-project.kidori.yaml
```

`npm link` が使えない・使いたくない環境（CI、制限された実行環境など）では、PATH を通さずに直接呼び出せる:

```bash
node dist/cli.js new my-project.kidori.yaml
```

以降の説明では `kidori <サブコマンド>` と表記するが、PATH が通っていない環境では常に `node dist/cli.js <サブコマンド>` に読み替えてよい（bin 宣言だけでは実行手段は保証されない）。

## 4. 使い方

1. 作業フォルダで `kidori new bookshelf.kidori.yaml`（または コマンドパレットから「kidori: New Cutting Plan」）を実行し、雛形ファイルを1枚生成する。ファイル名に `.kidori.yaml` サフィックスを付け忘れても、CLI 側は自動的に付与する（`bookshelf` → `bookshelf.kidori.yaml`、`bookshelf.yaml` → `bookshelf.kidori.yaml`）。動く実例は `examples/` 配下を参照（`examples/bookshelf/bookshelf.kidori.yaml`＝基本形、`examples/uma/uma.kidori.yaml`＝`assemblies`/`marks` を使う実例。下記「`assemblies`・`marks`」参照）。
2. VS Code で開くと、kidori 拡張が編集中の内容からスキーマを動的に登録する。キー名・enum の補完、型検証、日本語ホバー説明が有効になる。`stocks[].id` を書き換えると、ビルドを待たずに `parts[].stock` の補完候補・検証が追従する（`*.kidori.json` も同じ基底スキーマで検証されるが、`stocks[].id` の動的 enum 合成は現状 YAML 側のみ）。
3. `stocks:` 配下で補完（Ctrl+Space）すると規格材マスタの候補（「1×4材 6F（1820×89×19）」等）が出て、確定と同時に実値一式と `preset:` キーが挿入される。`length:` / `width:` の値位置では定尺候補（910 / 1820 / 2440 …）が出る。候補は4層カスケード（下記）から供給される。
4. コマンドパレットから「kidori: プレビューを開く」を実行する。
5. ファイルを保存するたびに自動ビルドが走り、`<ファイル名>.out/`（例: `bookshelf.kidori.yaml` → `bookshelf.out/`）配下の SVG/PNG/summary.json とプレビューが更新される。
6. 案を比較し、プレビューの「この案を採用」（またはコマンド「kidori: 案を採用する」）で `settings.selectedPlan` を書き込む。以後は採用案のみ再生成され、加工指示図に配置番号が連動する。

kidori ファイルの判定は2系統ある: (i) 命名規約 `*.kidori.yaml` / `.yml` / `.json`（推奨）、(ii) 素の `*.yaml` / `*.json` でもトップレベルに `meta.schemaVersion` があれば内容判定で認識される（既存ファイルの救済用）。同一ディレクトリに複数プロジェクトを同居させられる（例: `bookshelf.kidori.yaml` と `desk.kidori.yaml`）。

### コマンド一覧

| コマンド | 内容 |
| --- | --- |
| kidori: New Cutting Plan（木取りファイルの雛形を生成） | `kidori new` 相当。雛形ファイル1枚を生成する主経路 |
| kidori: ディレクトリを初期化（AGENTS.md・スキーマ等を生成） | `kidori init` 相当。任意の一括セットアップ |
| kidori: ビルド（木取り図・加工指示図を再生成） | 手動ビルド |
| kidori: プレビューを開く | Webview プレビュー（木取り図／加工指示図） |
| kidori: 案を採用する | QuickPick で案を選択して selectedPlan を書き込み |
| kidori: 構成を挿入（parts＋assembly の雛形） | カーソル位置に `parts`＋`assemblies`（`contains`／`marks`）の雛形をスニペット挿入する（下記「assemblies・marks」参照） |

### 設定

| 設定 | 既定値 | 内容 |
| --- | --- | --- |
| `kidori.buildOnSave` | true | kidori ファイル（`*.kidori.yaml` など、または `meta.schemaVersion` を持つ `*.yaml`/`*.json`）保存時の自動ビルド |
| `kidori.png.enabled` | true | PNG も生成する |
| `kidori.png.scale` | 2 | PNG のスケール倍率 |

### 規格材マスタ（4層カスケード）

`stocks[].id` の入力候補や `stocks:` の補完スニペットは、以下4層のカスケードから供給される。同じマスタキー（`preset`、無ければ `id`）が複数層に現れた場合は**近い層が勝つ**（シャドウは診断で通知される）:

1. **ビルトイン**: 拡張・CLI 同梱のプリセット（`assets/stock-presets.json`。1×4/2×4材の6F/8F、サブロク合板、集成材定尺など）
2. **ユーザー**: `$XDG_CONFIG_HOME/kidori/stocks.yaml`（未設定時は `~/.config/kidori/stocks.yaml`。VS Code の settings.json は CLI から見えないため、拡張・CLI が同じファイルを読む）
3. **ディレクトリ**: 編集中ファイルと同居する `stocks.yaml`（`stocksFile:` の参照先と兼用可）
4. **ファイル内**: 編集中ファイルの `stocks:` インライン定義

補完はあくまで「候補の供給構造」であり、ビルドはこのカスケードを一切参照しない。補完を確定した時点で `label`/`length`/`width`/`thickness` 等の実値と `preset:`（来歴キー、任意）が正本ファイルへ実体化されるため、正本はどの環境でも自己完結的にビルドできる。`preset:` を消してもビルドには影響しない。

旧 `kidori.presets.json`（v0.4 まで）は廃止された。規格材の追加・上書きは上記のユーザー層またはディレクトリ層の `stocks.yaml` に書く。

## 5. 正本データ（`*.kidori.yaml`）

トップレベルは `meta` / `settings` / `stocks` / `parts` の4区画に、任意の `stocksFile`（外部 stocks 参照）を加えた構成。単位は mm 固定。詳細は SPECS.md §4 を参照。

```yaml
# yaml-language-server: $schema=./kidori.schema.json
meta: { project: 書棚, units: mm, schemaVersion: "0.4" }

settings:
  kerf: 3                    # 鋸刃厚（mm）
  edgeTrim: 5                # 木口の捨て代（mm）
  candidates: 3
  rank: [cost, waste, cuts]  # 推奨案の評価優先順
  exact: auto                # 厳密探索（auto/on/off）
  selectedPlan: null

stocksFile: ./stocks.yaml    # 任意。同居プロジェクト間で共有する規格材（相対パス限定・単段のみ）

stocks:
  # preset: 補完確定時に挿入される規格材マスタの来歴キー（ビルドは読まない）
  - { id: 1x4-6f,  preset: spf/1x4/6f,       label: "1×4材 6F",        kind: bar,   length: 1820, width: 89,  thickness: 19, price: 382 }
  - { id: pine-18, preset: pine/18mm/sabroku, label: "パイン集成材18mm", kind: sheet, length: 1820, width: 910, thickness: 18, price: 6356 }

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

主なフィールド:

- `meta.schemaVersion`: 現行は `"0.4"`。不一致は**警告のみでビルドは継続する**（旧バージョンで書かれたファイルの救済経路）。
- `stocksFile`: 外部 stocks ファイルへの相対パス参照。**単段のみ**（参照先がさらに `stocksFile` を持つとエラー）。インラインの `stocks` と `id` が衝突した場合はインラインが勝つ。
- `stocks[].preset`: 規格材マスタの来歴キー（任意）。ビルドは一切解決しない。実値フィールドは `preset` の有無に関わらず全て必須。
- `settings.rank` / `settings.exact` / `settings.selectedPlan`: 推奨案・厳密探索・案採用の設定（下記§「採用案の無効化」参照）。
- `parts[].qty`: 必要個数。下記「`assemblies`・`marks`」の `contains` に形状 id が現れる場合は省略できる（全 assembly の合計から導出される）。併記して食い違う場合は警告診断になる。

注意: 2D（sheet）のカット回数は「概算」であり（共線カットの1パス統合を行わない）、図・プレビューでも「カット回数（概算）」と表記される。2D 厳密探索の最適性は、面積下界と一致した場合のみ「証明あり」として `summary.json` に記録される（`exact.proven`）。

### `assemblies`・`marks`（構成グルーピング・取り付けシロ）

部材リストには「形状の同一性」（割付が見る寸法・加工）と「構成への所属」（どの部材が何個でひと組か）と「取り付けシロ」（相手部材がどこに当たるか）という3つの独立した情報が同居しがちである。これらを `parts` の分割やコメントで表現すると、同じ形状を複数回定義する羽目になったり、グルーピングの軸が衝突したりする。kidori はこれを分離する: **形状は `parts` のまま、構成への所属と取り付けシロは任意区画 `assemblies` に書く**。

例（`examples/uma/uma.kidori.yaml`。作業用のウマ2脚を、足の組み方だけが違う2構成として表現している）:

```yaml
parts:
  - { id: leg,       label: 足,     stock: 2x4-6f, length: 800 }
  - { id: beam-top,  label: 天板,   stock: 2x4-6f, length: 850 }
  - { id: beam-foot, label: 接地面, stock: 2x4-6f, length: 900 }

assemblies:
  - id: uma-1
    label: ウマ1号機（足が内側）
    contains: { leg: 2, beam-top: 1, beam-foot: 1 }
    marks:
      - { on: beam-top, face: front, ref: leg, x: 50, note: 足当たり面 }
  - id: uma-2
    label: ウマ2号機（互い違いに噛み合う側）
    contains: { leg: 2, beam-top: 1, beam-foot: 1 }
    marks:
      - { on: beam-top, face: front, ref: leg, x: 120, note: 足当たり面 }
```

- **`assemblies[].contains`**: 形状 id → 個数のマップ。「このひと組（assembly）に、どの形状が何個入るか」の宣言。`leg`/`beam-top`/`beam-foot` は `parts` に `qty` を書いていない（省略時は全 assembly の `contains` 合計から導出される。上の例なら `leg` は 2×2=4 個）。割付は導出後の合計数だけを見るため、`beam-top` を「天板1」「天板2」のように形状として複製する必要はない。
- **`assemblies[].marks`**: 切削を伴わない当たり面・位置のマーキング（取り付けシロ）。`on`（対象形状 id）・`face`・`x`/`y`（領域左下角、省略時0）を指定し、領域の大きさは `w`/`h` を直接書くか、`ref: <形状id>` で相手部材の断面寸法（厚み×実効幅）から自動導出させる。上の例の `ref: leg` は 2×4 材（厚み38×幅89）の断面を指し、`leg` の寸法を変えれば追従する。marks は**加工指示図にのみ**破線／ハッチングで描画され（木取り図には出ない）、割付・歩留まり・カット回数には一切影響しない。
- **assembly ごとの変種面**: 同じ形状でも assembly によってマーク位置が異なる場合（上の例の `beam-top` は `uma-1` と `uma-2` でマーク位置 `x` が違う）、加工指示図は assembly 単位の変種面として出力される（`parts/uma-1-beam-top.svg` / `parts/uma-2-beam-top.svg`）。マークを持たない形状（上の例の `leg`・`beam-foot`）は従来どおり形状ごとに1面（`parts/leg.svg` 等）。
- **一括挿入**: コマンドパレットの「kidori: 構成を挿入（parts＋assembly の雛形）」で、上記と同じ形（`leg`/`beam-top`/`beam-foot` 相当）の `parts`＋`assembly` の雛形をタブストップ付きスニペットとして挿入できる。展開後はただの YAML で、マクロ的な参照や独自構文は残らない。

### 採用案の無効化（設計変更後の再割付）

`settings.selectedPlan` を設定した後に割付へ影響する編集（`parts`・`stocks`・`settings.kerf` 等）を行うと、記録済みの採用案は**設計変更後の割付とは無関係**とみなされる。次回ビルドは `selectedPlan` の指定を無視して全案（A/B/C、条件次第で X）を再生成し、`settings.selectedPlan` の位置に警告 Issue を出す。

- `selectedPlan` の**値自体は自動では書き換えられない**（正本の書き換えは人の操作に限る）。再選択するには、改めてプレビューの「この案を採用」または `kidori select A` を実行する。
- 採用の有効性は、割付結果のフィンガープリントと `<ファイル名>.out/summary.json` に記録された採用時のフィンガープリントを突き合わせて判定する。
- **既知の限界**: `<ファイル名>.out/` は `.gitignore` 対象（派生物）なので、これを削除してから再ビルドすると、採用の記録も消え、次のビルドが**現在の状態を採用時点として静かに再アンカーする**（無効化警告が出ないまま `selectedPlan` の値がそのまま有効化される）。設計変更の追跡を厳密にしたい場合は `<ファイル名>.out/` を不用意に削除しないこと。

### 出力先の衝突

出力先は `<正本のディレクトリ>/<stem>.out/` という規則で決まるため、`foo.yaml` と `foo.kidori.yaml` が同居すると**両方が `foo.out/` を使う**。ビルドは前回の `summary.json` の `sourceFile` と今回のファイル名を照合し、一致しなければ警告を出す。

- これは**事後検出**であり、上書き自体（片方のビルドがもう片方の成果物を書き換えること）は防げない。
- 対処: 片方のファイル名を変える（例: `foo.yaml` → `foo-legacy.kidori.yaml`）か、`--out` で出力先を明示的に分けてから両方を再ビルドする。

## 6. CLI（補助経路）

```bash
kidori new    <ファイル名> [--preset <キー>]...        # 雛形ファイル1枚を生成（主経路）
kidori init   [ディレクトリ] [--with-stocks]           # ディレクトリを初期化（任意）
kidori build  [<name>.kidori.yaml] [--out DIR] [--no-png] [--scale N]
kidori watch  [<name>.kidori.yaml] [--out DIR] [--no-png] [--scale N]   # 変更監視して自動再ビルド
kidori select <A|B|C|X|null> [<name>.kidori.yaml]
kidori check  <name>.kidori.yaml                        # 構造化診断を JSON で出力（ビルドなし）
kidori schema <name>.kidori.yaml                        # このファイル用の合成済みスキーマを stdout へ出力
```

`node dist/cli.js <サブコマンド>...` で実行できる（PATH を通す方法は §3 (c) を参照）。

- **対象ファイルを省略した場合**、`build`/`watch`/`select` はカレントディレクトリの `*.kidori.{yaml,yml,json}` を探索する。見つかったのが1件ならそれを使い、0件または複数件ならエラー（対象ファイルの明示を促す）。`check`/`schema` は対象ファイルの省略を受け付けず、常に明示が必要。
- `kidori new`: `--preset <キー>` を反復指定すると、既定のサンプル部材ではなく指定した規格材マスタのキー（例: `spf/1x4/6f`）を実体化して書き出す。未知のキーを渡すとエラーで利用可能なキー一覧が表示される。
- `kidori init`: `--with-stocks` を付けると共有 `stocks.yaml` の雛形も生成する（既定では生成しない）。生成物はすべて**冪等**（既存ファイルは書き換えず、1件ずつ結果を報告する。`.gitignore` のみ不足パターンの追記を行う）。
- `kidori check`: **拡張ホスト API に届かないコーディングエージェント（Claude Code 等）向けの検証ループ**。ビルドせずに検証だけを実行し、`{ file, errorCount, warningCount, diagnostics: [{ path, line, severity, message }] }` という構造化 JSON を stdout に出す。検証内容は拡張内の検証（補完・ホバーと同じ意味検証層）と同一実装。`stocksFile` の参照解決やスキーマ検証、`groove.depth` の板厚超過・`groove.pos` の範囲外・`end: through` への `from`/`to` 併記といった意味検証も対象。
  - 終了コードは `check` 専用の規約を持つ（他コマンドの一般規約とは独立）: **0**=error 診断なし（warning はあってもよく、JSON では報告される）、**1**=error 診断あり（YAML/JSON の構文エラーも診断1件として扱う）、**2**=引数エラー・ファイルが読めない（IO エラー）。CI からの利用も想定している。
- `kidori schema`: 当該ファイル用に、インラインの `stocks[].id` と `stocksFile` 参照先の id を動的 enum として合成した完全なスキーマをその場で stdout に出す。「静的ファイルとして読む」のではなく「問い合わせる」形にすることで、スナップショットの陳腐化を避ける。`kidori build` が書き出す `<ファイル名>.out/schema.json`（§7）と同じ合成ロジックを共有するため内容は一致する。
- CLI は非対話を貫く（規格材の選択も `--preset` の反復指定で表現し、対話 UI は拡張層の Quick Pick に任せる）。
- 終了コード（`check` を除く）: 0=成功、1=検証エラー・実行時エラー、2=引数エラー。

## 7. 出力

```
bookshelf.out/
├── plan-A.svg / plan-A.png   # 木取り図（案ごと。ヘッダに ★ 推奨案・厳密解一致を表示）
├── plan-B.* / plan-C.* / plan-X.*
├── parts/
│   ├── <部材ID>.svg / .png                 # 加工指示図（チェーン寸法・溝/穴の注記）
│   └── <assembly名>-<部材ID>.svg / .png    # assembly ごとの変種面（marks で位置が異なる場合のみ。§5「assemblies・marks」）
├── summary.json               # 必要本数・概算費用・歩留まり・カット回数・
│                              # rank / recommendedPlan / rankedPlans / exact
│                              # ／adopted・selectedPlanStale（採用案の無効化。§5）
│                              # ＋ sourceFile / sourceSha256（由来した正本の識別）
│                              # ／assemblies（assembly 単位の部材内訳。assemblies 使用時のみ）
├── schema.json                 # このファイル用の合成済みスキーマ（`kidori schema` の出力と同一内容。§6）
└── BUILD-FAILED.txt           # 直近ビルドが失敗したときだけ存在する失敗マーカー
```

出力先は正本ファイル名から導かれる（`bookshelf.kidori.yaml` → `bookshelf.out/`、拡張子のみのファイルなら `foo.yaml` → `foo.out/`）。

**スキーマ書き出しには区別すべき2つの経路がある**（紛らわしいため明記する）:

- **正本ディレクトリへの再生成は v0.6 で廃止**されたままである（§4b）。編集中ファイルの隣に `<stem>.schema.json` を都度書き出す経路はない。古い合成済みスキーマが正本のそばに残って誤情報源になる事故を防ぐための廃止であり、VS Code 以外の環境で補完・検証に使う基底スキーマは `kidori init` が明示的に書き出す `kidori.schema.json`（動的 enum なし）のみで、これはビルドの副作用では生成されない。
- 一方、**`<ファイル名>.out/schema.json` への書き出しは v0.7 で追加**された（動的 enum 込みの合成済みスキーマ）。`<ファイル名>.out/` は毎ビルド再生成され `.gitignore` 対象の派生物ディレクトリなので、上記の廃止理由（残骸化）には当たらない。`kidori schema <ファイル>` の stdout と同一内容になる。

### `<ファイル名>.out/` が現行の正本由来かを確認する

現場では PNG をそのまま参照するため、図面が最新の正本を反映しているかを外形的に確認できるようにしている。

- `<ファイル名>.out/BUILD-FAILED.txt` が存在する場合、直近のビルドは失敗しており、出力は最新ではない。
- 存在しない場合、`shasum -a 256 bookshelf.kidori.yaml` の出力が `bookshelf.out/summary.json` の `sourceSha256` と一致すれば、その出力は現在の正本から生成されたものと判定できる。

### `kidori.schema.json` の陳腐化

`kidori init` は `kidori.schema.json` が既に存在する場合、**内容を更新しない**（冪等性のため）。kidori のバージョンを上げてスキーマ本体（フィールド定義・description）が変わっても、既存の `kidori.schema.json` は古いまま残る。`kidori init` は内容差分（drift）があればスキップ時のメッセージで報告するが、自動更新はしない。更新するにはファイルを削除してから再度 `kidori init` を実行する。

## 8. 開発

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest（コアエンジンの単体テスト）
npm run build       # esbuild で dist/extension.js と dist/cli.js を生成
npm run package     # .vsix を生成
```

## 9. ライセンス・参考

詳細仕様は SPECS.md（v0.7）を参照。アルゴリズムの参照実装として使用した旧 Python CLI 版は git 履歴（コミット `39116a3` 以前）にある。
