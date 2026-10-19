// Commit 6 gate: initialization, run epoch and exception recovery coordinator.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { LifecycleIdentity } from '../src/durable/contracts'
import { UsageCollector } from '../src/durable/collector'
import { InitRecoveryCoordinator, SqliteCoordinatorStore, type PersistenceLike } from '../src/durable/init-recovery'
import { SqliteUsageStore } from '../src/durable/sqlite-store'
import type { UsageWorkerClient } from '../src/durable/worker-client'

let dir: string
let store: SqliteUsageStore

function identity(sessionId = 's1', createdAt = 1000, cwd = '/tmp/project'): LifecycleIdentity {
  return { sessionId, createdAtMs: createdAt, cwd }
}

function usageMessage(seq: number, turn = 1, step = 1, input = 10, output = 5): SessionEvent {
  return { type: 'assistant/message', seq, time: Date.now(), data: { turn, step, message: {}, usage: { inputTokens: input, outputTokens: output } } } as unknown as SessionEvent
}

function fakePersistence(sessions: Map<string, { revision: string; events: SessionEvent[] }>): PersistenceLike {
  return {
    async listSnapshots() {
      return [...sessions.entries()].map(([id, value]) => ({
        header: { id, createdAt: 1000, cwd: '/tmp/project' },
        revision: value.revision,
      }))
    },
    async readFrom(id: string, fromSeq: number) {
      return {
        meta: { id, createdAt: 1000, cwd: '/tmp/project' },
        events: (sessions.get(id)?.events ?? []).filter((event) => event.seq >= fromSeq),
      }
    },
  }
}

function dummyCollector(): UsageCollector {
  const flush = { async flush() { return true } }
  const worker = { async project() { return { committed: true } } }
  return new UsageCollector({ generation: 'g', flush, worker, flushCooldownMs: 0, flushRetryDelaysMs: [0] })
}

function dummyWorkerClient(): UsageWorkerClient {
  return { project: async () => ({ committed: true }) } as unknown as UsageWorkerClient
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
    const sessions = new Map<string, { revision: string; events: SessionEvent[] }>([
      ['s1', { revision: 'r1', events: [usageMessage(0), usageMessage(1)] }],
      ['s2', { revision: 'r1', events: [usageMessage(0)] }],
    ])
    const coordinator = new InitRecoveryCoordinator({
      store: new SqliteCoordinatorStore(store),
      persistence: fakePersistence(sessions),
      collector: dummyCollector(),
      worker: dummyWorkerClient(),
      generation: 'g',
      yieldEvery: 1,
    })
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

  it('recovers only revision-changed sessions after an active run', async () => {
    const sessions = new Map<string, { revision: string; events: SessionEvent[] }>([
      ['s1', { revision: 'r1', events: [usageMessage(0)] }],
    ])
    const persistence = fakePersistence(sessions)
    // Simulate a previous active epoch with an older baseline.
    const pk = store.upsertLifecycle(identity('s1'))
    store.projectBatch({
      batchId: 'old',
      hostGeneration: 'g',
      lifecycle: identity('s1'),
      fromSeq: 0,
      toSeq: 0,
      deltas: [{ kind: 'usage', seq: 0, time: Date.now(), turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 }, final: true }],
    })
    const oldEpoch = store.beginRunEpoch()
    store.activateRunEpoch(oldEpoch, [{ lifecyclePk: pk, sourceRevision: 'r0' }])
    // New revision r1 should be recovered from checkpoint+1 with a new step.
    sessions.set('s1', { revision: 'r1', events: [usageMessage(0, 1, 1), usageMessage(1, 1, 2)] })

    const coordinator = new InitRecoveryCoordinator({
      store: new SqliteCoordinatorStore(store),
      persistence,
      collector: dummyCollector(),
      worker: dummyWorkerClient(),
      generation: 'g',
      yieldEvery: 1,
    })
    await coordinator.start()
    const snap = store.snapshot({ weeks: 1, offsetWeeks: 0 }, 0)
    expect(snap.summary.all).toBe(30) // old fact 15 + recovered tail 15
    expect(store.getProjectionProgress().phase).toBe('ready')
  })

  it('degrades when a session read fails instead of pretending ready', async () => {
    const sessions = new Map<string, { revision: string; events: SessionEvent[] }>([
      ['s1', { revision: 'r1', events: [usageMessage(0)] }],
    ])
    const persistence: PersistenceLike = {
      async listSnapshots() {
        return [{ header: { id: 's1', createdAt: 1000, cwd: '/tmp/project' }, revision: 'r1' }]
      },
      async readFrom() {
        throw new Error('boom')
      },
    }
    const coordinator = new InitRecoveryCoordinator({
      store: new SqliteCoordinatorStore(store),
      persistence,
      collector: dummyCollector(),
      worker: dummyWorkerClient(),
      generation: 'g',
      yieldEvery: 1,
    })
    await coordinator.start()
    expect(store.getProjectionProgress().phase).toBe('degraded')
    expect(store.getProjectionProgress().failedSessions).toBe(1)
  })

  it('initializes through a handle-backed persistence service', async () => {
    const sessions = new Map<string, SessionEvent[]>([
      ['s1', [usageMessage(0), usageMessage(1)]],
      ['s2', [usageMessage(0)]],
    ])
    const closes: string[] = []
    const persistence: PersistenceLike = {
      async list() {
        return [...sessions.keys()].map((id) => ({
          header: { id, createdAt: 1000, cwd: '/tmp/project' },
          revision: 'r1',
        }))
      },
      async open(id: string) {
        return {
          header: { id, createdAt: 1000, cwd: '/tmp/project' },
          async read(offset = 0) {
            return { events: (sessions.get(id) ?? []).filter((event) => event.seq >= offset) }
          },
          async close() {
            closes.push(id)
          },
        }
      },
    }
    const coordinator = new InitRecoveryCoordinator({
      store: new SqliteCoordinatorStore(store),
      persistence,
      collector: dummyCollector(),
      worker: dummyWorkerClient(),
      generation: 'g',
      yieldEvery: 1,
    })
    await coordinator.start()

    const progress = store.getProjectionProgress()
    expect(progress.phase).toBe('ready')
    expect(progress.completedSessions).toBe(2)
    expect(store.snapshot({ weeks: 1, offsetWeeks: 0 }, 0).summary.all).toBe(30)
    // Every lifecycle's read handle was released.
    expect(closes.sort()).toEqual(['s1', 's1', 's2', 's2'])
  })
})
