import { type GenerationInfo, type LifecycleIdentity, type ProjectionBatch, type SnapshotQuery, type SnapshotV1 } from './contracts';
/** Minimal Worker-like surface used by tests. */
export interface WorkerLike {
    postMessage(value: unknown): void;
    on(event: 'message' | 'error' | 'exit', listener: (...args: any[]) => void): unknown;
    terminate(): Promise<unknown>;
}
export interface WorkerClientOptions {
    readonly generation: string;
    readonly dbPath: string;
    readonly workerFactory?: () => WorkerLike;
    readonly restartDelaysMs?: readonly number[];
}
export interface RunEpochInfo {
    epochId: number;
    state: 'arming' | 'active' | 'clean';
    startedAtMs: number;
    cleanAtMs: number | null;
}
export interface ProjectionProgress {
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
}
export interface CheckpointInfo {
    lifecyclePk: number;
    lastSeq: number;
    routeProvider: string | null;
    routeModel: string | null;
    bootstrapComplete: boolean;
    sourceRevision: string | null;
}
export interface BaselineInfo {
    lifecyclePk: number;
    sourceRevision: string;
}
export declare class UsageWorkerClient {
    private readonly generation;
    private readonly dbPath;
    private readonly workerFactory;
    private readonly restartDelaysMs;
    private worker;
    private readonly pending;
    private readonly unacked;
    private startPromise;
    private circuitOpen;
    private intentionalExit;
    private restartCount;
    private requestCounter;
    constructor(options: WorkerClientOptions);
    get pendingBatchCount(): number;
    get isCircuitOpen(): boolean;
    /** Start (or restart) the Worker and wait for init ack. */
    start(): Promise<void>;
    private spawnAndInit;
    /** Send a projection batch and await commit ack. */
    project(batch: ProjectionBatch): Promise<{
        committed: boolean;
        checkpoint: number;
        commitGeneration: number;
    }>;
    /** Query a consistent snapshot. */
    snapshot(query: SnapshotQuery): Promise<SnapshotV1>;
    /** Current store generations, used to key the snapshot cache without running a query. */
    getGeneration(): Promise<GenerationInfo>;
    /** Barrier: all previously sent commands have committed. */
    drain(): Promise<GenerationInfo>;
    beginRunEpoch(startedAtMs?: number): Promise<number>;
    activateRunEpoch(epochId: number, baselines: ReadonlyArray<{
        lifecyclePk: number;
        sourceRevision: string;
    }>): Promise<void>;
    markRunClean(epochId: number, cleanAtMs?: number): Promise<void>;
    getLastRunEpoch(): Promise<RunEpochInfo | null>;
    upsertLifecycle(lifecycle: LifecycleIdentity, discoveredAtMs?: number): Promise<number>;
    getLifecycle(lifecycle: LifecycleIdentity): Promise<number | null>;
    getCheckpoint(lifecyclePk: number): Promise<CheckpointInfo>;
    getProjectionProgress(): Promise<ProjectionProgress>;
    updateProjectionProgress(update: Record<string, unknown>, now?: number): Promise<void>;
    setProjectionReady(now?: number): Promise<void>;
    getBaselines(epochId: number): Promise<BaselineInfo[]>;
    /** Stop admission, flush commands, close DB and terminate the Worker. */
    shutdown(): Promise<void>;
    private attach;
    private onMessage;
    private onUnexpectedExit;
    private request;
    private nextRequestId;
}
export declare class WorkerRpcError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    constructor(code: string, message: string, retryable: boolean);
}
//# sourceMappingURL=worker-client.d.ts.map