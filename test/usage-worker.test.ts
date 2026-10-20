// Commit 3 gate: Worker entry/protocol/package shape.
// Exercises the serialized command loop with a fake port and a temporary DB.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectionBatch, WorkerCommand, WorkerResult } from '../src/durable/contracts'
import { PROTOCOL_VERSION } from '../src/durable/contracts'
import { UsageWorker, type WorkerPortLike } from '../src/host/usage-worker'

let dir: string
let messages: WorkerResult[]
let port: WorkerPortLike
let worker: UsageWorker

function send(command: WorkerCommand): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const original = port.postMessage.bind(port)
    port.postMessage = (value: unknown) => {
      original(value)
      const result = value as WorkerResult
      if (result.requestId === command.requestId) resolve(result)
    }
    worker.handle(command)
  })
}

function lifecycle() {
  return { sessionId: 's1', createdAtMs: 1000, cwd: '/tmp/project' }
}

function makeBatch(seq: number): ProjectionBatch {
  return {
    batchId: 'b' + seq,
    hostGeneration: 'gen-1',
    lifecycle: lifecycle(),
    fromSeq: 0,
    toSeq: seq,
    deltas: [
      { kind: 'route', seq: 0, time: 0, provider: 'opencode', model: 'deepseek-v4-pro' },
      { kind: 'usage', seq, time: Date.now(), turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 }, final: true },
    ],
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-token-dashboard-worker-'))
  messages = []
  port = {
    postMessage(value: unknown) {
      messages.push(value as WorkerResult)
    },
  }
  worker = new UsageWorker(port)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('UsageWorker', () => {
  it('boots, ingests, snapshots and drains', async () => {
    const dbPath = join(dir, 'usage-v1.sqlite')
    const init = await send({ type: 'init', requestId: 'r-init', hostGeneration: 'gen-1', protocolVersion: PROTOCOL_VERSION, dbPath })
    expect(init).toEqual({ ok: true, requestId: 'r-init', value: { ready: true } })

    const project = await send({ type: 'project', requestId: 'r-project', hostGeneration: 'gen-1', protocolVersion: PROTOCOL_VERSION, batch: makeBatch(2) })
    expect(project.ok).toBe(true)
    if (project.ok) expect(project.value).toMatchObject({ committed: true, checkpoint: 2 })

    const snap = await send({ type: 'snapshot', requestId: 'r-snap', hostGeneration: 'gen-1', protocolVersion: PROTOCOL_VERSION, query: { weeks: 1, offsetWeeks: 0 }, pendingBatches: 1 })
    expect(snap.ok).toBe(true)
    if (snap.ok) {
      expect((snap.value as { summary: { all: number } }).summary.all).toBe(15)
      expect((snap.value as { projection: { pendingBatches: number } }).projection.pendingBatches).toBe(1)
    }

    const generation = await send({ type: 'get_generation', requestId: 'r-generation', hostGeneration: 'gen-1', protocolVersion: PROTOCOL_VERSION })
    expect(generation.ok).toBe(true)
    if (generation.ok) expect(generation.value).toMatchObject({ commitGeneration: 1 })

    const drain = await send({ type: 'drain', requestId: 'r-drain', hostGeneration: 'gen-1', protocolVersion: PROTOCOL_VERSION })
    expect(drain.ok).toBe(true)
    if (drain.ok) expect(drain.value).toMatchObject({ commitGeneration: 1 })

    const shutdown = await send({ type: 'shutdown', requestId: 'r-shutdown', hostGeneration: 'gen-1', protocolVersion: PROTOCOL_VERSION })
    expect(shutdown.ok).toBe(true)
  })

  it('rejects protocol mismatch and generation mismatch without crashing', async () => {
    const dbPath = join(dir, 'usage-v1.sqlite')
    await send({ type: 'init', requestId: 'r-init', hostGeneration: 'gen-1', protocolVersion: PROTOCOL_VERSION, dbPath })
    const badProtocol = await send({ type: 'drain', requestId: 'r-p', hostGeneration: 'gen-1', protocolVersion: 999 })
    expect(badProtocol.ok).toBe(false)
    if (!badProtocol.ok) expect(badProtocol.error.code).toBe('protocol_mismatch')
    const badGen = await send({ type: 'drain', requestId: 'r-g', hostGeneration: 'gen-2', protocolVersion: PROTOCOL_VERSION })
    expect(badGen.ok).toBe(false)
    if (!badGen.ok) expect(badGen.error.code).toBe('generation_mismatch')
  })

  it('serializes errors into stable non-throwing responses', async () => {
    const dbPath = join(dir, 'usage-v1.sqlite')
    await send({ type: 'init', requestId: 'r-init', hostGeneration: 'gen-1', protocolVersion: PROTOCOL_VERSION, dbPath })
    const gap = await send({
      type: 'project',
      requestId: 'r-gap',
      hostGeneration: 'gen-1',
      protocolVersion: PROTOCOL_VERSION,
      batch: { ...makeBatch(5), fromSeq: 4, toSeq: 5 },
    })
    expect(gap.ok).toBe(false)
    if (!gap.ok) expect(gap.error.code).toBe('projection_gap')
  })
})
