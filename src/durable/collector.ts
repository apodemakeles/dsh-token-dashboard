// Real-time UsageCollector: O(1) event admission, per-lifecycle ordered
// pipelines, host-side batching, source flush barrier and bounded backpressure.
//
// This module is intentionally not wired to Cordis until the cutover commit.
// It talks to narrow interfaces so tests can use deterministic fakes.

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  HARD_DELTA_THRESHOLD,
  HOST_BATCH_DELTA_LIMIT,
  HOST_BATCH_IDLE_MS,
  HOST_BATCH_MAX_AGE_MS,
  SOFT_DELTA_THRESHOLD,
  type LifecycleIdentity,
  type ProjectionBatch,
  type UsageDelta,
} from './contracts'
import { diag } from './diag'
import { normalizeEventDelta } from './projector'

/** Minimal live Session shape used by the collector. */
export interface SessionLike {
  readonly id: string
  readonly header: {
    readonly createdAt: number
    readonly cwd?: string
  }
}

export interface FlushService {
  flush(session: SessionLike): Promise<boolean>
}

export interface WorkerProjectService {
  project(batch: ProjectionBatch): Promise<unknown>
}

export interface TimerLike {
  (callback: () => void, ms?: number): unknown
}

export interface CollectorOptions {
  readonly generation: string
  readonly flush: FlushService
  readonly worker: WorkerProjectService
  readonly now?: () => number
  readonly setTimeoutFn?: TimerLike
  readonly clearTimeoutFn?: (handle: unknown) => void
  readonly flushRetryDelaysMs?: readonly number[]
  readonly flushCooldownMs?: number
}

interface OpenBatch {
  fromSeq: number
  toSeq: number
  openedAt: number
  lastActivity: number
  deltas: UsageDelta[]
  timer?: unknown
}

interface Pipeline {
  readonly lifecycle: LifecycleIdentity
  readonly session: SessionLike
  expectedSeq: number
  openBatch: OpenBatch | null
  chain: Promise<void>
  pendingDeltaCount: number
  overflowed: boolean
  resyncRequired: boolean
}

const DEFAULT_FLUSH_RETRY_DELAYS_MS = [100, 1000, 5000] as const
const FLUSH_COOLDOWN_MS = 30_000

export class UsageCollector {
  private readonly generation: string
  private readonly flushService: FlushService
  private readonly worker: WorkerProjectService
  private readonly now: () => number
  private readonly setTimeoutFn: TimerLike
  private readonly clearTimeoutFn: (handle: unknown) => void
  private readonly flushRetryDelaysMs: readonly number[]
  private readonly flushCooldownMs: number
  private readonly pipelines = new Map<string, Pipeline>()
  private accepting = false

  constructor(options: CollectorOptions) {
    this.generation = options.generation
    this.flushService = options.flush
    this.worker = options.worker
    this.now = options.now ?? Date.now
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
    this.flushRetryDelaysMs = options.flushRetryDelaysMs ?? DEFAULT_FLUSH_RETRY_DELAYS_MS
    this.flushCooldownMs = options.flushCooldownMs ?? FLUSH_COOLDOWN_MS
  }

  start(): void {
    this.accepting = true
    diag('collector', 'start: accepting live events')
  }

  stop(): void {
    this.accepting = false
  }

  get isAccepting(): boolean {
    return this.accepting
  }

  /** Number of lifecycles currently flagged resync/degraded. */
  get resyncLifecycleCount(): number {
    let count = 0
    for (const pipeline of this.pipelines.values()) {
      if (pipeline.resyncRequired || pipeline.overflowed) count += 1
    }
    return count
  }

  /** Synchronous event admission: normalize + enqueue, never I/O. */
  onEvent(session: SessionLike, event: SessionEvent): void {
    if (!this.accepting) return
    const lifecycle = lifecycleOf(session)
    const key = lifecycleKey(lifecycle)
    let pipeline = this.pipelines.get(key)
    if (pipeline === undefined) {
      pipeline = {
        lifecycle,
        session,
        expectedSeq: 0,
        openBatch: null,
        chain: Promise.resolve(),
        pendingDeltaCount: 0,
        overflowed: false,
        resyncRequired: false,
      }
      this.pipelines.set(key, pipeline)
    }
    this.enqueue(pipeline, event)
  }

  /** Explicitly close one lifecycle's open batch and flush it (used by drain/init). */
  flushLifecycle(session: SessionLike): Promise<void> {
    const pipeline = this.pipelines.get(lifecycleKey(lifecycleOf(session)))
    if (pipeline === undefined) return Promise.resolve()
    this.closeBatch(pipeline)
    return pipeline.chain
  }

  /** Close all open batches and wait for every per-session chain. */
  async drain(): Promise<void> {
    for (const pipeline of this.pipelines.values()) this.closeBatch(pipeline)
    await Promise.all([...this.pipelines.values()].map((pipeline) => pipeline.chain))
  }

