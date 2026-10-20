import type { TokenUsageLike } from '../core/types';
/** Stable schema version stored in `PRAGMA user_version`. */
export declare const SCHEMA_VERSION = 1;
/** Semantic version of the JSONL -> usage_fact projection. */
export declare const PROJECTION_VERSION = 1;
/** Snapshot payload contract version. */
export declare const SNAPSHOT_CONTRACT_VERSION = 1;
/** Cross-thread RPC protocol version. */
export declare const PROTOCOL_VERSION = 1;
/** SQLite application id — ASCII "DTOK". */
export declare const DB_APPLICATION_ID = 1146376011;
/** Host-side related-delta soft threshold. */
export declare const SOFT_DELTA_THRESHOLD = 4096;
/** Host-side related-delta hard threshold. */
export declare const HARD_DELTA_THRESHOLD = 16384;
/** Maximum number of host pending/unacked related deltas we intentionally retain. */
export declare const MAX_OVERFLOW_LIFECYCLES = 1024;
/** Worker batch coalescing window. */
export declare const WORKER_BATCH_WAIT_MS = 250;
/** Worker batch fact-update count before forced commit. */
export declare const WORKER_BATCH_FACT_LIMIT = 128;
/** Host batch triggers. */
export declare const HOST_BATCH_IDLE_MS = 250;
export declare const HOST_BATCH_MAX_AGE_MS = 1000;
export declare const HOST_BATCH_DELTA_LIMIT = 64;
/** HTTP snapshot budget. */
export declare const SNAPSHOT_TIMEOUT_MS = 5000;
/** Normal shutdown drain budget. */
export declare const DRAIN_TIMEOUT_MS = 4000;
/** Projection phases surfaced to the browser. */
export type ProjectionPhase = 'initializing' | 'recovering' | 'ready' | 'degraded';
/** Internal phases stored in SQLite (superset of the browser-facing phase). */
export type StoredProjectionPhase = 'initializing' | 'recovering' | 'ready' | 'degraded' | 'rebuild_required' | 'error';
/** One DSH session lifecycle identity. */
export interface LifecycleIdentity {
    readonly sessionId: string;
    readonly createdAtMs: number;
    readonly cwd: string;
}
/** Minimal route/usage delta sent from host to Worker. Never carries message bodies. */
export type UsageDelta = {
    readonly kind: 'route';
    readonly seq: number;
    readonly time: number;
    readonly provider?: string;
    readonly model?: string;
} | {
    readonly kind: 'usage';
    readonly seq: number;
    readonly time: number;
    readonly turn: number;
    readonly step: number;
    readonly usage: TokenUsageLike;
    /** Whether this is the final assistant/message observation for the step. */
    readonly final: boolean;
};
/** A source-confirmed, contiguous projection batch. */
export interface ProjectionBatch {
    readonly batchId: string;
    readonly hostGeneration: string;
    readonly lifecycle: LifecycleIdentity;
    readonly fromSeq: number;
    readonly toSeq: number;
    readonly deltas: readonly UsageDelta[];
    /** Optional source revision captured at host flush time. */
    readonly sourceRevision?: string;
    /** Marks the last batch of an initialization scan for this lifecycle. */
    readonly bootstrapComplete?: boolean;
}
/** One persisted ingestion warning (bounded, no event body). */
export interface IngestionErrorRecord {
    readonly sourceSeq: number;
    readonly eventType?: string;
    readonly reasonCode: string;
    readonly detail: string;
    readonly firstSeenAtMs: number;
}
/** One committed usage fact in pure projector state. */
export interface ProjectedFact {
    readonly turn: number;
    readonly step: number;
    readonly sourceSeq: number;
    readonly occurredAtMs: number;
    readonly provider?: string;
    readonly model?: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
}
/** Pure per-lifecycle projection state (used by projector and tests). */
export interface ProjectionState {
    readonly checkpoint: number;
    readonly routeProvider?: string;
    readonly routeModel?: string;
    readonly facts: ReadonlyMap<string, ProjectedFact>;
    readonly errors: ReadonlyMap<number, IngestionErrorRecord>;
}
/** Store generations that invalidate every cached snapshot when either advances. */
export interface GenerationInfo {
    readonly commitGeneration: number;
    readonly stateGeneration: number;
}
/** Stable cross-thread command names. */
export type WorkerCommandType = 'init' | 'project' | 'snapshot' | 'drain' | 'get_generation' | 'shutdown' | 'begin_run' | 'activate_run' | 'mark_run_clean' | 'get_last_run' | 'upsert_lifecycle' | 'get_lifecycle' | 'get_checkpoint' | 'get_projection_progress' | 'update_projection_progress' | 'set_projection_ready' | 'get_baselines';
export interface SnapshotQuery {
    readonly weeks: number;
    readonly offsetWeeks: number;
}
export interface WorkerInitRequest {
    readonly type: 'init';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly dbPath: string;
    readonly protocolVersion: number;
}
export interface WorkerProjectRequest {
    readonly type: 'project';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
    readonly batch: ProjectionBatch;
}
export interface WorkerSnapshotRequest {
    readonly type: 'snapshot';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
    readonly query: SnapshotQuery;
    readonly pendingBatches: number;
}
export interface WorkerDrainRequest {
    readonly type: 'drain';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
}
export interface WorkerGetGenerationRequest {
    readonly type: 'get_generation';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
}
export interface WorkerShutdownRequest {
    readonly type: 'shutdown';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
}
export interface WorkerBeginRunRequest {
    readonly type: 'begin_run';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
    readonly startedAtMs: number;
}
export interface WorkerActivateRunRequest {
    readonly type: 'activate_run';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
    readonly epochId: number;
    readonly baselines: ReadonlyArray<{
        lifecyclePk: number;
        sourceRevision: string;
    }>;
}
export interface WorkerMarkRunCleanRequest {
    readonly type: 'mark_run_clean';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
    readonly epochId: number;
    readonly cleanAtMs: number;
}
export interface WorkerGetLastRunRequest {
    readonly type: 'get_last_run';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
}
export interface WorkerUpsertLifecycleRequest {
    readonly type: 'upsert_lifecycle';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
    readonly lifecycle: LifecycleIdentity;
    readonly discoveredAtMs: number;
}
export interface WorkerGetLifecycleRequest {
    readonly type: 'get_lifecycle';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
    readonly lifecycle: LifecycleIdentity;
}
export interface WorkerGetCheckpointRequest {
    readonly type: 'get_checkpoint';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
    readonly lifecyclePk: number;
}
export interface WorkerGetProjectionProgressRequest {
    readonly type: 'get_projection_progress';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
}
export interface WorkerUpdateProjectionProgressRequest {
    readonly type: 'update_projection_progress';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
    readonly update: Record<string, unknown>;
    readonly now: number;
}
export interface WorkerSetProjectionReadyRequest {
    readonly type: 'set_projection_ready';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
    readonly now: number;
}
export interface WorkerGetBaselinesRequest {
    readonly type: 'get_baselines';
    readonly requestId: string;
    readonly hostGeneration: string;
    readonly protocolVersion: number;
    readonly epochId: number;
}
export type WorkerCommand = WorkerInitRequest | WorkerProjectRequest | WorkerSnapshotRequest | WorkerDrainRequest | WorkerGetGenerationRequest | WorkerShutdownRequest | WorkerBeginRunRequest | WorkerActivateRunRequest | WorkerMarkRunCleanRequest | WorkerGetLastRunRequest | WorkerUpsertLifecycleRequest | WorkerGetLifecycleRequest | WorkerGetCheckpointRequest | WorkerGetProjectionProgressRequest | WorkerUpdateProjectionProgressRequest | WorkerSetProjectionReadyRequest | WorkerGetBaselinesRequest;
export type WorkerResult = {
    readonly ok: true;
    readonly requestId: string;
    readonly value: unknown;
} | {
    readonly ok: false;
    readonly requestId: string;
    readonly error: WorkerError;
};
export interface WorkerError {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
}
/** Model bucket used by the snapshot payload. */
export interface ModelBucket {
    readonly provider: string;
    readonly model: string;
    readonly tokens: number;
}
/** One day bucket in the snapshot payload. */
export interface SnapshotDay {
    readonly date: string;
    readonly totalTokens: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly requests: number;
    readonly byModel: ModelBucket[];
    readonly otherModelCount: number;
    readonly otherModelTokens: number;
}
/** Single consistent snapshot payload (contract v1). */
export interface SnapshotV1 {
    readonly contractVersion: 1;
    readonly asOf: {
        readonly committedAtMs: number;
        readonly commitGeneration: number;
        readonly stateGeneration: number;
    };
    readonly query: {
        readonly weeks: number;
        readonly offsetWeeks: number;
        readonly timezone: 'local';
        readonly fromDate: string;
        readonly toDate: string;
    };
    readonly projection: {
        readonly phase: ProjectionPhase;
        readonly complete: boolean;
        readonly pendingBatches: number;
        readonly progress: {
            readonly discoveredSessions: number;
            readonly completedSessions: number;
            readonly scanningSessions: number;
            readonly retryingSessions: number;
            readonly failedSessions: number;
            readonly startedAtMs: number | null;
            readonly completedAtMs: number | null;
        };
    };
    readonly summary: {
        readonly today: number;
        readonly week: number;
        readonly month30: number;
        readonly all: number;
        readonly cacheReadAll: number;
        readonly sessionCount: number;
    };
    readonly days: SnapshotDay[];
    readonly byModel: {
        readonly items: ModelBucket[];
        readonly otherModelCount: number;
        readonly otherModelTokens: number;
    };
    readonly warnings: {
        readonly count: number;
        readonly byCode: Array<{
            readonly code: string;
            readonly count: number;
        }>;
    };
}
/** Stable error codes returned to HTTP/browser. */
export declare const ErrorCodes: {
    readonly BadQuery: "bad_query";
    readonly DatabaseTooNew: "database_too_new";
    readonly ForeignDatabase: "foreign_database";
    readonly DatabaseInUse: "database_in_use";
    readonly CorruptDatabase: "corrupt_database";
    readonly RebuildRequired: "rebuild_required";
    readonly MaintenanceRequired: "maintenance_required";
    readonly WorkerUnavailable: "worker_unavailable";
    readonly SnapshotTimeout: "snapshot_timeout";
    readonly NumericOverflow: "numeric_overflow";
    readonly Internal: "internal";
};
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
/** Stable deterministic ingestion warning codes. */
export declare const IngestionCodes: {
    readonly MissingTurnStep: "missing_turn_step";
    readonly BadTokenValue: "bad_token_value";
    readonly UnsafeInteger: "unsafe_integer";
};
export type IngestionCode = (typeof IngestionCodes)[keyof typeof IngestionCodes];
//# sourceMappingURL=contracts.d.ts.map