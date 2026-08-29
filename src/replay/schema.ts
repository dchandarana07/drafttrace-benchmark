/**
 * The MINIMAL document schema the benchmark replays against.
 *
 * A real editor's schema has dozens of node and mark types; none of them are
 * needed to measure a writing-process recorder. The benchmark therefore builds
 * the smallest schema that can hold the quiz template (docs/PROTOCOL.md):
 *
 *   nodes: doc, paragraph, blockquote, text
 *   marks: bold
 *
 * It is derived from @tiptap/starter-kit with everything else switched off, so
 * the step JSON produced here is the ordinary Tiptap/ProseMirror step JSON any
 * Tiptap-based system already understands. Step POSITIONS depend only on the
 * document structure, not on which unused node types the schema declares, so a
 * system under test with a richer schema replays these steps identically.
 */
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type { Schema } from '@tiptap/pm/model'

export const minimalExtensions = [
  StarterKit.configure({
    // keep: document, paragraph, text, blockquote, bold
    heading: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    codeBlock: false,
    code: false,
    italic: false,
    strike: false,
    horizontalRule: false,
    hardBreak: false,
    // editor plugins, not schema — off so the module imports cleanly in Node
    dropcursor: false,
    gapcursor: false,
    history: false,
  }),
]

export const schema = getSchema(minimalExtensions) as Schema
