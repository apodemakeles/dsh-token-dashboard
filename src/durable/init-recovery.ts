// InitRecoveryCoordinator — background initialization and crash-tail recovery.
//
// It uses only the DSH persistence seam plus the collector and Worker client.
// It never touches physical JSONL/Zstd paths and never runs on the panel
// request path.

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionBatch, LifecycleIdentity } from './contracts'
import { diag } from './diag'
import { normalizeEventDeltas } from './projector'
import type { SqliteUsageStore } from './sqlite-store'
import type { UsageCollector } from './collector'
import type { UsageWorkerClient } from './worker-client'

/** One stored-session observation: the header identity plus an opaque change token. */
export interface SessionSnapshotLike {
  readonly header: { id: string; createdAt?: number; cwd?: string }
  readonly revision: unknown
}

/** A read handle from the handle-based persistence generation. */
export interface ReadHandleLike {
  readonly header: { id: string; createdAt?: number; cwd?: string }
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: SessionEvent[] }>
  close(): Promise<void>
}

/**
 * Minimal persistence seam shape sufficient for init/recovery.
 *
 * Two service generations are accepted, because `ctx.sessionPersistence` was
 * re-shaped after 0.1.0-rc.6 and both are in the field:
 *
 * - **handle** (`list`/`open`, shipped by current builds): one snapshot per
 *   stored session, and a per-session read handle whose `read(offset)` returns
 *   the logical events from seq `offset` on.
 * - **snapshot** (`listSnapshots`/`readFrom`, 0.1.0-rc.6): the same
 *   observations as two direct calls.
 *
 * `PersistenceSeam` normalizes both onto one vocabulary; only the methods the
 * running build provides are ever called.
 */
export interface PersistenceLike {
  list?(options?: { signal?: AbortSignal }): Promise<ReadonlyArray<SessionSnapshotLike>>
  open?(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<ReadHandleLike>
  listSnapshots?(signal?: AbortSignal): Promise<ReadonlyArray<SessionSnapshotLike>>
  readFrom?(id: string, fromSeq: number, signal?: AbortSignal): Promise<{ meta: { id: string; createdAt?: number; cwd?: string }; events: SessionEvent[] }>
}

/**
 * Normalize the persistence generations onto `listSnapshots`/`readFrom`.
 *
 * Generation detection is ordered, not feature-sniffed field by field:
 * 0.1.0-rc.6 exposes `listSnapshots`/`readFrom` *and* a `list()` that returns
 * bare headers without revisions, so `listSnapshots` decides the generation
 * and the handle path is taken only when it is absent.
 *
 * A handle read opens and closes one handle per call. `open(id, 'read')` never
 * takes write ownership, so the agent loop keeps its own writer, and closing
 * promptly keeps no read resources pinned between scan batches. A scan reads a
 * lifecycle at most twice (the tail, then the empty read that ends the loop).
 */
export class PersistenceSeam {
  private readonly persistence: PersistenceLike
  private readonly resolved: 'handle' | 'snapshot' | 'unsupported'

  constructor(persistence: PersistenceLike) {
    this.persistence = persistence
    if (typeof persistence.listSnapshots === 'function' && typeof persistence.readFrom === 'function') this.resolved = 'snapshot'
    else if (typeof persistence.list === 'function' && typeof persistence.open === 'function') this.resolved = 'handle'
    else this.resolved = 'unsupported'
  }

  /** Which service generation is mounted; surfaced in startup diagnostics. */
  get generation(): 'handle' | 'snapshot' | 'unsupported' {
    return this.resolved
  }

  /** Every stored session visible to this process, in either generation's shape. */
  async listSnapshots(signal?: AbortSignal): Promise<ReadonlyArray<SessionSnapshotLike>> {
    if (this.resolved === 'snapshot') return await this.persistence.listSnapshots!(signal)
    if (this.resolved === 'handle') return await this.persistence.list!({ signal })
    throw new Error('dsh-token-dashboard: ctx.sessionPersistence exposes neither listSnapshots() nor list()')
  }

