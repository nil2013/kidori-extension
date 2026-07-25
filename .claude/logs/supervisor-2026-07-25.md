# Supervisor notes — 2026-07-25 engagement
Model: claude-fable-5 (effort high). Charter: /fable-supervised SKILL.md.

## Step-1 intake (from instruction file only, before Main decomposition)
Instruction: .claude/logs/2026-07-25-instruction.md — kidori preview broken:
(S1) 「木取り図」「加工指示図」 tab buttons unresponsive; (S2) stuck at
「ビルド待ち…」 despite save and manual build.

Inspected: package.json, src/extension/preview.ts (full), src/extension/extension.ts
(full), git log/status, dist+vsix timestamps (both 07-25 11:36).

Key technical readings (evidence, not conclusions):
- Tabs and placeholder are static HTML (preview.ts:129-134); tab handlers wired in
  webview script (143-144). Dead tabs + no update rendering + no error banner are all
  consistent with the webview <script> never executing. Alternative: script runs but
  extension-side pipeline never posts update AND user perceives blank tab switch as
  "unresponsive" (view-parts initially empty, preview.ts:135).
- activate() awaits registerYamlSchemaContributor (ext.ts:53) and
  registerJsonSchemaSetting (ext.ts:100) BEFORE command registration (ext.ts:126) —
  an activation-path throw would leave commands/save-hook unregistered. Recent commit
  207de04 touched exactly this region. extensionDependencies: redhat.vscode-yaml.
- buildProject catches all errors and calls preview.showError → if script ran, an
  error banner would be visible. User reports none → strengthens script-dead hypothesis.
- Runtime ambiguity: user may run installed kidori-0.4.0.vsix or dev host; whether
  the 11:36 vsix was reinstalled is unknown. Fix must land where the user runs.

## Triage
- U1 diagnosis/repro: HIGH. U2 fix: provisionally HIGH (re-triage after root cause).
- U3 verification-evidence design: HIGH; its execution (tests/typecheck/build): LOW.
- U4 packaging/reinstall scope question: user decision point, not a unit.

## Consultation plan (beyond mandatory floor)
C1 post-diagnosis, pre-fix: root cause + evidence + candidate fixes.
C2 verification-evidence design (webview behavior is not gate-clickable).
C3 if defect is environmental/user-side (stale vsix, missing dependency): consult
   before reporting — scope changes, user's business.
C4 if fix touches core build 2-phase logic (8b9bc49): consult (fresh-gated code).

## Assurance note
HIGH-ASSURANCE → full gate (fable judge). Reasons: prior round logged 受入ゲート PASS
(07664c2) yet core feature is user-observed broken (prior-gate reliability defeated);
no automated coverage of webview/extension activation; fix likely near activation/
build pipeline where regressions are silent.

## Divergences flagged at intake
D1: 07664c2 claims gate PASS; user report contradicts for this surface. Main must not
    treat prior session logs as evidence of working behavior.
D2: SPECS.md untracked in git despite being referenced by code comments. Observation
    only; NOT scope expansion.

## Consultation 2 (U1 root cause) — 2026-07-25
Evidence file read: .claude/logs/2026-07-25-evidence-user.md (installed VSIX;
webview console: Uncaught SyntaxError "Invalid or unexpected token" at VM14:147,
extensionId=tnishimura.kidori).

Own probes (read-only, in-memory):
- shasum installed vs repo dist/extension.js: IDENTICAL (febe87b1a9fb…). Installed
  build IS current repo build → stale-install branch of C3 does not fire.
- U+2028/2029 scan: none in preview.ts, dist, installed bundle.
- Decisive repro: evaluated html() outer template with template-literal escape
  semantics, extracted inline script, new Function() parse → FAIL
  "Invalid or unexpected token"; odd-quote scan pinpoints script line 147:
  string broken by RAW NEWLINE. Cause: preview.ts:282 `\n` inside the OUTER
  template literal is consumed by the outer literal → generated inline script
  contains a real newline inside a double-quoted string. Extracted-script line 147
  matches user console "VM14:147" — corroborating fingerprint.
