# Recording bundles

A **recording bundle** is a captured class: every student's real event stream,
anonymised, replayable on demand. `live.ts --recording bundle.json` recreates
the quiz and plays every student's actual steps at their original timing, which
turns "did the release break anything?" into a question with a real answer.

**No bundle ships with this repository.** A bundle contains the participants'
writing inside its steps, so it is personal data. Publish one only after
review and with consent; otherwise keep it private.

## Shape

```json
{
  "exportedAt": "2026-08-29T12:38:00.000Z",
  "quiz": {
    "title": "…",
    "questions": [ { "prompt": "…" } ],
    "timeLimitMin": 15,
    "wordTarget": 300
  },
  "students": [
    {
      "id": "P001",
      "base": { "type": "doc", "content": [ … ] },
      "submitted": true,
      "durationMs": 903120,
      "events": [
        { "t": 0,    "source": "input", "delta": 1,  "steps": [ … ] },
        { "t": 214,  "source": "input", "delta": 1,  "steps": [ … ] },
        { "t": 8801, "source": "paste", "delta": 62, "steps": [ … ], "pastedTextLen": 61 }
      ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `quiz.questions` | Needed to recreate an identical template document — step positions depend on it. |
| `students[].id` | A participant code (`P001`…). Never a name, a handle, an email or the original session id. |
| `students[].base` | The document the recording started from: the snapshot at or before the student's first event. A replay MUST start here. |
| `students[].submitted` | Whether the student submitted (so the replay can reproduce the submit/non-submit mix). |
| `students[].durationMs` | Last event minus first, for reporting. |
| `events[].t` | **Relative** milliseconds since that student's first event. |
| `events[].source`, `delta`, `steps`, `pastedTextLen` | As in the live protocol (docs/PROTOCOL.md §3). |

## Producing one

Exporting is necessarily specific to the system that holds the data, so no
exporter ships here. A conforming exporter must:

1. take one assignment;
2. for each session with at least a handful of events, emit the events in
   `(ts, id)` order with timestamps made relative to the first event;
3. include the replay base: the latest snapshot at or before the first event;
4. replace every identifier with a sequential participant code, and carry over
   no names, no handles, no session ids, no IP addresses and no timestamps that
   would date the session;
5. record the quiz's questions verbatim, because the template document is part
   of the replay's meaning.

## Replaying one

```
API=http://host ADMIN_TOKEN=… npx tsx src/runners/live.ts \
  --recording bundle.json --timescale 2
```

The runner creates a fresh quiz from `quiz.questions` (needs `ADMIN_TOKEN`,
docs/PROTOCOL.md §5), posts each student's `base` as a snapshot older than
every event, then replays their steps verbatim at their original relative
timing — `--timescale 2` plays a 15-minute class in 7.5 minutes, at twice the
event rate.

Everything the synthetic runner checks is checked here too: every event
acknowledged, the server's replay identical to the client's document, submits,
instructor-list agreement.

## Caveats

- A recording is a *transport and replay* test, not a fresh sample: the same
  keystrokes produce the same document every time. It cannot discover a bug
  that depends on content nobody wrote.
- Replaying at `--timescale N` multiplies the event rate, so latency numbers
  from a compressed replay describe an N-times-larger class than the one
  recorded — state the timescale next to any number taken from one.
- The replay recreates the quiz, so the SUT will accumulate a new assignment
  per run.
