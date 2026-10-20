// Persistent usage Worker — owns node:sqlite and the serialized command queue.
//
// The host half never touches SQLite. This entry is built as
// `lib/usage-worker.js` and loaded by `new Worker(new URL('./usage-worker.js', import.meta.url))`.

import { parentPort } from 'node:worker_threads'
import { PROTOCOL_VERSION, type WorkerCommand, type WorkerResult } from '../durable/contracts'
import { ProjectionGapError, SqliteUsageStore } from '../durable/sqlite-store'

/** Minimal parent-port shape so the command loop is testable without threads. */
export interface WorkerPortLike {
  postMessage(value: unknown): void
}

const UNKNOWN_COMMAND = 'unknown_command'
const PROTOCOL_MISMATCH = 'protocol_mismatch'
const GENERATION_MISMATCH = 'generation_mismatch'
const WORKER_UNAVAILABLE = 'worker_unavailable'

/**
 * Serialized command dispatcher over a SqliteUsageStore. The Worker thread
 * feeds every incoming command through `handle()`; commands execute one at a
 * time in arrival order.
 */
export class UsageWorker {
  private store: SqliteUsageStore | null = null
  private chain: Promise<void> = Promise.resolve()
  private hostGeneration: string | null = null

  constructor(
    private readonly port: WorkerPortLike,
    private readonly defaultDbPath?: string,
  ) {}

  /** Enqueue a command without blocking the caller. */
  handle(command: WorkerCommand): void {
    this.chain = this.chain.then(() => this.dispatch(command))
  }

  private async dispatch(command: WorkerCommand): Promise<void> {
    try {
      this.assertProtocol(command)
      if (command.type === 'init') {
        if (this.store !== null) {
          this.reply(command.requestId, { ok: false, error: { code: 'already_initialized', message: 'worker already initialized', retryable: false } })
          return
        }
        const dbPath = this.defaultDbPath ?? command.dbPath
        this.store = new SqliteUsageStore(dbPath)
        this.hostGeneration = command.hostGeneration
        this.reply(command.requestId, { ok: true, value: { ready: true } })
        return
      }
      if (this.store === null || this.hostGeneration === null) {
        this.reply(command.requestId, { ok: false, error: { code: WORKER_UNAVAILABLE, message: 'worker is not initialized', retryable: true } })
        return
      }
      if (command.hostGeneration !== this.hostGeneration) {
        this.reply(command.requestId, { ok: false, error: { code: GENERATION_MISMATCH, message: 'host generation mismatch', retryable: false } })
        return
      }
      switch (command.type) {
        case 'project': {
          const result = this.store.projectBatch(command.batch)
          this.reply(command.requestId, { ok: true, value: result })
          return
        }
        case 'snapshot': {
          const snapshot = this.store.snapshot(command.query, command.pendingBatches)
          this.reply(command.requestId, { ok: true, value: snapshot })
          return
        }
        case 'get_generation': {
          this.reply(command.requestId, {
            ok: true,
            value: { commitGeneration: this.store.commitGenerationValue, stateGeneration: this.store.stateGenerationValue },
          })
          return
        }
        case 'drain': {
          this.reply(command.requestId, {
            ok: true,
            value: { commitGeneration: this.store.commitGenerationValue, stateGeneration: this.store.stateGenerationValue },
          })
          return
        }
        case 'shutdown': {
          this.store.close()
          this.store = null
          this.hostGeneration = null
          this.reply(command.requestId, { ok: true, value: { closed: true } })
          return
        }
        case 'begin_run': {
          const epochId = this.store.beginRunEpoch(command.startedAtMs)
          this.reply(command.requestId, { ok: true, value: { epochId } })
          return
        }
        case 'activate_run': {
          this.store.activateRunEpoch(command.epochId, command.baselines as never)
          this.reply(command.requestId, { ok: true, value: { activated: true } })
          return
        }
        case 'mark_run_clean': {
          this.store.markRunClean(command.epochId, command.cleanAtMs)
          this.reply(command.requestId, { ok: true, value: { clean: true } })
          return
        }
        case 'get_last_run': {
          this.reply(command.requestId, { ok: true, value: this.store.getLastRunEpoch() ?? null })
          return
        }
        case 'upsert_lifecycle': {
          const lifecyclePk = this.store.upsertLifecycle(command.lifecycle, command.discoveredAtMs)
          this.reply(command.requestId, { ok: true, value: { lifecyclePk } })
          return
        }
        case 'get_lifecycle': {
          const lifecyclePk = this.store.getLifecycle(command.lifecycle)
          this.reply(command.requestId, { ok: true, value: { lifecyclePk: lifecyclePk ?? null } })
          return
        }
        case 'get_checkpoint': {
          this.reply(command.requestId, { ok: true, value: this.store.getCheckpoint(command.lifecyclePk) })
          return
        }
        case 'get_projection_progress': {
          this.reply(command.requestId, { ok: true, value: this.store.getProjectionProgress() })
          return
        }
        case 'update_projection_progress': {
          this.store.updateProjectionProgress(command.update as never, command.now)
          this.reply(command.requestId, { ok: true, value: { updated: true } })
          return
        }
        case 'set_projection_ready': {
          this.store.setProjectionReady(command.now)
          this.reply(command.requestId, { ok: true, value: { ready: true } })
          return
        }
        case 'get_baselines': {
          this.reply(command.requestId, { ok: true, value: this.store.getBaselines(command.epochId) })
          return
        }
        default: {
          const unknown = command as WorkerCommand
          this.reply(unknown.requestId, { ok: false, error: { code: UNKNOWN_COMMAND, message: 'unknown command', retryable: false } })
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof ProjectionGapError
        ? 'projection_gap'
        : message.startsWith(PROTOCOL_MISMATCH)
          ? PROTOCOL_MISMATCH
          : error instanceof Error
            ? error.name
            : 'worker_error'
      this.reply(command.requestId, {
        ok: false,
        error: { code, message, retryable: !(error instanceof ProjectionGapError) },
      })
    }
  }

  private assertProtocol(command: WorkerCommand): void {
    if (command.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`${PROTOCOL_MISMATCH}: expected ${PROTOCOL_VERSION}, got ${String(command.protocolVersion)}`)
    }
  }

  private reply(requestId: string, result: { ok: boolean; value?: unknown; error?: { code: string; message: string; retryable: boolean } }): void {
    this.port.postMessage({ ...result, requestId } as WorkerResult)
  }
}

/** Entry point used by the actual Worker thread. */
export function runUsageWorker(port: WorkerPortLike = parentPort as unknown as WorkerPortLike, dbPath?: string): UsageWorker {
  const worker = new UsageWorker(port, dbPath)
  ;(parentPort as unknown as { on(event: string, listener: (value: unknown) => void): void } | undefined)?.on?.('message', (value: unknown) => {
    worker.handle(value as WorkerCommand)
  })
  return worker
}

if (typeof parentPort !== 'undefined' && parentPort !== null) {
  runUsageWorker()
}
