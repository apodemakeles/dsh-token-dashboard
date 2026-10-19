// Real-data verification (ticket 06 acceptance): fold every materialized
// session log on this machine and cross-check against a naive last-wins
// per-(turn, step) computation on the same parsed lines. Read-only; uses the
// zstd CLI only because node:zlib stops at the first frame of these
// multi-frame logs (research 02, §6).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldUsage } from '../src/host/usage-fold'

const ZSTD = '/usr/local/bin/zstd'

function sessionFiles(): string[] {
  const root = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project)
    if (!statSync(projectDir).isDirectory()) continue
    for (const session of readdirSync(projectDir)) {
      const file = join(projectDir, session, 'session.jsonl.zstd')
      if (existsSync(file)) files.push(file)
    }
  }
  return files
}

const FILES = sessionFiles()
const runnable = existsSync(ZSTD) && FILES.length > 0

// This suite zstd-decodes every materialized log on the machine, so its cost
// grows with the corpus and is unrelated to the code under test.
const REAL_CORPUS_TIMEOUT_MS = 180_000

interface RawLine {
  type?: string
  seq?: number
  time?: number
  data?: {
    turn?: number
    step?: number
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }
    chunk?: { type?: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } }
  }
}

function parseEvents(text: string): RawLine[] {
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => {
    try { return JSON.parse(line) as RawLine } catch { return {} }
  })
}

/** The ground truth from research 02, §3: last sample per (turn, step) wins. */
function naiveLastWins(events: RawLine[]): Map<string, { inT: number; out: number; cache: number }> {
  const byStep = new Map<string, { inT: number; out: number; cache: number }>()
  for (const event of events) {
    const data = event.data
    if (data === undefined) continue
    const turn = data.turn
    const step = data.step
    if (turn === undefined || step === undefined) continue
    let usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined
    if (event.type === 'assistant/chunk' && data.chunk?.type === 'usage') usage = data.chunk.usage
    else if (event.type === 'assistant/message' && data.usage !== undefined) usage = data.usage
    else continue
    byStep.set(turn + ':' + step, {
      inT: usage.inputTokens ?? 0,
      out: usage.outputTokens ?? 0,
      cache: usage.cacheReadTokens ?? 0,
    })
  }
  return byStep
}

describe.skipIf(!runnable)('real session logs', () => {
  it('fold matches last-wins per (turn, step) on every materialized log', () => {
    expect(FILES.length).toBeGreaterThan(0)
    let checkedSteps = 0
    let checkedTotal = 0
    for (const file of FILES) {
      const text = execFileSync(ZSTD, ['-dc', file], { maxBuffer: 512 << 20 }).toString('utf8')
      const raw = parseEvents(text)
      const expected = naiveLastWins(raw)
      const samples = foldUsage(raw as unknown as SessionEvent[])
      const actual = new Map(samples.map((s) => [s.turn + ':' + s.step, { inT: s.usage.inputTokens ?? 0, out: s.usage.outputTokens ?? 0, cache: s.usage.cacheReadTokens ?? 0 }]))
      expect(actual.size).toBe(expected.size)
      for (const [key, value] of expected) {
        expect(actual.get(key)).toEqual(value)
      }
      checkedSteps += actual.size
      checkedTotal += [...actual.values()].reduce((sum, v) => sum + v.inT + v.out, 0)
    }
    // The machine really has history: the fold must have found usage samples.
    expect(checkedSteps).toBeGreaterThan(0)
    expect(checkedTotal).toBeGreaterThan(0)
  }, REAL_CORPUS_TIMEOUT_MS)

  it('fold samples carry non-negative token buckets (cache included by design)', () => {
    for (const file of FILES.slice(0, 5)) {
      const text = execFileSync(ZSTD, ['-dc', file], { maxBuffer: 512 << 20 }).toString('utf8')
      const samples = foldUsage(parseEvents(text) as unknown as SessionEvent[])
      for (const sample of samples) {
        const input = sample.usage.inputTokens ?? 0
        const output = sample.usage.outputTokens ?? 0
        const headline = input + output
        expect(headline).toBeGreaterThanOrEqual(0)
        expect(sample.usage.cacheReadTokens ?? 0).toBeGreaterThanOrEqual(0)
      }
    }
  })
})