  /** Stored events from seq `fromSeq` on; an empty array means the log ends there. */
  async readFrom(id: string, fromSeq: number, signal?: AbortSignal): Promise<SessionEvent[]> {
    if (this.resolved === 'snapshot') return (await this.persistence.readFrom!(id, fromSeq, signal)).events
    if (this.resolved === 'handle') {
      const handle = await this.persistence.open!(id, 'read', { signal })
      try {
        const read = await handle.read(fromSeq, undefined, { signal })
        return read.events
      } finally {
        await handle.close().catch(() => undefined)
      }
    }
    throw new Error('dsh-token-dashboard: ctx.sessionPersistence exposes neither readFrom() nor open()')
  }
}

export interface CoordinatorStore {
  getLastRunEpoch(): Promise<{ epochId: number; state: 'arming' | 'active' | 'clean'; startedAtMs: number; cleanAtMs: number | null } | null>
  beginRunEpoch(startedAtMs?: number): Promise<number>
  activateRunEpoch(epochId: number, baselines: ReadonlyArray<{ lifecyclePk: number; sourceRevision: string }>): Promise<void>
  upsertLifecycle(identity: LifecycleIdentity, discoveredAtMs?: number): Promise<number>
  getLifecycle(identity: LifecycleIdentity): Promise<number | undefined>
  getCheckpoint(lifecyclePk: number): Promise<{
    lifecyclePk: number
    lastSeq: number
    routeProvider: string | null
    routeModel: string | null
    bootstrapComplete: boolean
    sourceRevision: string | null
  }>
  getProjectionProgress(): Promise<{
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
  }>
  updateProjectionProgress(update: Record<string, unknown>, now?: number): Promise<void>
  setProjectionReady(now?: number): Promise<void>
  getBaselines(epochId: number): Promise<Array<{ lifecyclePk: number; sourceRevision: string }>>
  projectBatch(batch: ProjectionBatch, now?: number): Promise<unknown>
}

/** Async adapter for the Worker client: all SQLite operations stay in the Worker. */
export class WorkerCoordinatorStore implements CoordinatorStore {
  constructor(private readonly client: UsageWorkerClient) {}

  async getLastRunEpoch() { return this.client.getLastRunEpoch() }
  async beginRunEpoch(startedAtMs?: number) { return this.client.beginRunEpoch(startedAtMs) }
  async activateRunEpoch(epochId: number, baselines: ReadonlyArray<{ lifecyclePk: number; sourceRevision: string }>) { await this.client.activateRunEpoch(epochId, baselines) }
  async upsertLifecycle(identity: LifecycleIdentity, discoveredAtMs?: number) { return this.client.upsertLifecycle(identity, discoveredAtMs) }
  async getLifecycle(identity: LifecycleIdentity) { return (await this.client.getLifecycle(identity)) ?? undefined }
  async getCheckpoint(lifecyclePk: number) { return this.client.getCheckpoint(lifecyclePk) }
  async getProjectionProgress() { return this.client.getProjectionProgress() }
  async updateProjectionProgress(update: Record<string, unknown>, now?: number) { await this.client.updateProjectionProgress(update, now) }
  async setProjectionReady(now?: number) { await this.client.setProjectionReady(now) }
  async getBaselines(epochId: number) { return this.client.getBaselines(epochId) }
  async projectBatch(batch: ProjectionBatch, _now?: number) { return this.client.project(batch) }
}

/** Async adapter so the coordinator can run against either direct SQLite (tests) or the Worker client. */
export class SqliteCoordinatorStore implements CoordinatorStore {
  constructor(private readonly store: SqliteUsageStore) {}

  async getLastRunEpoch() { return await this.store.getLastRunEpoch() ?? null }
  async beginRunEpoch(startedAtMs?: number) { return await this.store.beginRunEpoch(startedAtMs) }
  async activateRunEpoch(epochId: number, baselines: ReadonlyArray<{ lifecyclePk: number; sourceRevision: string }>) { await this.store.activateRunEpoch(epochId, baselines as never) }
  async upsertLifecycle(identity: LifecycleIdentity, discoveredAtMs?: number) { return await this.store.upsertLifecycle(identity, discoveredAtMs) }
  async getLifecycle(identity: LifecycleIdentity) { return await this.store.getLifecycle(identity) }
  async getCheckpoint(lifecyclePk: number) { return await this.store.getCheckpoint(lifecyclePk) }
  async getProjectionProgress() { return await this.store.getProjectionProgress() }
  async updateProjectionProgress(update: Record<string, unknown>, now?: number) { await this.store.updateProjectionProgress(update as never, now) }
  async setProjectionReady(now?: number) { await this.store.setProjectionReady(now) }
  async getBaselines(epochId: number) { return await this.store.getBaselines(epochId) }
  async projectBatch(batch: ProjectionBatch, now?: number) { return await this.store.projectBatch(batch, now) }
}

export interface InitRecoveryOptions {
  readonly store: CoordinatorStore
  readonly persistence: PersistenceLike
  readonly collector: UsageCollector
  readonly worker: UsageWorkerClient
  readonly generation: string
  readonly now?: () => number
  readonly yieldEvery?: number
  readonly maxRecoveryParallel?: number
  readonly signal?: AbortSignal
}

const DEFAULT_YIELD_EVERY = 500
const DEFAULT_MAX_RECOVERY_PARALLEL = 2

export class InitRecoveryCoordinator {
  private readonly store: CoordinatorStore
  private readonly persistence: PersistenceSeam
  private readonly collector: UsageCollector
  private readonly worker: UsageWorkerClient
  private readonly generation: string
  private readonly now: () => number
  private readonly yieldEvery: number
  private readonly maxRecoveryParallel: number
  private readonly signal?: AbortSignal
  private aborted = false
  private started = false
  private armed = false
  private snapshots: ReadonlyArray<SessionSnapshotLike> = []
  private previousState: 'arming' | 'active' | 'clean' | undefined
  private previousEpochId: number | undefined

