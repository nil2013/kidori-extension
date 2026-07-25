# Supervisor notes — engagement 2026-07-25c (SPECS v0.6→v0.7 追随)

## Step 1: intake double-read (2026-07-25)

Inspected: .claude/logs/2026-07-25-instruction-3.md / git diff SPECS.md (full, 73+/23-) /
git log -20 / git status / src・test・examples 構成 / package.json / README.md(コマンド節) /
assets/AGENTS.template.md / src/core/loader.ts(検証部grep) / src/cli/main.ts(dispatch) /
src/core/init.ts / examples/bookshelf.

### Scope reading
指示 = 「SPECS.md の v0.6→v0.7 差分のうち規範的（実装拘束的）な変更を実装に反映せよ」。
実装追随を要する差分:
1. §4c assemblies（contains・qty導出・併記不一致警告）+ marks（ref断面導出・非切削）
2. §6/§4c 加工指示図への marks 描画（破線/ハッチ・注記・チェーン寸法対象）+ assembly変種面
   parts/<assembly>-<形状id>.svg + summary.json の assembly 内訳
3. §3b kidori check（JSON診断: file/line/severity/message + exit code、拡張と同一実装）
4. §3b kidori schema（動的enum込み合成スキーマの stdout 出力）
5. §3b/§6 build 副産物 <name>.out/schema.json
6. §3a/§3b AGENTS.md 薄いポインタ化（テンプレ書換）+ kidori new での不在時生成（上書き禁止）
7. §3 CLI 実行手段の明記（npm link / node dist/cli.js を AGENTS.md・README に）
8. §4 groove.pos 座標規約の schema description 同文明記 + 実装適合の検証
9. §4c 「kidori: Insert Assembly」コマンド（スニペット一括挿入）
10. schemaVersion 0.3→0.4（loader/scaffold/schema/examples/README/AGENTSテンプレ）
ドキュメントのみ（実装不要）: §1 動機文、§7 将来構想、§8 open-issue 帳尻、改訂履歴、§2 表現調整。
完了条件: 上記実装 + vitest/typecheck green + ドキュメント整合 + step-7 gate PASS。

### Triage (default = mine)
- U1 assemblies データモデル(types/loader/schema/version bump): HIGH（横断・意味論曖昧点あり）
- U2 marks 描画 + 変種面 + チェーン寸法統合: HIGH（描画設計・出力ルーティング）
- U3 summary.json assembly 内訳: LOW（形式未指定だが自己完結）
- U4 kidori check: HIGH（行番号の出所 — loader は path ベース診断で位置情報未保持の疑い。
  横断改修の可能性 + 「拡張と同一実装」制約）
- U5 kidori schema: HIGH 仮置き（合成が extension 層(schemaContributor)にあればコア移設=
  アーキテクチャ判断。コアに既存なら LOW へ降格可、Main の異議を認める）
- U6 build schema.json 出力: LOW
- U7 AGENTS.md テンプレ書換 + README セットアップ節: LOW
- U8 kidori new の AGENTS.md 生成: LOW
- U9 groove.pos description 追記: LOW、ただし実装適合検証を必須付帯。不一致検出時 HIGH 再triage
- U10 Insert Assembly コマンド: LOW
- U11 README/examples v0.7 同期: LOW
- U12 コミット戦略・リリース判断（SPECS.md コミット / version bump / vsix）: 実装単位でなく
  decision point。リリース打包は指示の文言外 → ユーザーに委ねる（スコープ拡大禁止）

### Consultation plan（着手前必須）
C1 (U1): qty導出の縁ケース — assemblies 使用時に非所属 part の qty 省略はエラーか0か。
   marks の ref 導出で w/h ↔ 幅/厚みの対応（face との関係）。
C2 (U2): 変種面の出力ルーティング・命名、破線/ハッチの既定選択（§8 open issue のため既定+
   注記に留める）、寸法チェーンへの mark 端/中心の取り込み方。
