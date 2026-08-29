# The scenario matrix

Every scenario states its **expectation before its result**. That ordering is
the point: a benchmark whose expectations are written after the numbers is a
description, not a test.

Scenarios are grouped in four tiers by what they cost to run and what they can
prove. A tier only means anything if the tier below it is green.

- **Tier 0 — offline** (seconds, no server): the harness checks itself.
- **Tier 1 — API classroom** (minutes, a running system): transport, ordering,
  idempotency, durability, sealing.
- **Tier 2 — real browsers** (tens of minutes, a beefy client machine): the
  page, the editor, the client-side queue, the tab, the clock.
- **Tier 3 — class replay** (minutes, needs a recording): a captured class,
  reproduced on demand.

Reference results in the right-hand column are from one reference
implementation on a 2 vCPU / 2 GiB Linux VM, with the browser tier driven from
a desktop over a private network. They are there to show what the checks look
like when they pass and when they fail — **not** as a target to beat.

---

## Scoring

A scenario is **PASS** only if every expectation holds. There is no partial
credit and no aggregate score, because the failure modes are not commensurable:
losing one keystroke in ten thousand is not "99.99 % good", it is a recorder
that loses keystrokes.

Alongside pass/fail, every run reports numbers that should be quoted with it:

| Reported | From |
|---|---|
| events sent / acknowledged / duplicated | Tier 1, 3 |
| replay identity (students whose server document matched, out of those who wrote) | Tier 1, 2, 3 |
| submits completed, non-submitters sealed | Tier 1, 2, 3 |
| latency p50/p95/p99 per phase | Tier 1, 3 |
| cold page load p50/p95/max, POST success rate from the browser's own log | Tier 2 |
| process metrics per writer (WPM, bursts, pauses, non-linear edits, motor CV) | Tier 0 |

Report the *configuration* with the result — student count, minutes, timescale,
outage/skew/loss rates, and the machine both ends ran on. A number without its
configuration is not a result.

---

## Tier 0 — the harness checks itself

Run: `npm test`, then `npx tsx src/runners/run.ts --compare --n 10 --words 300`.

| # | Scenario | Expectation | Reference result |
|---|---|---|---|
| S0.1 | Every model reproduces its target text, 200 seeds each | exact, always | PASS |
| S0.2 | Same seed, same trace | byte-identical ops and truth | PASS |
| S0.3 | Markov port vs the original Python project, 300 runs each (`tools/xcheck_*`) | total time, inter-key mean and CV, backspaces within a few percent | PASS — 63.0 s vs 62.4 s; 217 ms vs 218 ms; CV 0.66 vs 0.67 |
| S0.4 | Composer → real ProseMirror → metrics | final text identical; typed chars, revisions, planning pauses and words EXACT; non-linear edits ≥ structural revisions | PASS, all models, dozens of seeds |
| S0.5 | Op trace self-consistency | applying the ops gives the composer's own final text | PASS |
| S0.6 | Metric definitions (`test/metrics.test.ts`) | the 2 s threshold, burst closure, pause location, jump threshold and rate normalisation each behave as documented | PASS (24 checks) |
| S0.7 | Motor rhythm separates naive bots | every fixed-profile and fixed-delay bot below the human floor; the Markov humanizer inside the human range | PASS — profiles/robotic 0.00–0.42, Markov 0.59–0.70, human floor 0.46 |

**S0.7 is a documented miss, not a win.** See docs/HUMAN_BASELINE.md: a
humanizer that models keyboard distance, bigrams and error correction is not
separable from real writers by timing. Any system claiming to detect scripted
typing from rhythm should be run against `--model markov` and should report the
result whichever way it goes.

---

## Tier 1 — the API classroom

Run: `API=http://host ADMIN_TOKEN=… npx tsx src/runners/live.ts --token <entryToken> …`

