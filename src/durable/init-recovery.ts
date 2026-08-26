// InitRecoveryCoordinator — background initialization and crash-tail recovery.
//
// It uses only the DSH persistence seam (listSnapshots/readFrom) plus the
// Worker client. It never touches physical JSONL/Zstd paths and never runs
// on the panel request path.
//
// Completeness contract: on every startup (regardless of how the previous
// run ended) and on a periodic re-check while the host stays up, each current
// session log is verified to be projected up to its current source revision.
// A session whose stored revision matches its file bytes is verified with one
// comparison and skipped; anything else — missing checkpoint, incomplete
// bootstrap, or a file that grew — is (re)scanned from its stored checkpoint
// to the durable tail. A run may be marked clean while scans are incomplete
// (drain budget or kill), and the next pass continues from the incomplete
// lifecycles; nothing is ever re-scanned from 0 unless the store says so.

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionBatch, LifecycleIdentity } from './contracts'
import { normalizeEventDeltas } from './projector'
import type { SqliteUsageStore } from './sqlite-store'
import type { UsageWorkerClient } from './worker-client'

/** Minimal persistence seam shape sufficient for init/recovery. */
export interface PersistenceLike {
  listSnapshots(signal?: AbortSignal): Promise<Array<{ header: { id: string; createdAt?: number; cwd?: string }; revision: unknown }>>
  readFrom(id: string, fromSeq: number, signal?: AbortSignal): Promise<{ meta: { id: string; createdAt?: number; cwd?: string }; events: SessionEvent[] }>
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

type Snapshot = { header: { id: string; createdAt?: number; cwd?: string }; revision: unknown }

export interface InitRecoveryOptions {
  readonly store: CoordinatorStore
  readonly persistence: PersistenceLike
  readonly generation: string
  readonly now?: () => number
  readonly yieldEvery?: number
  /**
   * Interval between completeness re-checks while the host stays up; the
   * re-check heals source growth or live-path losses without a restart.
   * 0 disables the periodic re-check.
   */
  readonly rescanIntervalMs?: number
  readonly signal?: AbortSignal
}

const DEFAULT_YIELD_EVERY = 500
const DEFAULT_RESCAN_INTERVAL_MS = 600_000

export class InitRecoveryCoordinator {
  private readonly store: CoordinatorStore
  private readonly persistence: PersistenceLike
  private readonly generation: string
  private readonly now: () => number
  private readonly yieldEvery: number
  private readonly rescanIntervalMs: number
  private readonly signal?: AbortSignal
  private aborted = false
  private armed = false
  private scanning = false
  private rescanTimer: ReturnType<typeof setTimeout> | undefined
  private snapshots: Snapshot[] = []

  constructor(options: InitRecoveryOptions) {
    this.store = options.store
    this.persistence = options.persistence
    this.generation = options.generation
    this.now = options.now ?? Date.now
    this.yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY
    this.rescanIntervalMs = options.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS
    this.signal = options.signal
  }

