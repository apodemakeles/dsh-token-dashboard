import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ProjectionBatch, LifecycleIdentity } from './contracts';
import type { SqliteUsageStore } from './sqlite-store';
import type { UsageWorkerClient } from './worker-client';
/** Minimal persistence seam shape sufficient for init/recovery. */
export interface PersistenceLike {
    listSnapshots(signal?: AbortSignal): Promise<Array<{
        header: {
            id: string;
            createdAt?: number;
            cwd?: string;
        };
        revision: unknown;
    }>>;
    readFrom(id: string, fromSeq: number, signal?: AbortSignal): Promise<{
        meta: {
            id: string;
            createdAt?: number;
            cwd?: string;
        };
        events: SessionEvent[];
    }>;
}
export interface CoordinatorStore {
    getLastRunEpoch(): Promise<{
        epochId: number;
        state: 'arming' | 'active' | 'clean';
        startedAtMs: number;
        cleanAtMs: number | null;
    } | null>;
    beginRunEpoch(startedAtMs?: number): Promise<number>;
    activateRunEpoch(epochId: number, baselines: ReadonlyArray<{
        lifecyclePk: number;
        sourceRevision: string;
    }>): Promise<void>;
    upsertLifecycle(identity: LifecycleIdentity, discoveredAtMs?: number): Promise<number>;
    getLifecycle(identity: LifecycleIdentity): Promise<number | undefined>;
    getCheckpoint(lifecyclePk: number): Promise<{
        lifecyclePk: number;
        lastSeq: number;
        routeProvider: string | null;
        routeModel: string | null;
        bootstrapComplete: boolean;
        sourceRevision: string | null;
    }>;
    getProjectionProgress(): Promise<{
        phase: 'initializing' | 'recovering' | 'ready' | 'degraded' | 'rebuild_required' | 'error';
        discoveredSessions: number;
        completedSessions: number;
        scanningSessions: number;
        retryingSessions: number;
        failedSessions: number;
        startedAtMs: number | null;
        completedAtMs: number | null;
        lastErrorCode: string | null;
        lastErrorMessage: string | null;
    }>;
    updateProjectionProgress(update: Record<string, unknown>, now?: number): Promise<void>;
    setProjectionReady(now?: number): Promise<void>;
    getBaselines(epochId: number): Promise<Array<{
        lifecyclePk: number;
        sourceRevision: string;
    }>>;
    projectBatch(batch: ProjectionBatch, now?: number): Promise<unknown>;
}
/** Async adapter for the Worker client: all SQLite operations stay in the Worker. */
export declare class WorkerCoordinatorStore implements CoordinatorStore {
    private readonly client;
    constructor(client: UsageWorkerClient);
    getLastRunEpoch(): Promise<import("./worker-client").RunEpochInfo | null>;
    beginRunEpoch(startedAtMs?: number): Promise<number>;
    activateRunEpoch(epochId: number, baselines: ReadonlyArray<{
        lifecyclePk: number;
        sourceRevision: string;
    }>): Promise<void>;
    upsertLifecycle(identity: LifecycleIdentity, discoveredAtMs?: number): Promise<number>;
    getLifecycle(identity: LifecycleIdentity): Promise<number | undefined>;
    getCheckpoint(lifecyclePk: number): Promise<import("./worker-client").CheckpointInfo>;
    getProjectionProgress(): Promise<import("./worker-client").ProjectionProgress>;
    updateProjectionProgress(update: Record<string, unknown>, now?: number): Promise<void>;
    setProjectionReady(now?: number): Promise<void>;
    getBaselines(epochId: number): Promise<import("./worker-client").BaselineInfo[]>;
    projectBatch(batch: ProjectionBatch, _now?: number): Promise<{
        committed: boolean;
        checkpoint: number;
        commitGeneration: number;
    }>;
}
/** Async adapter so the coordinator can run against either direct SQLite (tests) or the Worker client. */
export declare class SqliteCoordinatorStore implements CoordinatorStore {
    private readonly store;
    constructor(store: SqliteUsageStore);
    getLastRunEpoch(): Promise<import("./sqlite-store").RunEpochInfo | null>;
    beginRunEpoch(startedAtMs?: number): Promise<number>;
    activateRunEpoch(epochId: number, baselines: ReadonlyArray<{
        lifecyclePk: number;
        sourceRevision: string;
    }>): Promise<void>;
    upsertLifecycle(identity: LifecycleIdentity, discoveredAtMs?: number): Promise<number>;
    getLifecycle(identity: LifecycleIdentity): Promise<number | undefined>;
    getCheckpoint(lifecyclePk: number): Promise<import("./sqlite-store").CheckpointRow>;
    getProjectionProgress(): Promise<import("./sqlite-store").ProjectionProgress>;
    updateProjectionProgress(update: Record<string, unknown>, now?: number): Promise<void>;
    setProjectionReady(now?: number): Promise<void>;
    getBaselines(epochId: number): Promise<{
        lifecyclePk: number;
        sourceRevision: string;
    }[]>;
    projectBatch(batch: ProjectionBatch, now?: number): Promise<{
        committed: boolean;
        checkpoint: number;
        commitGeneration: number;
    }>;
}
export interface InitRecoveryOptions {
    readonly store: CoordinatorStore;
    readonly persistence: PersistenceLike;
    readonly generation: string;
    readonly now?: () => number;
    readonly yieldEvery?: number;
    /**
     * Interval between completeness re-checks while the host stays up; the
     * re-check heals source growth or live-path losses without a restart.
     * 0 disables the periodic re-check.
     */
    readonly rescanIntervalMs?: number;
    readonly signal?: AbortSignal;
}
export declare class InitRecoveryCoordinator {
    private readonly store;
    private readonly persistence;
    private readonly generation;
    private readonly now;
    private readonly yieldEvery;
    private readonly rescanIntervalMs;
    private readonly signal?;
    private aborted;
    private armed;
    private scanning;
    private rescanTimer;
    private snapshots;
    constructor(options: InitRecoveryOptions);
    get isAborted(): boolean;
    /** Start the coordinator: arm run, activate with baseline, then run scan. */
    start(): Promise<void>;
    /** Arm the run epoch and activate with a revision baseline; no scan yet. */
    arm(): Promise<void>;
    /**
     * Run the completeness pass over the arm-time snapshots and schedule the
     * periodic re-check. The pass runs on every startup regardless of the
     * previous epoch state: a run may be marked clean while scans are
     * incomplete, and the next startup must continue from the incomplete
     * lifecycles.
     */
    scan(): Promise<void>;
    /** Abort background scan/recovery; committed work is preserved. */
    abort(): void;
    /** Schedule the next periodic completeness re-check while the host stays up. */
    private armRescan;
    /** Re-list the session logs and re-run the completeness pass on a timer. */
    private periodicRescan;
    /**
     * The completeness pass: per current session log, verify the stored
     * checkpoint already covers the file's current revision (one comparison,
     * no log read) or (re)scan from the stored checkpoint to the durable tail
     * and record the caught-up revision. One failing session never blocks the
     * rest; a failure leaves the lifecycle incomplete so a later pass retries
     * it. An abort is not a failure: committed checkpoints are preserved and
     * the next pass resumes from them.
     */
    private runCompletenessScan;
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
    private scanLifecycle;
}
//# sourceMappingURL=init-recovery.d.ts.map