/**
 * MEASURED HUMAN BASELINE — the numbers the benchmark compares bots against.
 *
 * These are not thresholds to tune against; they are a measurement, reported
 * so that a claim like "this typing is too regular to be human" can be checked
 * against a distribution instead of an intuition. How they were obtained, and
 * how to reproduce them on your own corpus, is in docs/HUMAN_BASELINE.md.
 *
 * Provenance: 151 adult writers from the KUPA-KEYS keystroke corpus
 * (ALTA Institute, University of Cambridge), essay task, converted to this
 * benchmark's event format with tools/kupa and measured with src/metrics.
 * The corpus itself is NOT redistributed here.
 *
 * IMPORTANT CAVEAT: one corpus, one task, one recording setup. A motor-rhythm
 * CV below the human minimum reported here is evidence that timing is
 * unusually regular for THIS population — not proof of automation, and not a
 * calibrated false-positive rate for any other population.
 */

/** Coefficient of variation of sub-second inter-key intervals ("motor rhythm"). */
export const HUMAN_MOTOR_CV = {
  n: 151,
  min: 0.46,
  p5: 0.54,
  median: 0.72,
  max: 0.98,
  corpus: 'KUPA-KEYS (ALTA, Cambridge), essay task',
} as const

/**
 * Measured motor-rhythm CV of the three model ports, over the seeds the
 * benchmark ships (24 sessions per model, 250 words, revising 0.2-1.0).
 * Reproduce with: npx tsx tools/motor-cv.ts
 */
export const MODEL_MOTOR_CV: Record<string, { min: number; median: number; max: number }> = {
  markov: { min: 0.59, median: 0.64, max: 0.70 },
  personality: { min: 0.25, median: 0.28, max: 0.36 },
  'profile:human': { min: 0.15, median: 0.21, max: 0.29 },
  'profile:nervous': { min: 0.20, median: 0.29, max: 0.35 },
  'profile:casual': { min: 0.23, median: 0.33, max: 0.42 },
  'profile:expert': { min: 0.01, median: 0.02, max: 0.12 },
  robotic: { min: 0.00, median: 0.00, max: 0.14 },
}
