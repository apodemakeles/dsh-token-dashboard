// Gate: completeness pass — every startup verifies that all session logs are
// projected up to their current source revision, healing baselined-but-never-
// scanned sessions, stalled checkpoints and live tail growth.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { LifecycleIdentity, UsageDelta } from '../src/durable/contracts'
import { InitRecoveryCoordinator, SqliteCoordinatorStore, type PersistenceLike } from '../src/durable/init-recovery'
import { SqliteUsageStore } from '../src/durable/sqlite-store'

let dir: string
let store: SqliteUsageStore

function identity(sessionId = 's1', createdAt = 1000, cwd = '/tmp/project'): LifecycleIdentity {
  return { sessionId, createdAtMs: createdAt, cwd }
}

function usageMessage(seq: number, turn = 1, step = 1, input = 10, output = 5): SessionEvent {
  return { type: 'assistant/message', seq, time: Date.now(), data: { turn, step, message: {}, usage: { inputTokens: input, outputTokens: output } } } as unknown as SessionEvent
}

function usageDelta(seq: number, turn: number, step: number): UsageDelta {
  return { kind: 'usage', seq, time: Date.now(), turn, step, usage: { inputTokens: 10, outputTokens: 5 }, final: true }
}

interface FakeSession {
  revision: string
  events: SessionEvent[]
  failRead?: boolean
}

function fakePersistence(sessions: Map<string, FakeSession>) {
  let readFromCount = 0
  const persistence: PersistenceLike = {
    async listSnapshots() {
      return [...sessions.entries()].map(([id, value]) => ({
        header: { id, createdAt: 1000, cwd: '/tmp/project' },
        revision: value.revision,
      }))
    },
    async readFrom(id: string, fromSeq: number) {
      const session = sessions.get(id)
      if (session?.failRead) throw new Error('boom')
      readFromCount += 1
      return {
        meta: { id, createdAt: 1000, cwd: '/tmp/project' },
        events: (session?.events ?? []).filter((event) => event.seq >= fromSeq),
      }
    },
  }
  return { persistence, readFromCalls: () => readFromCount }
}

function makeCoordinator(sessions: Map<string, FakeSession>, options: { rescanIntervalMs?: number } = {}) {
  const { persistence, readFromCalls } = fakePersistence(sessions)
  const coordinator = new InitRecoveryCoordinator({
    store: new SqliteCoordinatorStore(store),
    persistence,
    generation: 'g',
    rescanIntervalMs: options.rescanIntervalMs ?? 0,
  })
  return { coordinator, readFromCalls }
}