| # | Scenario | Command | Expectation | Reference result |
|---|---|---|---|---|
| S1.1 | Smoke: 6 students, 1 min, 4× time | `--students 6 --minutes 1 --timescale 4 --offline 0.3` | all events acknowledged; server replay == client document for every student | PASS |
| S1.2 | Full class: 100 students, 3 min real time, 30–110 WPM, 10 % outages, 10 % non-submitters, 5 % bots | `--students 100 --minutes 3 --offline 0.1 --nosubmit 0.1 --bots 0.05` | same, plus the instructor list agrees with what was sent | **FAIL then PASS** — first run 78/100 refused at `/enter`: a per-IP identity cap, and a class behind one NAT address is one IP. After raising the cap: 76,776 events all acknowledged, 100/100 replays identical, 87/87 submitted, 9 outage students drained, list consistent |
| S1.3 | Assistant under a class burst (31 questions in 3 min) | `--askai 0.3` | every question answered | **FAIL** — 15/31 lost to provider rate limits. Fixed with request pacing; a failed ask now fails the run by design |
| S1.4 | Snapshot pressure at 100 students | as S1.2 | the server stays comfortable | load average 3.3 on 2 vCPU with 50-event snapshots → cadence changed to 30 s / 400 events |
| S1.5 | Non-submitters | as S1.2, then check | every non-submitter sealed by the server-side sweeper after the deadline plus the ingest grace, with metrics computed | verified |
| S1.6 | Wrong clocks: ±10 min per-student skew, 10 % outages | `--students 100 --minutes 3 --skew 10 --offline 0.1` | all acknowledged, 100/100 replays, list consistent | PASS — 74,242 events, ingest p99 35 ms, submit p99 27 ms |
| S1.7 | Deadline crossing | `--students 12 --minutes 4 --skew 10 --nosubmit 0.5 --wait-sweeper` on a 2-minute quiz | students stop at the **server's** bell; skew-ahead students' post-bell stamps show as late-stamped and are excluded; every non-submitter sealed within deadline + grace, with metrics | PASS — 12/12 stopped at the bell, 8/8 submitted, 6,401/6,401 events, 12/12 replays, 4/4 non-submitters sealed |
| S1.8 | Assistant with no quota left | `--askai 0.3` against an exhausted provider | a calm "keep writing" message in under a second, and the provider shown as cooling | PASS — 0.31 s first, 10 ms after |
| S1.9 | Submit/ingest race: a batch and the submit in the same tick | (needs a SUT-side probe) | no event received after its session was sealed; refused batches answered 409; exactly those sessions flagged | PASS — 23 landed before the seal, 17 refused, 0 leaked |

### What Tier 1 does and does not prove

It proves transport, ordering, idempotency, durability across an outage, the
cadence, the deadline and the sealing path. It does not touch the browser: a
green Tier 1 with a broken editor is entirely possible, and did happen.

---

## Tier 2 — real browsers

Run: `API=http://host npx tsx src/runners/browser.ts --token <entryToken> --students 40 --minutes 3 …`

Each student is a fresh browser context with a cold cache on the real page:
real key events timed by the human-typing models, shaped Wi-Fi, injected
request loss, clock skew, CPU throttling, offline windows, hidden tabs, a
closed-and-reopened tab, and non-submitters.

