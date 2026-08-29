/**
 * KEYSTROKE MODELS — how a hand types a given string.
 *
 * Three open-source "type like a human" projects (all MIT) were studied and
 * re-implemented here in TypeScript as seeded, pure generators:
 *
 *   1. Lax3n/HumanTyping — https://github.com/Lax3n/HumanTyping — a
 *      semi-Markov keystroke model: keyboard-distance timing, common-bigram
 *      bursts, word-difficulty speed, neighbour-key and swap ("teh") errors,
 *      error NOTICING with reaction time and drift (errors can linger a few
 *      characters), backspace timing, fatigue. Ported below as `markovTyper`;
 *      the constants in `M` are the upstream project's `config.py` values.
 *   2. Shawn-Falconbury/human-typer —
 *      https://github.com/Shawn-Falconbury/human-typer — a "typist
 *      personality" layer: per-session base WPM, rhythm irregularity, burst
 *      cycles (groove), fatigue with refocus recoveries, thinking pauses
 *      (1.5-5 s), punctuation/paragraph pauses, word-position effects,
 *      delayed corrections with a hesitation before the backspace and faster
 *      retyping. Ported as `personalityTyper`.
 *   3. djeada/Type-Simulator — https://github.com/djeada/Type-Simulator —
 *      fixed profiles (speed +/- variance, micro-pauses); its `robotic`
 *      profile is the textbook naive bot. Ported as `PROFILE_PRESETS`, used
 *      for the bot baselines.
 *
 * Every model returns a KeystrokeTrace — a list of {t, kind, ch} at the KEY
 * level — with one hard invariant: replaying the trace reproduces the target
 * text exactly (`replayTrace`). The trace is the only interface to the rest
 * of the harness, so models are swappable and inspectable on their own, and
 * the same seed always yields the same trace.
 */