function markCleanRun(baselines: ReadonlyArray<{ lifecyclePk: number; sourceRevision: string }>): void {
  const epoch = store.beginRunEpoch()
  store.activateRunEpoch(epoch, baselines)
  store.markRunClean(epoch)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-token-dashboard-init-'))
  store = new SqliteUsageStore(join(dir, 'usage-v1.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('InitRecoveryCoordinator', () => {
  it('initializes new sessions from readFrom(0) and reaches ready', async () => {
    const sessions = new Map<string, FakeSession>([
      ['s1', { revision: 'r1', events: [usageMessage(0), usageMessage(1)] }],
      ['s2', { revision: 'r1', events: [usageMessage(0)] }],
    ])
    const { coordinator } = makeCoordinator(sessions)
    await coordinator.start()
    const progress = store.getProjectionProgress()
    expect(progress.phase).toBe('ready')
    expect(progress.completedSessions).toBe(2)
    const snap = store.snapshot({ weeks: 1, offsetWeeks: 0 }, 0)
    expect(snap.summary.all).toBe(30)
    expect(snap.summary.sessionCount).toBe(2)
    const s1Pk = store.getLifecycle(identity('s1'))!
    expect(store.getCheckpoint(s1Pk).bootstrapComplete).toBe(true)
  })

  it('scans a baselined session that was never bootstrapped even after a clean run', async () => {
    // The previous run discovered s1 (baseline r1) but never scanned it, then
    // drained cleanly. The old recovery skipped this session forever because
    // the revision matched the baseline and the previous state was clean.
    const pk = store.upsertLifecycle(identity('s1'))
    markCleanRun([{ lifecyclePk: pk, sourceRevision: 'r1' }])
    store.setProjectionReady()

    const sessions = new Map<string, FakeSession>([
      ['s1', { revision: 'r1', events: [usageMessage(0)] }],
    ])
    const { coordinator } = makeCoordinator(sessions)
    await coordinator.start()

    expect(store.snapshot({ weeks: 1, offsetWeeks: 0 }, 0).summary.all).toBe(15)
    expect(store.getProjectionProgress().phase).toBe('ready')
    const checkpoint = store.getCheckpoint(pk)
    expect(checkpoint.lastSeq).toBe(0)
    expect(checkpoint.bootstrapComplete).toBe(true)
    expect(checkpoint.sourceRevision).toBe('r1')
  })

  it('rescans a session whose file revision advanced past its caught-up revision', async () => {
    // The previous run caught up to r0 at seq 0 and drained cleanly; the log
    // then grew to r1 with a new step (e.g. a batch dropped by the live
    // collector). The completeness pass must resume from the checkpoint.
    const pk = store.upsertLifecycle(identity('s1'))
    store.projectBatch({
      batchId: 'old',
      hostGeneration: 'g',
      lifecycle: identity('s1'),
      fromSeq: 0,
      toSeq: 0,
      deltas: [usageDelta(0, 1, 1)],
      sourceRevision: 'r0',
      bootstrapComplete: true,
    })
    markCleanRun([{ lifecyclePk: pk, sourceRevision: 'r0' }])
    store.setProjectionReady()

    const sessions = new Map<string, FakeSession>([
      ['s1', { revision: 'r1', events: [usageMessage(0, 1, 1), usageMessage(1, 1, 2)] }],
    ])
    const { coordinator, readFromCalls } = makeCoordinator(sessions)
    await coordinator.start()

    expect(store.snapshot({ weeks: 1, offsetWeeks: 0 }, 0).summary.all).toBe(30)
    expect(store.getProjectionProgress().phase).toBe('ready')
    const checkpoint = store.getCheckpoint(pk)
    expect(checkpoint.lastSeq).toBe(1)
    expect(checkpoint.sourceRevision).toBe('r1')
    expect(readFromCalls()).toBe(1)
  })

  it('resumes a stalled scan from its committed checkpoint when the source grew', async () => {
    // The previous run died mid-scan: it committed only seq 0, left the
    // bootstrap incomplete, and its epoch never went clean.
    const pk = store.upsertLifecycle(identity('s1'))
    store.projectBatch({
      batchId: 'old',
      hostGeneration: 'g',
      lifecycle: identity('s1'),
      fromSeq: 0,
      toSeq: 0,
      deltas: [usageDelta(0, 1, 1)],
    })
    const epoch = store.beginRunEpoch()
    store.activateRunEpoch(epoch, [{ lifecyclePk: pk, sourceRevision: 'r0' }])

    const sessions = new Map<string, FakeSession>([
      ['s1', { revision: 'r1', events: [usageMessage(0, 1, 1), usageMessage(1, 1, 2), usageMessage(2, 1, 3)] }],
    ])
    const { coordinator } = makeCoordinator(sessions)
    await coordinator.start()

    expect(store.snapshot({ weeks: 1, offsetWeeks: 0 }, 0).summary.all).toBe(45)
    expect(store.getProjectionProgress().phase).toBe('ready')
    const checkpoint = store.getCheckpoint(pk)
    expect(checkpoint.lastSeq).toBe(2)
    expect(checkpoint.bootstrapComplete).toBe(true)
    expect(checkpoint.sourceRevision).toBe('r1')
  })

  it('verifies caught-up sessions without reading their logs', async () => {
    const pk = store.upsertLifecycle(identity('s1'))
    store.projectBatch({
      batchId: 'old',
      hostGeneration: 'g',
      lifecycle: identity('s1'),
      fromSeq: 0,
      toSeq: 1,
      deltas: [usageDelta(0, 1, 1), usageDelta(1, 1, 2)],
      sourceRevision: 'r1',
      bootstrapComplete: true,
    })
    store.setProjectionReady()

    const sessions = new Map<string, FakeSession>([
      ['s1', { revision: 'r1', events: [usageMessage(0, 1, 1), usageMessage(1, 1, 2)] }],
    ])
    const { coordinator, readFromCalls } = makeCoordinator(sessions)
    await coordinator.start()

    expect(readFromCalls()).toBe(0)
    expect(store.getProjectionProgress().phase).toBe('ready')
    expect(store.snapshot({ weeks: 1, offsetWeeks: 0 }, 0).summary.all).toBe(30)
  })

  it('degrades when a session read fails and retries it on the next start', async () => {
    const sessions = new Map<string, FakeSession>([
      ['s1', { revision: 'r1', events: [usageMessage(0)], failRead: true }],
      ['s2', { revision: 'r1', events: [usageMessage(0)] }],
    ])
    const { coordinator } = makeCoordinator(sessions)
    await coordinator.start()

    expect(store.getProjectionProgress().phase).toBe('degraded')
    expect(store.getProjectionProgress().failedSessions).toBe(1)
    expect(store.snapshot({ weeks: 1, offsetWeeks: 0 }, 0).summary.all).toBe(15) // s2 only

    sessions.get('s1')!.failRead = false
    const retry = makeCoordinator(sessions)
    await retry.coordinator.start()

    expect(store.getProjectionProgress().phase).toBe('ready')
    expect(store.getProjectionProgress().failedSessions).toBe(0)
    expect(store.snapshot({ weeks: 1, offsetWeeks: 0 }, 0).summary.all).toBe(30)
  })

  it('heals a dropped live tail without a restart via the periodic rescan', async () => {
    const pk = store.upsertLifecycle(identity('s1'))
    const sessions = new Map<string, FakeSession>([
      ['s1', { revision: 'r1', events: [usageMessage(0, 1, 1)] }],
    ])
    const { coordinator } = makeCoordinator(sessions, { rescanIntervalMs: 25 })
    await coordinator.start()
    expect(store.snapshot({ weeks: 1, offsetWeeks: 0 }, 0).summary.all).toBe(15)

    // A live batch was dropped (e.g. a flush failure after session dispose):
    // the log grew to r2 with a new step but the store still points at r1.
    sessions.set('s1', { revision: 'r2', events: [usageMessage(0, 1, 1), usageMessage(1, 1, 2)] })
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(store.snapshot({ weeks: 1, offsetWeeks: 0 }, 0).summary.all).toBe(30)
    const checkpoint = store.getCheckpoint(pk)
    expect(checkpoint.lastSeq).toBe(1)
    expect(checkpoint.sourceRevision).toBe('r2')
    coordinator.abort()
  })

  it('marks an empty-tail session caught up and heals it once the log grows', async () => {
    const pk = store.upsertLifecycle(identity('s1'))
    const sessions = new Map<string, FakeSession>([
      ['s1', { revision: 'r1', events: [] }],
    ])
    const first = makeCoordinator(sessions)
    await first.coordinator.start()

    expect(store.getProjectionProgress().phase).toBe('ready')
    expect(store.snapshot({ weeks: 1, offsetWeeks: 0 }, 0).summary.all).toBe(0)
    let checkpoint = store.getCheckpoint(pk)
    expect(checkpoint.lastSeq).toBe(-1)
    expect(checkpoint.bootstrapComplete).toBe(true)
    expect(checkpoint.sourceRevision).toBe('r1')

    // The session starts producing events; the next pass must pick them up.
    sessions.set('s1', { revision: 'r2', events: [usageMessage(0, 1, 1)] })
    const second = makeCoordinator(sessions)
    await second.coordinator.start()

    expect(store.snapshot({ weeks: 1, offsetWeeks: 0 }, 0).summary.all).toBe(15)
    checkpoint = store.getCheckpoint(pk)
    expect(checkpoint.lastSeq).toBe(0)
    expect(checkpoint.sourceRevision).toBe('r2')
  })
})
