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
import { UsageCollector } from './durable/collector'
import { diag } from './durable/diag'
import { InitRecoveryCoordinator, WorkerCoordinatorStore, type PersistenceLike } from './durable/init-recovery'
import { canonicalDbPath, tokenDashboardDir } from './durable/maintenance'
import { registerSnapshotRoute } from './durable/snapshot-route'
import { UsageWorkerClient } from './durable/worker-client'

/** Required services: HTTP routes, persistence seam and live session store. */
export const inject = ['webServer', 'sessionPersistence', 'sessions']

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
      flush: {
        flush: (session) => ctx.sessions.flush(session as never),
      },
      worker,
    })
    const coordinator = new InitRecoveryCoordinator({
      store: new WorkerCoordinatorStore(worker),
      // The persistence service is re-shaped between DSH releases; PersistenceSeam
      // detects the mounted generation and is the only place that reads these fields.
      persistence: ctx.sessionPersistence as unknown as PersistenceLike,
      collector,
      worker,
      generation,
    })

    const onEvent = (session: unknown, event: unknown): void => {
      collector.onEvent(session as never, event as never)
    }
    const disposeListener = ctx.on('session/event', onEvent)
    diag('host', 'session/event listener registered')
    const disposeRoutes = registerSnapshotRoute(ctx, worker)

    // Only a run that armed its epoch may be recorded as a clean exit: a startup
    // that failed before arming must stay `arming`, so the next run recovers from
    // the checkpoints instead of trusting this one's silence.
    let armed = false
    void (async () => {
      try {
        const t0 = Date.now()
        await worker.start()
        diag('host', `worker started in ${Date.now() - t0}ms`)
        await coordinator.arm()
        diag('host', `armed in ${Date.now() - t0}ms (persistence seam: ${coordinator.persistenceGeneration})`)
        collector.start()
        armed = true
        void coordinator.scan().catch((error) => {
          console.error('dsh-token-dashboard: projection scan failed', error)
          diag('host', 'scan failed', error)
        })
      } catch (error) {
        console.error('dsh-token-dashboard: durable projection startup failed', error)
        diag('host', 'startup failed; live collection stays disabled', error)
      }
    })()

    return async () => {
      collector.stop()
      coordinator.abort()
      disposeListener()
      await collector.drain()
      await worker.drain()
      if (armed) {
        const lastRun = await worker.getLastRunEpoch().catch(() => null)
        if (lastRun !== null && lastRun.epochId !== undefined) {
          await worker.markRunClean(lastRun.epochId).catch(() => undefined)
        }
      }
      await worker.shutdown().catch(() => undefined)
      disposeRoutes()
    }
  }, 'dsh-token-dashboard: durable usage projection')
}
