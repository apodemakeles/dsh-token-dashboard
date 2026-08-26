// Regression: after a host restart, a restored session's first live batches sit
// ahead of the persisted checkpoint and are rejected deterministically
// (projection_gap). The unacked set must not grow from those rejections, and
// the completeness rescan must heal the tail so live commits resume.
//
// Exercises the real SqliteUsageStore, the real thread-less UsageWorker and
// the real UsageCollector together.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { LifecycleIdentity, ProjectionBatch, WorkerCommand, WorkerResult } from '../src/durable/contracts'
import { UsageCollector, type SessionLike } from '../src/durable/collector'
import { UsageWorkerClient, type WorkerLike } from '../src/durable/worker-client'
import { UsageWorker, type WorkerPortLike } from '../src/host/usage-worker'

/** Bridges the thread-less UsageWorker to the WorkerLike surface the client drives. */
class LocalWorker implements WorkerLike {
  private readonly worker: UsageWorker
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>()

  constructor(dbPath: string) {
    this.worker = new UsageWorker({
      postMessage: (value: unknown) => this.emit('message', value),
    } satisfies WorkerPortLike, dbPath)
  }

  on(event: 'message' | 'error' | 'exit', listener: (...args: any[]) => void): unknown {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  postMessage(value: unknown): void {
    this.worker.handle(value as WorkerCommand)
  }

  async terminate(): Promise<unknown> {
    return 0
  }

  private emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value)
  }
}

const LIFECYCLE: LifecycleIdentity = { sessionId: 's1', createdAtMs: 1000, cwd: '/tmp/project' }

function usageMessage(seq: number, turn = 1, step = 1): SessionEvent {
  return { type: 'assistant/message', seq, time: Date.now(), data: { turn, step, message: {}, usage: { inputTokens: 10, outputTokens: 5 } } } as unknown as SessionEvent
}

function preRestartBatch(): ProjectionBatch {
  return {
    batchId: 'b0-10',
    hostGeneration: 'g1',
    lifecycle: LIFECYCLE,
    fromSeq: 0,
    toSeq: 10,
    deltas: [
      { kind: 'route', seq: 0, time: 0, provider: 'opencode', model: 'deepseek-v4-pro' },
      { kind: 'usage', seq: 10, time: Date.now(), turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 }, final: true },
    ],
  }
}

/** One completeness-rescan chunk covering [fromSeq..toSeq], as the periodic scan builds it. */
function rescanBatch(fromSeq: number, toSeq: number): ProjectionBatch {
  return {
    batchId: 'rescan-' + fromSeq + '-' + toSeq,
    hostGeneration: 'g1',
    lifecycle: LIFECYCLE,
    fromSeq,
    toSeq,
    deltas: Array.from({ length: toSeq - fromSeq + 1 }, (_, i) => ({
      kind: 'usage' as const,
      seq: fromSeq + i,
      time: Date.now(),
      turn: fromSeq + i,
      step: 0,
      usage: { inputTokens: 10, outputTokens: 5 },
      final: true,
    })),
  }
}

describe('restart gap healing (regression)', () => {
  it('rejects post-restart live batches deterministically, keeps unacked clean, heals via rescan and resumes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-token-dashboard-gap-'))
    const dbPath = join(dir, 'usage-v1.sqlite')
    try {
      const worker = new LocalWorker(dbPath)
      const client = new UsageWorkerClient({
        generation: 'g1',
        dbPath,
        workerFactory: () => worker,
        restartDelaysMs: [0, 0, 0],
      })
      await client.start()

      const results: WorkerResult[] = []
      worker.on('message', (value) => { results.push(value as WorkerResult) })

      // Pre-restart run: checkpoint committed at 10.
      const first = await client.project(preRestartBatch())
      expect(first).toMatchObject({ committed: true, checkpoint: 10 })

      // Restart: a fresh collector on the restored session. Events 15..20 are the
      // live tail the collector observes; 11..14 are the pre-restart hole the log
      // still holds. Event 15 is the collector's first observation of this
      // lifecycle, so it is skipped and 16..20 form five gap-eligible batches.
      const collector = new UsageCollector({
        generation: 'g1',
        flush: { flush: async () => true },
        worker: client,
        flushCooldownMs: 0,
        flushRetryDelaysMs: [0],
      })
      collector.start()
      const s: SessionLike = { id: 's1', header: { createdAt: 1000, cwd: '/tmp/project' } }
      for (let seq = 15; seq <= 20; seq += 1) {
        collector.onEvent(s, usageMessage(seq))
      }
      await collector.drain()

      // Every live batch was deterministically rejected with a projection gap...
      const gapReplies = results.filter(
        (result): result is Extract<WorkerResult, { ok: false }> => !result.ok && result.error.code === 'projection_gap',
      )
      expect(gapReplies).toHaveLength(5)
      for (const reply of gapReplies) expect(reply.error.retryable).toBe(false)
      // ...the lifecycle is flagged for resync...
      expect(collector.resyncLifecycleCount).toBe(1)
      // ...and none of the dead batches leaked into the unacked set.
      expect(client.pendingBatchCount).toBe(0)

      // Completeness rescan: one chunk from checkpoint+1 to the log tail.
      const healed = await client.project(rescanBatch(11, 20))
      expect(healed).toMatchObject({ committed: true, checkpoint: 20 })

      // The live path resumes exactly at checkpoint + 1.
      collector.onEvent(s, usageMessage(21, 2, 1))
      await collector.drain()
      expect(client.pendingBatchCount).toBe(0)

      const lifecyclePk = await client.getLifecycle(LIFECYCLE)
      expect(lifecyclePk).toBeTypeOf('number')
      if (lifecyclePk === null) throw new Error('lifecycle row missing')
      const checkpoint = await client.getCheckpoint(lifecyclePk)
      expect(checkpoint.lastSeq).toBe(21)

      const snapshot = await client.snapshot({ weeks: 1, offsetWeeks: 0 })
      // 1 pre-restart fact + 10 rescan facts + 1 resumed live fact, 15 tokens each.
      expect(snapshot.summary.all).toBe(180)
      expect(snapshot.projection.pendingBatches).toBe(0)

      await client.shutdown()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
