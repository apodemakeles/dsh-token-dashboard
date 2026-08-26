// UsageWorkerClient — host-side RPC client for the persistent usage Worker.
//
// Owns the Worker lifecycle, request ids, unacked batches, restart backoff
// and circuit breaker. It contains no SQL and no knowledge of the JSONL
// format; it only speaks the cross-thread protocol.

import { Worker } from 'node:worker_threads'
import {
  DRAIN_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SNAPSHOT_TIMEOUT_MS,
  type LifecycleIdentity,
  type ProjectionBatch,
  type SnapshotQuery,
  type SnapshotV1,
  type WorkerCommand,
  type WorkerResult,
} from './contracts'

/** Minimal Worker-like surface used by tests. */
export interface WorkerLike {
  postMessage(value: unknown): void
  on(event: 'message' | 'error' | 'exit', listener: (...args: any[]) => void): unknown
  terminate(): Promise<unknown>
}

interface PendingRpc {
  readonly command: WorkerCommand
  resolve(value: WorkerResult): void
  reject(error: Error): void
  timer: NodeJS.Timeout | undefined
}

interface UnackedBatch {
  readonly batch: ProjectionBatch
  readonly hostGeneration: string
}

export interface WorkerClientOptions {
  readonly generation: string
  readonly dbPath: string
  readonly workerFactory?: () => WorkerLike
  readonly restartDelaysMs?: readonly number[]
}

export interface RunEpochInfo {
  epochId: number
  state: 'arming' | 'active' | 'clean'
  startedAtMs: number
  cleanAtMs: number | null
}

export interface ProjectionProgress {
  phase: 'initializing' | 'recovering' | 'ready' | 'degraded' | 'rebuild_required' | 'error'
  discoveredSessions: number
  completedSessions: number
  scanningSessions: number
  retryingSessions: number
  failedSessions: number
  startedAtMs: number | null
  completedAtMs: number | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
}

export interface CheckpointInfo {
  lifecyclePk: number
  lastSeq: number
  routeProvider: string | null
  routeModel: string | null
  bootstrapComplete: boolean
  sourceRevision: string | null
}

export interface BaselineInfo {
  lifecyclePk: number
  sourceRevision: string
}

const DEFAULT_RESTART_DELAYS_MS = [100, 1000, 5000] as const

export class UsageWorkerClient {
  private readonly generation: string
  private readonly dbPath: string
  private readonly workerFactory: () => WorkerLike
  private readonly restartDelaysMs: readonly number[]
  private worker: WorkerLike | null = null
  private readonly pending = new Map<string, PendingRpc>()
  private readonly unacked = new Map<string, UnackedBatch>()
  private startPromise: Promise<void> | null = null
  private circuitOpen = false
  private intentionalExit = false
  private restartCount = 0
  private requestCounter = 0

  constructor(options: WorkerClientOptions) {
    this.generation = options.generation
    this.dbPath = options.dbPath
    this.workerFactory = options.workerFactory ?? (() => new Worker(new URL('./usage-worker.js', import.meta.url)) as unknown as WorkerLike)
    this.restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS
  }

  get pendingBatchCount(): number {
    return this.unacked.size
  }

  get isCircuitOpen(): boolean {
    return this.circuitOpen
  }

  /** Start (or restart) the Worker and wait for init ack. */
  start(): Promise<void> {
    if (this.circuitOpen) return Promise.reject(new Error('worker circuit open'))
    if (this.startPromise !== null) return this.startPromise
    this.startPromise = this.spawnAndInit()
    return this.startPromise
  }

  private async spawnAndInit(): Promise<void> {
    this.intentionalExit = false
    const worker = this.workerFactory()
    this.worker = worker
    this.attach(worker)
    await this.request({
      type: 'init',
      requestId: this.nextRequestId(),
      hostGeneration: this.generation,
      protocolVersion: PROTOCOL_VERSION,
      dbPath: this.dbPath,
    })
    // Re-deliver unacked batches after a Worker restart; the Worker trims any
    // prefix already committed via checkpoint.
    for (const unacked of this.unacked.values()) {
      void this.project(unacked.batch)
    }
  }