  constructor(options: InitRecoveryOptions) {
    this.store = options.store
    this.persistence = new PersistenceSeam(options.persistence)
    this.collector = options.collector
    this.worker = options.worker
    this.generation = options.generation
    this.now = options.now ?? Date.now
    this.yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY
    this.maxRecoveryParallel = options.maxRecoveryParallel ?? DEFAULT_MAX_RECOVERY_PARALLEL
    this.signal = options.signal
  }

  get isAborted(): boolean {
    return this.aborted
  }

  /** Which ctx.sessionPersistence generation the seam resolved; surfaced in diagnostics. */
  get persistenceGeneration(): 'handle' | 'snapshot' | 'unsupported' {
    return this.persistence.generation
  }

  /** Start the coordinator: arm run, activate with baseline, then run scan. */
  async start(): Promise<void> {
    await this.arm()
    await this.scan()
  }

  /** Arm the run epoch and activate with a revision baseline; no scan yet. */
  async arm(): Promise<void> {
    if (this.armed) return
    this.armed = true
    this.started = true
    const previous = await this.store.getLastRunEpoch()
    this.previousState = previous?.state
    this.previousEpochId = previous?.epochId
    const startedAtMs = this.now()
    const epochId = await this.store.beginRunEpoch(startedAtMs)
    const snapshots = await this.persistence.listSnapshots(this.signal)
    this.snapshots = snapshots
    const baselines: Array<{ lifecyclePk: number; sourceRevision: string }> = []
    for (const snapshot of snapshots) {
      baselines.push({
        lifecyclePk: await this.store.upsertLifecycle(identityFromSnapshot(snapshot), startedAtMs),
        sourceRevision: String(snapshot.revision),
      })
    }
    await this.store.activateRunEpoch(epochId, baselines)
    if (this.signal?.aborted) this.aborted = true
  }

  /** Run initialization/recovery/ready transition after arm(). */
  async scan(): Promise<void> {
    if (!this.armed) throw new Error('coordinator not armed')
    if (this.aborted || this.signal?.aborted) return
    const progress = await this.store.getProjectionProgress()
    const phase = progress.phase
    if (phase === 'initializing') {
      await this.runInitialization(this.snapshots)
    } else if (this.previousState === 'active' || this.previousState === 'arming') {
      await this.runRecovery(this.previousState, this.previousEpochId, this.snapshots, [])
    } else {
      // Clean/ready startup. The logs are the authority and SQLite is a
      // projection, so sessions that changed since the last recorded
      // checkpoint (a window while this plugin was disabled, usage that
      // happened before this run activated, or writes by another profile
      // sharing the home) are still reconciled here; an unchanged corpus
      // costs one checkpoint comparison per session.
      await this.runReconciliation(this.snapshots)
      await this.store.updateProjectionProgress({ phase: 'ready' }, this.now())
    }
  }

