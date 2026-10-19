// PersistenceSeam gate: `ctx.sessionPersistence` is re-shaped between DSH
// releases, so the seam must adapt both generations onto one vocabulary —
// and pick the right one when a build exposes both.
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { PersistenceSeam, type PersistenceLike } from '../src/durable/init-recovery'

const event = (seq: number): SessionEvent => ({ type: 'assistant/message', seq, time: 0, data: {} }) as unknown as SessionEvent

/** Minimal handle-backed service, the generation shipped by current DSH builds. */
function handlePersistence(events: SessionEvent[]) {
  const close = vi.fn(async () => {})
  const read = vi.fn(async (offset = 0) => ({ events: events.filter((entry) => entry.seq >= offset) }))
  const open = vi.fn(async () => ({ header: { id: 's1', createdAt: 1, cwd: '/p' }, read, close }))
  const list = vi.fn(async () => [{ header: { id: 's1', createdAt: 1, cwd: '/p' }, revision: 'r1' }])
  return { service: { list, open } satisfies PersistenceLike, list, open, read, close }
}

/** Minimal snapshot-backed service, the 0.1.0-rc.6 generation. */
function snapshotPersistence(events: SessionEvent[]) {
  const readFrom = vi.fn(async (_id: string, fromSeq: number) => ({
    meta: { id: 's1', createdAt: 1, cwd: '/p' },
    events: events.filter((entry) => entry.seq >= fromSeq),
  }))
  const listSnapshots = vi.fn(async () => [{ header: { id: 's1', createdAt: 1, cwd: '/p' }, revision: 'r1' }])
  return { service: { listSnapshots, readFrom } satisfies PersistenceLike, listSnapshots, readFrom }
}

describe('PersistenceSeam', () => {
  it('reads a handle-backed service through open/read/close', async () => {
    const backend = handlePersistence([event(0), event(1), event(2)])
    const seam = new PersistenceSeam(backend.service)

    expect(seam.generation).toBe('handle')
    await expect(seam.listSnapshots()).resolves.toEqual([
      { header: { id: 's1', createdAt: 1, cwd: '/p' }, revision: 'r1' },
    ])
    await expect(seam.readFrom('s1', 1)).resolves.toHaveLength(2)

    expect(backend.open).toHaveBeenCalledWith('s1', 'read', { signal: undefined })
    expect(backend.read).toHaveBeenCalledWith(1, undefined, { signal: undefined })
    expect(backend.close).toHaveBeenCalledTimes(1)
  })

  it('closes the read handle even when the read fails', async () => {
    const backend = handlePersistence([event(0)])
    backend.read.mockRejectedValueOnce(new Error('boom'))
    const seam = new PersistenceSeam(backend.service)

    await expect(seam.readFrom('s1', 0)).rejects.toThrow('boom')
    expect(backend.close).toHaveBeenCalledTimes(1)
  })

  it('prefers listSnapshots when a build exposes both generations', async () => {
    // 0.1.0-rc.6 has listSnapshots *and* a list() that returns bare headers
    // without revisions; reading snapshots off list() would lose the revision.
    const backend = handlePersistence([event(0)])
    const legacy = snapshotPersistence([event(0)])
    const seam = new PersistenceSeam({ ...backend.service, ...legacy.service })

    expect(seam.generation).toBe('snapshot')
    await expect(seam.listSnapshots()).resolves.toEqual([
      { header: { id: 's1', createdAt: 1, cwd: '/p' }, revision: 'r1' },
    ])
    await expect(seam.readFrom('s1', 0)).resolves.toHaveLength(1)

    expect(legacy.listSnapshots).toHaveBeenCalledTimes(1)
    expect(legacy.readFrom).toHaveBeenCalledTimes(1)
    expect(backend.list).not.toHaveBeenCalled()
    expect(backend.open).not.toHaveBeenCalled()
  })

  it('fails loudly when the service exposes neither generation', async () => {
    const seam = new PersistenceSeam({} satisfies PersistenceLike)

    expect(seam.generation).toBe('unsupported')
    await expect(seam.listSnapshots()).rejects.toThrow(/neither listSnapshots\(\) nor list\(\)/)
    await expect(seam.readFrom('s1', 0)).rejects.toThrow(/neither readFrom\(\) nor open\(\)/)
  })
})