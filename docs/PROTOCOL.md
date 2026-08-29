# The measurement protocol

This document specifies what a system under test (SUT) has to implement to be
measured by `src/runners/live.ts` and `src/runners/browser.ts`. It is written
so that a tool with no connection to this project can implement the endpoints
and be scored the same way.

Nothing here is a recommendation about how to *build* a writing-process
recorder. It is the smallest contract under which the benchmark's claims —
"no event was lost", "the server can reproduce the student's document",
"a retry did not duplicate anything" — are checkable from outside.

---

## 0. Concepts

| Term | Meaning |
|---|---|
| **assignment / quiz** | A set of questions with a time limit, reachable by an opaque `entryToken`. |
| **session** | One student's attempt at one assignment. Has an id, a start time and a deadline. |
| **event** | One recorded change to the document: a timestamp, a source, a nodeSize delta, and the ProseMirror steps that made it. |
| **snapshot** | The full document at a moment in time; a replay anchor. |
| **replay** | Reconstructing a document server-side by applying a session's steps to its base snapshot. |
| **seal** | Making a session final — by the student submitting, or by a server-side sweeper after the deadline. |

Document changes are expressed as **ProseMirror steps** (`step.toJSON()`), the
same serialisation Tiptap and ProseMirror already produce. A step is a
*position*, so it only means something relative to a known base document; see
§2.

---

## 1. Transport

All endpoints are HTTP, JSON in and JSON out (`content-type:
application/json`), with the exception of the export endpoint. Identity is
carried by cookies set at `/enter`; the runners keep a per-student cookie jar
and send nothing else.

Paths below are relative to the base URL passed as `--api` or `API=`.

---

## 2. The base document

Both sides of a replay must start from byte-identical documents.

The SUT MUST seed a new session's editor with the template document produced by
`templateDoc(questions)` (`src/replay/quizTemplate.ts`): for each question, in
order,

1. a `blockquote` containing one `paragraph` whose content is
   `text("Question N. ")` with a **bold** mark, followed by `text(prompt)`;
2. an empty `paragraph` (the answer space);
3. a second empty `paragraph`.

and MUST record that document as the session's replay anchor at or before the
first event. The schema needs only `doc`, `paragraph`, `blockquote`, `text` and
a `bold` mark (`src/replay/schema.ts`); a richer schema is fine as long as the
template serialises identically.

A SUT with a different template can still be measured, but it must then supply
its own base document through the snapshot endpoint before the first event, and
the runner's op positions will no longer match its answer spaces. The supported
route is to accept this template.

---

## 3. Student endpoints

### `GET /api/quiz/{entryToken}`

Returns the quiz so the client can build its editor.

```json
{ "quiz": { "title": "…", "state": "open",
            "questions": [ { "prompt": "…" } ],
            "timeLimitMin": 15, "wordTarget": 300 } }
```

- MUST return the questions in the order the template will use.
- A quiz that is not open MAY omit `questions`; the runner then aborts with a
  clear error.

### `POST /api/quiz/{entryToken}/enter`

Body: `{}`. Mints an anonymous identity for this browser and sets its cookie.

- 200 on success.
- 429 when a rate limit is hit. **This is a real failure mode**: a class behind
  one NAT address shares one IP, so a per-IP identity cap will refuse most of a
  cohort. The benchmark deliberately exercises it (scenario `C2`).
- The identity MUST survive a page reload, so that a reopened tab can resume
  the same session.

### `POST /api/quiz/{entryToken}/start`

Body: `{ "name": "Alex Nguyen 12" }`.

```json
{ "session": { "id": "…", "deadlineAt": "2026-09-01T18:15:00.000Z" } }
```

- MUST create the session, MUST write the base snapshot (§2), and MUST return
  the id and the server-side deadline as an ISO timestamp.