C3 (U4): 行番号供給の設計（yaml パッケージの range 保持 vs 後付けマッピング）。単一実装共有の確認。
C4 (U5): スキーマ合成の所在確認結果と、コア移設が要る場合の切り方（floor item 2 該当）。
C5 (U12): SPECS.md のコミット位置、version bump・vsix 打包の要否 → ユーザーへ surface。
床: intake(済)・アーキ判断・argument/rules 衝突・rework 2段目・gate-FAIL 分類・pre-gate。
Fresh Plan agent 指定: なし（v0.7 仕様は詳細で、最高曖昧度に達する単位なし）。

### Assurance note
high-assurance。理由: 出力（木取り図・加工指示図）は実材の切断を直接駆動し誤りが物理的に
不可逆 + schemaVersion 0.4 の破壊的データ形式変更 + 本リポジトリは過去に反復修正履歴あり
（v0.4 全面再実装・v0.4.1 障害対応）。→ step-7 は full gate（judge = fable, 明示指名）。
スコープはこのノートによって一切拡大しない。

## Consultation C1-C4 (Main まとめ相談, 2026-07-25)

U12 ユーザー裁定を記録: v0.6.0 リリースまで（bump 0.5.0→0.6.0 + vsix + SPECS.md コミット）。

自ら点検: types.ts 100-174 / errors.ts 全 / loader.ts 40-60,140-230,375,430-560,630-716,
790-821,937-940,1085,1120-1210 / build.ts 700-782 / dimension.ts 55-99 / partcard.ts 200-323 /
schemaContributor.ts 25-49 / cli/main.ts 25-40,295-337 / SPECS.md 96-165,186-247。

助言（詳細は本文回答）:
- Q1a: Main 暫定(i)を精緻化して承認 — contains に1回でも現れる part は導出値が勝つ
  （§4c「割付は導出後の合計数だけを見る」）+ 併記不一致 warning。どの contains にも
  現れない part は qty 必須、無ければ error。qty=0 導出(ii)は物理リスクで却下。
- Q1b: error で承認（checkStockReferences 同型）。追加指摘: assemblies[].id は出力
  ファイル名に入るため checkIdSafety + 重複検査 + `<assembly>-<part>` の衝突検査が必要。
  marks[].on はその assembly の contains に含まれること（error）。
  path 規約: ユーザー制御キーを path セグメントに入れない（contains の診断は
  assemblies[i].contains を指し、id は message 側へ）— C3 の写像可能性を守るため。
- Q1c: (i) 承認。loader.ts:46-51 の既存コメントが warning=救済経路を明文化済み。
  コメントの版数表記も更新すること。
- Q1d: w = ref先 stock.thickness, h = effectiveWidth(refPart, refStock)。
  例「38×89」と (w,h)=(38,89) が一致する（強いテキスト根拠）。ref XOR w/h（併記 error）。
  回転接触は明示 w/h で書く（自動追従は失うが仕様外拡張はしない）。
- Q2a: Main 暫定を承認（マーク同値判定を持ち込まない）+ 補完規則: 面の集合 =
  {マークを持つ assembly ごとの変種面} ∪ {マーク無し assembly・非所属分の units が
  あれば基底面}。preview/partCards の id→file 写像変更が統合点。
- Q2b: ハッチング既定（既定選択であり §8 解決ではない）。境界線は front=実線細,
  back=破線（既存 face 規約と整合）。破線流用は back 加工と衝突するため不採用。
- Q2c: (i) 承認 — renderPartcard は既存 opts に marks?: ResolvedMark[] を追加、
  extractChainPoints は第3引数 optional。型分離が「割付不干渉」を構造的に担保。
  Mark/ResolvedMark 型と resolveMarks() は core に置き単一実装で共有。
- Q2d: 端と中心の両方（各軸 x, x+w/2, x+w）。x/y は領域の左下角（corner）基準・
  省略時 0。hole の中心基準との名前衝突があるため schema description に同文明記必須。
  corner の根拠: 領域意味論 + 墨付け実務（境界線を引く）。確信度 medium。
