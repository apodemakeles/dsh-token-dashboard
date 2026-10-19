// The sidebar capsule renders `summary.today` through fmt(), so the compact
// number the user reads every session is pinned here.
import { describe, expect, it } from 'vitest'
import { fmt } from '../src/client/fmt'

describe('fmt', () => {
  it('keeps small counts exact', () => {
    expect(fmt(0)).toBe('0')
    expect(fmt(1)).toBe('1')
    expect(fmt(999)).toBe('999')
  })

  it('compacts thousands and millions with one decimal', () => {
    expect(fmt(1_000)).toBe('1.0k')
    expect(fmt(715_430)).toBe('715.4k')
    expect(fmt(1_000_000)).toBe('1.0M')
    expect(fmt(111_434_181)).toBe('111.4M')
    expect(fmt(620_578_210)).toBe('620.6M')
  })
})