  /**
   * Heal the projection against the live corpus on a clean startup: scan
   * every session whose checkpoint is missing or whose stored revision no
   * longer matches the snapshot's revision. Batches are keyed and checkpoints
   * advance, so re-scanning an unchanged session is a no-op read.
   */
  private async runReconciliation(snapshots: ReadonlyArray<SessionSnapshotLike>): Promise<void> {
    const candidates: SessionSnapshotLike[] = []
    for (const snapshot of snapshots) {
      if (this.aborted) return
      const identity = identityFromSnapshot(snapshot)
      const pk = await this.store.getLifecycle(identity)
      const revision = String(snapshot.revision)
      if (pk === undefined) {
        candidates.push(snapshot)
        continue
      }
      const checkpoint = await this.store.getCheckpoint(pk)
      if (!checkpoint.bootstrapComplete || checkpoint.sourceRevision !== revision) candidates.push(snapshot)
    }
    if (candidates.length === 0) return

    let failed = 0
    const reasons = new FailureLog()
    for (const snapshot of candidates) {
      if (this.aborted) return
      try {
        const checkpoint = await this.store.getCheckpoint(await this.store.upsertLifecycle(identityFromSnapshot(snapshot)))
        await this.scanLifecycle(snapshot, checkpoint.lastSeq + 1, false)
      } catch (error) {
        failed += 1
        reasons.record(snapshot.header.id, error)
        diag('reconcile', `session ${snapshot.header.id} could not be reconciled; retried on the next startup`, error)
      }
    }
    reasons.report()
  }

  /** Abort background scan/recovery; committed work is preserved. */
  abort(): void {
    this.aborted = true
  }

  private async runInitialization(snapshots: ReadonlyArray<SessionSnapshotLike>): Promise<void> {
    if (this.aborted) return
    await this.store.updateProjectionProgress({
      phase: 'initializing',
      discoveredSessions: snapshots.length,
      startedAtMs: this.now(),
      scanningSessions: 0,
      retryingSessions: 0,
      failedSessions: 0,
      completedSessions: 0,
    }, this.now())

    let failed = 0
    const failedIds = new Set<string>()
    const reasons = new FailureLog()
    for (let index = 0; index < snapshots.length; index += 1) {
      if (this.aborted) return
      const snapshot = snapshots[index]!
      await this.store.updateProjectionProgress({ scanningSessions: 1 }, this.now())
      try {
        const completed = await this.scanLifecycle(snapshot, 0, true)
        if (!completed) {
          failed += 1
          failedIds.add(snapshot.header.id)
        } else {
          const progress = await this.store.getProjectionProgress()
          await this.store.updateProjectionProgress({
            completedSessions: progress.completedSessions + 1,
            scanningSessions: 0,
          }, this.now())
        }
      } catch (error) {
        failed += 1
        failedIds.add(snapshot.header.id)
        reasons.record(snapshot.header.id, error)
        await this.store.updateProjectionProgress({ scanningSessions: 0, failedSessions: failed }, this.now())
      }
    }

    // Final sweep: discover sessions created after the initial enumeration.
    const finalSnapshots = await this.persistence.listSnapshots(this.signal)
    for (const snapshot of finalSnapshots) {
      if (this.aborted) return
      if (failedIds.has(snapshot.header.id)) continue
      const pk = await this.store.getLifecycle(identityFromSnapshot(snapshot))
      if (pk !== undefined) {
        const checkpoint = await this.store.getCheckpoint(pk)
        if (checkpoint.bootstrapComplete) continue
      }
      try {
        await this.scanLifecycle(snapshot, 0, true)
        const progress = await this.store.getProjectionProgress()
        await this.store.updateProjectionProgress({
          discoveredSessions: Math.max(progress.discoveredSessions, finalSnapshots.length),
          completedSessions: progress.completedSessions + 1,
        }, this.now())
      } catch (error) {
        failed += 1
        failedIds.add(snapshot.header.id)
        reasons.record(snapshot.header.id, error)
      }
    }
    reasons.report()

    const progress = await this.store.getProjectionProgress()
    if (failed === 0 && !this.aborted) {
      await this.store.setProjectionReady(this.now())
    } else {
      await this.store.updateProjectionProgress({
        phase: 'degraded',
        failedSessions: failed,
        scanningSessions: 0,
        retryingSessions: 0,
      }, this.now())
    }
  }