- C3: (i) 承認。path 文法は formatJsonPath + 手組みテンプレで
  ident(.ident|[int])* | "<root>" に統一されており機械写像可能（点検済み）。
  ただし part id はドットを含み得るため、写像はドット分割ではなくセグメント文法で
  パースすること。line は nullable、stocksFile 由来 issue は主ファイルの stocksFile
  行に写像。exit code: 0=error なし（warning 可）/1=error あり/2=usage（既存 CLI 規約と整合）。
- C4: 降格承認 U5=LOW。schemaContributor.ts:34 が core（buildSchema/schemaJson/
  extractStockIds/loadStocksFile）を import しているのみ、を実見で確認。
  check/schema で stocksFile の baseDir 解決を contributor と同一に。

## Consultation U10 re-triage (LOW→HIGH, 2026-07-26)

自ら点検: assemblySnippet.ts 全 / extension.ts 674-695,287-305 / schema.ts required 群 /
scaffold.ts 310-330 / test/extension/insertAssembly.test.ts 冒頭 / cli/agentCommands.ts
（check の例外処理 91-122 相当）/ SPECS.md §4c 186-219（コミット済み版）。
実機確認: node -e で repo の yaml パッケージに重複トップレベルキーを与え
**YAMLParseError "Map keys must be unique at line 4" を throw することを確認**（last-wins ではない）。

判断:
- Q3（事実）: 重複キーは YAML 経路の全消費点で hard error。check は linePos 付き構造化
  診断（agentCommands 実装を実見）、保存時ビルドは toast+出力パネル（extension.ts 287-305）。
  「既存 parts が音もなく消える」事故は**発生しない**。JSON.parse は last-wins だが
  YAML 構文のスニペットを JSON 文書に挿すと即構文エラーになるため実害経路なし。
  赤線は redhat.vscode-yaml の既定挙動（重複キー検出）に依存 — repo 内では未検証（open risk）。
- Q1: 静的テンプレート方式は §4c:218 の逐語（スニペット・雛形一括挿入・展開後ただの YAML）
  を満たす。挿入直後に一時的不正となるのは UX の粗さであり、破壊ではなく loud failure。成立。
- Q2: 条件分岐案は不成立と判断 — `parts:` ヘッダ省略だけでは既存 parts: 配下への
  合流にならず（挿入位置はカーソルのまま）、真の合流は YAML 構造編集＝スニペットの
  範疇外 + tabstop ミラー編集（$1/$5/$8 共有）が二分割挿入で壊れる。コーダー判断 (a)(b) を支持。
  scope creep 認定。
- 助言（任意・小）: 挿入前に文書がトップレベル parts: を含む場合、挿入後に
  showInformationMessage で手動マージを案内（正本に残骸を残さない知覚可能化）。
- **乖離検出**: assemblySnippet.ts ヘッダコメントが「marks x/y 左下角基準を SPECS.md:130 が
  明示」と主張するが、SPECS.md:130 は `selectedPlan: null` であり §4c は corner/center を
  規定していない（corner は本 Supervisor の Q2d 助言に由来する実装判断）。出典捏造に
  当たるため要修正（コメントの出典を設計判断として書き直す）。

## Layer 2 pre-flight (floor item 6, 2026-07-26)

自ら点検: 8コミット diffstat / loader.ts 1039-1213(assemblies検証・qty導出・衝突検査) /
marks.ts 全 / dimension.ts 60-145 / partcard.ts(hatch・注記・構成ヘッダ) / build.ts
425-490,800-850(面集合・schema.json・PNG・partCards) / metrics.ts(AssemblyOut) /
schema.ts(oneOf・descriptions・qty任意化) / agentCommands.ts(check/schema・exit codes) /
assets/AGENTS.template.md / scaffold.ts / assemblySnippet.ts / package.json / README /
examples/uma / SPECS 行番号引用の突合(43,81,98,101,160,211,212,214,216,217,246,247,271) /
コミットメッセージ全文(af7f42b,59e8b9e,1e7ab34,a4baf2b) / vitest 実走(590 passed 実測)。

