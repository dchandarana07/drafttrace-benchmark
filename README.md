# DraftTrace Benchmark

Ground-truth data and scoring for the writing-provenance evaluation in the
DraftTrace EMNLP System Demonstrations paper. This repository releases the
**benchmark data and the scoring scripts only** — the provenance engine itself
is proprietary and available to researchers on request.

DraftTrace records the writing process and attributes every character of a
student submission to one of four origins: **typed**, **in-app AI**,
**cited paste**, or **uncited paste**. Because origin is recorded as the
document is produced, authorship is known by construction — which is what makes
a ground-truth benchmark possible.

## Contents
- `benchmark/recipes/` — the 30 LLM-authored submission recipes (procedural and
  adversarial recipes are generated deterministically by the paper's harness).
- `benchmark/labels.jsonl` — per-submission ground-truth character counts by origin.
- `benchmark/results.jsonl` — the engine's output per submission (shares, verdict,
  TV distance, flags).
- `benchmark/metrics.md` — the aggregate reconstruction report.
- `benchmark/kappa/` — the independent-agreement study: per-essay documents +
  per-character engine labels (`docs/`), the blind adjudicator inputs (`blind/`,
  engine labels withheld), the adjudications, `score.py`, and a README.
- `benchmark/e2e/` — the end-to-end live-pipeline results + README.
- `benchmark/transplant/` — the transplant-guard suite: 700 staged sessions
  probing whether provenance survives legitimate self-moves without becoming
  a relabeling channel (700/700) + README.

## Headline results
- **Reconstruction:** across 242 submissions (200 procedural, 30 LLM-authored,
  12 adversarial), the engine recovers the recipe's composition exactly
  (mean total-variation distance 0.0000; verdict band 242/242). This is a
  faithful-reconstruction guarantee, not an attribution-accuracy estimate:
  the generator and the engine share the same edit-transaction substrate.
- **Independent agreement:** an adjudicator blind to the engine re-attributed
  origin on all 30 LLM-authored essays (39,976 characters) from the recorded
  evidence alone. Cohen's kappa = 0.99 (raw agreement 99.4%).
- **Live pipeline:** replaying all 242 sessions through the running server
  (HTTP → Postgres → retrieval) round-trips with zero event loss and reproduces
  the in-process result exactly (TV 0.0000; verdict 242/242).

## Reproduce the scoring
```
python3 benchmark/kappa/score.py benchmark/kappa/adjudications.json
```
recomputes Cohen's kappa from the released adjudications and engine labels.

## Citation
DraftTrace: From "Is This AI?" to "How Was This Written?" — Per-Character Writing
Provenance in Canvas. Gupta and Chandarana, CoRAL Lab, Arizona State University.

## License
Data and scoring are released under CC BY 4.0 (see `LICENSE`).