| # | Scenario | Expectation | Reference result |
|---|---|---|---|
| S2.1 | Smoke: 6 students, 1 min | all reach the editor; every event POST acknowledged (from the browser's own network log); replay 6/6; submit 6/6 | PASS — cold load p50 0.93 s, POST p50 149 ms browser-side |
| S2.2 | 10 students, 3 min, all scenarios, 2 % request loss, ±10 min skew | same, plus memory per student recorded | 10/10 reached the editor, 10/10 submitted, 9/10 replays (one reopen-during-loss case) |
| S2.3 | 30 students | memory flat, throughput unchanged | ~370 MB per student including shared processes; server 23 % CPU |
| S2.4 | 60 real browsers + 40 API students, 2-second arrival ("everyone scans the QR at once") | same, and server ingest p99 unchanged | the client machine, not the server, is the ceiling: 20.3 GB of browser memory, cold load p50 3.4 s. Server: 38 % CPU, API tier 40/40 PASS |
| S2.5 | Realistic profile: 40 real browsers + 40 API, 20-second arrival, 1 % loss, 20 % reopen, 25 % tab-hide, 15 % offline | every expectation | 40/40 reached the editor (cold p50 0.94 s), **40/40 replays identical, including all 7 reopen students**, 4,782/4,839 POSTs first try, 36/37 submitted |
| S2.6 | Type → network off → keep typing → network on → reload → submit | every keystroke reaches the server | PASS — 158/158 |
| S2.7 | Reload **while** offline (browser error page) → reconnect → reopen → submit immediately | every keystroke on the server; the local queue empty afterwards | PASS — 105/105 |
| S2.8 | Reload mid-quiz | "Continue as …" then the editor with the text and the same clock | PASS |
| S2.9 | A shared computer: "not me" | a fresh identity, the previous attempt untouched | PASS |
| S2.10 | Submit → done screen → download links | present and working | PASS |

**Three bugs were found only at this tier**, which is the argument for paying
its cost:

1. a fast student who pressed Begin before the identity round-trip completed
   got a 401;
2. a statically `Secure` cookie broke every plain-HTTP rehearsal from another
   machine;
3. **a tab closed about a second after typing reopened from a local backup that
   lagged the events already on the server** — every later step was then
   recorded against a document the server never had, and the replay threw for 3
   of 60 sessions. Fixed by writing the backup within 250 ms and synchronously
   on hide/unload, and by skipping an unappliable step instead of dying.

---

## Tier 3 — class replay

Run: `API=… ADMIN_TOKEN=… npx tsx src/runners/live.ts --recording bundle.json --timescale 2`

| # | Scenario | Expectation | Reference result |
|---|---|---|---|
| S3.1 | Export a real class as an anonymised bundle | bundle written, no names, no identifiers | 136 students, 164,075 events |
| S3.2 | Replay 6 recorded students at 4× | quiz recreated, all acknowledged, replay == client document | PASS 6/6 |
| S3.3 | Replay the whole class at 2× | same, at roughly double the recorded event rate | PASS — 146,142/146,142 events, 136/136 replays identical, 119/119 submits, ingest p99 99 ms |

See docs/RECORDING_FORMAT.md. No bundle ships with this repository.

---

## Known gaps

Honest list. Each of these is a thing the benchmark **cannot** currently tell
you, and each should be repeated by anyone quoting a result from it.

- **The humanizer is not caught.** A bot that models keyboard distance,
  bigrams, fatigue and error correction (`--model markov`) sits inside the human
  motor-rhythm range on every session. Timing alone does not separate it. The
  next lever is the structure of revision, which this harness measures but does
  not yet turn into a discriminator.
- **The human baseline is one corpus, one task.** 151 writers, one essay
  prompt, one recording setup. Treat the reported floor as a measurement of
  that population, not as a calibrated false-positive rate.
- **The browser tier's limits.** The hidden-tab scenario is a shim: Chrome's
  real background timer throttling cannot be induced through the automation
  protocol, so only the app's `visibilitychange`/beacon path is exercised.
  Request loss is injected in the automation layer, not on a network. Every
  context shares one machine, one NIC and one IP, so this is not a test of a
  real access point, and cold-load times above roughly 30 browsers describe the
  client machine rather than the system under test.
- **No real-room evidence.** 100 cold page loads on one access point,
  backgrounded tabs on real laptops, and real laptop clocks are only testable
  with people in a room. Nothing here substitutes for that.
- **The document model is narrower than production.** No paragraph joins,
  marks, lists, selection-replace typing or undo (docs/TRACE_FORMAT.md). A real
  recorder ingests a superset of what this exercises.
- **Snapshots beyond the first are not exercised as a recovery net.** The
  replay uses the latest snapshot at or before the first event; mid-session
  snapshots are written but not used as a fallback, so nothing here proves they
  would help.
- **The class replay is not a fresh sample.** It reproduces transport and
  replay perfectly and discovers nothing that depends on content nobody wrote.