- Consequence: entire webview script never parses → dead tabs + frozen ビルド待ち
  + error banner impossible. Explains ALL current symptoms.

Advice given:
1. CRITICAL trap flagged: naive textual extraction from preview.ts source would
   FALSE-PASS node --check (raw `\n` is a valid escape pre-evaluation). Extraction
   must execute/evaluate the template (dist-derived or escape-evaluated).
2. Hypothesis A confirmed; but A does not exclude latent pipeline defects —
   "no error banner" now carries zero info about pipeline health. Post-fix E2E
   verification of save→build→update still required before closing S2.
3. Q2 moot (hashes equal). Had they differed: confirm repo status first anyway.
4. Fix advice for C1: minimal `\\n` at preview.ts:282; systematic guard = automated
   regression test that evaluates html() and parse-checks inline script; verify in
   rebuilt dist AND repackaged vsix (user runs VSIX); reinstall is user's action.
Confidence: high (reproduced, corroborated by line number). Open risks: latent
pipeline defect post-fix; template may hide other intended-for-inner escapes
(parse check is the guard, not eyeballing).

## Consultation 3 (pre-gate review, floor item 6 + decision points) — 2026-07-25
Inspected: git status/diff/log --graph, branch -a; test/extension/preview.test.ts,
vscode-mock.ts; vitest.config.ts diff; preview.ts:282 diff; dist sha cc09f093;
root vsix still 11:36 bug build.

Advice summary:
1. Branch: observable convention is linear direct-to-main (16 commits, no branches,
   no merges). Recommend main-direct, consistent with convention; harness default
   considered and displaced by convention per skill step 1.
