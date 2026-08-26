// Commit 8 gate: snapshot route contract, inflight coalescing and cache.
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SnapshotQuery, SnapshotV1 } from '../src/durable/contracts'
import { registerSnapshotRoute, type SnapshotProvider } from '../src/durable/snapshot-route'

function fakeSnapshot(overrides: Partial<SnapshotV1> = {}): SnapshotV1 {
  return {
    contractVersion: 1,
    asOf: { committedAtMs: 1, commitGeneration: 1, stateGeneration: 1 },
    query: { weeks: 26, offsetWeeks: 0, timezone: 'local', fromDate: '2026-01-01', toDate: '2026-07-01' },
    projection: { phase: 'ready', complete: true, pendingBatches: 0, progress: { discoveredSessions: 1, completedSessions: 1, scanningSessions: 0, retryingSessions: 0, failedSessions: 0, startedAtMs: 1, completedAtMs: 1 } },
    summary: { today: 0, week: 0, month30: 0, all: 0, cacheReadAll: 0, sessionCount: 0 },
    days: [],
    byModel: { items: [], otherModelCount: 0, otherModelTokens: 0 },
    warnings: { count: 0, byCode: [] },
    ...overrides,
  }
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {} as Record<string, string | number>,
    body: '',
    setHeader(name: string, value: string | number) {
      this.headers[name] = value
    },
    writeHead(status: number, headers: Record<string, string | number>) {
      this.status = status
      this.headers = { ...this.headers, ...headers }
    },
    end(body: string) {
      this.body = body
    },
  }
  return res as unknown as ServerResponse & { status: number; headers: Record<string, string | number>; body: string }
}

function fakeCtx(provider: SnapshotProvider) {
  let handler: ((req: IncomingMessage, res: ServerResponse) => void | Promise<void>) | undefined
  const ctx = {
    webServer: {
      register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
        handler = route.handler
        return () => { handler = undefined }
      },
    },
  }
  return {
    ctx: ctx as unknown as Parameters<typeof registerSnapshotRoute>[0],
    get handler() { return handler! },
    async call(url: string) {
      const req = { url } as IncomingMessage
      const res = fakeRes()
      await handler!(req, res)
      return res
    },
  }
}

describe('snapshot route', () => {
  it('returns 200 with no-store for a valid snapshot', async () => {
    const calls: SnapshotQuery[] = []
    const provider: SnapshotProvider = {
      snapshot: async (query) => {
        calls.push(query)
        return fakeSnapshot()
      },
      revision: async () => ({ commitGeneration: 1, stateGeneration: 1 }),
    }
    const fx = fakeCtx(provider)
    registerSnapshotRoute(fx.ctx, provider)
    const res = await fx.call('/api/token-dashboard/snapshot?weeks=26&offsetWeeks=0')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(res.body).ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('returns 400 for invalid query parameters', async () => {
    const provider: SnapshotProvider = {
      snapshot: async () => fakeSnapshot(),
      revision: async () => ({ commitGeneration: 1, stateGeneration: 1 }),
    }
    const fx = fakeCtx(provider)
    registerSnapshotRoute(fx.ctx, provider)
    expect((await fx.call('/api/token-dashboard/snapshot?weeks=999')).status).toBe(400)
    expect((await fx.call('/api/token-dashboard/snapshot?offsetWeeks=-1')).status).toBe(400)
  })

  it('coalesces concurrent identical requests and caches the result', async () => {
    let resolveSnapshot!: (value: SnapshotV1) => void
    let calls = 0
    const provider: SnapshotProvider = {
      snapshot: () => {
        calls += 1
        return new Promise<SnapshotV1>((resolve) => { resolveSnapshot = resolve })
      },
      revision: async () => ({ commitGeneration: 1, stateGeneration: 1 }),
    }
    const fx = fakeCtx(provider)
    registerSnapshotRoute(fx.ctx, provider)
    const first = fx.call('/api/token-dashboard/snapshot?weeks=26&offsetWeeks=0')
    const second = fx.call('/api/token-dashboard/snapshot?weeks=26&offsetWeeks=0')
    // Let both handlers pass the revision() hop before snapshot() is called.
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveSnapshot(fakeSnapshot())
    const [res1, res2] = await Promise.all([first, second])
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    expect(calls).toBe(1)
    // Cache hit: a third request must not call the provider again.
    const third = await fx.call('/api/token-dashboard/snapshot?weeks=26&offsetWeeks=0')
    expect(third.status).toBe(200)
    expect(calls).toBe(1)
  })

  it('re-queries the provider once the store generation advances', async () => {
    // Regression: the key was built from the last SERVED generation, which
    // only advanced when the provider ran. The first request of a local day
    // therefore cached a (possibly mid-scan) snapshot and every later
    // refresh hit the same key forever.
    const generation = { commitGeneration: 1, stateGeneration: 1 }
    let calls = 0
    const provider: SnapshotProvider = {
      revision: async () => ({ ...generation }),
      snapshot: async () => {
        calls += 1
        return fakeSnapshot({
          asOf: {
            committedAtMs: calls,
            commitGeneration: generation.commitGeneration,
            stateGeneration: generation.stateGeneration,
          },
        })
      },
    }
    const fx = fakeCtx(provider)
    registerSnapshotRoute(fx.ctx, provider)
    const first = await fx.call('/api/token-dashboard/snapshot?weeks=26&offsetWeeks=0')
    expect(first.status).toBe(200)
    expect(calls).toBe(1)
    const cached = await fx.call('/api/token-dashboard/snapshot?weeks=26&offsetWeeks=0')
    expect(cached.status).toBe(200)
    expect(calls).toBe(1)
    generation.commitGeneration = 2
    const second = await fx.call('/api/token-dashboard/snapshot?weeks=26&offsetWeeks=0')
    expect(second.status).toBe(200)
    expect(calls).toBe(2)
    expect(JSON.parse(second.body).value.asOf.commitGeneration).toBe(2)
  })

  it('returns 503 for provider errors and does not leak stacks', async () => {
    const provider: SnapshotProvider = {
      snapshot: async () => { throw new Error('secret stack') },
      revision: async () => ({ commitGeneration: 1, stateGeneration: 1 }),
    }
    const fx = fakeCtx(provider)
    registerSnapshotRoute(fx.ctx, provider)
    const res = await fx.call('/api/token-dashboard/snapshot?weeks=26&offsetWeeks=0')
    expect(res.status).toBe(503)
    expect(res.body).not.toContain('secret stack')
  })

  it('returns 503 when the revision query fails', async () => {
    const provider: SnapshotProvider = {
      snapshot: async () => fakeSnapshot(),
      revision: async () => { throw new Error('circuit open') },
    }
    const fx = fakeCtx(provider)
    registerSnapshotRoute(fx.ctx, provider)
    const res = await fx.call('/api/token-dashboard/snapshot?weeks=26&offsetWeeks=0')
    expect(res.status).toBe(503)
    expect(res.body).not.toContain('circuit open')
  })
})