  private enqueue(pipeline: Pipeline, event: SessionEvent): void {
    // A pipeline created mid-log (the host activated after the session
    // already had history) baselines at the first delivered event instead of
    // dropping it: the prefix below is the scanner's job, and the first
    // delivered event is very often the usage-bearing one.
    if (pipeline.expectedSeq === 0 && event.seq > 0) {
      pipeline.expectedSeq = event.seq
      diag('collector', `pipeline ${pipeline.lifecycle.sessionId} baselined at seq ${event.seq} (mid-log attach)`)
    }
    if (event.seq < pipeline.expectedSeq) return
    if (event.seq > pipeline.expectedSeq) {
      pipeline.resyncRequired = true
      diag('collector', `pipeline ${pipeline.lifecycle.sessionId} gap: got seq ${event.seq}, expected ${pipeline.expectedSeq}; dropping to resync`)
      pipeline.expectedSeq = event.seq + 1
      return
    }
    pipeline.expectedSeq = event.seq + 1

    if (pipeline.overflowed) {
      // Hard overflow: stop retaining in memory; JSONL tail resync will recover.
      pipeline.resyncRequired = true
      return
    }

    const now = this.now()
    if (pipeline.openBatch === null) {
      pipeline.openBatch = { fromSeq: event.seq, toSeq: event.seq, openedAt: now, lastActivity: now, deltas: [] }
    } else {
      pipeline.openBatch.toSeq = event.seq
      pipeline.openBatch.lastActivity = now
    }

    const delta = normalizeEventDelta(event)
    if (delta !== null) {
      pipeline.openBatch.deltas.push(delta)
      pipeline.pendingDeltaCount += 1
    }

    const isFinalUsage = delta !== null && delta.kind === 'usage' && delta.final
    const isTurnEnd = event.type === 'turn/end'
    if (isFinalUsage || isTurnEnd || pipeline.openBatch.deltas.length >= HOST_BATCH_DELTA_LIMIT) {
      this.closeBatch(pipeline)
      return
    }

    // Soft threshold: stop coalescing and commit promptly to bound memory.
    if (pipeline.pendingDeltaCount >= SOFT_DELTA_THRESHOLD) {
      this.closeBatch(pipeline)
      return
    }

    if (pipeline.pendingDeltaCount >= HARD_DELTA_THRESHOLD) {
      pipeline.overflowed = true
      pipeline.resyncRequired = true
      this.closeBatch(pipeline)
      return
    }

    this.armIdleClose(pipeline)
  }

  private armIdleClose(pipeline: Pipeline): void {
    const batch = pipeline.openBatch
    if (batch === undefined || batch === null) return
    if (batch.timer !== undefined) this.clearTimeoutFn(batch.timer)
    const idleDelay = Math.max(0, HOST_BATCH_IDLE_MS - (this.now() - batch.lastActivity))
    batch.timer = this.setTimeoutFn(() => {
      const current = pipeline.openBatch
      if (current === batch) this.closeBatch(pipeline)
    }, idleDelay)
    const maxAge = Math.max(0, HOST_BATCH_MAX_AGE_MS - (this.now() - batch.openedAt))
    if (maxAge <= 0) {
      this.closeBatch(pipeline)
    }
  }

  private closeBatch(pipeline: Pipeline): void {
    const batch = pipeline.openBatch
    if (batch === null || batch === undefined) return
    if (batch.timer !== undefined) this.clearTimeoutFn(batch.timer)
    pipeline.openBatch = null
    const projected: ProjectionBatch = {
      batchId: this.generation + ':' + batch.fromSeq + '-' + batch.toSeq + ':' + Math.random().toString(36).slice(2, 8),
      hostGeneration: this.generation,
      lifecycle: pipeline.lifecycle,
      fromSeq: batch.fromSeq,
      toSeq: batch.toSeq,
      deltas: batch.deltas,
    }
    pipeline.chain = pipeline.chain.then(() => this.flushAndSend(pipeline, projected))
  }

  private async flushAndSend(pipeline: Pipeline, batch: ProjectionBatch): Promise<void> {
    try {
      await this.flushWithRetry(pipeline.session)
    } catch (error) {
      pipeline.resyncRequired = true
      diag('collector', `flush failed for ${pipeline.lifecycle.sessionId} seqs ${batch.fromSeq}-${batch.toSeq}; batch dropped for resync`, error)
      return
    }
    try {
      await this.worker.project(batch)
      pipeline.pendingDeltaCount = Math.max(0, pipeline.pendingDeltaCount - batch.deltas.length)
    } catch (error) {
      pipeline.resyncRequired = true
      diag('collector', `worker.project failed for ${pipeline.lifecycle.sessionId} seqs ${batch.fromSeq}-${batch.toSeq}; batch dropped for resync`, error)
    }
  }

  private async flushWithRetry(session: SessionLike): Promise<void> {
    let lastError: unknown
    for (const delay of this.flushRetryDelaysMs) {
      try {
        const ok = await this.flushService.flush(session)
        if (ok) return
        throw new Error('flush returned false')
      } catch (error) {
        lastError = error
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    // After the 3 retries, enter a cooldown before the next attempt.
    if (this.flushCooldownMs > 0) await new Promise((resolve) => setTimeout(resolve, this.flushCooldownMs))
    throw lastError ?? new Error('flush failed')
  }
}

function lifecycleOf(session: SessionLike): LifecycleIdentity {
  return {
    sessionId: session.id,
    createdAtMs: session.header.createdAt,
    cwd: session.header.cwd ?? '',
  }
}

function lifecycleKey(lifecycle: LifecycleIdentity): string {
  return lifecycle.sessionId + '\u0000' + lifecycle.createdAtMs + '\u0000' + lifecycle.cwd
}
