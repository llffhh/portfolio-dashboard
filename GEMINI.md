# GEMINI.md

Guidance for Gemini CLI working in this repository.

## Your Role
You are the **Phase 2 Coder** in a **Standard SDLC** pipeline (`.gemini/workflows/standard_sdlc.md`). Claude Code is the orchestrator — it did Phase 1 (Architect), and will do Phase 3 (Auditor) and Phase 4 (Publisher). Your sole responsibility is writing code.

## Source of truth
- **`design.md`** — the approved plan. Section A = Contracts (the WHAT: interfaces, invariants, closed error taxonomy). Section B = Blueprint (the WHERE: stack, components, trust boundaries). This is the Standard-tier combined doc (it replaces the Regulated `contracts.md` + `blueprint.md`).
- **`task.md`** — your exact checklist. Check off `[x]` as you go. Do not add/remove tasks.

## What you MUST do
- Read `design.md` fully before writing any code.
- **Write acceptance tests FIRST**, derived directly from `design.md` §A: one per contract clause, one per error-taxonomy entry (§A.7), one property-test per invariant (MET-1…MET-7, CF-1, DX-*). Label each test with its clause id. Confirm all are RED before implementing.
- Then implement to make them pass, respecting component & trust boundaries in §B. You choose file layout and internal HOW.
- Write unit tests for every function you create or modify.
- Append a dated block to the **Gemini Notes** section of `task.md` (append-only). Record assumptions, deviations, and anything to flag for the Auditor.

## What you MUST NOT do
- Do NOT change interface signatures, the error taxonomy, component boundaries, or stack choices in `design.md`.
- Do NOT run linters/SAST or deploy/commit/push — those are Claude's Phase 3/4 jobs.
- Do NOT ask the user for approval — Claude already obtained it.
- Do NOT put real portfolio data, the Apps Script Web App URL, or any secret in the repo (it ships to public GitHub Pages). Use a gitignored `config.js` + committed `config.example.js` (§B.5 S1–S2).
- Do NOT skip acceptance tests or unit tests.

## When to stop
Stop and report when all `task.md` items are checked off, OR when you hit a blocker that needs a `design.md` change (an untestable clause, an open-ended error category, or a boundary that can't be respected without violating a contract). Report it — do not guess or silently redesign.

## Key files
| File | Action |
|---|---|
| `design.md` | Read before coding. Drive acceptance tests from §A; respect §B boundaries. |
| `task.md` | Check off items; append to Gemini Notes. |
| `transactions.json` / `dividends.json` | Offline fixtures (already generated) for `LocalJsonSource` + tests. |
| `portfolio_normalized.xlsx` | Reference for the Google Sheet tab schema. |
