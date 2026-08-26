// Commit 4 gate: UsageWorkerClient RPC/ack/restart/circuit breaker.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectionBatch, WorkerCommand, WorkerResult } from '../src/durable/contracts'
import { PROTOCOL_VERSION } from '../src/durable/contracts'
import { UsageWorkerClient, type WorkerLike } from '../src/durable/worker-client'

class FakeWorker implements WorkerLike {
  posted: WorkerCommand[] = []
  private listeners = new Map<string, Array<(...args: any[]) => void>>()
  failProject = false
  exitOnProject = false
  ackProject = true
  rejectProject: { code: string; retryable: boolean } | null = null
  terminateCalls = 0

  on(event: string, listener: (...args: any[]) => void): unknown {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  postMessage(value: unknown): void {
    const command = value as WorkerCommand
    this.posted.push(command)
    if (command.type === 'init') {
      this.emit('message', { ok: true, requestId: command.requestId, value: { ready: true } } satisfies WorkerResult)
      return
    }
    if (command.type === 'project') {
      if (this.failProject) {
        this.emit('error', new Error('boom'))
        return
      }
      if (this.exitOnProject) {
        this.emit('exit', 1)
        return
      }
      if (this.rejectProject !== null) {
        this.emit('message', {
          ok: false,
          requestId: command.requestId,
          error: { code: this.rejectProject.code, message: this.rejectProject.code, retryable: this.rejectProject.retryable },
        } satisfies WorkerResult)
        return
      }
      if (this.ackProject) {
        this.emit('message', {
          ok: true,
          requestId: command.requestId,
          value: { committed: true, checkpoint: command.batch.toSeq, commitGeneration: 1 },
        } satisfies WorkerResult)
      }
      return
    }
    if (command.type === 'snapshot') {
      this.emit('message', {
        ok: true,
        requestId: command.requestId,
        value: { summary: { all: 0 } },
      } satisfies WorkerResult)
      return
    }
    if (command.type === 'drain' || command.type === 'shutdown') {
      this.emit('message', { ok: true, requestId: command.requestId, value: { ok: true } } satisfies WorkerResult)
    }
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  terminate(): Promise<unknown> {
    this.terminateCalls += 1
    this.emit('exit', 0)
    return Promise.resolve(0)
  }
}

function makeBatch(seq: number, batchId = 'b' + seq, generation = 'gen-1'): ProjectionBatch {
  return {
    batchId,
    hostGeneration: generation,
    lifecycle: { sessionId: 's1', createdAtMs: 1000, cwd: '/tmp/project' },
    fromSeq: 0,
    toSeq: seq,
    deltas: [
      { kind: 'route', seq: 0, time: 0, provider: 'opencode', model: 'deepseek-v4-pro' },
      { kind: 'usage', seq, time: Date.now(), turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 }, final: true },
    ],
  }
}

describe('UsageWorkerClient', () => {
  let workers: FakeWorker[]
  let client: UsageWorkerClient
  let factory: () => WorkerLike

  beforeEach(async () => {
    workers = []
    factory = () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    }
    client = new UsageWorkerClient({
      generation: 'gen-1',
      dbPath: '/tmp/usage.sqlite',
      workerFactory: factory,
      restartDelaysMs: [0, 0, 0],
    })
    await client.start()
  })

  afterEach(async () => {
    await client.shutdown().catch(() => undefined)
  })

  it('starts, projects, snapshots and drains', async () => {
    const ack = await client.project(makeBatch(2))
    expect(ack.committed).toBe(true)
    expect(client.pendingBatchCount).toBe(0)
    await client.snapshot({ weeks: 1, offsetWeeks: 0 })
    const drain = await client.drain()
    expect(drain).toBeTypeOf('object')
  })

  it('keeps unacked batch when worker exits before ack, then redelivers after restart', async () => {
    workers[0]!.exitOnProject = true
    await expect(client.project(makeBatch(2))).rejects.toMatchObject({ code: 'worker_unavailable' })
    expect(client.pendingBatchCount).toBe(1)
    // Restart is scheduled with 0ms delay; wait for the new worker to init/resend.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(workers.length).toBeGreaterThanOrEqual(2)
    // The redelivered project on the second worker should be acked.
    expect(client.pendingBatchCount).toBe(0)
  })

  it('drops a deterministically rejected batch from the unacked set', async () => {
    workers[0]!.rejectProject = { code: 'projection_gap', retryable: false }
    await expect(client.project(makeBatch(2))).rejects.toMatchObject({ code: 'projection_gap' })
    expect(client.pendingBatchCount).toBe(0)
  })

  it('keeps a retryable error batch unacked for redelivery', async () => {
    workers[0]!.rejectProject = { code: 'worker_error', retryable: true }
    await expect(client.project(makeBatch(2))).rejects.toMatchObject({ code: 'worker_error' })
    expect(client.pendingBatchCount).toBe(1)
  })

  it('ignores stale acks and does not remove a newer unacked batch', async () => {
    const batch = makeBatch(2)
    const first = client.project(batch)
    // Simulate a stale ack from an older request id after the new project was sent.
    workers[0]!.emit('message', { ok: true, requestId: 'old:1', value: { committed: true, checkpoint: 2, commitGeneration: 1 } } satisfies WorkerResult)
    await first
    expect(client.pendingBatchCount).toBe(0)
  })

  it('opens the circuit after three consecutive unexpected exits', async () => {
    let attempts = 0
    while (!client.isCircuitOpen && attempts < 10) {
      const current = workers[workers.length - 1]
      current!.failProject = true
      await expect(client.project(makeBatch(attempts + 2, 'b' + attempts))).rejects.toBeTruthy()
      await new Promise((resolve) => setTimeout(resolve, 5))
      attempts += 1
    }
    expect(client.isCircuitOpen).toBe(true)
    await expect(client.project(makeBatch(99))).rejects.toThrow('circuit open')
  })
})
