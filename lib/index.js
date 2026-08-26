import { mkdirSync } from "node:fs";
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
		if (event.seq < pipeline.expectedSeq) return;
		if (event.seq > pipeline.expectedSeq) {
			pipeline.resyncRequired = true;
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
		} catch {
			pipeline.resyncRequired = true;
			return;
		}
		try {
			await this.worker.project(batch);
			pipeline.pendingDeltaCount = Math.max(0, pipeline.pendingDeltaCount - batch.deltas.length);
		} catch {
			pipeline.resyncRequired = true;
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
const DEFAULT_RESCAN_INTERVAL_MS = 6e5;
var InitRecoveryCoordinator = class {
	store;
	persistence;
	generation;
	now;
	yieldEvery;
	rescanIntervalMs;
	signal;
	aborted = false;
	armed = false;
	scanning = false;
	rescanTimer;
	snapshots = [];
	constructor(options) {
		this.store = options.store;
		this.persistence = options.persistence;
		this.generation = options.generation;
		this.now = options.now ?? Date.now;
		this.yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;
		this.rescanIntervalMs = options.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS;
		this.signal = options.signal;
	}
	get isAborted() {
		return this.aborted;
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
	/**
	* Run the completeness pass over the arm-time snapshots and schedule the
	* periodic re-check. The pass runs on every startup regardless of the
	* previous epoch state: a run may be marked clean while scans are
	* incomplete, and the next startup must continue from the incomplete
	* lifecycles.
	*/
	async scan() {
		if (!this.armed) throw new Error("coordinator not armed");
		if (this.aborted || this.signal?.aborted) return;
		const progress = await this.store.getProjectionProgress();
		await this.runCompletenessScan(progress.phase === "initializing", this.snapshots);
		this.armRescan();
	}
	/** Abort background scan/recovery; committed work is preserved. */
	abort() {
		this.aborted = true;
		if (this.rescanTimer !== void 0) {
			clearTimeout(this.rescanTimer);
			this.rescanTimer = void 0;
		}
	}
	/** Schedule the next periodic completeness re-check while the host stays up. */
	armRescan() {
		if (this.aborted || this.rescanIntervalMs <= 0 || this.rescanTimer !== void 0) return;
		this.rescanTimer = setTimeout(() => {
			this.rescanTimer = void 0;
			if (this.aborted) return;
			this.periodicRescan();
		}, this.rescanIntervalMs);
		const timer = this.rescanTimer;
		if (typeof timer.unref === "function") timer.unref();
	}
	/** Re-list the session logs and re-run the completeness pass on a timer. */
	async periodicRescan() {
		if (this.aborted) return;
		try {
			const snapshots = await this.persistence.listSnapshots(this.signal);
			await this.runCompletenessScan(false, snapshots);
		} catch (error) {
			await this.store.updateProjectionProgress({
				lastErrorCode: "rescan_failed",
				lastErrorMessage: error instanceof Error ? error.message : String(error)
			}).catch(() => void 0);
		} finally {
			this.armRescan();
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
	async runCompletenessScan(firstRun, snapshots) {
		if (this.scanning) return;
		this.scanning = true;
		try {
			await this.store.updateProjectionProgress({
				...firstRun ? { phase: "initializing" } : {},
				discoveredSessions: snapshots.length,
				startedAtMs: this.now(),
				completedSessions: 0,
				failedSessions: 0,
				scanningSessions: 0,
				retryingSessions: 0
			}, this.now());
			let verified = 0;
			let failed = 0;
			let enteredRecovering = false;
			const beginRecovery = () => {
				if (enteredRecovering || firstRun) return Promise.resolve();
				enteredRecovering = true;
				return this.store.updateProjectionProgress({
					phase: "recovering",
					scanningSessions: 1
				}, this.now());
			};
			const scanOne = async (snapshot) => {
				const identity = identityFromSnapshot(snapshot);
				const lifecyclePk = await this.store.upsertLifecycle(identity);
				const checkpoint = await this.store.getCheckpoint(lifecyclePk);
				const revision = String(snapshot.revision);
				if (checkpoint.sourceRevision === revision && (checkpoint.lastSeq >= 0 || checkpoint.bootstrapComplete)) return true;
				await beginRecovery();
				return await this.scanLifecycle(snapshot, checkpoint.lastSeq + 1);
			};
			for (let index = 0; index < snapshots.length; index += 1) {
				if (this.aborted) break;
				const snapshot = snapshots[index];
				try {
					if (await scanOne(snapshot)) verified += 1;
					else if (!this.aborted) failed += 1;
				} catch (error) {
					if (this.aborted) break;
					failed += 1;
					await this.store.updateProjectionProgress({
						lastErrorCode: "scan_failed",
						lastErrorMessage: error instanceof Error ? error.message : String(error)
					}, this.now());
				}
				if (index % 10 === 9 || index === snapshots.length - 1) await this.store.updateProjectionProgress({
					completedSessions: verified,
					failedSessions: failed,
					scanningSessions: this.aborted ? 0 : 1
				}, this.now());
			}
			if (!this.aborted) {
				const finalSnapshots = await this.persistence.listSnapshots(this.signal);
				const known = new Set(snapshots.map((snapshot) => snapshot.header.id));
				let grown = false;
				for (const snapshot of finalSnapshots) {
					if (this.aborted) break;
					if (known.has(snapshot.header.id)) continue;
					known.add(snapshot.header.id);
					grown = true;
					try {
						if (await scanOne(snapshot)) verified += 1;
						else failed += 1;
					} catch {
						failed += 1;
					}
				}
				if (grown) await this.store.updateProjectionProgress({ discoveredSessions: Math.max(snapshots.length, finalSnapshots.length) }, this.now());
			}
			await this.store.updateProjectionProgress({
				completedSessions: verified,
				failedSessions: failed,
				scanningSessions: 0
			}, this.now());
			if (failed === 0 && !this.aborted) await this.store.setProjectionReady(this.now());
			else if (!this.aborted) await this.store.updateProjectionProgress({ phase: "degraded" }, this.now());
		} finally {
			this.scanning = false;
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
	async scanLifecycle(snapshot, fromSeq) {
		const identity = identityFromSnapshot(snapshot);
		const revision = String(snapshot.revision);
		const read = await this.persistence.readFrom(identity.sessionId, fromSeq, this.signal);
		if (read.events.length === 0) {
			await this.store.projectBatch({
				batchId: this.generation + ":tail:" + identity.sessionId + ":" + fromSeq,
				hostGeneration: this.generation,
				lifecycle: identity,
				fromSeq,
				toSeq: fromSeq - 1,
				deltas: [],
				sourceRevision: revision,
				bootstrapComplete: true
			});
			return true;
		}
		for (let offset = 0; offset < read.events.length; offset += this.yieldEvery) {
			if (this.aborted) return false;
			const chunk = read.events.slice(offset, offset + this.yieldEvery);
			const first = chunk[0];
			const last = chunk[chunk.length - 1];
			const isLastChunk = offset + chunk.length >= read.events.length;
			await this.store.projectBatch({
				batchId: this.generation + ":scan:" + identity.sessionId + ":" + first.seq + "-" + last.seq,
				hostGeneration: this.generation,
				lifecycle: identity,
				fromSeq: first.seq,
				toSeq: last.seq,
				deltas: normalizeEventDeltas(chunk),
				...isLastChunk ? {
					sourceRevision: revision,
					bootstrapComplete: true
				} : {}
			});
			await new Promise((resolve) => setImmediate(resolve));
		}
		return !this.aborted;
	}
};
function identityFromSnapshot(snapshot) {
	return {
		sessionId: snapshot.header.id,
		createdAtMs: snapshot.header.createdAt ?? 0,
		cwd: snapshot.header.cwd ?? ""
	};
}
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
				const revision = await provider.revision();
				const cacheKey = `${weeks}:${offsetWeeks}:${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}:${revision.commitGeneration}:${revision.stateGeneration}`;
				const cached = cache.get(cacheKey);
				if (cached !== void 0) return ok(res, cached.snapshot);
				let snapshotPromise = inflight.get(cacheKey);
				if (snapshotPromise === void 0) {
					snapshotPromise = Promise.race([provider.snapshot(query), new Promise((_, reject) => {
						setTimeout(() => reject(new SnapshotTimeoutError()), SNAPSHOT_TIMEOUT_MS);
					})]);
					inflight.set(cacheKey, snapshotPromise);
				}
				try {
					const snapshot = await snapshotPromise;
					cache.set(cacheKey, { snapshot });
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
		if (result.error.retryable === false) this.unacked.delete(key);
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
/**
* Build the collector's source-durability barrier on top of the session store.
*
* A session that is no longer live in the store has already persisted its
* buffered events (the store drains a session before disposal), so its
* barrier is already met. Projecting its batch via a bare `flush` call would
* make the store reject the disposed session and the collector would drop
* the batch with nothing to recover it; live sessions await `flush` as usual.
*/
function createFlushService(sessions) {
	return { flush(session) {
		const live = sessions.get(session.id);
		if (live === void 0) return Promise.resolve(true);
		return sessions.flush(live);
	} };
}
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
			flush: createFlushService(ctx.sessions),
			worker
		});
		const coordinator = new InitRecoveryCoordinator({
			store: new WorkerCoordinatorStore(worker),
			persistence: ctx.sessionPersistence,
			generation
		});
		const onEvent = (session, event) => {
			collector.onEvent(session, event);
		};
		const disposeListener = ctx.on("session/event", onEvent);
		const disposeRoutes = registerSnapshotRoute(ctx, {
			snapshot: (query) => worker.snapshot(query),
			revision: () => worker.drain()
		});
		(async () => {
			try {
				await worker.start();
				await coordinator.arm();
				collector.start();
				coordinator.scan().catch((error) => {
					console.error("dsh-token-dashboard: projection scan failed", error);
				});
			} catch (error) {
				console.error("dsh-token-dashboard: durable projection startup failed", error);
			}
		})();
		return async () => {
			collector.stop();
			coordinator.abort();
			disposeListener();
			await collector.drain();
			await worker.drain();
			const lastRun = await worker.getLastRunEpoch().catch(() => null);
			if (lastRun !== null && lastRun.epochId !== void 0) await worker.markRunClean(lastRun.epochId).catch(() => void 0);
			await worker.shutdown().catch(() => void 0);
			disposeRoutes();
		};
	}, "dsh-token-dashboard: durable usage projection");
}
//#endregion
export { apply, createFlushService, inject };

//# sourceMappingURL=index.js.map