- MUST mint an identity if `/enter` has not run yet (a student who presses
  Begin before `/enter`'s round-trip completes must not get a 401).
- The runner treats `deadlineAt` as authoritative and stops typing when the
  **server's** clock reaches it, regardless of the client's own clock (§7).

### `POST /api/sessions/{id}/events`

Body:

```json
{ "events": [
  { "ts": 1756483200123, "source": "input", "delta": 1,
    "steps": [ { "stepType": "replace", "from": 12, "to": 12,
                 "slice": { "content": [ { "type": "text", "text": "a" } ] } } ],
    "clientSeq": 918273645001 },
  { "ts": 1756483200310, "source": "paste", "delta": 41,
    "pastedTextLen": 41, "steps": [ … ], "clientSeq": 918273645002 }
] }
```

Fields:

| Field | Required | Meaning |
|---|---|---|
| `ts` | yes | Client wall-clock ms. May be wrong (§7). |
| `source` | yes | `input`, `paste`, `drop`, `history`, or a SUT-specific label. |
| `delta` | yes | Change in `doc.nodeSize`. Negative means text was removed. |
| `steps` | yes | Array of `step.toJSON()`. |
| `pastedTextLen` | on paste/drop | Length of the pasted plain text (`delta` is inflated by block tokens). |
| `clientSeq` | yes | Monotonic per session. See idempotency below. |

Response, 200:

```json
{ "ingested": 37, "duplicates": 3 }
```

- **Idempotency.** `clientSeq` is unique per session. A retried batch MUST be
  accepted and counted under `duplicates`, never stored twice. The benchmark's
  central accounting rule is `sent == ingested + duplicates`, summed over every
  batch of every student.
- **Batching.** The runner posts at most 500 events per request; a SUT MAY
  impose its own limit and MUST then reject oversized batches with 413.
- **Status codes.** 200 = accepted. 403 / 404 / 409 = terminal for this session
  (the runner stops and reports an error — 409 is the correct answer to a batch
  that arrives after the session was sealed). Anything else, including a
  network failure, is treated as retryable: the runner keeps the batch in its
  buffer and tries again on the next tick. A SUT that answers 500 to a
  duplicate will therefore hang the client, which is itself a finding.
- **Ordering.** Events MAY arrive out of order across batches (an outage drains
  late). The SUT MUST order by `clientSeq` for replay, not by arrival.

### `POST /api/sessions/{id}/snapshots`

Body: `{ "ts": 1756483230000, "content": { "type": "doc", "content": [ … ] } }`

- 200 on success. Snapshots are replay anchors; the runner posts one every 30 s
  or every 400 events, and one final snapshot at the end of a session.
- The SUT MUST pick, as a replay base, the latest snapshot at or before the
  first event being replayed.

### `GET /api/sessions/{id}/doc`

The **server's own replay** of the session.

```json
{ "plainText": "…", "content": { "type": "doc", "content": [ … ] } }
```

- `plainText` MUST be the document's text with paragraphs separated by `\n`.
- This is the single most important endpoint in the benchmark: the runners
  compare it, character for character, against the document the client holds.
- A step that cannot be applied MUST be skipped, not fatal. (Found the hard
  way: a tab reopened from a stale local backup replays steps against a
  document the server never had; dying on that loses the whole session.)

### `POST /api/sessions/{id}/submit`

Body: `{ "content": { … }, "plainText": "…" }` — the client's final document.

- 200 seals the session. After sealing, later event batches MUST be refused
  (409) and MUST NOT be stored.
- The SUT SHOULD flag a session whose client document disagrees with its own
  replay; the benchmark reads that flag from the instructor list (§5) when it
  is present.

### `GET /api/sessions/{id}/export?format=txt`

Returns the submitted text as `text/plain` (or JSON-encoded string). The runner
checks that the last 40 characters of the client's document appear in it.

### `POST /api/chat` *(optional)*

Body: `{ "sessionId": "…", "messages": [ { "role": "user", "content": "…" } ], "docContent": "…" }`

A streamed assistant response. Optional: run with `--askai 0` if the SUT has no
assistant. When enabled, the benchmark requires **every** request to be
answered — a runner that reports PASS while the assistant is dead is worse than
useless, so any failure fails the run.

---

## 4. Sealing unsubmitted sessions

Some students never press Submit. The SUT SHOULD seal them automatically:

- after `deadlineAt` plus an ingest grace period (the reference implementation
  uses 15 minutes),
- marking the session as auto-submitted,
- and computing whatever per-session metrics it computes for a normal submit.

`live.ts --wait-sweeper` waits for this and fails if any non-submitter is still
open. Without it, this part of the contract is untested.

---

## 5. Instructor endpoints *(optional, for the agreement checks)*

Set `ADMIN_TOKEN` to enable these.

### `GET /api/auth/admin-login?token=…` — sets the instructor cookie.

### `GET /api/instructor/sessions`

```json
{ "sessions": [ { "id": "…", "eventCount": 918, "lateEvents": 0,
                  "lateArrivals": 0, "submittedAt": "…",
                  "autoSubmitted": false, "categoryWords": { … } } ] }
```

The runner checks, for every student it drove:

| Field | Expectation |
|---|---|
| `eventCount` | equals the number of events that student sent |
| `lateEvents` | 0 — events stamped after the deadline (except by a clock-skewed student who was still allowed to type; see §7) |
| `lateArrivals` | 0 — events that *arrived* after the session was sealed |
| `categoryWords` | present for every submitted session (metrics were computed) |

### `POST /api/instructor/assignments`

Body: `{ title, mode, timeLimitMin, wordTarget, blind, published, questions }`
returning `{ "assignment": { "entryToken": "…" } }`. Only needed for
`--recording`, which recreates the recorded quiz so step positions stay valid.

### `GET /api/readiness`

Anything JSON; if it exposes `{ "metrics": { "queued": 0, "active": 0 } }` the
runner waits for the queue to drain before reading the instructor list.

---

## 6. Client recorder behaviour the runners emulate

`live.ts` is a *model of a browser recorder*. A SUT's own client should behave
at least this well, and the benchmark's numbers assume it:

- flush the event buffer every **2 s**, or immediately at **200** buffered
  events; at most **500** events per POST;
- snapshot every **30 s** or every **400** events, and once at the end;
- keep unsent events in a durable local buffer across an outage and drain them
  when the network returns, in order;
- never drop an event because a request failed;
- flush on `visibilitychange`/`pagehide` (a beacon), because a closed tab is
  the most common way to lose the tail of a session.

---

## 7. Clocks

Student clocks are wrong. `--skew N` gives each simulated student a fixed
offset drawn from ±N minutes, applied to every `ts` it sends.

The SUT MUST therefore:

- treat `ts` as *the client's claim*, and keep its own receipt time;
- enforce the deadline on the **server's** clock (the runner stops typing when
  the server's `deadlineAt` passes, whatever its own clock says);
- expect events stamped after the deadline from a student whose clock runs
  ahead — these are legitimate and the benchmark excludes exactly those
  sessions from the `lateEvents` check.

---

## 8. What a passing run means, and what it does not

A green `live.ts` run says: under this load, with these outages, retries,
skewed clocks and late arrivals, **no event was lost, nothing was double
counted, and the server can reproduce every student's document exactly**.

It does not say anything about the browser (use `browser.ts`), about a real
access point with 100 cold page loads on it, about real laptop clocks, or about
whether the SUT's own analysis of the recorded process is correct.
