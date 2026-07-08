# Independent per-character agreement (Cohen's κ)

Breaks the shared-substrate circularity in the reconstruction benchmark: the
generator and the engine both consume the same ProseMirror step log, so the
TV=0 result is a *faithful-reconstruction* check, not an accuracy estimate. This
study supplies a ground truth **independent of the generator**.

## Protocol
1. `scripts/stress/kappa-dump.ts` builds each of the 30 LLM-authored recipes
   through the real engine and emits, per essay: the final `text`, the engine's
   per-character category string `engine` (T/A/C/U), and an `evidence` pack —
   the raw external events (paste texts with cited/uncited status, Ask-AI
   inserts) in **shuffled order, with no positions**. `docs/` keeps `engine`;
   `blind/` strips it.
2. 30 adjudicators (one per essay), each **blind to `engine`**, locate each
   evidence item in the text and label spans ai / cited / uncited; everything
   uncovered is implicitly typed. Output: `adjudications.json`.
3. `score.py` maps adjudicator spans to a per-character label string and
   computes Cohen's κ against `engine`, pooled over all characters (engine
   `residual` positions excluded).

## Result (`python3 score.py adjudications.json`)
- 30 docs, **39,976 characters**
- observed agreement **0.9941**, chance **0.4872**, **Cohen's κ = 0.9884**
- The residual is dominated by ONE adjudicator error (`llm-sanctioned_ai-2`:
  an AI-inserted passage labeled "uncited" by the judge; the engine had it
  right — see confusion cell A→U = 219). Engine-side error is negligible.

Reproduce: `npx tsx scripts/stress/kappa-dump.ts && python3 benchmark/kappa/score.py benchmark/kappa/adjudications.json`
