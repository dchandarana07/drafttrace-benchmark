# Generation and Adjudication Prompts (verbatim)

These are the exact orchestration scripts used to (1) generate the 30
LLM-authored, origin-tagged submission recipes and (2) run the blind
per-character adjudication behind the Cohen kappa result. They are excerpted
verbatim from the study harness; each `agent(...)` call spawned one
independent model instance with the shown prompt and JSON schema.

## 1. Student-agent recipe generation (`llm-students`)

```js
export const meta = {
  name: 'llm-students',
  description: 'Spawn diverse LLM student agents to write natural assignments as origin-tagged recipes for the DraftTrace benchmark',
  phases: [{ title: 'Write', detail: 'one student agent per (persona x category)' }],
}

const RECIPE_SCHEMA = {
  type: 'object',
  required: ['category', 'paragraphs'],
  additionalProperties: true,
  properties: {
    category: { type: 'string' },
    esl: { type: 'boolean' },
    persona: { type: 'object', additionalProperties: true, properties: { wpm: { type: 'number' }, esl: { type: 'boolean' } } },
    chatTurns: { type: 'number' },
    disclosure: { type: 'object', additionalProperties: true },
    note: { type: 'string' },
    paragraphs: {
      type: 'array',
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['origin', 'text'],
          additionalProperties: false,
          properties: {
            origin: { type: 'string', enum: ['typed', 'ai', 'cited', 'uncited'] },
            text: { type: 'string' },
          },
        },
      },
    },
  },
}

const ASSIGNMENTS = [
  'Argue whether constant smartphone connectivity helps or harms deep, sustained focus. Use a concrete personal example.',
  'Should your city adopt a carbon price? Take a position and defend it.',
  'How did the printing press actually change society, and how fast?',
  'Explain why the gut microbiome is hard to study and what that means for health claims.',
  'Is multitasking a skill worth cultivating, or a myth? Argue one side.',
  'What is the most defensible argument for protecting uninterrupted study time on campus?',
]

const PERSONAS = [
  'a first-year undergraduate, casual voice, some run-on sentences',
  'a careful junior who plans before writing, tight paragraphs',
  'a graduate student, precise and source-aware',
  'a sophomore who writes quickly and informally',
  'a senior who is a confident, fluent writer',
]

const CATS = [
  { key: 'fully_human', rule: 'EVERYTHING you write is origin "typed". Do NOT include any ai/cited/uncited segments. Write entirely in your own words.' },
  { key: 'sanctioned_ai', rule: 'Mostly "typed" in your own words, PLUS 1-2 "ai" segments that read like a writing-assistant suggestion you accepted (a sentence of coaching/phrasing), and optionally one "cited" segment that is a quoted source you attribute. Set chatTurns to the number of ai segments and disclosure {usedAI:true}.' },
  { key: 'borderline', rule: 'Mostly "typed" in your own words, PLUS exactly ONE short "uncited" segment (about 10-15% of total characters) that is clearly external source-like prose pasted WITHOUT attribution.' },
  { key: 'likely_copied', rule: 'About 30-40% of total characters should be "uncited" external source-like passages (formal, reference-style prose) pasted without attribution, mixed with your own "typed" sentences.' },
  { key: 'copied', rule: 'The MAJORITY (about 70%) of characters are "uncited" external source-like passages pasted without attribution, with only a thin "typed" frame of your own. ' },
  { key: 'esl_human', rule: 'EVERYTHING is origin "typed". Write as a non-native English speaker: simpler clauses, occasional slightly awkward phrasing, but a real argument. Set esl:true and persona.esl:true. No paste, no ai.' },
]

const PER = 5
const tasks = []
for (let ci = 0; ci < CATS.length; ci++) for (let i = 0; i < PER; i++) tasks.push({ c: CATS[ci], ci, i })

const recipes = await parallel(tasks.map(({ c, ci, i }) => () => {
  const assignment = ASSIGNMENTS[(ci + i) % ASSIGNMENTS.length]
  const persona = PERSONAS[i % PERSONAS.length]
  const prompt =
    'You are ' + persona + ', writing a short essay (4-7 sentences across 2-3 paragraphs, ~150-260 words) for this assignment:\n\n"' + assignment + '"\n\n' +
    'INTEGRITY PROFILE for this submission: ' + c.rule + '\n\n' +
    'Output a JSON "recipe" describing exactly how this draft is composed. It has "paragraphs": an array of paragraphs; each paragraph is an array of segments; each segment is {origin, text} where origin is one of typed/ai/cited/uncited as instructed above. Concatenating all segment texts in order is the finished essay (include trailing spaces so words do not run together). Make the prose NATURAL, specific, and varied — like a real student, not a template. "cited"/"uncited" text should read like formal external source material; "ai" text should read like assistant phrasing. Set category to "' + c.key + '". Return ONLY the recipe object.'
  return agent(prompt, { schema: RECIPE_SCHEMA, label: c.key + '-' + i, phase: 'Write' })
    .then((rec) => (rec ? { ...rec, category: c.key, id: 'llm-' + c.key + '-' + i, source: 'llm' } : null))
}))

return recipes.filter(Boolean)

```