// ── seeded RNG ────────────────────────────────────────────────────────────
export type Rng = () => number
export function rng(seed: number): Rng {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const gauss = (r: Rng, mean = 0, sd = 1) => {
  const u = Math.max(1e-12, r())
  const v = r()
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
export const uniform = (r: Rng, lo: number, hi: number) => lo + r() * (hi - lo)
export const pick = <T>(r: Rng, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

// ── trace IR ──────────────────────────────────────────────────────────────
export type Key =
  | { t: number; kind: 'char'; ch: string; intended: boolean }
  | { t: number; kind: 'backspace' }
/** A key without its timestamp — what the generators hand to `push`. */
export type KeyBody = { kind: 'char'; ch: string; intended: boolean } | { kind: 'backspace' }
export type KeystrokeTrace = {
  keys: Key[]
  totalMs: number
  /** number of wrong characters typed (each later removed) */
  errors: number
  /** number of backspaces */
  backspaces: number
  /** pauses >= 2000 ms (the P-burst boundary), counted at generation time */
  cognitivePauses: number
  sessionWpm: number
}

/** Replay a trace to text — the correctness oracle for every model. */
export function replayTrace(keys: Key[]): string {
  let s = ''
  for (const k of keys) {
    if (k.kind === 'char') s += k.ch
    else s = s.slice(0, -1)
  }
  return s
}

// ── keyboard (QWERTY) — from HumanTyping keyboard.py ─────────────────────
const QWERTY = ['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./'].map((r) => r.split(''))
const POS = new Map<string, [number, number]>()
QWERTY.forEach((row, r) => row.forEach((ch, c) => POS.set(ch, [r, c])))
const norm = (ch: string) => ch.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
export function keyDistance(a: string, b: string, far = 4): number {
  const pa = POS.get(norm(a)), pb = POS.get(norm(b))
  if (!pa || !pb) return far
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1])
}
export function neighbours(ch: string): string[] {
  const p = POS.get(norm(ch))
  if (!p) return []
  const out: string[] = []
  for (const dr of [-1, 0, 1]) for (const dc of [-1, 0, 1]) {
    if (!dr && !dc) continue
    const row = QWERTY[p[0] + dr]
    const c = row?.[p[1] + dc]
    if (c) out.push(c)
  }
  return out
}
const hasKey = (ch: string) => POS.has(norm(ch))

// ── language helpers — HumanTyping language.py + human-typer bigram sets ──
const COMMON_WORDS = new Set('the be to of and a in that have it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because'.split(' '))
const COMMON_BIGRAMS = new Set('th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce'.split(' '))
const FAST_BIGRAMS = new Set('th he in er an on en at es ed or te ti is it al ar st to nt ng se ha ou io le no re hi ea ri ro co de ra li ch ic ei nd ll ma si om ur ca el ta la ns ge ly ne us ec di ve me sa ce'.split(' '))
const SLOW_BIGRAMS = new Set('br cr fr gr pr tr bl cl fl gl pl mn nm bf fb gk kg pq qp xz zx zy yz qz zq jy yj vw wv'.split(' '))
const SHIFT_CHARS = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()_+{}|:"<>?~'.split(''))
const PUNCT = '.,!?;:\'"-()[]{}/'
export function wordDifficulty(word: string): 'common' | 'normal' | 'complex' {
  const w = word.toLowerCase().replace(new RegExp(`^[${PUNCT.replace(/[\]\\\-]/g, '\\$&')}]+|[${PUNCT.replace(/[\]\\\-]/g, '\\$&')}]+$`, 'g'), '')
  if (COMMON_WORDS.has(w)) return 'common'
  if (w.length > 8 || /[zxqj]/.test(w)) return 'complex'
  return 'normal'
}
function wordAt(text: string, i: number): string {
  let s = i, e = i
  while (s > 0 && text[s - 1] !== ' ') s--
  while (e < text.length && text[e] !== ' ') e++
  return text.slice(s, e)
}

// ═══════════════════════════════════════════════════════════════════════════
// Model 1 — HumanTyping MarkovTyper (Lax3n), constants from config.py
// ═══════════════════════════════════════════════════════════════════════════
export type MarkovParams = {
  wpm: number
  /** per-session WPM jitter (config WPM_STD=10) */
  wpmStd?: number
  probError?: number // 0.04
  probSwap?: number // 0.015
  probNotice?: number // 0.85 (notice at distance 1)
  driftCorrection?: number // 0.8 (notice at distance >= 2)
}
const M = {
  AVG_WORD_LENGTH: 5,
  SPEED_BOOST_COMMON_WORD: 0.6, SPEED_PENALTY_COMPLEX_WORD: 1.3,
  SPEED_BOOST_CLOSE_KEYS: 0.5, SPEED_BOOST_BIGRAM: 0.4,
  CLOSE_KEY_THRESHOLD: 2.0, FAR_KEY_THRESHOLD: 4.0, FAR_KEY_PENALTY: 1.2,
  MIN_SPEED_MULTIPLIER: 0.15,
  TIME_KEYSTROKE_STD: 0.03, TIME_BACKSPACE_MEAN: 0.12, TIME_BACKSPACE_STD: 0.02,
  TIME_REACTION_MEAN: 0.35, TIME_REACTION_STD: 0.1,
  MIN_KEYSTROKE_TIME: 0.02, MIN_REACTION_TIME: 0.1, MIN_BACKSPACE_TIME: 0.03,
  TIME_UPPERCASE_PENALTY: 0.2, TIME_SPACE_PAUSE_MEAN: 0.25, TIME_SPACE_PAUSE_STD: 0.05,
  COMPLEX_WORD_ERROR_MULT: 1.5, COMMON_WORD_ERROR_MULT: 0.5,
  FATIGUE_FACTOR: 1.0005, FATIGUE_CAP: 1.5,
}

export function markovTyper(target: string, p: MarkovParams, r: Rng): KeystrokeTrace {
  const probError = p.probError ?? 0.04
  const probSwap = p.probSwap ?? 0.015
  const probNotice = p.probNotice ?? 0.85
  const drift = p.driftCorrection ?? 0.8
  const sessionWpm = Math.max(10, gauss(r, p.wpm, p.wpmStd ?? 10))
  const baseKs = 60 / (sessionWpm * M.AVG_WORD_LENGTH) // seconds

  const keys: Key[] = []
  let t = 0
  let cur = ''
  let mental = 0
  let fatigue = 1
  let last: string | null = null
  let lastWasBackspace = false
  let errors = 0, backspaces = 0, pauses = 0

  const ksTime = (ch: string) => {
    let ks = baseKs * fatigue
    const w = wordAt(target, Math.min(mental, target.length - 1))
    const d = wordDifficulty(w)
    if (d === 'common') ks *= M.SPEED_BOOST_COMMON_WORD
    else if (d === 'complex') ks *= M.SPEED_PENALTY_COMPLEX_WORD
    if (last) {
      if (COMMON_BIGRAMS.has((last + ch).toLowerCase())) ks *= M.SPEED_BOOST_BIGRAM
      else {
        const dist = keyDistance(last, ch, M.FAR_KEY_THRESHOLD)
        if (dist > 0 && dist < M.CLOSE_KEY_THRESHOLD) ks *= M.SPEED_BOOST_CLOSE_KEYS
        else if (dist > M.FAR_KEY_THRESHOLD) ks *= M.FAR_KEY_PENALTY
      }
    }
    if (ch === ' ') ks += gauss(r, M.TIME_SPACE_PAUSE_MEAN, M.TIME_SPACE_PAUSE_STD)
    else if (ch !== ch.toLowerCase()) ks += M.TIME_UPPERCASE_PENALTY
    ks = Math.max(M.MIN_SPEED_MULTIPLIER * baseKs, ks)
    return Math.max(M.MIN_KEYSTROKE_TIME, gauss(r, ks, M.TIME_KEYSTROKE_STD))
  }
  const push = (dt: number, k: KeyBody) => {
    if (dt >= 2) pauses++
    t += dt
    keys.push({ ...k, t: Math.round(t * 1000) })
  }

  let guard = target.length * 10
  while (cur !== target && guard-- > 0) {
    // divergence point
    let firstErr = target.length
    const minLen = Math.min(cur.length, target.length)
    for (let i = 0; i < minLen; i++) if (cur[i] !== target[i]) { firstErr = i; break }
    if (firstErr < cur.length) {
      let correct = false
      if (lastWasBackspace) correct = true
      else if (mental >= target.length) correct = true
      else if (cur.length > 0) {
        const lastCh = cur[cur.length - 1]
        const distance = cur.length - firstErr
        if (' \n\t.,;!?:()[]{}<>"\''.includes(lastCh)) correct = true
        else if (distance >= 2) correct = r() < drift
        else if (distance === 1) correct = r() < probNotice
      }
      if (correct) {
        let dt = 0
        if (!lastWasBackspace) dt += Math.max(M.MIN_REACTION_TIME, gauss(r, M.TIME_REACTION_MEAN, M.TIME_REACTION_STD))
        dt += Math.max(M.MIN_BACKSPACE_TIME, gauss(r, M.TIME_BACKSPACE_MEAN, M.TIME_BACKSPACE_STD))
        cur = cur.slice(0, -1)
        push(dt, { kind: 'backspace' })
        backspaces++
        mental = cur.length
        lastWasBackspace = true
        continue
      }
    }
    lastWasBackspace = false
    if (mental > cur.length) mental = cur.length
    if (mental >= target.length) break
    const intended = target[mental]
    fatigue = Math.min(M.FATIGUE_CAP, fatigue * M.FATIGUE_FACTOR)

    if (!hasKey(intended) && intended !== ' ') {
      // not on the keyboard (newline, unicode): typed literally, no error model
      const dt = Math.max(M.MIN_KEYSTROKE_TIME, gauss(r, baseKs * fatigue, M.TIME_KEYSTROKE_STD))
      cur += intended; last = intended; mental++
      push(dt, { kind: 'char', ch: intended, intended: true })
      continue
    }
    // swap error (anticipation): "the" → "hte"
    if (mental + 1 < target.length) {
      const after = target[mental + 1]
      if (after !== ' ' && after !== intended && r() < probSwap) {
        const dt1 = ksTime(after)
        cur += after
        push(dt1, { kind: 'char', ch: after, intended: false })
        const dt2 = ksTime(intended)
        cur += intended
        push(dt2, { kind: 'char', ch: intended, intended: false })
        last = intended; mental += 2; errors += 2
        continue
      }
    }
    let pe = probError
    const d = wordDifficulty(wordAt(target, mental))
    if (d === 'complex') pe *= M.COMPLEX_WORD_ERROR_MULT
    else if (d === 'common') pe *= M.COMMON_WORD_ERROR_MULT
    if (r() < pe) {
      const ns = neighbours(intended)
      let wrong = ns.length ? pick(r, ns) : pick(r, QWERTY.flat())
      if (intended !== intended.toLowerCase()) wrong = wrong.toUpperCase()
      const dt = ksTime(wrong)
      cur += wrong; last = wrong; mental++; errors++
      push(dt, { kind: 'char', ch: wrong, intended: false })
    } else {
      const dt = ksTime(intended)
      cur += intended; last = intended; mental++
      push(dt, { kind: 'char', ch: intended, intended: true })
    }
  }
  return { keys, totalMs: Math.round(t * 1000), errors, backspaces, cognitivePauses: pauses, sessionWpm }
}

// ═══════════════════════════════════════════════════════════════════════════
// Model 2 — human-typer TypingProfile (Shawn-Falconbury), "typist personality"
// ═══════════════════════════════════════════════════════════════════════════
export type Personality = {
  baseWpm: number
  typoRate: number
  rhythmIrregularity: number
  pauseTendency: number
  burstSpeedFactor: number
  fatigueRate: number
  recoveryChance: number
  thinkPauseChance: number
  instantCorrectPct: number
  delayedCorrectMax: number
  correctionPauseBase: number
}
/** A fresh random personality, exactly the ranges the original draws from. */
export function randomPersonality(r: Rng, over: Partial<Personality> = {}): Personality {
  return {
    baseWpm: uniform(r, 48, 82),
    typoRate: uniform(r, 0.015, 0.04),
    rhythmIrregularity: uniform(r, 0.15, 0.4),
    pauseTendency: uniform(r, 0.3, 0.8),
    burstSpeedFactor: uniform(r, 1.15, 1.45),
    fatigueRate: uniform(r, 0.0001, 0.0005),
    recoveryChance: uniform(r, 0.002, 0.008),
    thinkPauseChance: uniform(r, 0.001, 0.006),
    instantCorrectPct: uniform(r, 0.55, 0.85),
    delayedCorrectMax: 1 + Math.floor(r() * 4),
    correctionPauseBase: uniform(r, 0.08, 0.25),
    ...over,
  }
}
const ADJ: Record<string, string> = {
  q: 'wa', w: 'qeas', e: 'wrds', r: 'etdf', t: 'ryfg', y: 'tugh', u: 'yijh', i: 'uojk', o: 'iplk', p: 'ol',
  a: 'qwsz', s: 'awedxz', d: 'serfcx', f: 'drtgvc', g: 'ftyhbv', h: 'gyujnb', j: 'huiknm', k: 'jiolm', l: 'kop',
  z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
  '1': '2q', '2': '13qw', '3': '24we', '4': '35er', '5': '46rt', '6': '57ty', '7': '68yu', '8': '79ui', '9': '80io', '0': '9p',
}

export function personalityTyper(target: string, prof: Personality, r: Rng): KeystrokeTrace {
  const keys: Key[] = []
  let t = 0, charsTyped = 0, inBurst = false, burstLeft = 0
  let errors = 0, backspaces = 0, pauses = 0
  const push = (dtSec: number, k: KeyBody) => {
    if (dtSec >= 2) pauses++
    t += dtSec
    keys.push({ ...k, t: Math.round(t * 1000) })
  }
  const baseDelay = () => 60 / (prof.baseWpm * 5)
  const delay = (prev: string, cur: string, posInWord: number, wordLen: number) => {
    let fat = 1 + charsTyped * prof.fatigueRate
    if (r() < prof.recoveryChance) fat *= uniform(r, 0.85, 0.95)
    let burstMod = 1
    if (inBurst) { burstLeft--; if (burstLeft <= 0) inBurst = false; burstMod = 1 / prof.burstSpeedFactor }
    else if (r() < 0.015) { inBurst = true; burstLeft = 8 + Math.floor(r() * 23) }
    const bg = (prev + cur).toLowerCase()
    const bigramMod = FAST_BIGRAMS.has(bg) ? uniform(r, 0.7, 0.88) : SLOW_BIGRAMS.has(bg) ? uniform(r, 1.15, 1.45) : uniform(r, 0.92, 1.08)
    const posMod = posInWord === 0 ? uniform(r, 1.05, 1.3) : posInWord >= wordLen - 1 ? uniform(r, 0.98, 1.15) : uniform(r, 0.85, 1.02)
    let shiftMod = SHIFT_CHARS.has(cur) ? uniform(r, 1.08, 1.25) : 1
    if (cur === ' ') shiftMod = uniform(r, 0.8, 0.98)
    let d = baseDelay() * fat * burstMod * bigramMod * posMod * shiftMod
    d *= clamp(gauss(r, 1, prof.rhythmIrregularity * 0.3), 0.4, 2.2)
    if (r() < 0.03 * prof.pauseTendency) d += uniform(r, 0.05, 0.2)
    charsTyped++
    return Math.max(0.02, d)
  }
  const punctPause = (ch: string) =>
    ch === '.' ? uniform(r, 0.25, 0.9) : ch === ',' ? uniform(r, 0.08, 0.35) : ch === '!' ? uniform(r, 0.2, 0.7)
      : ch === '?' ? uniform(r, 0.25, 0.8) : ch === ':' ? uniform(r, 0.15, 0.45) : ch === ';' ? uniform(r, 0.12, 0.4) : 0
  const typoChar = (ch: string) => {
    const lo = ch.toLowerCase()
    const up = ch !== lo
    if (ADJ[lo] && r() < 0.7) { const c = pick(r, ADJ[lo].split('')); return up ? c.toUpperCase() : c }
    if (/[a-z]/.test(lo) && r() < 0.5) {
      const idx = lo.charCodeAt(0) - 97 + pick(r, [-1, 1, -2, 2])
      if (idx >= 0 && idx < 26) { const c = String.fromCharCode(97 + idx); return up ? c.toUpperCase() : c }
    }
    if (r() < 0.5) { const c = String.fromCharCode(97 + Math.floor(r() * 26)); return up ? c.toUpperCase() : c }
    return ch
  }

  let prev = ' '
  let i = 0
  // word geometry
  const wordLenAt = (k: number) => { let e = k; while (e < target.length && target[e] !== ' ' && target[e] !== '\n') e++; let s = k; while (s > 0 && target[s - 1] !== ' ' && target[s - 1] !== '\n') s--; return { pos: k - s, len: e - s } }
  while (i < target.length) {
    const ch = target[i]
    if (ch === '\n') { push(uniform(r, 0.4, 2.0), { kind: 'char', ch, intended: true }); prev = ch; i++; continue }
    if (r() < prof.thinkPauseChance) { t += uniform(r, 1.5, 5.0); pauses++ }
    const { pos, len } = wordLenAt(i)
    // typo?
    if (prof.typoRate > 0 && ch !== ' ' && r() < prof.typoRate) {
      const wrong = typoChar(ch)
      if (wrong !== ch) {
        push(delay(prev, wrong, pos, len), { kind: 'char', ch: wrong, intended: false })
        errors++
        const instant = r() < prof.instantCorrectPct
        const ahead = instant ? 0 : 1 + Math.floor(r() * prof.delayedCorrectMax)
        // type `ahead` more correct chars before noticing
        let typedAhead = 0
        for (let j = 1; j <= ahead && i + j < target.length && target[i + j] !== ' ' && target[i + j] !== '\n'; j++) {
          const g = wordLenAt(i + j)
          push(delay(target[i + j - 1], target[i + j], g.pos, g.len), { kind: 'char', ch: target[i + j], intended: false })
          typedAhead++
        }
        // hesitation, then backspace typedAhead + 1
        let first = true
        for (let b = 0; b < typedAhead + 1; b++) {
          const hes = first ? prof.correctionPauseBase + uniform(r, 0.05, 0.3) : 0
          first = false
          push(hes + uniform(r, 0.06, 0.14), { kind: 'backspace' })
          backspaces++
        }
        // retype (slightly faster — muscle memory)
        for (let j = 0; j <= typedAhead; j++) {
          const g = wordLenAt(i + j)
          push(delay(j === 0 ? prev : target[i + j - 1], target[i + j], g.pos, g.len) * uniform(r, 0.75, 0.9), { kind: 'char', ch: target[i + j], intended: true })
        }
        prev = target[i + typedAhead]
        i += typedAhead + 1
        continue
      }
    }
    push(delay(prev, ch, pos, len), { kind: 'char', ch, intended: true })
    const pp = punctPause(ch)
    if (pp > 0) t += pp
    prev = ch
    i++
  }
  return { keys, totalMs: Math.round(t * 1000), errors, backspaces, cognitivePauses: pauses, sessionWpm: prof.baseWpm }
}

// ═══════════════════════════════════════════════════════════════════════════
// Model 3 — Type-Simulator profiles (djeada): speed ± variance + micro-pauses
// ═══════════════════════════════════════════════════════════════════════════
export type Profile = { name: string; speed: number; variance: number; pauseProbability: number; pauseDuration: number }
export const PROFILE_PRESETS: Record<string, Profile> = {
  human: { name: 'human', speed: 0.08, variance: 0.04, pauseProbability: 0.1, pauseDuration: 0.3 },
  fast: { name: 'fast', speed: 0.03, variance: 0.01, pauseProbability: 0.05, pauseDuration: 0.1 },
  slow: { name: 'slow', speed: 0.2, variance: 0.08, pauseProbability: 0.15, pauseDuration: 0.5 },
  robotic: { name: 'robotic', speed: 0.05, variance: 0, pauseProbability: 0, pauseDuration: 0 },
  hunt_and_peck: { name: 'hunt_and_peck', speed: 0.4, variance: 0.2, pauseProbability: 0.3, pauseDuration: 0.8 },
  programmer: { name: 'programmer', speed: 0.05, variance: 0.03, pauseProbability: 0.2, pauseDuration: 0.4 },
  storyteller: { name: 'storyteller', speed: 0.1, variance: 0.05, pauseProbability: 0.25, pauseDuration: 0.6 },
  casual: { name: 'casual', speed: 0.12, variance: 0.08, pauseProbability: 0.15, pauseDuration: 0.35 },
  expert: { name: 'expert', speed: 0.02, variance: 0.005, pauseProbability: 0.03, pauseDuration: 0.05 },
  nervous: { name: 'nervous', speed: 0.06, variance: 0.04, pauseProbability: 0.3, pauseDuration: 0.25 },
}
export function profileTyper(target: string, prof: Profile, r: Rng): KeystrokeTrace {
  const keys: Key[] = []
  let t = 0, pauses = 0
  for (const ch of target) {
    let d = prof.speed + (prof.variance > 0 ? uniform(r, -prof.variance, prof.variance) : 0)
    d = Math.max(0.001, d)
    if (ch === ' ' && prof.pauseProbability > 0 && r() < prof.pauseProbability) d += prof.pauseDuration * uniform(r, 0.5, 1.5)
    if (d >= 2) pauses++
    t += d
    keys.push({ t: Math.round(t * 1000), kind: 'char', ch, intended: true })
  }
  return { keys, totalMs: Math.round(t * 1000), errors: 0, backspaces: 0, cognitivePauses: pauses, sessionWpm: 12 / prof.speed }
}

// ── model registry ────────────────────────────────────────────────────────
export type ModelName = 'markov' | 'personality' | 'robotic' | 'profile:human' | 'profile:expert' | 'profile:nervous' | 'profile:casual'
export function typeWith(model: ModelName, target: string, r: Rng, opts: { wpm?: number } = {}): KeystrokeTrace {
  switch (model) {
    case 'markov': return markovTyper(target, { wpm: opts.wpm ?? 60 }, r)
    case 'personality': return personalityTyper(target, randomPersonality(r, opts.wpm ? { baseWpm: opts.wpm } : {}), r)
    case 'robotic': return profileTyper(target, opts.wpm ? { ...PROFILE_PRESETS.robotic, speed: 12 / opts.wpm } : PROFILE_PRESETS.robotic, r)
    default: {
      const name = model.slice('profile:'.length)
      const prof = PROFILE_PRESETS[name]
      if (!prof) throw new Error(`unknown profile ${name}`)
      return profileTyper(target, opts.wpm ? { ...prof, speed: 12 / opts.wpm } : prof, r)
    }
  }
}
