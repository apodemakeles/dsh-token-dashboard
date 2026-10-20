// Snapshot route — the single panel read endpoint.
// Returns 200 for ready/initializing/recovering/degraded, 400 for bad query,
// 503 for unavailable/timeout/overflow/rebuild/error. It never triggers DSH
// scan/flush/backfill.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ErrorCodes, SNAPSHOT_TIMEOUT_MS, type GenerationInfo, type SnapshotQuery, type SnapshotV1 } from './contracts'

export interface SnapshotProvider {
  snapshot(query: SnapshotQuery): Promise<SnapshotV1>
  /** Cheap read of the store generations that invalidate every cached snapshot. */
  getGeneration(): Promise<GenerationInfo>
}

const DEFAULT_WEEKS = 26
const MAX_WEEKS = 52
const MAX_OFFSET_WEEKS = 10_000
const CACHE_MAX = 8

interface WebRouteLike {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://localhost').searchParams
}

/** Local calendar day; the store aggregates `today` and day buckets in local time. */
function localDateKey(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function intOf(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number | null {
  const raw = params.get(name)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) return null
  return value
}

export function registerSnapshotRoute(ctx: Context, provider: SnapshotProvider): () => void {
  const inflight = new Map<string, Promise<SnapshotV1>>()
  const cache = new Map<string, SnapshotV1>()

  const dispose = (ctx.webServer as unknown as WebRouteLike).register({
    kind: 'exact',
    path: '/api/token-dashboard/snapshot',
    handler: async (req, res) => {
      try {
        const params = queryOf(req)
        const weeks = intOf(params, 'weeks', DEFAULT_WEEKS, 1, MAX_WEEKS)
        if (weeks === null) return fail(res, 400, ErrorCodes.BadQuery, 'weeks must be an integer in [1, 52]')
        const offsetWeeks = intOf(params, 'offsetWeeks', 0, 0, MAX_OFFSET_WEEKS)
        if (offsetWeeks === null) return fail(res, 400, ErrorCodes.BadQuery, 'offsetWeeks must be a non-negative integer')
        const query: SnapshotQuery = { weeks, offsetWeeks }

        res.setHeader('cache-control', 'no-store')
        const localDate = localDateKey()
        // Read the live generation before consulting the cache. Deriving the key
        // from the last queried snapshot would pin the entry forever: a cache hit
        // never queries the Worker again, so it could never learn about a commit.
        const generation = await provider.getGeneration()
        const cacheKey = `${weeks}:${offsetWeeks}:${localDate}:${generation.commitGeneration}:${generation.stateGeneration}`
        const cached = cache.get(cacheKey)
        if (cached !== undefined) {
          return ok(res, cached)
        }

        let snapshotPromise = inflight.get(cacheKey)
        if (snapshotPromise === undefined) {
          snapshotPromise = Promise.race([
            provider.snapshot(query),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new SnapshotTimeoutError()), SNAPSHOT_TIMEOUT_MS)
            }),
          ])
          inflight.set(cacheKey, snapshotPromise)
        }
        try {
          const snapshot = await snapshotPromise
          const resultKey = `${weeks}:${offsetWeeks}:${localDate}:${snapshot.asOf.commitGeneration}:${snapshot.asOf.stateGeneration}`
          cache.set(resultKey, snapshot)
          if (cache.size > CACHE_MAX) {
            const oldest = cache.keys().next().value
            if (oldest !== undefined) cache.delete(oldest)
          }
          ok(res, snapshot)
        } finally {
          inflight.delete(cacheKey)
        }
      } catch (error) {
        if (error instanceof SnapshotTimeoutError) {
          fail(res, 503, ErrorCodes.SnapshotTimeout, 'snapshot timed out')
        } else {
          const code = error instanceof Error && error.message.includes('circuit') ? ErrorCodes.WorkerUnavailable : ErrorCodes.Internal
          fail(res, 503, code, 'snapshot unavailable')
        }
      }
    },
  })
  return dispose
}

class SnapshotTimeoutError extends Error {
  constructor() {
    super('snapshot timeout')
    this.name = 'SnapshotTimeoutError'
  }
}

function ok<T>(res: ServerResponse, value: T): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: true, value }))
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ ok: false, error: { code, message, retryable: status === 503 } }))
}
