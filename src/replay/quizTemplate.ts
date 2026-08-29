/**
 * The quiz's in-document template — each question as a quoted block with the
 * answer space directly beneath it.
 *
 * Vendored from the reference implementation, because BOTH sides of a replay
 * must start from byte-identical documents: a ProseMirror step is a position,
 * and a position only means something relative to a known base document. A
 * system under test that wants to be measured by the classroom runners must
 * seed its editor with exactly this document for a given question list (see
 * docs/PROTOCOL.md).
 *
 * Requires only doc/blockquote/paragraph/text + the bold mark — the whole
 * reason the benchmark's schema can stay minimal.
 */
export type TemplateQuestion = { prompt: string }

export type TemplateJSON = {
  type: 'doc'
  content: Array<Record<string, unknown>>
}

export function templateDoc(questions: TemplateQuestion[]): TemplateJSON {
  const content: Array<Record<string, unknown>> = []
  questions.forEach((q, i) => {
    content.push({
      type: 'blockquote',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', marks: [{ type: 'bold' }], text: `Question ${i + 1}. ` },
            { type: 'text', text: q.prompt },
          ],
        },
      ],
    })
    // The answer space for this question.
    content.push({ type: 'paragraph' })
    content.push({ type: 'paragraph' })
  })
  return { type: 'doc', content }
}

/** Words the template itself contributes — subtracted from any student-facing
 *  word meter. Approximate by design (a student who edits the question text
 *  skews it), so consumers clamp at zero. */
export function templateWordCount(questions: TemplateQuestion[]): number {
  return questions.reduce(
    (n, q, i) => n + `Question ${i + 1}. ${q.prompt}`.split(/\s+/).filter(Boolean).length,
    0,
  )
}
