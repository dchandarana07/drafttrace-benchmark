# Reference runs

One implementation's results, kept so the checks in docs/SCENARIOS.md can be
read against real output — including the runs that failed. They are a worked
example, not a target.

**What produced them.** A reference writing-process recorder deployed on a
2 vCPU / 2 GiB Ubuntu 24.04 VM. The browser tier was driven from a separate
desktop (Ryzen 7, 32 GB) over a private network. Runs are from 2026-08-29.

**What is in them.** Only counters, timings and pass/fail. No writing, no
student text, no names beyond the runner's own generated ones (`Alex Nguyen
0`), no addresses. Session ids are UUIDs from a throwaway test database. The
host address and the source quiz's title have been generalised.

Licence: CC BY 4.0 (see `../LICENSE-DATA`).

| File | Scenario | Outcome |
|---|---|---|
| `offline-compare.txt` | S0.4, S0.7 — Tier 0, five models, 10 sessions each | PASS. Regenerate with `npx tsx src/runners/run.ts --compare --n 10 --words 300 --quiet` |
| `api-100-first-run.{json,log}` | S1.2 — 100 students, 3 min, first attempt | **FAIL.** 78 of 100 refused at `/enter`: a per-IP identity cap of 300/hour, and a class behind one NAT address is a single IP. The most valuable run in this folder |
| `api-100-assistant-burst.{json,log}` | S1.2 + S1.3 — the same class after the cap was raised, with 31 assistant questions | PASS on transport (76,776 events all acknowledged, 100/100 replays identical, 87/87 submitted), **16/31 assistant answers** — provider rate limits |
| `api-100-assistant-exhausted.{json,log}` | S1.8 — the same class with the assistant's quota gone | PASS on transport (71,948 events, 100/100 replays); 0/29 assistant answers, all failing slowly (p50 24 s). This is why a failed ask now fails the run |
| `api-100-clock-skew.{json,log}` | S1.6 — 100 students, ±10 min per-student clock skew, 10 % outages | PASS — 74,242 events all acknowledged, 100/100 replays identical, 91/91 submitted, ingest p99 35 ms, submit p99 27 ms |
| `replay-136-class.{json,log}` | S3.3 — a recorded class of 136 students replayed at 2× | PASS — 146,142/146,142 events, 136/136 replays identical, 119/119 submits, ingest p99 99 ms. The bundle itself is not published |
| `browser-10.log` | S2.2 — 10 real browsers, 3 min, all scenarios, 2 % injected loss, ±10 min skew | FAIL as reported: 9/10 replays. The first pass counted injected-loss retries as failures; the accounting was corrected for the later runs |
| `browser-60-herd.log` + `browser-60-herd-api-tier.log` | S2.4 — 60 real browsers with a 2-second arrival, plus 40 API students concurrently | FAIL at 60: 58/60 reached the editor, 57/58 replays, cold load p50 3.4 s. The client machine was at 86–92 % CPU — this is the **client's** ceiling, not the server's. The API tier PASSED concurrently (29,074 events, 40/40 replays) |
| `browser-40-realistic.log` + `browser-40-realistic-api-tier.log` | S2.5 — 40 real browsers, 20-second arrival, 1 % loss, 20 % reopen, 25 % tab-hide, 15 % offline, plus 40 API students | 40/40 reached the editor (cold p50 0.94 s, p95 1.16 s), **40/40 server replays identical including all 7 reopen students**, 4,782/4,839 POSTs first try, 36/37 submitted. The one miss: the app correctly showed "Could not submit — try again" after an injected loss and the runner did not press Submit again. A student would; the runner now retries. API tier 40/40 PASS |

## Reading the JSON

Each `*.json` from `live.ts` is:

```json
{ "api": "…", "students": 100, "minutes": 3, "wall": 226.4,
  "reports": [ { "i": 0, "name": "…", "model": "markov", "wpm": 36,
                 "opsPlanned": 632, "opsPlayed": 437,
                 "sent": 437, "acked": 437, "duplicates": 0,
                 "batches": 86, "snapshots": 13,
                 "offline": false, "submitted": true, "wantedSubmit": true,
                 "docMatch": true, "exportOk": true,
                 "skewMs": -46927, "askai": "skipped",
                 "errors": [], "finalWords": 92 } ],
  "samples": [ { "kind": "ingest", "ms": 11.4, "status": 200 } ] }
```

`sent` vs `acked + duplicates` is the loss check; `docMatch` is the replay
check; `samples` is every HTTP call the runner made, for the latency
percentiles.

## Two honest notes

- The browser-tier logs are truncated where the runs were captured over a
  network session; the memory-ladder figures quoted in docs/SCENARIOS.md
  (10 / 30 / 60 browsers) came from process sampling alongside those runs, not
  from these files.
- Everything here is one implementation measuring itself. That is exactly the
  circularity this repository exists to let someone else break: run the same
  scenarios against your own system, and publish your own `results/`.
