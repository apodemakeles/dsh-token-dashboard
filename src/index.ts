// @apodemakeles/dsh-token-dashboard — host half.
//
// Durable usage projection runtime:
//   session/event -> UsageCollector -> flush barrier -> UsageWorkerClient -> SQLite Worker
// plus the single snapshot route. The old TokenAggregator/summary/days scan
// path is removed in this cutover commit.

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { UsageCollector, type FlushService, type SessionLike } from './durable/collector'
import { InitRecoveryCoordinator, WorkerCoordinatorStore } from './durable/init-recovery'
import { canonicalDbPath, tokenDashboardDir } from './durable/maintenance'
import { registerSnapshotRoute, type SnapshotProvider } from './durable/snapshot-route'
import { UsageWorkerClient } from './durable/worker-client'

/** Required services: HTTP routes, persistence seam and live session store. */
export const inject = ['webServer', 'sessionPersistence', 'sessions']

/** Structural view of the live session store used by the flush barrier. */
export interface SessionStoreLike {
  /** Look up a live session by id; `undefined` once the session is disposed. */
  get(id: string): unknown
  /** Durability checkpoint for one live session. */
  flush(session: unknown): Promise<boolean>
}

/**
 * Build the collector's source-durability barrier on top of the session store.
 *
 * A session that is no longer live in the store has already persisted its
 * buffered events (the store drains a session before disposal), so its
 * barrier is already met. Projecting its batch via a bare `flush` call would
 * make the store reject the disposed session and the collector would drop
 * the batch with nothing to recover it; live sessions await `flush` as usual.
 */
export function createFlushService(sessions: SessionStoreLike): FlushService {
  return {
    flush(session: SessionLike): Promise<boolean> {
      const live = sessions.get(session.id)
      if (live === undefined) return Promise.resolve(true)
      return sessions.flush(live)
    },
  }
}

/** Mount the durable projection runtime and the single snapshot route. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const dir = tokenDashboardDir(home)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const generation = 'host-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    const worker = new UsageWorkerClient({ generation, dbPath: canonicalDbPath(home) })
    const collector = new UsageCollector({
      generation,
      flush: createFlushService(ctx.sessions),
      worker,
    })
    const coordinator = new InitRecoveryCoordinator({
      store: new WorkerCoordinatorStore(worker),
      persistence: ctx.sessionPersistence,
      generation,
    })

    const onEvent = (session: unknown, event: unknown): void => {
      collector.onEvent(session as never, event as never)
    }
    const disposeListener = ctx.on('session/event', onEvent)
    const snapshotProvider: SnapshotProvider = {
      snapshot: (query) => worker.snapshot(query),
      revision: () => worker.drain(),
    }
    const disposeRoutes = registerSnapshotRoute(ctx, snapshotProvider)

    void (async () => {
      try {
        await worker.start()
        await coordinator.arm()
        collector.start()
        void coordinator.scan().catch((error) => {
          console.error('dsh-token-dashboard: projection scan failed', error)
        })
      } catch (error) {
        console.error('dsh-token-dashboard: durable projection startup failed', error)
      }
    })()

    return async () => {
      collector.stop()
      coordinator.abort()
      disposeListener()
      await collector.drain()
      await worker.drain()
      const lastRun = await worker.getLastRunEpoch().catch(() => null)
      if (lastRun !== null && lastRun.epochId !== undefined) {
        await worker.markRunClean(lastRun.epochId).catch(() => undefined)
      }
      await worker.shutdown().catch(() => undefined)
      disposeRoutes()
    }
  }, 'dsh-token-dashboard: durable usage projection')
}
