import { describe, expect, it } from 'vitest'
import { expandContextSurface, expandFromReachedPoint, type ContextNode } from '../packages/server/src/task-controller/context-page.js'

const stage = (id: string, links: string[], text = id): ContextNode => ({ source: 'stage', id, text, links })
const message = (id: string, links: string[], text = id): ContextNode => ({ source: 'conversation', id, text, links })

describe('context surface', () => {
  it('grows from the anchor along links and leaves uncited conversation outside', () => {
    const nodes = [
      stage('setup', ['setup', 'criterion-1']),
      stage('unrelated', ['unrelated', 'criterion-9']),
      message('constraint', ['criterion-1'], 'Do not rewrite tests while reading source'),
      message('aside', [], 'NEVER modify tests'),
    ]
    const surface = expandContextSurface(['read', 'criterion-1', 'setup'], nodes)
    expect(surface.hits.map((hit) => hit.id)).toEqual(['setup', 'constraint'])
    expect(surface.hits.map((hit) => hit.ring)).toEqual([1, 1])
    expect(surface.remaining).toEqual([])
  })

  it('keeps the remainder of the current ring instead of jumping to a farther record', () => {
    const nodes = [
      ...Array.from({ length: 9 }, (_, index) => stage(`dep-${index}`, [`dep-${index}`, `evidence-${index}`], `dependency ${index}`)),
      message('later', ['evidence-0'], 'a cite that belongs to the next ring'),
    ]
    const surface = expandContextSurface(['active', ...Array.from({ length: 9 }, (_, index) => `dep-${index}`)], nodes, 8)
    expect(surface.hits.map((hit) => hit.id)).toEqual(Array.from({ length: 8 }, (_, index) => `dep-${index}`))
    expect(surface.remaining).toEqual([{ source: 'stage', id: 'dep-8', ring: 1 }])
    expect(surface.hits.some((hit) => hit.id === 'later')).toBe(false)
  })

  it('keeps a long snippet inside the surface bound', () => {
    const surface = expandContextSurface(['read'], [stage('read', ['read'], `source ${'字'.repeat(800)}`)])
    expect([...surface.hits[0]!.text].length).toBe(500)
  })

  it('expands only from a point the current surface already reached', () => {
    const nodes = [
      ...Array.from({ length: 9 }, (_, index) => stage(`dep-${index}`, [`dep-${index}`], `dependency ${index}`)),
      message('later', ['missing'], 'not on the surface'),
    ]
    const anchor = ['active', ...Array.from({ length: 9 }, (_, index) => `dep-${index}`)]
    expect(expandFromReachedPoint(anchor, nodes, 'dep-8').hits[0]).toMatchObject({ id: 'dep-8', ring: 1 })
    expect(() => expandFromReachedPoint(anchor, nodes, 'later')).toThrow('POINT_NOT_REACHED')
    expect(() => expandFromReachedPoint(anchor, nodes, 'message-99')).toThrow('POINT_NOT_REACHED')
  })
  it('reaches a record that cites the previous ring on the next ring', () => {
    const nodes = [
      stage('setup', ['setup', 'source.txt']),
      message('follow-up', ['source.txt'], 'Check source.txt'),
    ]
    const surface = expandContextSurface(['read', 'setup'], nodes)
    expect(surface.hits.map((hit) => [hit.id, hit.ring])).toEqual([['setup', 1], ['follow-up', 2]])
  })
})
