import { parentPort } from "node:worker_threads";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
/** Stable deterministic ingestion warning codes. */
const IngestionCodes = {
	MissingTurnStep: "missing_turn_step",
	BadTokenValue: "bad_token_value",
	UnsafeInteger: "unsafe_integer"
};
//#endregion
//#region src/durable/projector.ts
/** Key for one fact within a lifecycle: `turn:step`. */
function factKey(turn, step) {
	return turn + ":" + step;
}
/**
* Normalize a raw token usage object into the four non-negative buckets.
* Missing values become 0. Invalid numbers, negative values, non-integer
* values, or values above Number.MAX_SAFE_INTEGER produce a deterministic
* ingestion warning instead of a fact.
*/
function normalizeTokenUsage(usage) {
	if (usage === null || typeof usage !== "object") return {
		usage: null,
		reasonCode: IngestionCodes.BadTokenValue,
		detail: "usage is not an object"
	};
	const record = usage;
	const buckets = [
		["inputTokens", "input"],
		["outputTokens", "output"],
		["cacheReadTokens", "cacheRead"],
		["cacheWriteTokens", "cacheWrite"]
	];
	const normalized = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0
	};
	for (const [field, label] of buckets) {
		const raw = record[field];
		if (raw === void 0) continue;
		if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) return {
			usage: null,
			reasonCode: IngestionCodes.BadTokenValue,
			detail: `${label} must be a non-negative safe integer`
		};
		normalized[field] = raw;
	}
	return { usage: normalized };
}
/**
* Apply a contiguous batch to a projection state.
*
* Returns `gap` when the batch does not start at `checkpoint + 1` (or a
* no-op when it is entirely at/below the checkpoint). Successful application
* advances `checkpoint` to `batch.toSeq` and commits facts/errors atomically
* in the returned state.
*/
function projectBatch(state, batch, now = Date.now()) {
	if (batch.fromSeq > state.checkpoint + 1) return {
		state,
		status: "gap",
		reason: `expected ${state.checkpoint + 1}, got ${batch.fromSeq}`
	};
	if (batch.toSeq <= state.checkpoint) return {
		state,
		status: "noop"
	};
	const startSeq = state.checkpoint + 1;
	const facts = new Map(state.facts);
	const errors = new Map(state.errors);
	let routeProvider = state.routeProvider;
	let routeModel = state.routeModel;
	for (const delta of batch.deltas) {
		if (delta.seq < startSeq || delta.seq > batch.toSeq) continue;
		if (delta.kind === "route") {
			if (delta.provider !== void 0) routeProvider = delta.provider;
			if (delta.model !== void 0) routeModel = delta.model;
			continue;
		}
		if (!Number.isSafeInteger(delta.turn) || delta.turn < 0 || !Number.isSafeInteger(delta.step) || delta.step < 0) {
			errors.set(delta.seq, {
				sourceSeq: delta.seq,
				eventType: delta.final ? "assistant/message" : "assistant/chunk",
				reasonCode: IngestionCodes.MissingTurnStep,
				detail: "usage event must carry non-negative turn and step",
				firstSeenAtMs: now
			});
			continue;
		}
		const normalized = normalizeTokenUsage(delta.usage);
		if (normalized.usage === null) {
			errors.set(delta.seq, {
				sourceSeq: delta.seq,
				eventType: delta.final ? "assistant/message" : "assistant/chunk",
				reasonCode: normalized.reasonCode ?? IngestionCodes.BadTokenValue,
				detail: normalized.detail ?? "invalid token buckets",
				firstSeenAtMs: now
			});
			continue;
		}
		const key = factKey(delta.turn, delta.step);
		const existing = facts.get(key);
		if (existing !== void 0 && existing.sourceSeq > delta.seq) continue;
		const fact = {
			turn: delta.turn,
			step: delta.step,
			sourceSeq: delta.seq,
			occurredAtMs: delta.time,
			provider: routeProvider,
			model: routeModel,
			inputTokens: normalized.usage.inputTokens,
			outputTokens: normalized.usage.outputTokens,
			cacheReadTokens: normalized.usage.cacheReadTokens ?? 0,
			cacheWriteTokens: normalized.usage.cacheWriteTokens ?? 0
		};
		facts.set(key, fact);
	}
	return {
		state: {
			checkpoint: batch.toSeq,
			routeProvider,
			routeModel,
			facts,
			errors
		},
		status: "ok"
	};
}
//#endregion
//#region src/host/day-buckets.ts
const HOUR_MS = 36e5;
/** Machine-local UTC offset (hours, positive east) at the given instant. */
function localOffsetHours(time) {
	return -new Date(time).getTimezoneOffset() / 60;
}
function offsetHoursFor(tz, time, localOffset = localOffsetHours) {
	return tz === "utc" ? 0 : localOffset(time);
}
/** YYYY-MM-DD of an epoch-ms instant under the timezone policy. */
function dayKeyOf(time, tz, localOffset = localOffsetHours) {
	return new Date(time + offsetHoursFor(tz, time, localOffset) * HOUR_MS).toISOString().slice(0, 10);
}
/** YYYY-MM-DD shifted by N days (pure, timezone-independent calendar math). */
function shiftDateKey(key, days) {
	const [y, m, d] = key.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
//#endregion
//#region src/durable/sqlite-store.ts
const DDL = `
CREATE TABLE IF NOT EXISTS session_lifecycle (
  lifecycle_pk          INTEGER PRIMARY KEY,
  session_id            TEXT NOT NULL,
  session_created_at_ms INTEGER NOT NULL CHECK (session_created_at_ms >= 0),
  cwd                    TEXT NOT NULL,
  discovered_at_ms       INTEGER NOT NULL CHECK (discovered_at_ms >= 0),
  UNIQUE (session_id, session_created_at_ms, cwd)
);

CREATE TABLE IF NOT EXISTS usage_fact (
  lifecycle_pk       INTEGER NOT NULL
                       REFERENCES session_lifecycle(lifecycle_pk) ON DELETE RESTRICT,
  turn               INTEGER NOT NULL CHECK (turn >= 0),
  step               INTEGER NOT NULL CHECK (step >= 0),
  source_seq         INTEGER NOT NULL CHECK (source_seq >= 0),
  occurred_at_ms     INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  provider           TEXT,
  model              TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens      INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  PRIMARY KEY (lifecycle_pk, turn, step)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS usage_fact_occurred_at_idx ON usage_fact(occurred_at_ms);

CREATE TABLE IF NOT EXISTS session_checkpoint (
  lifecycle_pk       INTEGER PRIMARY KEY
                       REFERENCES session_lifecycle(lifecycle_pk) ON DELETE RESTRICT,
  last_seq           INTEGER NOT NULL DEFAULT -1 CHECK (last_seq >= -1),
  route_provider     TEXT,
  route_model        TEXT,
  bootstrap_complete INTEGER NOT NULL DEFAULT 0 CHECK (bootstrap_complete IN (0, 1)),
  source_revision    TEXT,
  updated_at_ms      INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (bootstrap_complete = 0 OR source_revision IS NOT NULL)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ingestion_error (
  lifecycle_pk     INTEGER NOT NULL
                     REFERENCES session_lifecycle(lifecycle_pk) ON DELETE RESTRICT,
  source_seq       INTEGER NOT NULL CHECK (source_seq >= 0),
  event_type       TEXT,
  reason_code      TEXT NOT NULL,
  detail           TEXT NOT NULL,
  first_seen_at_ms INTEGER NOT NULL CHECK (first_seen_at_ms >= 0),
  PRIMARY KEY (lifecycle_pk, source_seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS projection_state (
  singleton_id        INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version  INTEGER NOT NULL,
  phase               TEXT NOT NULL CHECK (
                        phase IN ('initializing','recovering','ready','degraded',
                                  'rebuild_required','error')
                      ),
  discovered_sessions INTEGER NOT NULL DEFAULT 0 CHECK (discovered_sessions >= 0),
  completed_sessions  INTEGER NOT NULL DEFAULT 0 CHECK (completed_sessions >= 0),
  scanning_sessions   INTEGER NOT NULL DEFAULT 0 CHECK (scanning_sessions >= 0),
  retrying_sessions   INTEGER NOT NULL DEFAULT 0 CHECK (retrying_sessions >= 0),
  failed_sessions     INTEGER NOT NULL DEFAULT 0 CHECK (failed_sessions >= 0),
  started_at_ms       INTEGER,
  completed_at_ms     INTEGER,
  last_error_code     TEXT,
  last_error_message  TEXT,
  updated_at_ms       INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (completed_sessions + failed_sessions <= discovered_sessions)
);

CREATE TABLE IF NOT EXISTS run_epoch (
  epoch_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  state         TEXT NOT NULL CHECK (state IN ('arming','active','clean')),
  clean_at_ms   INTEGER
);

CREATE TABLE IF NOT EXISTS run_baseline (
  epoch_id        INTEGER NOT NULL REFERENCES run_epoch(epoch_id) ON DELETE CASCADE,
  lifecycle_pk    INTEGER NOT NULL REFERENCES session_lifecycle(lifecycle_pk) ON DELETE RESTRICT,
  source_revision TEXT NOT NULL,
  PRIMARY KEY (epoch_id, lifecycle_pk)
) WITHOUT ROWID;
`;
var ProjectionGapError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ProjectionGapError";
	}
};
var ProjectionTooNewError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ProjectionTooNewError";
	}
};
var ForeignDatabaseError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ForeignDatabaseError";
	}
};
var DatabaseInUseError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "DatabaseInUseError";
	}
};
var SqliteUsageStore = class {
	db;
	commitGeneration = 0;
	stateGeneration = 0;
	closed = false;
	constructor(dbPath, options = {}) {
		try {
			this.db = new DatabaseSync(dbPath, {
				readOnly: options.readOnly ?? false,
				timeout: 5e3,
				enableForeignKeyConstraints: true
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/locked|database is locked/i.test(message)) throw new DatabaseInUseError("database_in_use: " + message);
			throw error;
		}
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec("PRAGMA synchronous = FULL");
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		if (!options.readOnly) try {
			chmodSync(dbPath, 384);
		} catch {}
		this.probe();
		if (!options.readOnly) {
			this.db.exec("PRAGMA application_id = 1146376011");
			this.db.exec("PRAGMA user_version = 1");
		}
	}
	probe() {
		const appId = this.db.prepare("PRAGMA application_id").get().application_id;
		const userVersion = this.db.prepare("PRAGMA user_version").get().user_version;
		if (userVersion > 1) {
			this.db.close();
			throw new ProjectionTooNewError(`database schema too new: user_version=${userVersion}, plugin supports 1`);
		}
		if (appId !== 0 && appId !== 1146376011) {
			this.db.close();
			throw new ForeignDatabaseError(`foreign sqlite database application_id=${appId.toString(16)}`);
		}
		if (userVersion === 0) {
			this.db.exec(DDL);
			this.db.exec("PRAGMA user_version = 1");
			const now = Date.now();
			this.db.prepare(`INSERT INTO projection_state (
           singleton_id, projection_version, phase, discovered_sessions, completed_sessions,
           scanning_sessions, retrying_sessions, failed_sessions, started_at_ms, completed_at_ms,
           updated_at_ms
         ) VALUES (1, ?, 'initializing', 0, 0, 0, 0, 0, NULL, NULL, ?)`).run(1, now);
		}
	}
	txDepth = 0;
	/** Run a function inside an immediate transaction; rolls back on throw. */
	transaction(fn) {
		if (this.txDepth > 0) return fn();
		this.txDepth += 1;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const value = fn();
			this.db.exec("COMMIT");
			return value;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		} finally {
			this.txDepth -= 1;
		}
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}
	get isClosed() {
		return this.closed;
	}
	get commitGenerationValue() {
		return this.commitGeneration;
	}
	get stateGenerationValue() {
		return this.stateGeneration;
	}
	bumpState() {
		this.stateGeneration += 1;
	}
	bumpCommit() {
		this.commitGeneration += 1;
	}
	upsertLifecycle(identity, discoveredAtMs = Date.now()) {
		return this.db.prepare(`INSERT INTO session_lifecycle (session_id, session_created_at_ms, cwd, discovered_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, session_created_at_ms, cwd) DO UPDATE SET discovered_at_ms = excluded.discovered_at_ms
       RETURNING lifecycle_pk`).get(identity.sessionId, identity.createdAtMs, identity.cwd, discoveredAtMs).lifecycle_pk;
	}
	getLifecycle(identity) {
		return this.db.prepare(`SELECT lifecycle_pk FROM session_lifecycle WHERE session_id = ? AND session_created_at_ms = ? AND cwd = ?`).get(identity.sessionId, identity.createdAtMs, identity.cwd)?.lifecycle_pk;
	}
	getCheckpoint(lifecyclePk) {
		const row = this.db.prepare(`SELECT lifecycle_pk, last_seq, route_provider, route_model, bootstrap_complete, source_revision
       FROM session_checkpoint WHERE lifecycle_pk = ?`).get(lifecyclePk);
		if (row === void 0) return {
			lifecyclePk,
			lastSeq: -1,
			routeProvider: null,
			routeModel: null,
			bootstrapComplete: false,
			sourceRevision: null
		};
		return {
			lifecyclePk: row.lifecycle_pk,
			lastSeq: row.last_seq,
			routeProvider: row.route_provider,
			routeModel: row.route_model,
			bootstrapComplete: row.bootstrap_complete === 1,
			sourceRevision: row.source_revision
		};
	}
	/** Project one source-confirmed batch; facts/errors/checkpoint are atomic. */
	projectBatch(batch, now = Date.now()) {
		return this.transaction(() => {
			const lifecyclePk = this.upsertLifecycle(batch.lifecycle);
			const current = this.getCheckpoint(lifecyclePk);
			const result = projectBatch({
				checkpoint: current.lastSeq,
				routeProvider: current.routeProvider ?? void 0,
				routeModel: current.routeModel ?? void 0,
				facts: /* @__PURE__ */ new Map(),
				errors: /* @__PURE__ */ new Map()
			}, batch, now);
			if (result.status === "gap") throw new ProjectionGapError(result.reason ?? "projection gap");
			if (result.status === "noop") {
				if (batch.bootstrapComplete === true && batch.sourceRevision !== void 0) {
					this.db.prepare(`INSERT INTO session_checkpoint (
               lifecycle_pk, last_seq, route_provider, route_model, bootstrap_complete, source_revision, updated_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(lifecycle_pk) DO UPDATE SET
               bootstrap_complete = excluded.bootstrap_complete,
               source_revision = excluded.source_revision,
               updated_at_ms = excluded.updated_at_ms`).run(lifecyclePk, current.lastSeq, current.routeProvider, current.routeModel, 1, batch.sourceRevision, now);
					this.bumpState();
				}
				return {
					committed: false,
					checkpoint: current.lastSeq,
					commitGeneration: this.commitGeneration
				};
			}
			const upsertFact = this.db.prepare(`INSERT INTO usage_fact (
           lifecycle_pk, turn, step, source_seq, occurred_at_ms, provider, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lifecycle_pk, turn, step) DO UPDATE SET
           source_seq         = excluded.source_seq,
           occurred_at_ms     = excluded.occurred_at_ms,
           provider           = COALESCE(excluded.provider, usage_fact.provider),
           model              = COALESCE(excluded.model, usage_fact.model),
           input_tokens       = excluded.input_tokens,
           output_tokens      = excluded.output_tokens,
           cache_read_tokens  = excluded.cache_read_tokens,
           cache_write_tokens = excluded.cache_write_tokens
         WHERE excluded.source_seq >= usage_fact.source_seq`);
			for (const fact of result.state.facts.values()) upsertFact.run(lifecyclePk, fact.turn, fact.step, fact.sourceSeq, fact.occurredAtMs, fact.provider ?? null, fact.model ?? null, fact.inputTokens, fact.outputTokens, fact.cacheReadTokens, fact.cacheWriteTokens);
			const upsertError = this.db.prepare(`INSERT INTO ingestion_error (lifecycle_pk, source_seq, event_type, reason_code, detail, first_seen_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(lifecycle_pk, source_seq) DO UPDATE SET
           event_type = excluded.event_type,
           reason_code = excluded.reason_code,
           detail = excluded.detail`);
			for (const error of result.state.errors.values()) upsertError.run(lifecyclePk, error.sourceSeq, error.eventType ?? null, error.reasonCode, error.detail.slice(0, 500), error.firstSeenAtMs);
			const bootstrapComplete = batch.bootstrapComplete === true ? 1 : current.bootstrapComplete ? 1 : 0;
			const sourceRevision = batch.bootstrapComplete === true ? batch.sourceRevision ?? current.sourceRevision : current.sourceRevision;
			this.db.prepare(`INSERT INTO session_checkpoint (
           lifecycle_pk, last_seq, route_provider, route_model, bootstrap_complete, source_revision, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lifecycle_pk) DO UPDATE SET
           last_seq = excluded.last_seq,
           route_provider = excluded.route_provider,
           route_model = excluded.route_model,
           bootstrap_complete = excluded.bootstrap_complete,
           source_revision = excluded.source_revision,
           updated_at_ms = excluded.updated_at_ms`).run(lifecyclePk, result.state.checkpoint, result.state.routeProvider ?? null, result.state.routeModel ?? null, bootstrapComplete, sourceRevision, now);
			this.bumpCommit();
			return {
				committed: true,
				checkpoint: result.state.checkpoint,
				commitGeneration: this.commitGeneration
			};
		});
	}
	beginRunEpoch(startedAtMs = Date.now()) {
		return this.db.prepare(`INSERT INTO run_epoch (started_at_ms, state) VALUES (?, 'arming') RETURNING epoch_id`).get(startedAtMs).epoch_id;
	}
	activateRunEpoch(epochId, baselines, now = Date.now()) {
		this.transaction(() => {
			this.db.prepare(`UPDATE run_epoch SET state = 'active', clean_at_ms = NULL WHERE epoch_id = ?`).run(epochId);
			const insert = this.db.prepare(`INSERT INTO run_baseline (epoch_id, lifecycle_pk, source_revision) VALUES (?, ?, ?)
         ON CONFLICT(epoch_id, lifecycle_pk) DO UPDATE SET source_revision = excluded.source_revision`);
			for (const baseline of baselines) insert.run(epochId, baseline.lifecyclePk, baseline.sourceRevision);
		});
		this.bumpState();
	}
	markRunClean(epochId, cleanAtMs = Date.now()) {
		this.transaction(() => {
			this.db.prepare(`UPDATE run_epoch SET state = 'clean', clean_at_ms = ? WHERE epoch_id = ?`).run(cleanAtMs, epochId);
			this.db.prepare(`DELETE FROM run_baseline WHERE epoch_id = ?`).run(epochId);
		});
		this.bumpState();
	}
	getLastRunEpoch() {
		const row = this.db.prepare(`SELECT epoch_id, started_at_ms, state, clean_at_ms FROM run_epoch ORDER BY epoch_id DESC LIMIT 1`).get();
		if (row === void 0) return void 0;
		return {
			epochId: row.epoch_id,
			state: row.state,
			startedAtMs: row.started_at_ms,
			cleanAtMs: row.clean_at_ms
		};
	}
	getBaselines(epochId) {
		return this.db.prepare(`SELECT lifecycle_pk, source_revision FROM run_baseline WHERE epoch_id = ?`).all(epochId).map((row) => ({
			lifecyclePk: row.lifecycle_pk,
			sourceRevision: row.source_revision
		}));
	}
	getProjectionProgress() {
		const row = this.db.prepare(`SELECT projection_version, phase, discovered_sessions, completed_sessions, scanning_sessions,
              retrying_sessions, failed_sessions, started_at_ms, completed_at_ms, last_error_code, last_error_message
       FROM projection_state WHERE singleton_id = 1`).get();
		if (row === void 0) return {
			phase: "initializing",
			discoveredSessions: 0,
			completedSessions: 0,
			scanningSessions: 0,
			retryingSessions: 0,
			failedSessions: 0,
			startedAtMs: null,
			completedAtMs: null,
			lastErrorCode: null,
			lastErrorMessage: null
		};
		if (row.projection_version > 1) throw new ProjectionTooNewError(`projection too new: ${row.projection_version}`);
		return {
			phase: row.phase,
			discoveredSessions: row.discovered_sessions,
			completedSessions: row.completed_sessions,
			scanningSessions: row.scanning_sessions,
			retryingSessions: row.retrying_sessions,
			failedSessions: row.failed_sessions,
			startedAtMs: row.started_at_ms,
			completedAtMs: row.completed_at_ms,
			lastErrorCode: row.last_error_code,
			lastErrorMessage: row.last_error_message
		};
	}
	updateProjectionProgress(update, now = Date.now()) {
		this.transaction(() => {
			const next = {
				...this.getProjectionProgress(),
				...update,
				updatedAtMs: now
			};
			this.db.prepare(`UPDATE projection_state SET
           projection_version = ?,
           phase = ?,
           discovered_sessions = ?,
           completed_sessions = ?,
           scanning_sessions = ?,
           retrying_sessions = ?,
           failed_sessions = ?,
           started_at_ms = ?,
           completed_at_ms = ?,
           last_error_code = ?,
           last_error_message = ?,
           updated_at_ms = ?
         WHERE singleton_id = 1`).run(1, next.phase, next.discoveredSessions, next.completedSessions, next.scanningSessions, next.retryingSessions, next.failedSessions, next.startedAtMs, next.completedAtMs, next.lastErrorCode, next.lastErrorMessage, next.updatedAtMs);
		});
		this.bumpState();
	}
	setProjectionReady(now = Date.now()) {
		this.updateProjectionProgress({
			phase: "ready",
			completedAtMs: now,
			scanningSessions: 0,
			retryingSessions: 0
		});
	}
	warnings() {
		return this.db.prepare(`SELECT reason_code, COUNT(*) AS count FROM ingestion_error GROUP BY reason_code ORDER BY reason_code`).all().map((row) => ({
			code: row.reason_code,
			count: row.count
		}));
	}
	snapshot(query, pendingBatches, now = Date.now()) {
		const progress = this.getProjectionProgress();
		const facts = this.db.prepare(`SELECT lifecycle_pk, turn, step, source_seq, occurred_at_ms, provider, model,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
       FROM usage_fact`).all();
		const todayKey = dayKeyOf(now, "local");
		const fromDate = shiftDateKey(todayKey, -((query.offsetWeeks + query.weeks) * 7) + 1);
		const toDate = shiftDateKey(todayKey, -query.offsetWeeks * 7);
		const dayAgg = /* @__PURE__ */ new Map();
		const windowModelTotals = /* @__PURE__ */ new Map();
		const sessions = /* @__PURE__ */ new Set();
		let today = 0;
		let week = 0;
		let month30 = 0;
		let all = 0;
		let cacheReadAll = 0;
		for (const fact of facts) {
			const tokens = fact.input_tokens + fact.output_tokens + fact.cache_read_tokens;
			all += tokens;
			cacheReadAll += fact.cache_read_tokens;
			sessions.add(fact.lifecycle_pk);
			const date = dayKeyOf(fact.occurred_at_ms, "local");
			if (date === todayKey) today += tokens;
			if (date > shiftDateKey(todayKey, -7) && date <= todayKey) week += tokens;
			if (date > shiftDateKey(todayKey, -30) && date <= todayKey) month30 += tokens;
			if (date >= fromDate && date <= toDate) {
				let day = dayAgg.get(date);
				if (day === void 0) {
					day = {
						totalTokens: 0,
						inputTokens: 0,
						outputTokens: 0,
						cacheReadTokens: 0,
						requests: 0,
						modelTotals: /* @__PURE__ */ new Map()
					};
					dayAgg.set(date, day);
				}
				day.totalTokens += tokens;
				day.inputTokens += fact.input_tokens;
				day.outputTokens += fact.output_tokens;
				day.cacheReadTokens += fact.cache_read_tokens;
				day.requests += 1;
				const provider = fact.provider ?? "unknown";
				const model = fact.model ?? "unknown";
				provider + "" + model;
				const modelKey = provider + "\0" + model;
				const dayEntry = day.modelTotals.get(modelKey);
				if (dayEntry === void 0) day.modelTotals.set(modelKey, {
					provider,
					model,
					tokens
				});
				else day.modelTotals.set(modelKey, {
					provider: dayEntry.provider,
					model: dayEntry.model,
					tokens: dayEntry.tokens + tokens
				});
				const windowEntry = windowModelTotals.get(modelKey);
				if (windowEntry === void 0) windowModelTotals.set(modelKey, {
					provider,
					model,
					tokens
				});
				else windowModelTotals.set(modelKey, {
					provider: windowEntry.provider,
					model: windowEntry.model,
					tokens: windowEntry.tokens + tokens
				});
			}
		}
		const days = [];
		for (let date = fromDate; date <= toDate; date = shiftDateKey(date, 1)) {
			const agg = dayAgg.get(date);
			if (agg === void 0) {
				days.push({
					date,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					requests: 0,
					byModel: [],
					otherModelCount: 0,
					otherModelTokens: 0
				});
				continue;
			}
			const models = [...agg.modelTotals.values()].sort(modelSort);
			const top = models.slice(0, 3);
			const otherModelCount = Math.max(0, models.length - 3);
			const otherModelTokens = models.slice(3).reduce((sum, entry) => sum + entry.tokens, 0);
			days.push({
				date,
				totalTokens: agg.totalTokens,
				inputTokens: agg.inputTokens,
				outputTokens: agg.outputTokens,
				cacheReadTokens: agg.cacheReadTokens,
				requests: agg.requests,
				byModel: top,
				otherModelCount,
				otherModelTokens
			});
		}
		const windowModels = [...windowModelTotals.values()].sort(modelSort);
		const topModels = windowModels.slice(0, 100);
		const otherModelCount = Math.max(0, windowModels.length - 100);
		const otherModelTokens = windowModels.slice(100).reduce((sum, entry) => sum + entry.tokens, 0);
		const browserPhase = progress.phase === "rebuild_required" || progress.phase === "error" ? "degraded" : progress.phase;
		const warnings = this.warnings();
		const totalWarnings = warnings.reduce((sum, entry) => sum + entry.count, 0);
		return {
			contractVersion: 1,
			asOf: {
				committedAtMs: Date.now(),
				commitGeneration: this.commitGeneration,
				stateGeneration: this.stateGeneration
			},
			query: {
				weeks: query.weeks,
				offsetWeeks: query.offsetWeeks,
				timezone: "local",
				fromDate,
				toDate
			},
			projection: {
				phase: browserPhase,
				complete: progress.phase === "ready",
				pendingBatches,
				progress: {
					discoveredSessions: progress.discoveredSessions,
					completedSessions: progress.completedSessions,
					scanningSessions: progress.scanningSessions,
					retryingSessions: progress.retryingSessions,
					failedSessions: progress.failedSessions,
					startedAtMs: progress.startedAtMs,
					completedAtMs: progress.completedAtMs
				}
			},
			summary: {
				today,
				week,
				month30,
				all,
				cacheReadAll,
				sessionCount: sessions.size
			},
			days,
			byModel: {
				items: topModels,
				otherModelCount,
				otherModelTokens
			},
			warnings: {
				count: totalWarnings,
				byCode: warnings
			}
		};
	}
};
function modelSort(a, b) {
	if (a.tokens !== b.tokens) return b.tokens - a.tokens;
	if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
	return a.model.localeCompare(b.model);
}
//#endregion
//#region src/host/usage-worker.ts
const UNKNOWN_COMMAND = "unknown_command";
const PROTOCOL_MISMATCH = "protocol_mismatch";
const GENERATION_MISMATCH = "generation_mismatch";
const WORKER_UNAVAILABLE = "worker_unavailable";
/**
* Serialized command dispatcher over a SqliteUsageStore. The Worker thread
* feeds every incoming command through `handle()`; commands execute one at a
* time in arrival order.
*/
var UsageWorker = class {
	port;
	defaultDbPath;
	store = null;
	chain = Promise.resolve();
	hostGeneration = null;
	constructor(port, defaultDbPath) {
		this.port = port;
		this.defaultDbPath = defaultDbPath;
	}
	/** Enqueue a command without blocking the caller. */
	handle(command) {
		this.chain = this.chain.then(() => this.dispatch(command));
	}
	async dispatch(command) {
		try {
			this.assertProtocol(command);
			if (command.type === "init") {
				if (this.store !== null) {
					this.reply(command.requestId, {
						ok: false,
						error: {
							code: "already_initialized",
							message: "worker already initialized",
							retryable: false
						}
					});
					return;
				}
				const dbPath = this.defaultDbPath ?? command.dbPath;
				this.store = new SqliteUsageStore(dbPath);
				this.hostGeneration = command.hostGeneration;
				this.reply(command.requestId, {
					ok: true,
					value: { ready: true }
				});
				return;
			}
			if (this.store === null || this.hostGeneration === null) {
				this.reply(command.requestId, {
					ok: false,
					error: {
						code: WORKER_UNAVAILABLE,
						message: "worker is not initialized",
						retryable: true
					}
				});
				return;
			}
			if (command.hostGeneration !== this.hostGeneration) {
				this.reply(command.requestId, {
					ok: false,
					error: {
						code: GENERATION_MISMATCH,
						message: "host generation mismatch",
						retryable: false
					}
				});
				return;
			}
			switch (command.type) {
				case "project": {
					const result = this.store.projectBatch(command.batch);
					this.reply(command.requestId, {
						ok: true,
						value: result
					});
					return;
				}
				case "snapshot": {
					const snapshot = this.store.snapshot(command.query, command.pendingBatches);
					this.reply(command.requestId, {
						ok: true,
						value: snapshot
					});
					return;
				}
				case "get_generation":
					this.reply(command.requestId, {
						ok: true,
						value: {
							commitGeneration: this.store.commitGenerationValue,
							stateGeneration: this.store.stateGenerationValue
						}
					});
					return;
				case "drain":
					this.reply(command.requestId, {
						ok: true,
						value: {
							commitGeneration: this.store.commitGenerationValue,
							stateGeneration: this.store.stateGenerationValue
						}
					});
					return;
				case "shutdown":
					this.store.close();
					this.store = null;
					this.hostGeneration = null;
					this.reply(command.requestId, {
						ok: true,
						value: { closed: true }
					});
					return;
				case "begin_run": {
					const epochId = this.store.beginRunEpoch(command.startedAtMs);
					this.reply(command.requestId, {
						ok: true,
						value: { epochId }
					});
					return;
				}
				case "activate_run":
					this.store.activateRunEpoch(command.epochId, command.baselines);
					this.reply(command.requestId, {
						ok: true,
						value: { activated: true }
					});
					return;
				case "mark_run_clean":
					this.store.markRunClean(command.epochId, command.cleanAtMs);
					this.reply(command.requestId, {
						ok: true,
						value: { clean: true }
					});
					return;
				case "get_last_run":
					this.reply(command.requestId, {
						ok: true,
						value: this.store.getLastRunEpoch() ?? null
					});
					return;
				case "upsert_lifecycle": {
					const lifecyclePk = this.store.upsertLifecycle(command.lifecycle, command.discoveredAtMs);
					this.reply(command.requestId, {
						ok: true,
						value: { lifecyclePk }
					});
					return;
				}
				case "get_lifecycle": {
					const lifecyclePk = this.store.getLifecycle(command.lifecycle);
					this.reply(command.requestId, {
						ok: true,
						value: { lifecyclePk: lifecyclePk ?? null }
					});
					return;
				}
				case "get_checkpoint":
					this.reply(command.requestId, {
						ok: true,
						value: this.store.getCheckpoint(command.lifecyclePk)
					});
					return;
				case "get_projection_progress":
					this.reply(command.requestId, {
						ok: true,
						value: this.store.getProjectionProgress()
					});
					return;
				case "update_projection_progress":
					this.store.updateProjectionProgress(command.update, command.now);
					this.reply(command.requestId, {
						ok: true,
						value: { updated: true }
					});
					return;
				case "set_projection_ready":
					this.store.setProjectionReady(command.now);
					this.reply(command.requestId, {
						ok: true,
						value: { ready: true }
					});
					return;
				case "get_baselines":
					this.reply(command.requestId, {
						ok: true,
						value: this.store.getBaselines(command.epochId)
					});
					return;
				default: {
					const unknown = command;
					this.reply(unknown.requestId, {
						ok: false,
						error: {
							code: UNKNOWN_COMMAND,
							message: "unknown command",
							retryable: false
						}
					});
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code = error instanceof ProjectionGapError ? "projection_gap" : message.startsWith(PROTOCOL_MISMATCH) ? PROTOCOL_MISMATCH : error instanceof Error ? error.name : "worker_error";
			this.reply(command.requestId, {
				ok: false,
				error: {
					code,
					message,
					retryable: !(error instanceof ProjectionGapError)
				}
			});
		}
	}
	assertProtocol(command) {
		if (command.protocolVersion !== 1) throw new Error(`${PROTOCOL_MISMATCH}: expected 1, got ${String(command.protocolVersion)}`);
	}
	reply(requestId, result) {
		this.port.postMessage({
			...result,
			requestId
		});
	}
};
/** Entry point used by the actual Worker thread. */
function runUsageWorker(port = parentPort, dbPath) {
	const worker = new UsageWorker(port, dbPath);
	parentPort?.on?.("message", (value) => {
		worker.handle(value);
	});
	return worker;
}
if (typeof parentPort !== "undefined" && parentPort !== null) runUsageWorker();
//#endregion
export { UsageWorker, runUsageWorker };

//# sourceMappingURL=usage-worker.js.map