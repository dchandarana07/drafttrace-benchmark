# End-to-end live-pipeline evaluation

`scripts/stress/e2e-live.ts` replays every benchmark recipe through the RUNNING
server over HTTP (dev-login → create session → batched POST /events → POST
/sources → submit), then reads the session back via the instructor API and
checks (1) the event stream round-trips through ingest + Postgres + retrieval
with no loss (live provenance == in-process provenance), and (2) provenance
recomputed from the stored log still matches ground truth.

## Result (242 sessions: 200 procedural, 30 LLM-authored, 12 adversarial)
- event-stream fidelity (0 loss, live == in-process): **242 / 242**
- provenance vs ground truth: **TV mean 0.0000 / max 0.0000**
- verdict-band accuracy, end to end: **242 / 242**
- errored sessions: **0**

Distinct from the in-process benchmark: this exercises the real ingestion,
batching, persistence, and retrieval path, so it shows the *deployed* system —
not just the pure function — reconstructs authorship without loss.

Reproduce: start the stack, then `npx tsx scripts/stress/e2e-live.ts 25`
