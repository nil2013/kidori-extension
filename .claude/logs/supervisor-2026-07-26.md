# Supervisor notes — engagement 2026-07-26 (instruction-4)

## Boot (intake double-read)
- Model: claude-fable-5. Read instruction file .claude/logs/2026-07-26-instruction-4.md myself.
- Inspected: SPECS.md (working tree, full), git diff SPECS.md (full, vs 3c23ae8), git log -15, git status,
  src/core/{types,loader,marks,fingerprint,schema}.ts (full), src/cli/agentCommands.ts (full),
  grep build.ts (planPartFaces/schema.json), examples+scaffold+README schemaVersion grep, package.json version (0.7.0),
  .claude/logs/2026-07-26-session.md (full).
- Note: prior supervisor notes (supervisor-2026-07-25*.md) deliberately NOT read — fresh framing for this engagement.

## (a) Scope reading
Instruction: implement what revised SPECS (uncommitted, v0.7 rev with §4d + 実装レビュー反映) mandates. §4d now IN scope (owner-scope limitation lifted per instruction note).
Classification:
- NEW: expression engine (§4d: vars, context-free/position exprs, lexical spec, cycle/undefined/unused-hint, EPS), 10-step pipeline integration, marks geometric bounds (§4c:228, explicit override of prior "no check" decision), check --resolved (§3b:100; current runCheck REJECTS all options), extension hover/inlay + vars re-eval + $vars completion (§4b:188-189, §4d:274), schema union number|expr + vars section, severity "hint", schemaVersion 0.5 bump.
- CORRECTION of existing behavior: marks[].ref must be within same assembly's contains (§4b:190) — current checkMarks only checks existence in parts. Behavior change, previously-valid files may error.
- RATIFICATION (no behavior change; doc/comment sync only): front=wide face + axis mapping (§4a:117), stopped-groove from/to axes+inequality+through-error (§4:170 — but from/to DESCRIPTIONS lack the 同文 coordinate convention → real edit), rot w/h mapping ("既存の実装・出力に合わせ"), variant output unit (§6:296), marks common application (§4c:232), check path field (§3b:99), fingerprint on resolved values (§5:291 — current impl already value-based; once exprs resolve pre-fingerprint, "原式変更で無効化しない" holds structurally; add test).
- Stale comments: marks.ts resolveAliasCoord cites removed "点位置 center=軸長1/2" rule; types.ts refs.

## Tension found (divergence duty)
- §4a "初回実装の加工指示対象は front のみ" vs implementation face: "front"|"back" (features AND marks, back drawn as hidden lines on the front card). My reading: compatible (only the front face gets a card; back features project onto it). Recommend NO behavior change, do not delete back; record. Main must not read this as a mandate to remove back support.
- Instruction note claims 52 ins/25 del — verify vs git diff --stat (run alongside).

## (b) Triage (authority: mine)
- U-EXPR expression engine core — HIGH
- U-PIPE loader/pipeline integration (10 steps, mark resolution moved into validation, bounds step 8, fingerprint step 9) — HIGH
- U-SCHEMA schema union + vars section + description updates + assets regen — HIGH (layer-1 validator interplay: minimum vs string, negative-after-resolve)
- U-BOUNDS marks geometry checks — spec fully determined; fold into U-PIPE, audit HIGH
- U-REF ref∈contains check — LOW (mechanical, +tests; check examples/)
- U-RESOLVED check --resolved — HIGH until U-EXPR trace design fixed, then LOW
- U-EXT extension hover/inlay + re-eval + completion — HIGH (API/UX design choice; spec allows hover OR inlay)
- U-HINT severity "hint" plumbing — LOW (mechanical but cross-cutting)
- U-VER schemaVersion 0.5 (loader/scaffold/assets/examples/README) — LOW
- U-DOCSYNC comment/description ratification sync incl. groove from/to descriptions — LOW
- U-FP fingerprint conformance test — LOW

## (c) Consultation plan (consult BEFORE implementation)
1. C1: expression-engine architecture + model integration (raw-expr retention vs resolved model, resolution trace feeding --resolved and hover). Covers U-EXPR/U-PIPE/U-RESOLVED.
2. C2: schema union design & layer-1 validator implications (where numeric minimums move when value is an expr string).
3. C3: face:"back" ruling — adopt "no behavior change" unless user says otherwise; if Main disagrees, surface to user (Literal scope).
4. C4: extension surface choice (hover vs inlay; scope of "プレビューを更新" given save-triggered build architecture).
5. Mandatory floor items apply. No fresh-Plan designation: §4d is unusually well-specified (grammar, field list, fixed pipeline); my accumulated framing here is one session old only.

## (d) Assurance note
HIGH-assurance: outputs drive irreversible physical saw cuts; schemaVersion format bump; a mini-language whose misparse silently changes meaning of committed master files; repo history includes a shipped-defect episode. → full gate (judge model: fable, named).

## Consultation C1-C4 (2026-07-26)
Additionally inspected: errors.ts (full), schemaContributor.ts (full), completion.ts (full),
extension.ts (grep: activation/providers/diagnostics — semantic diagnostics currently applied only on save/build path via applyDiagnostics:397; onDidChangeTextDocument only bumps schema generation), preview.ts (grep: update flow — push from build), test/core/schema.test.ts (grep: rejection tests at 189-203, 292-338), git log (5489ba5 confirmed).