  get isAborted(): boolean {
    return this.aborted
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

  /**
   * Run the completeness pass over the arm-time snapshots and schedule the
   * periodic re-check. The pass runs on every startup regardless of the
   * previous epoch state: a run may be marked clean while scans are
   * incomplete, and the next startup must continue from the incomplete
   * lifecycles.
   */
  async scan(): Promise<void> {
    if (!this.armed) throw new Error('coordinator not armed')
    if (this.aborted || this.signal?.aborted) return
    const progress = await this.store.getProjectionProgress()
    await this.runCompletenessScan(progress.phase === 'initializing', this.snapshots)
    this.armRescan()
  }

  /** Abort background scan/recovery; committed work is preserved. */
  abort(): void {
    this.aborted = true
    if (this.rescanTimer !== undefined) {
      clearTimeout(this.rescanTimer)
      this.rescanTimer = undefined
    }
  }

  /** Schedule the next periodic completeness re-check while the host stays up. */
  private armRescan(): void {
    if (this.aborted || this.rescanIntervalMs <= 0 || this.rescanTimer !== undefined) return
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined
      if (this.aborted) return
      void this.periodicRescan()
    }, this.rescanIntervalMs)
    // The re-check must not keep the host process alive at shutdown.
    const timer = this.rescanTimer as { unref?: () => void }
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** Re-list the session logs and re-run the completeness pass on a timer. */
  private async periodicRescan(): Promise<void> {
    if (this.aborted) return
    try {
      const snapshots = await this.persistence.listSnapshots(this.signal)
      await this.runCompletenessScan(false, snapshots)
    } catch (error) {
      // The next startup re-runs the pass; record the failure where the
      // snapshot route surfaces it.
      await this.store.updateProjectionProgress({
        lastErrorCode: 'rescan_failed',
        lastErrorMessage: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
    } finally {
      this.armRescan()
    }
  }

  /**
   * The completeness pass: per current session log, verify the stored
   * checkpoint already covers the file's current revision (one comparison,
   * no log read) or (re)scan from the stored checkpoint to the durable tail
   * and record the caught-up revision. One failing session never blocks the
   * rest; a failure leaves the lifecycle incomplete so a later pass retries
   * it. An abort is not a failure: committed checkpoints are preserved and
   * the next pass resumes from them.
   */
  private async runCompletenessScan(firstRun: boolean, snapshots: ReadonlyArray<Snapshot>): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      await this.store.updateProjectionProgress({
        ...(firstRun ? { phase: 'initializing' as const } : {}),
        discoveredSessions: snapshots.length,
        startedAtMs: this.now(),
        completedSessions: 0,
        failedSessions: 0,
        scanningSessions: 0,
        retryingSessions: 0,
      }, this.now())

      let verified = 0
      let failed = 0
      let enteredRecovering = false
      const beginRecovery = (): Promise<void> => {
        if (enteredRecovering || firstRun) return Promise.resolve()
        enteredRecovering = true
        return this.store.updateProjectionProgress({ phase: 'recovering', scanningSessions: 1 }, this.now())
      }

      const scanOne = async (snapshot: Snapshot): Promise<boolean> => {
        const identity = identityFromSnapshot(snapshot)
        const lifecyclePk = await this.store.upsertLifecycle(identity)
        const checkpoint = await this.store.getCheckpoint(lifecyclePk)
        const revision = String(snapshot.revision)
        if (checkpoint.sourceRevision === revision && (checkpoint.lastSeq >= 0 || checkpoint.bootstrapComplete)) {
          return true // file byte-identical to the one last scanned to its tail
        }
        await beginRecovery()
        return await this.scanLifecycle(snapshot, checkpoint.lastSeq + 1)
      }

      for (let index = 0; index < snapshots.length; index += 1) {
        if (this.aborted) break
        const snapshot = snapshots[index]!
        try {
          if (await scanOne(snapshot)) {
            verified += 1
          } else if (!this.aborted) {
            failed += 1
          }
        } catch (error) {
          if (this.aborted) break
          failed += 1
          await this.store.updateProjectionProgress({
            lastErrorCode: 'scan_failed',
            lastErrorMessage: error instanceof Error ? error.message : String(error),
          }, this.now())
        }
        if (index % 10 === 9 || index === snapshots.length - 1) {
          await this.store.updateProjectionProgress({
            completedSessions: verified,
            failedSessions: failed,
            scanningSessions: this.aborted ? 0 : 1,
          }, this.now())
        }
      }

      // Final sweep: discover session logs created after the arm-time enumeration.
      if (!this.aborted) {
        const finalSnapshots = await this.persistence.listSnapshots(this.signal)
        const known = new Set(snapshots.map((snapshot) => snapshot.header.id))
        let grown = false
        for (const snapshot of finalSnapshots) {
          if (this.aborted) break
          if (known.has(snapshot.header.id)) continue
          known.add(snapshot.header.id)
          grown = true
          try {
            if (await scanOne(snapshot)) {
              verified += 1
            } else {
              failed += 1
            }
          } catch {
            failed += 1
          }
        }
        if (grown) {
          await this.store.updateProjectionProgress({
            discoveredSessions: Math.max(snapshots.length, finalSnapshots.length),
          }, this.now())
        }
      }

      await this.store.updateProjectionProgress({
        completedSessions: verified,
        failedSessions: failed,
        scanningSessions: 0,
      }, this.now())
      if (failed === 0 && !this.aborted) {
        await this.store.setProjectionReady(this.now())
      } else if (!this.aborted) {
        await this.store.updateProjectionProgress({ phase: 'degraded' }, this.now())
      }
    } finally {
      this.scanning = false
    }
  }

  /**
   * Project one session log from 'fromSeq' to its current durable tail and
   * record the snapshot's source revision as caught up on the final batch.
   *
   * One readFrom returns every stored event at/after fromSeq, so the pass
   * reads each session log once per scan and yields between projected
   * chunks; the file is never re-read per chunk.
   *
   * An empty tail is a legitimate caught-up state: a finished session has no
   * more bytes, and a still-live session's revision changes as it grows, so
   * the next pass re-enters from the checkpoint and picks up the new tail.
   * The empty-tail marker is a no-op projection (toSeq < fromSeq) that only
   * updates the checkpoint's caught-up revision; the store keeps any
   * concurrently advanced checkpoint and never regresses it.
   */
  private async scanLifecycle(snapshot: Snapshot, fromSeq: number): Promise<boolean> {
    const identity = identityFromSnapshot(snapshot)
    const revision = String(snapshot.revision)
    const read = await this.persistence.readFrom(identity.sessionId, fromSeq, this.signal)
    if (read.events.length === 0) {
      await this.store.projectBatch({
        batchId: this.generation + ':tail:' + identity.sessionId + ':' + fromSeq,
        hostGeneration: this.generation,
        lifecycle: identity,
        fromSeq: fromSeq,
        toSeq: fromSeq - 1,
        deltas: [],
        sourceRevision: revision,
        bootstrapComplete: true,
      })
      return true
    }
    for (let offset = 0; offset < read.events.length; offset += this.yieldEvery) {
      if (this.aborted) return false
      const chunk = read.events.slice(offset, offset + this.yieldEvery)
      const first = chunk[0]!
      const last = chunk[chunk.length - 1]!
      const isLastChunk = offset + chunk.length >= read.events.length
      await this.store.projectBatch({
        batchId: this.generation + ':scan:' + identity.sessionId + ':' + first.seq + '-' + last.seq,
        hostGeneration: this.generation,
        lifecycle: identity,
        fromSeq: first.seq,
        toSeq: last.seq,
        deltas: normalizeEventDeltas(chunk),
        ...(isLastChunk ? { sourceRevision: revision, bootstrapComplete: true } : {}),
      })
      await new Promise((resolve) => setImmediate(resolve))
    }
    return !this.aborted
  }
}

function identityFromSnapshot(snapshot: Snapshot): LifecycleIdentity {
  return {
    sessionId: snapshot.header.id,
    createdAtMs: snapshot.header.createdAt ?? 0,
    cwd: snapshot.header.cwd ?? '',
  }
}
