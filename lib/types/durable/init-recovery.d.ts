import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ProjectionBatch, LifecycleIdentity } from './contracts';
import type { SqliteUsageStore } from './sqlite-store';
import type { UsageCollector } from './collector';
import type { UsageWorkerClient } from './worker-client';
/** One stored-session observation: the header identity plus an opaque change token. */
export interface SessionSnapshotLike {
    readonly header: {
        id: string;
        createdAt?: number;
        cwd?: string;
    };
    readonly revision: unknown;
}
/** A read handle from the handle-based persistence generation. */
export interface ReadHandleLike {
    readonly header: {
        id: string;
        createdAt?: number;
        cwd?: string;
    };
    read(offset?: number, length?: number, options?: {
        signal?: AbortSignal;
    }): Promise<{
        events: SessionEvent[];
    }>;
    close(): Promise<void>;
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
    list?(options?: {
        signal?: AbortSignal;
    }): Promise<ReadonlyArray<SessionSnapshotLike>>;
    open?(id: string, access: 'read', options?: {
        signal?: AbortSignal;
    }): Promise<ReadHandleLike>;
    listSnapshots?(signal?: AbortSignal): Promise<ReadonlyArray<SessionSnapshotLike>>;
    readFrom?(id: string, fromSeq: number, signal?: AbortSignal): Promise<{
        meta: {
            id: string;
            createdAt?: number;
            cwd?: string;
        };
        events: SessionEvent[];
    }>;
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
export declare class PersistenceSeam {
    private readonly persistence;
    private readonly resolved;
    constructor(persistence: PersistenceLike);
    /** Which service generation is mounted; surfaced in startup diagnostics. */
    get generation(): 'handle' | 'snapshot' | 'unsupported';
    /** Every stored session visible to this process, in either generation's shape. */
    listSnapshots(signal?: AbortSignal): Promise<ReadonlyArray<SessionSnapshotLike>>;
    /** Stored events from seq `fromSeq` on; an empty array means the log ends there. */
    readFrom(id: string, fromSeq: number, signal?: AbortSignal): Promise<SessionEvent[]>;
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
    readonly collector: UsageCollector;
    readonly worker: UsageWorkerClient;
    readonly generation: string;
    readonly now?: () => number;
    readonly yieldEvery?: number;
    readonly maxRecoveryParallel?: number;
    readonly signal?: AbortSignal;
}
export declare class InitRecoveryCoordinator {
    private readonly store;
    private readonly persistence;
    private readonly collector;
    private readonly worker;
    private readonly generation;
    private readonly now;
    private readonly yieldEvery;
    private readonly maxRecoveryParallel;
    private readonly signal?;
    private aborted;
    private started;
    private armed;
    private snapshots;
    private previousState;
    private previousEpochId;
    constructor(options: InitRecoveryOptions);
    get isAborted(): boolean;
    /** Start the coordinator: arm run, activate with baseline, then run scan. */
    start(): Promise<void>;
    /** Arm the run epoch and activate with a revision baseline; no scan yet. */
    arm(): Promise<void>;
    /** Run initialization/recovery/ready transition after arm(). */
    scan(): Promise<void>;
    /** Abort background scan/recovery; committed work is preserved. */
    abort(): void;
    private runInitialization;
    private runRecovery;
    private scanLifecycle;
}
//# sourceMappingURL=init-recovery.d.ts.map