結果:
- 10デルタ被覆: 全実装をコードとテストで確認。裁定10問も全て裁定どおり
  （D2 2規則・path規約+prototype汚染ガード・ref写像・基底面規則・{x,x+w/2,x+w}左下角）。
- 逸脱7件: 全て受理妥当。watch 掲載のみ軽微な nitpick リスク（防御可能・コミットで開示済み）。
- **要修正1件**: assemblySnippet.ts:16 の「SPECS.md:81」は誤引用（81行=ライフサイクル表。
  parts.qty の定義は 160 行）。前回検出と同類の stale 行番号。direct: minor-fix 相当。
- コミットメッセージの SPECS 引用は全て正確。af7f42b が 0a52551 時点の manifest drift
  （中間コミット赤）を開示 — hygiene 上の瑕疵だが最終状態は緑、gate 基準外。
- reverse probe 候補: 0.3後方互換(緑)/挿入時重複キー(loud failure 確認済み・通知緩和は
  未実装=任意助言のまま)/marks境界外無診断(SPECS沈黙で防御)/.json 重複キーは
  JSON.parse last-wins で check 素通り(YAML主経路・機械生成前提で低リスク)/
  assemblies:[] の summary キー有無(未確認・些末)。
- 未検証残: redhat.vscode-yaml の重複キー赤線(外部)/scaffold 上書き禁止はコメント+
  テスト増分のみ確認/preview の変種面表示は partCards 経由の構造で確認(実UIは未見)。

## Final flush — engagement close (2026-07-26)

### 結果
- step-7 受入ゲート PASS（Main 報告: full gate、criteria=opus 26基準・judge=fable、
  逆方向プローブ実施済み）。Supervisor はゲート成果物を検証しない（Supervisor ≠ gate）。
  本記録は Main 報告の転記であり、私の認証ではない。
- pre-flight 検出の誤引用（assemblySnippet.ts:16 SPECS.md:81→:160）はゲート前に修正、
  b869b72 として着地（コミットの実在と diff は自ら確認済み）。
- リリース: bd00d34 chore(release): v0.6.0（U12 ユーザー裁定の範囲）。

### 実測で妥当性が確認された私の補完規則（Main 報告 + 一部自己点検）
- 基底面規則（面集合 = 変種面 ∪ 条件付き基底面）: 実ビルド両ケース確認 + judge の
  混在ケース逆方向プローブで独立確認（Main 報告）。実装は build.ts:465-489 で自己点検済み。
- Issue.path 非ユーザー制御規約: check の行番号写像の成立条件として機能（実装で維持確認済み）。
- ref 写像 (thickness, effectiveWidth): SPECS §4c:214 の例「38×89」と数値順一致が根拠。

### 後継者への申し送り
1. **SPECS §4c は「部分マーク」ケースを明文化していない**: 一部 unit だけが未マーク
   assembly に残る場合に基底面と変種面が併存する規則は、本エンゲージメントで未規定部を
   補完したもの。根拠はコミット 59e8b9e のメッセージと実装のみ。次回 SPECS 改訂時に
   §4c へ反映するかはユーザーの判断事項（勝手に SPECS を書き換えないこと）。
2. 同様に SPECS 未規定で実装が決めた事項: marks x/y の左下角基準（権威は
   DESCRIPTIONS["marks.x"]）・marks 境界外の無診断（描画は溢れさせ、チェーンからは落とす）・
   contains 非所属 part の qty 必須・schemaVersion 不一致 warning 維持・
   `.json` 重複キーは JSON.parse last-wins で check 素通り（YAML 主経路で許容した残余リスク）。
3. 拡張の実 UI（変種面の Webview 表示・redhat.vscode-yaml の重複キー赤線）は
   本エンゲージメントでは実機未検証のまま。
4. 誤出典2件（SPECS への虚偽/陳腐化した行番号引用）はいずれもコードコメントで発生した。
   同種作業では「仕様が規定」と「実装の設計判断」の出典区別を audit 項目に含めること。

以後の相談なし。Supervisor 解放。