2. Commit granularity: one commit (fix+tests+vitest.config) agreed — one logical
   change; EXCLUDE SPECS.md and .claude/logs/* from the fix commit.
3. vsix: repackage is engagement work; install is user's (provide exact command).
   Recommend version bump 0.4.1 via AskUserQuestion (recommended option) — two
   different binaries under one version id is the ambiguity that forced shasum
   diagnosis today. Bump = delivery hygiene, not scope creep; but user-facing, so ask.
   GATE RISK flagged: stale bug-version kidori-0.4.0.vsix at repo root is a FAIL
   vector if judge unzips it — must be repackaged/replaced before gate.
4. Out-of-scope flags (schema.json beside 正本; resvg hard-fail): report-only with
   file/line; fixing = scope expansion barred by intake + user rules.
5. Sweep: main gap = no executable evidence for the two trigger routes (save hook
   ext.ts:112-123, command 126-141). Plausible gate probe. Advice: add activation-
   level test ONLY if mock-only (no src refactor); otherwise document evidence chain
   with file:line + examples/bookshelf E2E + user-side verification steps in report.
   Tests reviewed: well-designed (public path via show(), vm parse-only, targeted
   regression assertions 98-103); non-vacuity stash-verified by Main (tool output).
Confidence high. Open risks: real-VSCode event delivery unprovable outside extension
host (residual, disclose honestly); same-version reinstall caching if user declines bump.

## Consultation 4 (Layer-2 pre-flight, advisory) — 2026-07-25
Own verification: git log/status; git show 8af8f24, 9e5e2bd, 639ab1f;
activation.test.ts + extended vscode-mock.ts read in full; kidori-0.4.1.vsix
unzipped in session scratchpad → pkg version 0.4.1, inline script PARSE OK
(152 lines), bundled extension.js sha == repo dist (cc09f093); tsc exit=0 and
vitest 241/241 run by my own hand. (Scratchpad unzip + test run noted: inspection-
purposed execution, no project state touched.)
Q1 sweep: no blocking ヌケモレ. Residual disclosures for final report listed (see
advice). Note *.vsix and dist gitignored — 0.4.0.vsix was never tracked.
Q2: old 0.4.0.vsix retention = report-only OK; gate risk now low (0.4.1 present,
README updated); old file doubles as diagnostic contrast artifact; user may delete.
Q3: activation.test.ts NOT over-claiming — header lines 23-36 + commit message
explicitly delimit mock-fired events vs real host delivery; verdict honest.
Q4 additions: (i) user-side verification steps incl. resvg caveat linkage — the
activation test ran with png.enabled=false, user's env runs png=true; if resvg-js
fails to load in user's Electron, build hard-fails (build.ts:474-481) and an
S2-like symptom would persist post-fix → tell user to check Output「kidori」;
(ii) provenance tags per Artifact Write Gate in final report; (iii) SPECS.md
untracked (D2) surfaced as user decision; (iv) honest E2E boundary statement;
(v) gate mechanics reminder (full gate, fable judge named, isolation).
Confidence high. Open risks: user-env resvg; real event delivery unprovable in CI.

## Final flush — engagement released after step-7 full gate PASS (2026-07-25)
Gate: full gate, fable judge, PASS; 4 reverse probes (revert→test-fail,
revert→symptom-repro, src→dist→vsix byte-identity, 241/241 no regression) per
Main's report of the displayed verdict. My notes did not cross the gate boundary.

### Triage retrospective
- U1 HIGH: correct — diagnosis was the engagement's center of gravity.
- U2 provisional HIGH: fix itself was a 2-character edit (LOW in hindsight), but
  the consultation was still warranted: value lay in the false-negative extraction
  warning and the verification design, not the edit. Provisional-HIGH was right.
- U3a HIGH (evidence design): correct — mock-boundary honesty and the vsix-level
  parse check are what carried the gate.
- Fresh-Plan exception: never needed. Assurance note (high-assurance → full gate):
  vindicated by the impeached prior PASS (D1).

### Advice that landed
1. Intake script-dead hypothesis + own in-memory repro (preview.ts:282, outer
   template consuming `\n`; line-147 fingerprint matching user console).
2. False-negative warning: raw-source extraction would PASS node --check; only
   evaluated-template extraction reveals the defect. (Main credits this as decisive.)
3. "No error banner carries zero info about pipeline health once script is dead"
   → motivated independent S2 verification (second-defect check, activation test).
4. Stale 0.4.0.vsix as gate-FAIL vector → repackage before gate; version bump
   0.4.1 rationale (artifact identity, shasum-forensics argument).
5. Mock-only constraint on activation test (no src refactor) — kept scope tight.

### Advice that missed / was moot
- Q2 branch of consultation 2 (shasum-divergence handling): mooted — hashes equal.
- Intake C3/C4 consultation points never fired (no environmental defect; fix did
  not touch 8b9bc49 core code). Cheap to have planned, no cost.
- Initial confidence split (medium on script-dead) was conservative; evidence
  settled it one probe later. Acceptable calibration.

### Residual risks for future sessions
1. resvg-js hard-fail (src/core/build.ts:474-481): with png.enabled=true (default),
   a resvg load failure in the user's Electron aborts the entire build — symptom
   resembles the fixed bug ("nothing updates"). If the user reports recurrence
   after 0.4.1, check Output「kidori」 channel FIRST before re-opening preview.ts.
2. schema.json written beside 正本 regardless of outDir (build.ts:426,
   schema.ts:322-324) — reported, unfixed, by scope decision.
3. Real extension-host event delivery (onDidSaveTextDocument firing) remains
   CI-unverifiable; final E2E is the user's reinstall of 0.4.1. Not yet confirmed
   on the user's machine at release time.
4. SPECS.md remains untracked (D2) — user decision pending.
5. Old kidori-0.4.0.vsix retained at repo root by design (defective build,
   diagnostic contrast artifact); user may delete.
6. Defect-class note: template-literal-inside-template-literal escapes in
   preview.ts html() are guarded only by test/extension/preview.test.ts (vm parse
   check). Any future inline-script edit must keep that test.

Engagement closed. No further consultations.