## 2. Blind adjudication (`kappa-adjudication`)

The blind input files (`benchmark/kappa/blind/`) contain only the final text
and the recorded external events in randomized order; all engine labels are
withheld.

```js
export const meta = {
  name: 'kappa-adjudication',
  description: 'Independent per-character origin adjudication of 30 LLM-authored benchmark essays (blind to engine output) for Cohen kappa',
  phases: [{ title: 'Adjudicate', detail: 'one blind labeling agent per essay' }],
}
const DIR = '/Users/divyansh/Research/Projectsss/asu-plagerism-detector/benchmark/kappa/blind'
const IDS = [
  'llm-borderline-0','llm-borderline-1','llm-borderline-2','llm-borderline-3','llm-borderline-4',
  'llm-copied-0','llm-copied-1','llm-copied-2','llm-copied-3','llm-copied-4',
  'llm-esl_human-0','llm-esl_human-1','llm-esl_human-2','llm-esl_human-3','llm-esl_human-4',
  'llm-fully_human-0','llm-fully_human-1','llm-fully_human-2','llm-fully_human-3','llm-fully_human-4',
  'llm-likely-0','llm-likely-1','llm-likely-2','llm-likely-3','llm-likely-4',
  'llm-sanctioned_ai-0','llm-sanctioned_ai-1','llm-sanctioned_ai-2','llm-sanctioned_ai-3','llm-sanctioned_ai-4',
]
const SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    spans: { type: 'array', items: { type: 'object', properties: {
      start: { type: 'integer' }, end: { type: 'integer' },
      origin: { type: 'string', enum: ['ai', 'cited', 'uncited'] },
      matchedEvidenceIndex: { type: 'integer' },
      note: { type: 'string' },
    }, required: ['start', 'end', 'origin'] } },
    unmatchedEvidence: { type: 'array', items: { type: 'integer' } },
  },
  required: ['id', 'spans'],
}
phase('Adjudicate')
const out = await parallel(IDS.map((id) => () =>
  agent(`You are an independent adjudicator attributing per-character origin in a student essay, using only the recorded external-event evidence. Read the file ${DIR}/${id}.json — it has:
- "text": the final essay (label every character; character indices are 0-based offsets into this exact string)
- "evidence": recorded external events in RANDOM order — each is either a paste (with "cited": true/false) or an ai_insert. Their text may have been lightly trimmed or edited after insertion, so allow near-exact matches (missing tail, small edits).

TASK: find where each evidence item's text appears in the essay and output spans [start,end) (0-based, end exclusive) labeled: ai_insert → "ai"; paste cited:true → "cited"; paste cited:false → "uncited". Everything you do NOT cover is implicitly "typed" — do not output typed spans. Rules: spans must not overlap; if an evidence text appears in the essay only partially (trimmed tail), label only the part actually present; if you cannot find an evidence item at all, list its index in unmatchedEvidence; if the same passage could match two evidence items, pick the better match and note it. Verify offsets by quoting: for each span, check text.slice(start,end) begins and ends with the evidence words you matched (compute carefully — off-by-one errors destroy the study). Use whatever scripting you need (node/python) to compute exact offsets rather than counting by eye; the file is machine-readable JSON. Return ONLY the structured result.`,
    { label: `adj:${id}`, phase: 'Adjudicate', schema: SCHEMA, effort: 'low' })
))
return { adjudications: out.filter(Boolean) }

```
