/**
 * The wire types of the benchmark: the event a writing-process recorder is
 * expected to produce, and the ProseMirror step JSON it carries.
 *
 * These mirror the transport contract documented in docs/PROTOCOL.md. Nothing
 * here is specific to any one implementation: a system under test only has to
 * accept events of this shape and be able to replay them.
 */

/** A ProseMirror step, serialised with `step.toJSON()`. */
export type StepJSON = Record<string, unknown>

/**
 * Where the change came from. The metrics module treats `input` as typing,
 * `paste`/`drop` as imported text, and `history` as an undo/redo revision;
 * any other label is carried through and ignored by the metrics.
 */
export type EventSource = 'input' | 'paste' | 'drop' | 'history' | (string & {})

/** One recorded change to the document. */
export type SessionEvent = {
  /** Client wall-clock time in ms since the epoch (or ms since session start
   *  in a self-contained trace). Only differences are ever used. */
  ts: number
  source: EventSource
  /** Change in `doc.nodeSize` produced by the steps. Negative = text removed. */
  delta: number
  steps: StepJSON[]
  /** Length of the pasted plain text, when `source` is `paste` or `drop`. */
  pastedTextLen?: number
  /** Monotonic per-session counter used for idempotent retries. */
  clientSeq?: number
}
