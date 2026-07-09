# Transplant-guard evaluation (700 staged sessions)

Provenance metadata must survive legitimate editing (cut/paste of your own
text) without becoming a laundering channel (re-pasting external text to
relabel it as typed). This suite stages 700 sessions that exercise exactly
that boundary and checks the engine's post-transplant labels character by
character.

## Families

| Family | n | What is staged | Expected outcome |
|---|---|---|---|
| A-move-typed | 75 | Cut and re-paste a span the author typed, within the move window | Labels preserved (typed stays typed) |
| A-move-uncited | 75 | Same move, span originally pasted without a source | Preserved (uncited stays uncited — a move must not upgrade it) |
| A-move-cited | 75 | Same move, span originally pasted with a citation | Preserved (citation follows the text) |
| A-move-ai | 75 | Same move, span originally inserted by the in-app AI | Preserved (AI provenance follows the text) |
| B-duplicate-whitewash | 100 | Paste a copy while the original is still in the document | Duplicate is NOT inherited — labeled unattributed paste |
| C-stale-move | 100 | Re-paste a span after the move window has expired | Relabeled as unattributed paste |
| D-minlength | 100 | Move a span shorter than the own-text minimum | No inheritance (below evidence threshold) |
| E-ratio | 100 | Paste that only partially matches recently deleted text | No inheritance (fails the match-ratio guard) |

Result: **700 of 700** sessions produce the expected labels
(`results.json`: one `{family, pass}` row per session plus a per-family
summary).

## Reading `results.json`

```json
{
  "rows":    [{ "family": "A-move-typed", "pass": true }, ...],
  "summary": [{ "family": "A-move-typed", "pass": 75, "total": 75 }, ...]
}
```

Sessions are generated procedurally (seeded, deterministic) and replayed
through the same engine entry point as the main 242-session benchmark; the
guards under test are the own-text minimum length, the move time window,
the deleted-text match ratio, and the history-only duplicate rule described
in the paper.
