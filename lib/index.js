import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
/** HTTP snapshot budget. */
const SNAPSHOT_TIMEOUT_MS = 5e3;
/** Normal shutdown drain budget. */
const DRAIN_TIMEOUT_MS = 4e3;
/** Stable error codes returned to HTTP/browser. */
const ErrorCodes = {
	BadQuery: "bad_query",
	DatabaseTooNew: "database_too_new",
	ForeignDatabase: "foreign_database",
	DatabaseInUse: "database_in_use",
	CorruptDatabase: "corrupt_database",
	RebuildRequired: "rebuild_required",
	MaintenanceRequired: "maintenance_required",
	WorkerUnavailable: "worker_unavailable",
	SnapshotTimeout: "snapshot_timeout",
	NumericOverflow: "numeric_overflow",
	Internal: "internal"
};
//#endregion
//#region src/durable/diag.ts
const MAX_BYTES = 256 * 1024;
let diagPath;
function resolvePath() {
	if (diagPath === void 0) diagPath = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "data", "token-dashboard", "live-diag.log");
	return diagPath;
}
/**
* Append one diagnostic line with an ISO timestamp. Failures are swallowed.
* The file self-truncates (keep the newest half) once it passes the cap.
*/
function diag(scope, message, detail) {
	try {
		const path = resolvePath();
		let suffix = "";
		if (detail !== void 0) suffix = " " + String(detail instanceof Error ? detail.stack ?? detail.message : JSON.stringify(detail)).slice(0, 600);
		appendFileSync(path, `${(/* @__PURE__ */ new Date()).toISOString()} [${scope}] ${message}${suffix}\n`);
		try {
			if (statSync(path).size > MAX_BYTES) truncateSync(path, 0);
		} catch {}
	} catch {}
}
//#endregion
//#region src/durable/projector.ts
/** Extract one minimal delta from a committed SessionEvent, or null. */
function normalizeEventDelta(event) {
	if (event.type === "request/header") {
		const config = event.data.header.config;
		return {
			kind: "route",
			seq: event.seq,
			time: event.time,
			...typeof config.provider === "string" && config.provider.length > 0 ? { provider: config.provider.slice(0, 256) } : {},
			...typeof config.model === "string" && config.model.length > 0 ? { model: config.model.slice(0, 256) } : {}
		};
	}
	if (event.type === "request/context") return {
		kind: "route",
		seq: event.seq,
		time: event.time,
		...typeof event.data.provider === "string" && event.data.provider.length > 0 ? { provider: event.data.provider.slice(0, 256) } : {},
		...typeof event.data.model === "string" && event.data.model.length > 0 ? { model: event.data.model.slice(0, 256) } : {}
	};
	if (event.type === "assistant/message") {
		if (event.data.usage === void 0) return null;
		return {
			kind: "usage",
			seq: event.seq,
			time: event.time,
			turn: event.data.turn,
			step: event.data.step,
			usage: event.data.usage,
			final: true
		};
	}
	if (event.type === "assistant/chunk") {
		const chunk = event.data.chunk;
		if (chunk.type !== "usage") return null;
		return {
			kind: "usage",
			seq: event.seq,
			time: event.time,
			turn: event.data.turn,
			step: event.data.step,
			usage: chunk.usage,
			final: false
		};
	}
	return null;
}
/** Normalize a whole contiguous event array into minimal deltas (test helper). */
function normalizeEventDeltas(events) {
	const out = [];
	for (const event of events) {
		const delta = normalizeEventDelta(event);
		if (delta !== null) out.push(delta);
	}
	return out;
}
//#endregion
//#region src/durable/collector.ts
const DEFAULT_FLUSH_RETRY_DELAYS_MS = [
	100,
	1e3,
	5e3
];
const FLUSH_COOLDOWN_MS = 3e4;
var UsageCollector = class {
	generation;
	flushService;
	worker;
	now;
	setTimeoutFn;
	clearTimeoutFn;
	flushRetryDelaysMs;
	flushCooldownMs;
	pipelines = /* @__PURE__ */ new Map();
	accepting = false;
	constructor(options) {
		this.generation = options.generation;
		this.flushService = options.flush;
		this.worker = options.worker;
		this.now = options.now ?? Date.now;
		this.setTimeoutFn = options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
		this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
		this.flushRetryDelaysMs = options.flushRetryDelaysMs ?? DEFAULT_FLUSH_RETRY_DELAYS_MS;
		this.flushCooldownMs = options.flushCooldownMs ?? FLUSH_COOLDOWN_MS;
	}
	start() {
		this.accepting = true;
		diag("collector", "start: accepting live events");
	}
	stop() {
		this.accepting = false;
	}
	get isAccepting() {
		return this.accepting;
	}
	/** Number of lifecycles currently flagged resync/degraded. */
	get resyncLifecycleCount() {
		let count = 0;
		for (const pipeline of this.pipelines.values()) if (pipeline.resyncRequired || pipeline.overflowed) count += 1;
		return count;
	}
	/** Synchronous event admission: normalize + enqueue, never I/O. */
	onEvent(session, event) {
		if (!this.accepting) return;
		const lifecycle = lifecycleOf(session);
		const key = lifecycleKey(lifecycle);
		let pipeline = this.pipelines.get(key);
		if (pipeline === void 0) {
			pipeline = {
				lifecycle,
				session,
				expectedSeq: 0,
				openBatch: null,
				chain: Promise.resolve(),
				pendingDeltaCount: 0,
				overflowed: false,
				resyncRequired: false
			};
			this.pipelines.set(key, pipeline);
		}
		this.enqueue(pipeline, event);
	}
	/** Explicitly close one lifecycle's open batch and flush it (used by drain/init). */
	flushLifecycle(session) {
		const pipeline = this.pipelines.get(lifecycleKey(lifecycleOf(session)));
		if (pipeline === void 0) return Promise.resolve();
		this.closeBatch(pipeline);
		return pipeline.chain;
	}
	/** Close all open batches and wait for every per-session chain. */
	async drain() {
		for (const pipeline of this.pipelines.values()) this.closeBatch(pipeline);
		await Promise.all([...this.pipelines.values()].map((pipeline) => pipeline.chain));
	}
	enqueue(pipeline, event) {
		if (pipeline.expectedSeq === 0 && event.seq > 0) {
			pipeline.expectedSeq = event.seq;
			diag("collector", `pipeline ${pipeline.lifecycle.sessionId} baselined at seq ${event.seq} (mid-log attach)`);
		}
		if (event.seq < pipeline.expectedSeq) return;
		if (event.seq > pipeline.expectedSeq) {
			pipeline.resyncRequired = true;
			diag("collector", `pipeline ${pipeline.lifecycle.sessionId} gap: got seq ${event.seq}, expected ${pipeline.expectedSeq}; dropping to resync`);
			pipeline.expectedSeq = event.seq + 1;
			return;
		}
		pipeline.expectedSeq = event.seq + 1;
		if (pipeline.overflowed) {
			pipeline.resyncRequired = true;
			return;
		}
		const now = this.now();
		if (pipeline.openBatch === null) pipeline.openBatch = {
			fromSeq: event.seq,
			toSeq: event.seq,
			openedAt: now,
			lastActivity: now,
			deltas: []
		};
		else {
			pipeline.openBatch.toSeq = event.seq;
			pipeline.openBatch.lastActivity = now;
		}
		const delta = normalizeEventDelta(event);
		if (delta !== null) {
			pipeline.openBatch.deltas.push(delta);
			pipeline.pendingDeltaCount += 1;
		}
		const isFinalUsage = delta !== null && delta.kind === "usage" && delta.final;
		const isTurnEnd = event.type === "turn/end";
		if (isFinalUsage || isTurnEnd || pipeline.openBatch.deltas.length >= 64) {
			this.closeBatch(pipeline);
			return;
		}
		if (pipeline.pendingDeltaCount >= 4096) {
			this.closeBatch(pipeline);
			return;
		}
		if (pipeline.pendingDeltaCount >= 16384) {
			pipeline.overflowed = true;
			pipeline.resyncRequired = true;
			this.closeBatch(pipeline);
			return;
		}
		this.armIdleClose(pipeline);
	}
	armIdleClose(pipeline) {
		const batch = pipeline.openBatch;
		if (batch === void 0 || batch === null) return;
		if (batch.timer !== void 0) this.clearTimeoutFn(batch.timer);
		const idleDelay = Math.max(0, 250 - (this.now() - batch.lastActivity));
		batch.timer = this.setTimeoutFn(() => {
			if (pipeline.openBatch === batch) this.closeBatch(pipeline);
		}, idleDelay);
		if (Math.max(0, 1e3 - (this.now() - batch.openedAt)) <= 0) this.closeBatch(pipeline);
	}
	closeBatch(pipeline) {
		const batch = pipeline.openBatch;
		if (batch === null || batch === void 0) return;
		if (batch.timer !== void 0) this.clearTimeoutFn(batch.timer);
		pipeline.openBatch = null;
		const projected = {
			batchId: this.generation + ":" + batch.fromSeq + "-" + batch.toSeq + ":" + Math.random().toString(36).slice(2, 8),
			hostGeneration: this.generation,
			lifecycle: pipeline.lifecycle,
			fromSeq: batch.fromSeq,
			toSeq: batch.toSeq,
			deltas: batch.deltas
		};
		pipeline.chain = pipeline.chain.then(() => this.flushAndSend(pipeline, projected));
	}
	async flushAndSend(pipeline, batch) {
		try {
			await this.flushWithRetry(pipeline.session);
		} catch (error) {
			pipeline.resyncRequired = true;
			diag("collector", `flush failed for ${pipeline.lifecycle.sessionId} seqs ${batch.fromSeq}-${batch.toSeq}; batch dropped for resync`, error);
			return;
		}
		try {
			await this.worker.project(batch);
			pipeline.pendingDeltaCount = Math.max(0, pipeline.pendingDeltaCount - batch.deltas.length);
		} catch (error) {
			pipeline.resyncRequired = true;
			diag("collector", `worker.project failed for ${pipeline.lifecycle.sessionId} seqs ${batch.fromSeq}-${batch.toSeq}; batch dropped for resync`, error);
		}
	}
	async flushWithRetry(session) {
		let lastError;
		for (const delay of this.flushRetryDelaysMs) try {
			if (await this.flushService.flush(session)) return;
			throw new Error("flush returned false");
		} catch (error) {
			lastError = error;
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		}
		if (this.flushCooldownMs > 0) await new Promise((resolve) => setTimeout(resolve, this.flushCooldownMs));
		throw lastError ?? /* @__PURE__ */ new Error("flush failed");
	}
};
function lifecycleOf(session) {
	return {
		sessionId: session.id,
		createdAtMs: session.header.createdAt,
		cwd: session.header.cwd ?? ""
	};
}
function lifecycleKey(lifecycle) {
	return lifecycle.sessionId + "\0" + lifecycle.createdAtMs + "\0" + lifecycle.cwd;
}
//#endregion
//#region src/durable/init-recovery.ts
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
var PersistenceSeam = class {
	persistence;
	resolved;
	constructor(persistence) {
		this.persistence = persistence;
		if (typeof persistence.listSnapshots === "function" && typeof persistence.readFrom === "function") this.resolved = "snapshot";
		else if (typeof persistence.list === "function" && typeof persistence.open === "function") this.resolved = "handle";
		else this.resolved = "unsupported";
	}
	/** Which service generation is mounted; surfaced in startup diagnostics. */
	get generation() {
		return this.resolved;
	}
	/** Every stored session visible to this process, in either generation's shape. */
	async listSnapshots(signal) {
		if (this.resolved === "snapshot") return await this.persistence.listSnapshots(signal);
		if (this.resolved === "handle") return await this.persistence.list({ signal });
		throw new Error("dsh-token-dashboard: ctx.sessionPersistence exposes neither listSnapshots() nor list()");
	}
	/** Stored events from seq `fromSeq` on; an empty array means the log ends there. */
	async readFrom(id, fromSeq, signal) {
		if (this.resolved === "snapshot") return (await this.persistence.readFrom(id, fromSeq, signal)).events;
		if (this.resolved === "handle") {
			const handle = await this.persistence.open(id, "read", { signal });
			try {
				return (await handle.read(fromSeq, void 0, { signal })).events;
			} finally {
				await handle.close().catch(() => void 0);
			}
		}
		throw new Error("dsh-token-dashboard: ctx.sessionPersistence exposes neither readFrom() nor open()");
	}
};
/** Async adapter for the Worker client: all SQLite operations stay in the Worker. */
var WorkerCoordinatorStore = class {
	client;
	constructor(client) {
		this.client = client;
	}
	async getLastRunEpoch() {
		return this.client.getLastRunEpoch();
	}
	async beginRunEpoch(startedAtMs) {
		return this.client.beginRunEpoch(startedAtMs);
	}
	async activateRunEpoch(epochId, baselines) {
		await this.client.activateRunEpoch(epochId, baselines);
	}
	async upsertLifecycle(identity, discoveredAtMs) {
		return this.client.upsertLifecycle(identity, discoveredAtMs);
	}
	async getLifecycle(identity) {
		return await this.client.getLifecycle(identity) ?? void 0;
	}
	async getCheckpoint(lifecyclePk) {
		return this.client.getCheckpoint(lifecyclePk);
	}
	async getProjectionProgress() {
		return this.client.getProjectionProgress();
	}
	async updateProjectionProgress(update, now) {
		await this.client.updateProjectionProgress(update, now);
	}
	async setProjectionReady(now) {
		await this.client.setProjectionReady(now);
	}
	async getBaselines(epochId) {
		return this.client.getBaselines(epochId);
	}
	async projectBatch(batch, _now) {
		return this.client.project(batch);
	}
};
const DEFAULT_YIELD_EVERY = 500;
const DEFAULT_MAX_RECOVERY_PARALLEL = 2;
var InitRecoveryCoordinator = class {
	store;
	persistence;
	collector;
	worker;
	generation;
	now;
	yieldEvery;
	maxRecoveryParallel;
	signal;
	aborted = false;
	started = false;
	armed = false;
	snapshots = [];
	previousState;
	previousEpochId;
	constructor(options) {
		this.store = options.store;
		this.persistence = new PersistenceSeam(options.persistence);
		this.collector = options.collector;
		this.worker = options.worker;
		this.generation = options.generation;
		this.now = options.now ?? Date.now;
		this.yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;
		this.maxRecoveryParallel = options.maxRecoveryParallel ?? DEFAULT_MAX_RECOVERY_PARALLEL;
		this.signal = options.signal;
	}
	get isAborted() {
		return this.aborted;
	}
	/** Which ctx.sessionPersistence generation the seam resolved; surfaced in diagnostics. */
	get persistenceGeneration() {
		return this.persistence.generation;
	}
	/** Start the coordinator: arm run, activate with baseline, then run scan. */
	async start() {
		await this.arm();
		await this.scan();
	}
	/** Arm the run epoch and activate with a revision baseline; no scan yet. */
	async arm() {
		if (this.armed) return;
		this.armed = true;
		this.started = true;
		const previous = await this.store.getLastRunEpoch();
		this.previousState = previous?.state;
		this.previousEpochId = previous?.epochId;
		const startedAtMs = this.now();
		const epochId = await this.store.beginRunEpoch(startedAtMs);
		const snapshots = await this.persistence.listSnapshots(this.signal);
		this.snapshots = snapshots;
		const baselines = [];
		for (const snapshot of snapshots) baselines.push({
			lifecyclePk: await this.store.upsertLifecycle(identityFromSnapshot(snapshot), startedAtMs),
			sourceRevision: String(snapshot.revision)
		});
		await this.store.activateRunEpoch(epochId, baselines);
		if (this.signal?.aborted) this.aborted = true;
	}
	/** Run initialization/recovery/ready transition after arm(). */
	async scan() {
		if (!this.armed) throw new Error("coordinator not armed");
		if (this.aborted || this.signal?.aborted) return;
		if ((await this.store.getProjectionProgress()).phase === "initializing") await this.runInitialization(this.snapshots);
		else if (this.previousState === "active" || this.previousState === "arming") await this.runRecovery(this.previousState, this.previousEpochId, this.snapshots, []);
		else {
			await this.runReconciliation(this.snapshots);
			await this.store.updateProjectionProgress({ phase: "ready" }, this.now());
		}
	}
	/**
	* Heal the projection against the live corpus on a clean startup: scan
	* every session whose checkpoint is missing or whose stored revision no
	* longer matches the snapshot's revision. Batches are keyed and checkpoints
	* advance, so re-scanning an unchanged session is a no-op read.
	*/
	async runReconciliation(snapshots) {
		const candidates = [];
		for (const snapshot of snapshots) {
			if (this.aborted) return;
			const identity = identityFromSnapshot(snapshot);
			const pk = await this.store.getLifecycle(identity);
			const revision = String(snapshot.revision);
			if (pk === void 0) {
				candidates.push(snapshot);
				continue;
			}
			const checkpoint = await this.store.getCheckpoint(pk);
			if (!checkpoint.bootstrapComplete || checkpoint.sourceRevision !== revision) candidates.push(snapshot);
		}
		if (candidates.length === 0) return;
		let failed = 0;
		const reasons = new FailureLog();
		for (const snapshot of candidates) {
			if (this.aborted) return;
			try {
				const checkpoint = await this.store.getCheckpoint(await this.store.upsertLifecycle(identityFromSnapshot(snapshot)));
				await this.scanLifecycle(snapshot, checkpoint.lastSeq + 1, false);
			} catch (error) {
				failed += 1;
				reasons.record(snapshot.header.id, error);
				diag("reconcile", `session ${snapshot.header.id} could not be reconciled; retried on the next startup`, error);
			}
		}
		reasons.report();
	}
	/** Abort background scan/recovery; committed work is preserved. */
	abort() {
		this.aborted = true;
	}
	async runInitialization(snapshots) {
		if (this.aborted) return;
		await this.store.updateProjectionProgress({
			phase: "initializing",
			discoveredSessions: snapshots.length,
			startedAtMs: this.now(),
			scanningSessions: 0,
			retryingSessions: 0,
			failedSessions: 0,
			completedSessions: 0
		}, this.now());
		let failed = 0;
		const failedIds = /* @__PURE__ */ new Set();
		const reasons = new FailureLog();
		for (let index = 0; index < snapshots.length; index += 1) {
			if (this.aborted) return;
			const snapshot = snapshots[index];
			await this.store.updateProjectionProgress({ scanningSessions: 1 }, this.now());
			try {
				if (!await this.scanLifecycle(snapshot, 0, true)) {
					failed += 1;
					failedIds.add(snapshot.header.id);
				} else {
					const progress = await this.store.getProjectionProgress();
					await this.store.updateProjectionProgress({
						completedSessions: progress.completedSessions + 1,
						scanningSessions: 0
					}, this.now());
				}
			} catch (error) {
				failed += 1;
				failedIds.add(snapshot.header.id);
				reasons.record(snapshot.header.id, error);
				await this.store.updateProjectionProgress({
					scanningSessions: 0,
					failedSessions: failed
				}, this.now());
			}
		}
		const finalSnapshots = await this.persistence.listSnapshots(this.signal);
		for (const snapshot of finalSnapshots) {
			if (this.aborted) return;
			if (failedIds.has(snapshot.header.id)) continue;
			const pk = await this.store.getLifecycle(identityFromSnapshot(snapshot));
			if (pk !== void 0) {
				if ((await this.store.getCheckpoint(pk)).bootstrapComplete) continue;
			}
			try {
				await this.scanLifecycle(snapshot, 0, true);
				const progress = await this.store.getProjectionProgress();
				await this.store.updateProjectionProgress({
					discoveredSessions: Math.max(progress.discoveredSessions, finalSnapshots.length),
					completedSessions: progress.completedSessions + 1
				}, this.now());
			} catch (error) {
				failed += 1;
				failedIds.add(snapshot.header.id);
				reasons.record(snapshot.header.id, error);
			}
		}
		reasons.report();
		await this.store.getProjectionProgress();
		if (failed === 0 && !this.aborted) await this.store.setProjectionReady(this.now());
		else await this.store.updateProjectionProgress({
			phase: "degraded",
			failedSessions: failed,
			scanningSessions: 0,
			retryingSessions: 0
		}, this.now());
	}
	async runRecovery(previousState, previousEpochId, currentSnapshots, baselines) {
		if (this.aborted) return;
		await this.store.updateProjectionProgress({
			phase: "recovering",
			discoveredSessions: currentSnapshots.length,
			startedAtMs: this.now()
		}, this.now());
		const previousBaselines = previousState === "active" && previousEpochId !== void 0 ? await this.store.getBaselines(previousEpochId) : [];
		const candidates = [];
		for (const snapshot of currentSnapshots) {
			if (previousState === "arming") {
				candidates.push(snapshot);
				continue;
			}
			const identity = identityFromSnapshot(snapshot);
			const pk = await this.store.getLifecycle(identity);
			const baseline = previousBaselines.find((entry) => entry.lifecyclePk === pk);
			if (baseline === void 0 || baseline.sourceRevision !== String(snapshot.revision)) candidates.push(snapshot);
		}
		let failed = 0;
		const reasons = new FailureLog();
		const queue = [...candidates];
		const workers = [];
		const runOne = async () => {
			while (queue.length > 0 && !this.aborted) {
				const snapshot = queue.shift();
				try {
					const checkpoint = await this.store.getCheckpoint(await this.store.upsertLifecycle(identityFromSnapshot(snapshot)));
					await this.scanLifecycle(snapshot, checkpoint.lastSeq + 1, false);
				} catch (error) {
					failed += 1;
					reasons.record(snapshot.header.id, error);
				}
			}
		};
		for (let i = 0; i < Math.min(this.maxRecoveryParallel, Math.max(1, candidates.length)); i += 1) workers.push(runOne());
		await Promise.all(workers);
		reasons.report();
		await this.store.getProjectionProgress();
		if (failed === 0 && !this.aborted) await this.store.setProjectionReady(this.now());
		else await this.store.updateProjectionProgress({
			phase: "degraded",
			failedSessions: failed,
			scanningSessions: 0
		}, this.now());
	}
	async scanLifecycle(snapshot, fromSeq, bootstrap) {
		const identity = identityFromSnapshot(snapshot);
		await this.store.upsertLifecycle(identity);
		let cursor = fromSeq;
		while (!this.aborted) {
			const events = await this.persistence.readFrom(identity.sessionId, cursor, this.signal);
			if (events.length === 0) {
				if (bootstrap) await this.store.projectBatch({
					batchId: this.generation + ":bootstrap:" + identity.sessionId + ":" + cursor,
					hostGeneration: this.generation,
					lifecycle: identity,
					fromSeq: cursor,
					toSeq: cursor - 1,
					deltas: [],
					sourceRevision: String(snapshot.revision),
					bootstrapComplete: true
				});
				return true;
			}
			for (let offset = 0; offset < events.length; offset += this.yieldEvery) {
				if (this.aborted) return false;
				const chunk = events.slice(offset, offset + this.yieldEvery);
				const first = chunk[0];
				const last = chunk[chunk.length - 1];
				const isLastChunk = offset + chunk.length >= events.length;
				await this.store.projectBatch({
					batchId: this.generation + ":scan:" + identity.sessionId + ":" + first.seq + "-" + last.seq,
					hostGeneration: this.generation,
					lifecycle: identity,
					fromSeq: first.seq,
					toSeq: last.seq,
					deltas: normalizeEventDeltas(chunk),
					sourceRevision: isLastChunk && bootstrap ? String(snapshot.revision) : void 0,
					bootstrapComplete: isLastChunk && bootstrap
				});
				cursor = last.seq + 1;
				await new Promise((resolve) => setImmediate(resolve));
			}
		}
		return false;
	}
};
function identityFromSnapshot(snapshot) {
	return {
		sessionId: snapshot.header.id,
		createdAtMs: snapshot.header.createdAt ?? 0,
		cwd: snapshot.header.cwd ?? ""
	};
}
/**
* Bounded per-session failure report.
*
* A scan fails per lifecycle — an unreadable or uninterpretable log is isolated
* so the remaining sessions still project — but the phase only ever carries a
* count. Naming a few causes is what makes `degraded` actionable; the bound
* keeps a wholesale-unreadable corpus from flooding the host log.
*/
const MAX_REPORTED_FAILURES = 5;
var FailureLog = class {
	entries = [];
	total = 0;
	record(id, error) {
		this.total += 1;
		if (this.entries.length < MAX_REPORTED_FAILURES) this.entries.push({
			id,
			reason: error instanceof Error ? error.message : String(error)
		});
	}
	report() {
		if (this.total === 0) return;
		console.error(`dsh-token-dashboard: ${this.total} session(s) could not be projected; the rest of the history is unaffected`);
		for (const entry of this.entries) console.error(`dsh-token-dashboard:   ${entry.id}: ${entry.reason}`);
		if (this.total > this.entries.length) console.error(`dsh-token-dashboard:   …and ${this.total - this.entries.length} more`);
	}
};
//#endregion
//#region src/durable/maintenance.ts
function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
function tokenDashboardDir(home = dshHome()) {
	return join(home, "data", "token-dashboard");
}
function canonicalDbPath(home = dshHome()) {
	return join(tokenDashboardDir(home), "usage-v1.sqlite");
}
//#endregion
//#region src/durable/snapshot-route.ts
const DEFAULT_WEEKS = 26;
const MAX_WEEKS = 52;
const MAX_OFFSET_WEEKS = 1e4;
const CACHE_MAX = 8;
function queryOf(req) {
	return new URL(req.url ?? "/", "http://localhost").searchParams;
}
/** Local calendar day; the store aggregates `today` and day buckets in local time. */
function localDateKey(now = /* @__PURE__ */ new Date()) {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function intOf(params, name, fallback, min, max) {
	const raw = params.get(name);
	if (raw === null) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) return null;
	return value;
}
function registerSnapshotRoute(ctx, provider) {
	const inflight = /* @__PURE__ */ new Map();
	const cache = /* @__PURE__ */ new Map();
	return ctx.webServer.register({
		kind: "exact",
		path: "/api/token-dashboard/snapshot",
		handler: async (req, res) => {
			try {
				const params = queryOf(req);
				const weeks = intOf(params, "weeks", DEFAULT_WEEKS, 1, MAX_WEEKS);
				if (weeks === null) return fail(res, 400, ErrorCodes.BadQuery, "weeks must be an integer in [1, 52]");
				const offsetWeeks = intOf(params, "offsetWeeks", 0, 0, MAX_OFFSET_WEEKS);
				if (offsetWeeks === null) return fail(res, 400, ErrorCodes.BadQuery, "offsetWeeks must be a non-negative integer");
				const query = {
					weeks,
					offsetWeeks
				};
				res.setHeader("cache-control", "no-store");
				const localDate = localDateKey();
				const generation = await provider.getGeneration();
				const cacheKey = `${weeks}:${offsetWeeks}:${localDate}:${generation.commitGeneration}:${generation.stateGeneration}`;
				const cached = cache.get(cacheKey);
				if (cached !== void 0) return ok(res, cached);
				let snapshotPromise = inflight.get(cacheKey);
				if (snapshotPromise === void 0) {
					snapshotPromise = Promise.race([provider.snapshot(query), new Promise((_, reject) => {
						setTimeout(() => reject(new SnapshotTimeoutError()), SNAPSHOT_TIMEOUT_MS);
					})]);
					inflight.set(cacheKey, snapshotPromise);
				}
				try {
					const snapshot = await snapshotPromise;
					const resultKey = `${weeks}:${offsetWeeks}:${localDate}:${snapshot.asOf.commitGeneration}:${snapshot.asOf.stateGeneration}`;
					cache.set(resultKey, snapshot);
					if (cache.size > CACHE_MAX) {
						const oldest = cache.keys().next().value;
						if (oldest !== void 0) cache.delete(oldest);
					}
					ok(res, snapshot);
				} finally {
					inflight.delete(cacheKey);
				}
			} catch (error) {
				if (error instanceof SnapshotTimeoutError) fail(res, 503, ErrorCodes.SnapshotTimeout, "snapshot timed out");
				else fail(res, 503, error instanceof Error && error.message.includes("circuit") ? ErrorCodes.WorkerUnavailable : ErrorCodes.Internal, "snapshot unavailable");
			}
		}
	});
}
var SnapshotTimeoutError = class extends Error {
	constructor() {
		super("snapshot timeout");
		this.name = "SnapshotTimeoutError";
	}
};
function ok(res, value) {
	res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify({
		ok: true,
		value
	}));
}
function fail(res, status, code, message) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify({
		ok: false,
		error: {
			code,
			message,
			retryable: status === 503
		}
	}));
}
//#endregion
//#region src/durable/worker-client.ts
const DEFAULT_RESTART_DELAYS_MS = [
	100,
	1e3,
	5e3
];
var UsageWorkerClient = class {
	generation;
	dbPath;
	workerFactory;
	restartDelaysMs;
	worker = null;
	pending = /* @__PURE__ */ new Map();
	unacked = /* @__PURE__ */ new Map();
	startPromise = null;
	circuitOpen = false;
	intentionalExit = false;
	restartCount = 0;
	requestCounter = 0;
	constructor(options) {
		this.generation = options.generation;
		this.dbPath = options.dbPath;
		this.workerFactory = options.workerFactory ?? (() => new Worker(new URL("./usage-worker.js", import.meta.url)));
		this.restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
	}
	get pendingBatchCount() {
		return this.unacked.size;
	}
	get isCircuitOpen() {
		return this.circuitOpen;
	}
	/** Start (or restart) the Worker and wait for init ack. */
	start() {
		if (this.circuitOpen) return Promise.reject(/* @__PURE__ */ new Error("worker circuit open"));
		if (this.startPromise !== null) return this.startPromise;
		this.startPromise = this.spawnAndInit();
		return this.startPromise;
	}
	async spawnAndInit() {
		this.intentionalExit = false;
		const worker = this.workerFactory();
		this.worker = worker;
		this.attach(worker);
		await this.request({
			type: "init",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1,
			dbPath: this.dbPath
		});
		for (const unacked of this.unacked.values()) this.project(unacked.batch);
	}
	/** Send a projection batch and await commit ack. */
	async project(batch) {
		if (this.circuitOpen) throw new Error("worker circuit open");
		await this.start();
		const key = batch.batchId + "\0" + this.generation;
		this.unacked.set(key, {
			batch,
			hostGeneration: this.generation
		});
		const command = {
			type: "project",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1,
			batch
		};
		const result = await this.request(command);
		if (result.ok) {
			this.unacked.delete(key);
			return result.value;
		}
		throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	/** Query a consistent snapshot. */
	async snapshot(query) {
		if (this.circuitOpen) throw new Error("worker circuit open");
		await this.start();
		const command = {
			type: "snapshot",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1,
			query,
			pendingBatches: this.unacked.size
		};
		const result = await this.request(command, SNAPSHOT_TIMEOUT_MS);
		if (result.ok) return result.value;
		throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	/** Current store generations, used to key the snapshot cache without running a query. */
	async getGeneration() {
		if (this.circuitOpen) throw new Error("worker circuit open");
		await this.start();
		const command = {
			type: "get_generation",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1
		};
		const result = await this.request(command, SNAPSHOT_TIMEOUT_MS);
		if (result.ok) return result.value;
		throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	/** Barrier: all previously sent commands have committed. */
	async drain() {
		if (this.circuitOpen) throw new Error("worker circuit open");
		await this.start();
		const command = {
			type: "drain",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1
		};
		const result = await this.request(command, DRAIN_TIMEOUT_MS);
		if (result.ok) return result.value;
		throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	async beginRunEpoch(startedAtMs = Date.now()) {
		await this.start();
		const command = {
			type: "begin_run",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1,
			startedAtMs
		};
		const result = await this.request(command);
		if (result.ok) return result.value.epochId;
		throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	async activateRunEpoch(epochId, baselines) {
		await this.start();
		const command = {
			type: "activate_run",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1,
			epochId,
			baselines
		};
		const result = await this.request(command);
		if (!result.ok) throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	async markRunClean(epochId, cleanAtMs = Date.now()) {
		await this.start();
		const command = {
			type: "mark_run_clean",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1,
			epochId,
			cleanAtMs
		};
		const result = await this.request(command);
		if (!result.ok) throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	async getLastRunEpoch() {
		await this.start();
		const command = {
			type: "get_last_run",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1
		};
		const result = await this.request(command);
		if (result.ok) return result.value;
		throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	async upsertLifecycle(lifecycle, discoveredAtMs = Date.now()) {
		await this.start();
		const command = {
			type: "upsert_lifecycle",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1,
			lifecycle,
			discoveredAtMs
		};
		const result = await this.request(command);
		if (result.ok) return result.value.lifecyclePk;
		throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	async getLifecycle(lifecycle) {
		await this.start();
		const command = {
			type: "get_lifecycle",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1,
			lifecycle
		};
		const result = await this.request(command);
		if (result.ok) return result.value.lifecyclePk;
		throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	async getCheckpoint(lifecyclePk) {
		await this.start();
		const command = {
			type: "get_checkpoint",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1,
			lifecyclePk
		};
		const result = await this.request(command);
		if (result.ok) return result.value;
		throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	async getProjectionProgress() {
		await this.start();
		const command = {
			type: "get_projection_progress",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1
		};
		const result = await this.request(command);
		if (result.ok) return result.value;
		throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	async updateProjectionProgress(update, now = Date.now()) {
		await this.start();
		const command = {
			type: "update_projection_progress",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1,
			update,
			now
		};
		const result = await this.request(command);
		if (!result.ok) throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	async setProjectionReady(now = Date.now()) {
		await this.start();
		const command = {
			type: "set_projection_ready",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1,
			now
		};
		const result = await this.request(command);
		if (!result.ok) throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	async getBaselines(epochId) {
		await this.start();
		const command = {
			type: "get_baselines",
			requestId: this.nextRequestId(),
			hostGeneration: this.generation,
			protocolVersion: 1,
			epochId
		};
		const result = await this.request(command);
		if (result.ok) return result.value;
		throw new WorkerRpcError(result.error.code, result.error.message, result.error.retryable);
	}
	/** Stop admission, flush commands, close DB and terminate the Worker. */
	async shutdown() {
		this.intentionalExit = true;
		if (this.worker !== null && !this.circuitOpen) {
			const command = {
				type: "shutdown",
				requestId: this.nextRequestId(),
				hostGeneration: this.generation,
				protocolVersion: 1
			};
			try {
				await this.request(command, DRAIN_TIMEOUT_MS);
			} catch {}
		}
		await this.worker?.terminate();
		this.worker = null;
		this.pending.clear();
		this.startPromise = null;
		this.circuitOpen = false;
		this.restartCount = 0;
	}
	attach(worker) {
		worker.on("message", (value) => this.onMessage(value));
		worker.on("error", () => this.onUnexpectedExit());
		worker.on("exit", () => this.onUnexpectedExit());
	}
	onMessage(result) {
		const pending = this.pending.get(result.requestId);
		if (pending === void 0) return;
		this.pending.delete(result.requestId);
		if (pending.timer !== void 0) clearTimeout(pending.timer);
		pending.resolve(result);
	}
	onUnexpectedExit() {
		if (this.intentionalExit) return;
		for (const pending of this.pending.values()) {
			if (pending.timer !== void 0) clearTimeout(pending.timer);
			pending.reject(new WorkerRpcError("worker_unavailable", "worker exited before reply", true));
		}
		this.pending.clear();
		this.worker = null;
		this.startPromise = null;
		if (this.circuitOpen) return;
		if (this.restartCount >= this.restartDelaysMs.length) {
			this.circuitOpen = true;
			return;
		}
		const delay = this.restartDelaysMs[this.restartCount] ?? 5e3;
		this.restartCount += 1;
		setTimeout(() => {
			this.startPromise = this.spawnAndInit().catch(() => {
				this.startPromise = null;
			});
		}, delay);
	}
	request(command, timeoutMs) {
		if (this.worker === null) return Promise.reject(new WorkerRpcError("worker_unavailable", "worker is not running", true));
		return new Promise((resolve, reject) => {
			const pending = {
				command,
				resolve,
				reject,
				timer: void 0
			};
			if (timeoutMs !== void 0) pending.timer = setTimeout(() => {
				this.pending.delete(command.requestId);
				reject(new WorkerRpcError("rpc_timeout", "worker rpc timed out", true));
			}, timeoutMs);
			this.pending.set(command.requestId, pending);
			this.worker?.postMessage(command);
		});
	}
	nextRequestId() {
		this.requestCounter += 1;
		return this.generation + ":" + this.requestCounter;
	}
};
var WorkerRpcError = class extends Error {
	code;
	retryable;
	constructor(code, message, retryable) {
		super(message);
		this.code = code;
		this.retryable = retryable;
		this.name = "WorkerRpcError";
	}
};
//#endregion
//#region src/index.ts
/** Required services: HTTP routes, persistence seam and live session store. */
const inject = [
	"webServer",
	"sessionPersistence",
	"sessions"
];
/** Mount the durable projection runtime and the single snapshot route. */
function apply(ctx) {
	ctx.effect(() => {
		const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
		mkdirSync(tokenDashboardDir(home), {
			recursive: true,
			mode: 448
		});
		const generation = "host-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
		const worker = new UsageWorkerClient({
			generation,
			dbPath: canonicalDbPath(home)
		});
		const collector = new UsageCollector({
			generation,
			flush: { flush: (session) => ctx.sessions.flush(session) },
			worker
		});
		const coordinator = new InitRecoveryCoordinator({
			store: new WorkerCoordinatorStore(worker),
			persistence: ctx.sessionPersistence,
			collector,
			worker,
			generation
		});
		const onEvent = (session, event) => {
			collector.onEvent(session, event);
		};
		const disposeListener = ctx.on("session/event", onEvent);
		diag("host", "session/event listener registered");
		const disposeRoutes = registerSnapshotRoute(ctx, worker);
		let armed = false;
		(async () => {
			try {
				const t0 = Date.now();
				await worker.start();
				diag("host", `worker started in ${Date.now() - t0}ms`);
				await coordinator.arm();
				diag("host", `armed in ${Date.now() - t0}ms (persistence seam: ${coordinator.persistenceGeneration})`);
				collector.start();
				armed = true;
				coordinator.scan().catch((error) => {
					console.error("dsh-token-dashboard: projection scan failed", error);
					diag("host", "scan failed", error);
				});
			} catch (error) {
				console.error("dsh-token-dashboard: durable projection startup failed", error);
				diag("host", "startup failed; live collection stays disabled", error);
			}
		})();
		return async () => {
			collector.stop();
			coordinator.abort();
			disposeListener();
			await collector.drain();
			await worker.drain();
			if (armed) {
				const lastRun = await worker.getLastRunEpoch().catch(() => null);
				if (lastRun !== null && lastRun.epochId !== void 0) await worker.markRunClean(lastRun.epochId).catch(() => void 0);
			}
			await worker.shutdown().catch(() => void 0);
			disposeRoutes();
		};
	}, "dsh-token-dashboard: durable usage projection");
}
//#endregion
export { apply, inject };

//# sourceMappingURL=index.js.map