  /** Send a projection batch and await commit ack. */
  async project(batch: ProjectionBatch): Promise<{ committed: boolean; checkpoint: number; commitGeneration: number }> {
    if (this.circuitOpen) throw new Error('worker circuit open')
    await this.start()
    const key = batch.batchId + '\u0000' + this.generation
    this.unacked.set(key, { batch, hostGeneration: this.generation })
    const command: WorkerCommand = {
      type: 'project',
      requestId: this.nextRequestId(),
      hostGeneration: this.generation,
      protocolVersion: PROTOCOL_VERSION,
      batch,
    }
    const result = await this.request(command)
    if (result.ok) {
      this.unacked.delete(key)
      return result.value as { committed: boolean; checkpoint: number; commitGeneration: number }
    }
    // A non-retryable rejection (projection_gap) is deterministic for this
    // batch: it will never commit as-is, and the completeness rescan owns
    // recovery — the flush barrier guarantees the batch's events reached the
    // durable log. Drop the entry so pendingBatchCount only tracks
    // in-flight commits; retryable failures keep it for redelivery.
    if (result.error.retryable === false) this.unacked.delete(key)
    throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  /** Query a consistent snapshot. */
  async snapshot(query: SnapshotQuery): Promise<SnapshotV1> {
    if (this.circuitOpen) throw new Error('worker circuit open')
    await this.start()
    const command: WorkerCommand = {
      type: 'snapshot',
      requestId: this.nextRequestId(),
      hostGeneration: this.generation,
      protocolVersion: PROTOCOL_VERSION,
      query,
      pendingBatches: this.unacked.size,
    }
    const result = await this.request(command, SNAPSHOT_TIMEOUT_MS)
    if (result.ok) return result.value as SnapshotV1
    throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  /** Barrier: all previously sent commands have committed. */
  async drain(): Promise<{ commitGeneration: number; stateGeneration: number }> {
    if (this.circuitOpen) throw new Error('worker circuit open')
    await this.start()
    const command: WorkerCommand = {
      type: 'drain',
      requestId: this.nextRequestId(),
      hostGeneration: this.generation,
      protocolVersion: PROTOCOL_VERSION,
    }
    const result = await this.request(command, DRAIN_TIMEOUT_MS)
    if (result.ok) return result.value as { commitGeneration: number; stateGeneration: number }
    throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  async beginRunEpoch(startedAtMs = Date.now()): Promise<number> {
    await this.start()
    const command: WorkerCommand = { type: 'begin_run', requestId: this.nextRequestId(), hostGeneration: this.generation, protocolVersion: PROTOCOL_VERSION, startedAtMs }
    const result = await this.request(command)
    if (result.ok) return (result.value as { epochId: number }).epochId
    throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  async activateRunEpoch(epochId: number, baselines: ReadonlyArray<{ lifecyclePk: number; sourceRevision: string }>): Promise<void> {
    await this.start()
    const command: WorkerCommand = { type: 'activate_run', requestId: this.nextRequestId(), hostGeneration: this.generation, protocolVersion: PROTOCOL_VERSION, epochId, baselines }
    const result = await this.request(command)
    if (!result.ok) throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  async markRunClean(epochId: number, cleanAtMs = Date.now()): Promise<void> {
    await this.start()
    const command: WorkerCommand = { type: 'mark_run_clean', requestId: this.nextRequestId(), hostGeneration: this.generation, protocolVersion: PROTOCOL_VERSION, epochId, cleanAtMs }
    const result = await this.request(command)
    if (!result.ok) throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  async getLastRunEpoch(): Promise<RunEpochInfo | null> {
    await this.start()
    const command: WorkerCommand = { type: 'get_last_run', requestId: this.nextRequestId(), hostGeneration: this.generation, protocolVersion: PROTOCOL_VERSION }
    const result = await this.request(command)
    if (result.ok) return result.value as RunEpochInfo | null
    throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  async upsertLifecycle(lifecycle: LifecycleIdentity, discoveredAtMs = Date.now()): Promise<number> {
    await this.start()
    const command: WorkerCommand = { type: 'upsert_lifecycle', requestId: this.nextRequestId(), hostGeneration: this.generation, protocolVersion: PROTOCOL_VERSION, lifecycle, discoveredAtMs }
    const result = await this.request(command)
    if (result.ok) return (result.value as { lifecyclePk: number }).lifecyclePk
    throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  async getLifecycle(lifecycle: LifecycleIdentity): Promise<number | null> {
    await this.start()
    const command: WorkerCommand = { type: 'get_lifecycle', requestId: this.nextRequestId(), hostGeneration: this.generation, protocolVersion: PROTOCOL_VERSION, lifecycle }
    const result = await this.request(command)
    if (result.ok) return (result.value as { lifecyclePk: number | null }).lifecyclePk
    throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  async getCheckpoint(lifecyclePk: number): Promise<CheckpointInfo> {
    await this.start()
    const command: WorkerCommand = { type: 'get_checkpoint', requestId: this.nextRequestId(), hostGeneration: this.generation, protocolVersion: PROTOCOL_VERSION, lifecyclePk }
    const result = await this.request(command)
    if (result.ok) return result.value as CheckpointInfo
    throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  async getProjectionProgress(): Promise<ProjectionProgress> {
    await this.start()
    const command: WorkerCommand = { type: 'get_projection_progress', requestId: this.nextRequestId(), hostGeneration: this.generation, protocolVersion: PROTOCOL_VERSION }
    const result = await this.request(command)
    if (result.ok) return result.value as ProjectionProgress
    throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  async updateProjectionProgress(update: Record<string, unknown>, now = Date.now()): Promise<void> {
    await this.start()
    const command: WorkerCommand = { type: 'update_projection_progress', requestId: this.nextRequestId(), hostGeneration: this.generation, protocolVersion: PROTOCOL_VERSION, update, now }
    const result = await this.request(command)
    if (!result.ok) throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  async setProjectionReady(now = Date.now()): Promise<void> {
    await this.start()
    const command: WorkerCommand = { type: 'set_projection_ready', requestId: this.nextRequestId(), hostGeneration: this.generation, protocolVersion: PROTOCOL_VERSION, now }
    const result = await this.request(command)
    if (!result.ok) throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  async getBaselines(epochId: number): Promise<BaselineInfo[]> {
    await this.start()
    const command: WorkerCommand = { type: 'get_baselines', requestId: this.nextRequestId(), hostGeneration: this.generation, protocolVersion: PROTOCOL_VERSION, epochId }
    const result = await this.request(command)
    if (result.ok) return result.value as BaselineInfo[]
    throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable)
  }

  /** Stop admission, flush commands, close DB and terminate the Worker. */
  async shutdown(): Promise<void> {
    this.intentionalExit = true
    if (this.worker !== null && !this.circuitOpen) {
      const command: WorkerCommand = {
        type: 'shutdown',
        requestId: this.nextRequestId(),
        hostGeneration: this.generation,
        protocolVersion: PROTOCOL_VERSION,
      }
      try {
        await this.request(command, DRAIN_TIMEOUT_MS)
      } catch {
        // Even if the Worker is unresponsive, terminate below.
      }
    }
    await this.worker?.terminate()
    this.worker = null
    this.pending.clear()
    this.startPromise = null
    this.circuitOpen = false
    this.restartCount = 0
  }

  private attach(worker: WorkerLike): void {
    worker.on('message', (value: unknown) => this.onMessage(value as WorkerResult))
    worker.on('error', () => this.onUnexpectedExit())
    worker.on('exit', () => this.onUnexpectedExit())
  }

  private onMessage(result: WorkerResult): void {
    const pending = this.pending.get(result.requestId)
    if (pending === undefined) return
    this.pending.delete(result.requestId)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.resolve(result)
  }

  private onUnexpectedExit(): void {
    if (this.intentionalExit) return
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(new WorkerRpcError('worker_unavailable', 'worker exited before reply', true))
    }
    this.pending.clear()
    this.worker = null
    this.startPromise = null
    if (this.circuitOpen) return
    if (this.restartCount >= this.restartDelaysMs.length) {
      this.circuitOpen = true
      return
    }
    const delay = this.restartDelaysMs[this.restartCount] ?? 5000
    this.restartCount += 1
    setTimeout(() => {
      this.startPromise = this.spawnAndInit().catch(() => {
        this.startPromise = null
      })
    }, delay)
  }

  private request(command: WorkerCommand, timeoutMs?: number): Promise<WorkerResult> {
    if (this.worker === null) return Promise.reject(new WorkerRpcError('worker_unavailable', 'worker is not running', true))
    return new Promise<WorkerResult>((resolve, reject) => {
      const pending: PendingRpc = {
        command,
        resolve,
        reject,
        timer: undefined,
      }
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.pending.delete(command.requestId)
          reject(new WorkerRpcError('rpc_timeout', 'worker rpc timed out', true))
        }, timeoutMs)
      }
      this.pending.set(command.requestId, pending)
      this.worker?.postMessage(command)
    })
  }

  private nextRequestId(): string {
    this.requestCounter += 1
    return this.generation + ':' + this.requestCounter
  }
}

export class WorkerRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'WorkerRpcError'
  }
}
