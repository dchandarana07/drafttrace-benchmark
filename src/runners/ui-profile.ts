/**
 * UI PROFILE for the real-browser runner.
 *
 * The API-level runner only needs the HTTP protocol (docs/PROTOCOL.md). The
 * browser runner additionally has to *drive a page*, so it needs to know how
 * to find things on it. Rather than hard-code one product's markup, every
 * selector lives here and can be overridden with `--ui my-profile.json`.
 *
 * The defaults describe the reference implementation's quiz page. To measure
 * your own system, copy `ui-profile.example.json`, change the selectors, and
 * pass it with `--ui`. Anything you leave out keeps the default.
 *
 * Selector conventions:
 *   - `*Css` fields are CSS selectors, passed to `page.locator`.
 *   - `*Button` / `*Text` fields are ACCESSIBLE NAMES, matched by role
 *     (`getByRole('button', { name })`) or by text. Values that look like
 *     `/.../` are treated as regular expressions.
 */
import { readFileSync } from 'node:fs'

export type UiProfile = {
  /** Path to the student's quiz page; `{token}` is replaced with the entry token. */
  quizPath: string
  /** Text input for the student's display name, on the pre-quiz screen. */
  nameInputCss: string
  /** Button that starts the attempt. */
  beginButton: string
  /** Button shown instead of `beginButton` when an attempt is already open in this browser. */
  continueButton: string
  /** The editable document. */
  editorCss: string
  /** The paragraph the caret should start in (the first answer space). */
  firstAnswerCss: string
  /** Opens the submit confirmation. */
  submitButton: string
  /** Confirms inside the dialog. */
  submitConfirmButton: string
  /** Text that proves the submission landed. */
  doneText: string
  /** Text that means "submit failed, press it again". */
  submitRetryText: string
  /** A link on the done screen that downloads the submission. */
  downloadLinkText: string
  /** Optional in-app assistant. Leave `assistantOpenButton` empty to disable. */
  assistantOpenButton: string
  assistantSidebarCss: string
  assistantPromptButton: string
  assistantCloseButton: string
  /** How to recover the session id from the page: a localStorage key prefix. */
  sessionIdLocalStoragePrefix: string
  /** Console messages matching this regex are expected and not counted as errors. */
  ignoreConsoleRegex: string
}

export const DEFAULT_UI: UiProfile = {
  quizPath: '/q/{token}',
  nameInputCss: '#quiz-name',
  beginButton: 'Begin',
  continueButton: '/Continue as/',
  editorCss: '.ProseMirror',
  firstAnswerCss: '.ProseMirror > p',
  submitButton: 'Submit',
  submitConfirmButton: 'Submit',
  doneText: 'Your answers are in',
  submitRetryText: '/Could not submit|Connection hiccup/',
  downloadLinkText: '/Download/',
  assistantOpenButton: 'Ask AI',
  assistantSidebarCss: '[aria-label="Writing assistant sidebar"]',
  assistantPromptButton: 'What is this question actually asking?',
  assistantCloseButton: 'Close sidebar',
  sessionIdLocalStoragePrefix: 'quiz-doc-',
  ignoreConsoleRegex: 'Cross-Origin-Opener-Policy',
}

/** `/foo/i` becomes a RegExp; anything else stays an exact accessible name. */
export function name(value: string): string | RegExp {
  const m = /^\/(.*)\/([a-z]*)$/.exec(value)
  return m ? new RegExp(m[1], m[2]) : value
}

export function loadUiProfile(path?: string): UiProfile {
  if (!path) return { ...DEFAULT_UI }
  const override = JSON.parse(readFileSync(path, 'utf8')) as Partial<UiProfile>
  return { ...DEFAULT_UI, ...override }
}