  private async runRecovery(
    previousState: 'arming' | 'active',
    previousEpochId: number | undefined,
    currentSnapshots: ReadonlyArray<SessionSnapshotLike>,
    baselines: ReadonlyArray<{ lifecyclePk: number; sourceRevision: string }>,
  ): Promise<void> {
    if (this.aborted) return
    await this.store.updateProjectionProgress({
      phase: 'recovering',
      discoveredSessions: currentSnapshots.length,
      startedAtMs: this.now(),
    }, this.now())

    const previousBaselines = previousState === 'active' && previousEpochId !== undefined ? await this.store.getBaselines(previousEpochId) : []
    const candidates: Array<SessionSnapshotLike> = []
    for (const snapshot of currentSnapshots) {
      if (previousState === 'arming') {
        candidates.push(snapshot)
        continue
      }
      const identity = identityFromSnapshot(snapshot)
      const pk = await this.store.getLifecycle(identity)
      const baseline = previousBaselines.find((entry) => entry.lifecyclePk === pk)
      if (baseline === undefined || baseline.sourceRevision !== String(snapshot.revision)) candidates.push(snapshot)
    }

    let failed = 0
    const reasons = new FailureLog()
    const queue = [...candidates]
    const workers: Promise<void>[] = []
    const runOne = async (): Promise<void> => {
      while (queue.length > 0 && !this.aborted) {
        const snapshot = queue.shift()!
        try {
          const checkpoint = await this.store.getCheckpoint(await this.store.upsertLifecycle(identityFromSnapshot(snapshot)))
          await this.scanLifecycle(snapshot, checkpoint.lastSeq + 1, false)
        } catch (error) {
          failed += 1
          reasons.record(snapshot.header.id, error)
        }
      }
    }
    for (let i = 0; i < Math.min(this.maxRecoveryParallel, Math.max(1, candidates.length)); i += 1) {
      workers.push(runOne())
    }
    await Promise.all(workers)
    reasons.report()

    const progress = await this.store.getProjectionProgress()
    if (failed === 0 && !this.aborted) {
      await this.store.setProjectionReady(this.now())
    } else {
      await this.store.updateProjectionProgress({ phase: 'degraded', failedSessions: failed, scanningSessions: 0 }, this.now())
    }
  }

  private async scanLifecycle(
    snapshot: SessionSnapshotLike,
    fromSeq: number,
    bootstrap: boolean,
  ): Promise<boolean> {
    const identity = identityFromSnapshot(snapshot)
    const lifecyclePk = await this.store.upsertLifecycle(identity)
    let cursor = fromSeq
    let index = 0
    while (!this.aborted) {
      const events = await this.persistence.readFrom(identity.sessionId, cursor, this.signal)
      if (events.length === 0) {
        if (bootstrap) {
          await this.store.projectBatch({
            batchId: this.generation + ':bootstrap:' + identity.sessionId + ':' + cursor,
            hostGeneration: this.generation,
            lifecycle: identity,
            fromSeq: cursor,
            toSeq: cursor - 1,
            deltas: [],
            sourceRevision: String(snapshot.revision),
            bootstrapComplete: true,
          })
        }
        return true
      }
      for (let offset = 0; offset < events.length; offset += this.yieldEvery) {
        if (this.aborted) return false
        const chunk = events.slice(offset, offset + this.yieldEvery)
        const first = chunk[0]!
        const last = chunk[chunk.length - 1]!
        const isLastChunk = offset + chunk.length >= events.length
        await this.store.projectBatch({
          batchId: this.generation + ':scan:' + identity.sessionId + ':' + first.seq + '-' + last.seq,
          hostGeneration: this.generation,
          lifecycle: identity,
          fromSeq: first.seq,
          toSeq: last.seq,
          deltas: normalizeEventDeltas(chunk),
          sourceRevision: isLastChunk && bootstrap ? String(snapshot.revision) : undefined,
          bootstrapComplete: isLastChunk && bootstrap,
        })
        cursor = last.seq + 1
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    return false
  }

}

function identityFromSnapshot(snapshot: SessionSnapshotLike): LifecycleIdentity {
  return {
    sessionId: snapshot.header.id,
    createdAtMs: snapshot.header.createdAt ?? 0,
    cwd: snapshot.header.cwd ?? '',
  }
}

/**
 * Bounded per-session failure report.
 *
 * A scan fails per lifecycle — an unreadable or uninterpretable log is isolated
 * so the remaining sessions still project — but the phase only ever carries a
 * count. Naming a few causes is what makes `degraded` actionable; the bound
 * keeps a wholesale-unreadable corpus from flooding the host log.
 */
const MAX_REPORTED_FAILURES = 5

class FailureLog {
  private readonly entries: Array<{ id: string; reason: string }> = []
  private total = 0

  record(id: string, error: unknown): void {
    this.total += 1
    if (this.entries.length < MAX_REPORTED_FAILURES) {
      this.entries.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  report(): void {
    if (this.total === 0) return
    console.error(`dsh-token-dashboard: ${this.total} session(s) could not be projected; the rest of the history is unaffected`)
    for (const entry of this.entries) console.error(`dsh-token-dashboard:   ${entry.id}: ${entry.reason}`)
    if (this.total > this.entries.length) {
      console.error(`dsh-token-dashboard:   …and ${this.total - this.entries.length} more`)
    }
  }
}