Advice given (summary):
- Q1a: option (i) — numeric Project + ResolutionTrace side-channel. Path grammar = formatJsonPath grammar. vars.<name> is path-safe because §4d:259 restricts var names (no dots/brackets); emit vars paths only for lexically valid names.
- Q1b: extend return of loadProjectFromRaw/loadProject with optional `resolved` field; no fork API (single-pipeline principle §4d:273; additive field is non-breaking for existing destructuring call sites).
- Q1c: model type `number | string` (raw); layer 1 relaxes to string branch; unknown alias authority moves to layer 2 parser (identifier not in {$vars}∪axis-aliases → error). Editor red-line via schema `pattern` (editor-only, validateNode keeps ignoring pattern — ID_PATTERN precedent, loader.ts:205-209 comment). Field capabilities from a single table mirroring §4d:244 enumeration.
- Q1d: split is data-flow-forced, not optional: reference checks (steps 1-2 group: duplicates, id safety, stock refs, contains, marks on/ref incl. new ref∈contains) must precede resolution (3-7); value-dependent checks (physical fit, width consistency, feature bounds, marks bounds) must follow (step 8). Value-independent checks (meta/rank/selectedPlan/barRot/qty) sit outside the fixed pipeline — place pragmatically. Gate: reference errors ⇒ skip resolution (mirrors layer1 gate). Fingerprint stays post-resolution — existing call sites satisfy §5; add regression test 原式変更/解決値同一 ⇒ fingerprint 不変.
- Q1e: resolvedValues = expression-authored fields only (strings incl. bare aliases); numeric literals excluded; expression-free file ⇒ empty array. 原式 concept implies expressions.
- Q2a: keep numeric-branch exclusiveMinimum/minimum at layer 1. No double-diagnosis: layer 1 errors gate layer 2 (loader.ts:1486-1488). §4d:260 mandates post-resolution check for expr results; doesn't forbid literal checks.
- Q2b: inversion + finite table-driven rejection suite (~15-20 cases: * / parens fn cond, dotted identifiers, unknown alias, alias in context-free fields incl. vars, expr on forbidden fields price/qty/contains/candidates/rot/selectedPlan, undefined/cyclic/duplicate/bad-name vars, trailing/double operator, empty expr, non-decimal literals incl. exponent notation — record the exponent-rejection reading as a decision). Not excessive given assurance note (mini-language on committed masters).
- Q2c: yes — layer 1 type-only, grammar authority layer 2; permissive anchored pattern in schema for editor/agent hint (optional, low-risk).
- C3: confirmed — no behavior change; back stays as hidden-line projection onto front card. SPECS never enumerates face values; removal not mandated. Sync §4a front definition into face descriptions in U-DOCSYNC.
- Q4a: hover. Pull-based ⇒ always fresh from current buffer (即時反映 trivially satisfied); no refresh plumbing/mock surface. §4b:188's インレイヒント mention read as conditional on chosen surface; authoritative wording is twice "ホバーまたは" (§4b:189, §4d:274). Inlay addable later.
- Q4b: preview update satisfied by save→build→webview (§3:51-53 fixes this flow; unsaved buffer is not 正本). Live (debounced, in-memory loadProjectFromRaw) re-eval REQUIRED for diagnostics/hover/completion on change — this is new behavior (semantic diagnostics currently save-only). Record interpretation; not user-surfaced.
- Q4c: extract pure hover-content function (text+position→string|null, needs position→path mapping via yaml CST — flagged as real design piece); test values directly on real YAML; plus one registration/wiring smoke test through vscode mock verifying an actual resolved value end-to-end.
Open risks logged: position→path mapping is genuinely new machinery (inverse of positions.ts); exponent-notation reading; live-diagnostics debounce noise.

## Consultation C5 (U-EXPR language boundary)
Inspected: src/core/expr.ts (full), test/core/expr.test.ts:300-539, grep for unary-minus tests; reproduced myself: JSON.parse dup key last-wins, yaml dup key throws (vars AND contains), JSON contains dup last-wins; a736b21 exists; expr tests 60/60 pass (ran vitest myself). Full-suite count 672/30 NOT independently verified (only expr file run).
- Q5a ruling: KEEP any-operand-position negative literals. §4d:258-260 grammar `operand ((+|-) operand)*` + "負数リテラルはパース可能" (no positional qualifier) *derives* current behavior; first-term-only would be an unwritten extra rule and makes パース可能 position-dependent. Two-spellings concern is style; SPECS handles style by recommendation (cf. "50 + 38" allowed but vars recommended), not prohibition. Tokenization unambiguous ('-' after operand = binary op; after operator = sign; '- 5' with space correctly rejected by lexNumber). Direction-of-error: rejecting risks spec-conformance FAIL at gate; accepting matches literal text. Require: pin acceptance tests for "$a + -5", "$a - -5" (grep shows only "- -5"-adjacent coverage unclear → verify) and a code comment recording the derivation.
- Q5b ruling: (i)+(iii)-lite. No raw-text scanning (disproportionate: would need JSON tokenizer, and consistency would demand scanning ALL map keys — contains, top-level sections — not just vars). YAML (primary authoring path) enforces upstream via uniqueKeys:true throw = §4d:259 satisfied where humans write; JSON is machine-generated path (§4a:115) and JSON.stringify cannot emit dup keys. Confirmed Q5b-3: contains/any map has identical pre-existing hole in JSON; prior session log (Turn 6 open threads) already recorded and accepted this exact class ("`.json` 入力の重複キー…当面は許容"). So: pre-existing class, not newly created by U-EXPR. Not a floor-3 argument-vs-project-rule conflict; treat as documented substrate limitation → report line in completion report + candidate SPECS note for next revision (user owns SPECS). No AskUserQuestion needed now; no quarantine. YAML dup message is generic parse error at <root> — acceptable, satisfies "エラー", no gold-plating.
