# Supervisor notes — engagement 2026-07-25b (instruction-2)
Model: claude-fable-5. Charter: /fable-supervised SKILL.md read from disk.

## Step-1 intake (own reading, formed before seeing Main decomposition)
Inspected: .claude/logs/2026-07-25-instruction-2.md (verbatim), SPECS.md (v0.6, 237 lines, UNTRACKED),
git state (HEAD 639ab1f = brief's claim, confirmed; main ahead of origin by 3, unpushed),
src/extension/extension.ts, src/cli/main.ts, package.json, src/extension/presets.ts,
src/extension/schemaContributor.ts, greps on build.ts/loader.ts/schema.ts, examples/bookshelf/project.yaml head, README greps.

Instruction = (1) track+commit SPECS.md (it is untracked; other untracked files are engagement logs — out of scope),
(2) update implementation to conform to SPECS v0.6, scope = §7 v1 list (v2 items & §8 unchecked excluded).

Current impl is v0.4-era. Key deltas (v0.5+v0.6): file=project (naming *.kidori.yaml + content detection) vs
current fixed project.{yaml,json} everywhere (isProjectFile regex schemaContributor.ts:22, activationEvents,
completion selector pattern extension.ts:91, findProjectFile, CLI defaultProjectPath); out/ -> <name>.out/;
presets: bundled+kidori.presets.json two-source vs 4-layer cascade (builtin/user-XDG/dir-stocks.yaml/in-file)
+ preset provenance key + materialization snippet; stocksFile: absent; schemaVersion 0.2->0.3 (loader warns on
mismatch, non-fatal); kidori new/init absent entirely; project.schema.json disk regeneration must be removed
(json.schemas currently points at adjacent project.schema.json, extension.ts:395-455); selectedPlan
invalidation-on-edit (§5) unimplemented, needs persisted fingerprint design; preview/build state is
single-global (lastProjectPath/lastResult) vs multi-project coexistence.

Triage: HIGH = detection redesign, cascade+materialization, JSON schema path redesign, multi-project state,
selectedPlan invalidation, new/init scaffold+AGENTS.md. LOW = out-dir rename, stocksFile loader (well-specified),
preset field passthrough, schemaVersion bump, README/examples, package.json.

Assurance: HIGH-assurance -> full gate (fable judge). Rationale: cross-cutting break of core assumption across
3 layers; artifact governs real material cutting; prior gates found real defects; preview regression class
(test/extension/preview.test.ts is sole barrier).

Backward-compat recommendation: no dedicated legacy paths. Spec's own content-detection (§3 救済) rescues old
project.yaml (they carry meta.schemaVersion). Drop kidori.presets.json (superseded by cascade). Keep
schemaVersion warning-not-error. Migrate examples/README.

Open user questions: version bump + .vsix packaging in scope? (repo convention commits vsix on release;
instruction silent). Push of ahead-by-3 not in scope unless asked.

## Consultation 2 — step-3 design, clusters A/B/C (U1,U10,U11,U2 / U3-U6 / U8,U9,U12)
Verified myself: 5967c89 (SPECS committed, ahead-by-4 OK), 8032194 (Python removal — old design docs stale, agreed),
loader.ts:92-94 readRaw ext-switch only (Main's claim holds, with caveat: core still carries name-coupled
strings/defaults — build.ts out/ default, checkModeline text recommending project.schema.json, marker texts).
Read in full: completion.ts (S-06 price omission rationale confirmed), preview.ts (+test constraints:
assertions cover tab ids/script-parse/stale-banner only; empty-state string line 134 is name-coupled but unasserted),
assets/stock-presets.json ({stocks,lengths,widths} completion-shape), metrics.ts Summary interface.

Key advice given (decision-grade):
A-1: basename suffix predicate (.kidori.{yaml,yml,json}) + content detection (modeline→kidori.schema.json basename,
or parsed meta.schemaVersion) w/ per-URI verdict cache retaining last on parse failure; broad language:yaml selector +
in-provider gate (confirmed best); activationEvents = onLanguage yaml/json + workspaceContains **/*.kidori.*;
accept *.kidori.json by name (spec closure, log it); regex bug fixed only via explicit basename tests — mandated.
A-2: contributes.jsonValidation for *.kidori.json → bundled assets/kidori.schema.json generated at build from
schema.ts (single source); runtime json.schemas per-file only for content-detected plain .json → bundled asset URL;
no dynamic stock-enum for JSON in v1; init writes same base schema at runtime.
A-3: single panel, per-project result map, panel bound at update-time; PreviewData += projectPath/label (additive,
test-safe); action routing must carry bound path (latent race in applySelection flagged); update line-134 string.
A-4: strip .kidori.{yaml,yml,json} suffix else last ext, + ".out"; spec §3 example bookshelf.out/ is normative;
collision guard = O(1) sourceFile check in existing summary.json, else user error, README note.
B-1: master key = preset ?? id; layers 2/3 format = top-level stocks: list, same entry shape as 正本 (dir file doubles
as stocksFile target); builtin redesigned {presets:[{preset,label,kind,dims}],lengths,widths}, no price;
XDG_CONFIG_HOME respected, fallback ~/.config; shadow diagnostics = Information severity (editor-side; output channel
when no doc), inline-vs-stocksFile collision = loader warning path.
B-2: materialize all master fields incl. price *only when present*; builtin carries no price → S-06 preserved;
id tabstop from master id, preset key second per spec example.
B-3: single hop (nested stocksFile in target = error → no cycles); missing/invalid target = error (正本セット integrity);
absolute path = error, .. allowed, no symlink policing (read not write).
B-4: preset?: string minLength 1, no pattern (§8 unconfirmed), loader pass-through.
C-1: CLI non-interactive + repeatable --preset; VS Code InputBox + canPickMany QuickPick; overwrite refusal;
modeline active only if ./kidori.schema.json exists else commented hint — deliberate minor spec deviation, log it.
C-2: extension command required (§3); AGENTS.md minimal per §3a bullets, schema-reference-first; .gitignore
append-not-clobber; stocks.yaml opt-in; idempotent skip-and-report.
C-3: fingerprint = sha256 canonical JSON of placement inputs (parts: id,qty,stock,length,width,rot; stocks:
id,kind,dims incl thickness; settings: kerf,edgeTrim; EXCLUDE price/labels/features/preset/candidates/rank/exact);
stored in summary.json adopted:{plan,fingerprint}; invalidation preserves original fingerprint (revert revalidates,
no self-heal); warning Issue at settings.selectedPlan via existing channel; Summary += selectedPlanStale;
recommendationActive must use effective selection; out/-deletion limitation documented.
User-question: none mandatory; two log-level interpretations (*.kidori.json naming, scaffold modeline conditionality).

## Consultation 3 — cluster B landing: 2 flags + architecture
Inspected: presets.ts full (rewrite verified: masterKey/mergeLayers/resolveCascade/StockShadowReporter,
XDG handling, dedup guard for stocks.yaml-as-document), completion.ts full (S-06 refinement implemented,
snippet esc, isInsertable), assets/stock-presets.json (new presets[] format, no price, key scheme 素材/断面/定尺),
schema.ts:334-355 buildStocksFileSchema (additionalProperties:false, required:[stocks]), test describe/it survey.
Advice:
F1: builtin-only lengths/widths = defensible literal reading but loses declared function; DECIDE: derive dim
candidates from resolved cascade entries (union builtin lists + entry.length/width of winners), no schema loosening,
兼用可 intact. Update "定尺候補はビルトイン層が供給する" test.
F2: YES materialize preset for id-fallback keys from layers 2-3 (user layer IS 規格材マスタ per §2/§4b; v2 divergence
tracking needs the linkage; §4 "キーを消すだけ" opt-out covers it). BUT exclude layer=="file" entries from
insertion candidates (self-referential duplicate w/ preset pointing at sibling id = v2-semantic noise).
Arch: cut IS mandatory (not hygiene) — CLI kidori new --preset cannot import vscode. Placement: src/core/stocks/
(cascade pure parts + materializeEntry plain-text form); tabstop-wrapping stays extension-side. §3 "エディタ非依存"
is the defining property of core; build-path independence is invocation not location — the REAL invariant is
"build.ts/loader.ts do not import cascade". Flag: existing test asserts the inverted direction
(presets/completion don't import src/core) and will break on refactor — rewrite to correct invariant.
Include cut in EXT brief before C-1.

## Consultation 4 — deviation notice (C-3 bar-rot normalization) + label-escape direct-fix
Inspected: git show 61c0750 (stat), src/core/fingerprint.ts (full), loader.ts rot handling (469, 887-905),
adoption.test.ts describe/it survey (incl. sheet-rot positive control, no-self-heal, revert-revalidate,
out-dir sharing guard), src/core/stocks/materialize.ts escapeYamlDoubleQuoted (backslash-first order OK).
Verdict: NO OBJECTION to bar-rot normalization — pack1d never reads rot, loader warns on bar rot; my own
principle (placement-determining inputs only) entails it. Record correction flagged: the width caveat the Main
attributed to my C-3 decision is NOT in my record either — BOTH bar normalizations (width AND rot) are
Main/implementer-originated. Both correct. Label direct-fix accepted (correctness, small, no design reopened).

PRE-GATE REVIEW CHECKLIST (accumulating):
1. fingerprint.ts bar normalization (width+rot) — Main-originated design change; re-verify against final loader
   semantics (esp. if bar width validation changes later).
2. materialize.ts label escaping — verify escape LAYERING: core does YAML escape; extension SnippetString wrapper
   must snippet-escape ($ } \) OVER the yaml-escaped body; demand a test with label containing both " and $.
3. Aliases Presets/loadPresets removed; extension.ts wiring in flight; tsc currently red on uncommitted work —
   check no commit was made in red state; each commit self-consistent.
4. preview.test.ts intact after extension wiring (standing item).
5. Earlier items: recommendationActive uses effective selection (verified test 344/368 region exists — re-check
   in build.ts final); *.kidori.json naming + scaffold-modeline conditionality logged as interpretations;
   orphaned "project.yaml" strings sweep (core messages, preview.ts:134, README).

## Consultation 5 — extension wiring landed (61c0750/8a89528/38c6845), flags A/B/C
Inspected: extension.ts full (rewired: results Map, activeProjectPath, gated completion, rescue json.schemas,
bundledSchemaPath), preview.ts binding+stale sections, build.ts resolveAdoption region, manifest.test.ts
(drift test = exact content compare vs baseSchemaJson() + .vscodeignore + jsonValidation + activationEvents),
esbuild.mjs:38-61 (schema asset generation), completion.test.ts:151-157 (escape LAYERING test exists —
checklist item 2 SATISFIED), selectionTarget/previewProject test surveys (action routing race covered —
checklist item on applySelection race SATISFIED), cli/main.ts runSelect fix verified (options passed through).
Verdicts:
FlagA APPROVE — graying displayed project X for other-project Y's failure would show FALSE info; per-project
surfaces (diagnostics on Y = user's active editor, toast, channel, BUILD-FAILED) remain. RESIDUAL GAP FLAGGED:
stale bit is per-panel, results Map stores successes only → fail Y, switch preview to X, switch back to Y
re-shows Y's outdated drawing WITHOUT banner. Recommended cheap fix: failedProjects Map, showResult re-issues
showError. Small follow-up, not blocker; pre-gate checklist item 6.
FlagB APPROVE — 2-step is the honest UI of the no-self-heal invariant; same-plan re-adopt genuinely cannot
1-step (no text change → no save → no rebuild; and rebuild wouldn't refresh record by design). Different-plan
adoption from stale IS 1-step (resolveAdoption previous.plan !== requested). Reject core reconfirm API for v1.
FlagC APPROVE — commit generated schema OK GIVEN the drift test does regenerate-and-compare (verified exact
string equality) — without that test it would be a foot-gun. Asymmetry vs dist/ principled: schema is
user-facing 形式仕様 w/ review value; dist is unreviewed runtime bundle. Their arg(1) weak (package builds first)
but F5 dev-host + drift-visibility carry it.
runSelect fix accepted (coupled to U2, correctness of changed behavior, not unsolicited improvement).
jsonValidation glob open risk CLOSED by implementer's実測 (glob compiler extraction, **/ normalization).
Remaining known: kidori.new/init handlers unregistered (in progress — gate-relevant), README/examples, release.
Checklist adds: 6. per-project failure state on preview switch. 7. verify command handlers registered before gate.

