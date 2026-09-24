import { describe, expect, it } from 'vitest'
import { acceptanceCriteriaFromObjective, hasTaskProgress } from '../packages/server/src/task.js'

describe('persisted task state helpers', () => {
  it('keeps filenames, URLs, and decimals intact when deriving criteria', () => {
    expect(acceptanceCriteriaFromObjective('Write report.md using https://example.com/docs/v1.2 and Python 3.12. Then run tests.').map((item) => item.description)).toEqual(['Write report.md using https://example.com/docs/v1.2 and Python 3.12.', 'Then run tests.'])
    expect(acceptanceCriteriaFromObjective('生成 report.md。检查内容。')).toHaveLength(2)
  })

  it('turns explicit list items into criteria and preserves overflow beyond the bounded list', () => {
    expect(acceptanceCriteriaFromObjective('只改样例。1. 复现问题。2. 修复代码。3. 验证。').map((item) => item.description)).toEqual(['只改样例。', '1. 复现问题。', '2. 修复代码。', '3. 验证。'])
    const listed = acceptanceCriteriaFromObjective('- Find the sources\n- Summarize the findings')
    expect(listed).toEqual([
      { id: 'criterion-1', description: 'Find the sources' },
      { id: 'criterion-2', description: 'Summarize the findings' },
    ])

    const longRequest = Array.from({ length: 40 }, (_, index) => `- Condition ${index + 1}`).join('\n')
    const bounded = acceptanceCriteriaFromObjective(longRequest)
    expect(bounded).toHaveLength(32)
    expect(bounded.at(-1)?.description).toContain('Condition 40')
  })

  it('treats unchanged candidates and unchanged evidence as no progress', () => {
    const first = { candidateResultRef: 'candidate-1', candidateHash: 'same', evidenceRefs: ['candidate-1', 'tool-1'] }
    const second = { candidateResultRef: 'candidate-2', candidateHash: 'same', evidenceRefs: ['candidate-1', 'candidate-2', 'tool-1'] }
    expect(hasTaskProgress(first, second, [first, second])).toBe(false)
    expect(hasTaskProgress(first, { ...second, evidenceRefs: [...second.evidenceRefs, 'tool-2'] }, [first, second])).toBe(true)
    expect(hasTaskProgress(first, { ...second, candidateHash: 'changed' }, [first, second])).toBe(true)
  })
})