## Consultation 6 — Layer-2 pre-flight (floor item 6, advisory only)
Own verification: git log (7 commits as reported), status clean except .claude/logs; npx vitest run = 483/483
(25 files) MY RUN; npx tsc --noEmit exit 0 MY RUN. Orphan sweep for project.yaml/project.schema.json/
kidori.presets.json → only intentional deprecation notes remain. examples/ = bookshelf.kidori.yaml with
commented-modeline + rationale, schemaVersion 0.3, preset keys cross-checked against builtin (pine/18mm/sabroku,
spf/1x4/6f — both exist). AGENTS.template.md matches §3a 4 bullets, schema-reference-first. package.json:
version 0.5.0, 5 commands, buildOnSave text updated. .gitignore *.out/ + documented do-not-ignore exceptions.
preview empty-state string updated. checkModeline removed (no orphan). kidori.new: InputBox + canPickMany
preset QuickPick; kidori.init: withStocks QuickPick (extension.ts:479-652, cdfec7f w/ newInitCommands.test 367L,
staleReassert.test 142L — my Flag-A gap fix verified present).
RECORD CORRECTION (own error): intake claim "repo convention commits vsix" was WRONG — git ls-files/-diff-filter=D
show *.vsix never tracked; user decision 2 (generate-only) is self-standing and satisfied; disclose in report.
Pre-flight verdict (ADVISORY, zero certification value): no blocking ヌケモレ found against step-1 reading.
Gate-risk register: (1) §3a scaffold modeline letter (commented form always present; defense §4b 代替手段);
(2) §4b JSON dynamic enum deferral (defense §4a positioning); both may FAIL under a literal judge → floor-5
consult before acting, classify as spec-internal tension if hit. Reverse-probe exposure: deletion side clean
(orphan sweep). Report-must-include list handed to Main (interpretations/deviations, known limits incl. out/
deletion re-validation + old out/ dirs not auto-removed, unpushed state, vsix generated-not-committed,
presets content still §8-provisional, bar-normalization attribution, my vsix-convention correction).
Reminder to Main: full gate (fable judge, named explicitly) per intake assurance note; criteria agent opus;
nothing Main/Supervisor-generated crosses the boundary (these notes included); verdict displayed in full;
reverse probe mandatory; Supervisor pass ≠ certification.

## FINAL FLUSH — engagement released after step-7 full-gate PASS (fable judge, verdict displayed per Main)
Gate outcome as reported by Main: PASS, 55 criteria, 5 reverse probes (incl. mutation-probe on defaultOutDir and
rot, vsix byte-identity vs judge's own rebuild), my 2 registered letter-risks did not FAIL; judge self-rejected
over-derived criteria A1/A3. (Narration, not my evidence — but consistent with my own pre-flight measurements:
483/483 vitest, tsc 0, orphan sweep clean.)

### Triage validity (retrospective)
HIGH calls all earned their consults: U1 (selector/gating/JSON), U3+U4 (cascade model, 2 implementation flags),
U10 (jsonValidation design), U11 (produced the applySelection race find), U12 (produced no-self-heal invariant),
U8/U9 (modeline tension). LOW calls held: U2 needed only the A-4 stem sub-question; U5 stocksFile stayed
well-specified; no LOW unit re-triaged HIGH. Judgment-density model worked.

### Advice that landed (per Main's closing attribution + my record)
applySelection race; per-panel-stale/success-only-results gap; adoption-record non-update on mismatch
(no self-heal); price exclusion from fingerprint; lengths/widths "format constraint ≠ supply constraint" split;
layer-4 exclusion from insertion candidates; escape-layering test demand (mutation-verified); attribution
correction (bar normalization = Main-originated); gate-risk register with floor-5 handling instructions.

### My errors (for the record)
1. Intake: claimed repo convention commits vsix — wrong (never tracked); corrected at pre-flight, disclosed.
2. C-3 original field list lacked the bar-normalization class entirely (width and rot); implementer caught it.
3. Early U1 blast-radius listed core as behaviorally name-coupled; actually strings/defaults only.

### Residual risks for future sessions
1. out/-deletion silently revalidates adoption (structural; README-documented).
2. Scaffold modeline conditionality is a deliberate §3a-letter deviation — if user objects, revisit; interpretation logged.
3. JSON dynamic stock-enum deferred to v2; custom-scheme TextDocumentContentProvider route remains unverified.
4. Builtin preset content is §8-provisional (資材価格ログ表記整合 pending); keys now stable — renaming keys later
   breaks materialized preset provenance in user files.
5. bar fingerprint normalization presumes loader never validates bar part width; adding such validation requires
   fingerprint revisit (fingerprint.ts header documents inputs).
6. resolveCascade re-reads layers 2/3 per completion — perf watch item for large stocks.yaml (mtime cache is the fix).
7. Webview inline-script escape class: preview.test.ts + staleReassert/previewProject tests are the barrier;
   any html() string edit must keep double-escape discipline.
8. main unpushed (push never requested); .claude/logs to be committed post-gate as docs(log).
9. v2 preset divergence detection: linkage now exists (preset keys materialized incl. user-layer fallback keys) —
   design hook intact; diagnostic-strength question remains §8-open.
10. Respawn rule: any future Supervisor boots from instruction file + task list + this notes file only.

Engagement closed. No further consultations.
