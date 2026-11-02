import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCheckEdit, captureCheck, finishCheck, freezeCheckDefinitions, repositoryTestChangesAllowed } from '../packages/server/src/check-receipt.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it.each(['合并软件更新与组件版本这两个页面', 'Merge the two settings pages', '修复界面并同步测试', 'Fixing the feature and its regressions'])('recognizes product-owned regression maintenance: %s', request => {
  expect(repositoryTestChangesAllowed(request)).toBe(true)
})
it.each(['合并页面但不要修改现有测试', 'Merge pages; do not rewrite tests', 'Fix the feature and preserve baseline tests', '检查页面为何未完成', '合并页面但不改测试', '合并页面，现有测试不可修改', 'Merge pages and preserve existing tests', "Fix the feature, don't modify tests", 'Verify feature.mjs in fixtures', 'Review the feature in prefixes'])('keeps explicit baselines and read-only tasks protected: %s', request => {
  expect(repositoryTestChangesAllowed(request)).toBe(false)
})
it('allows authorized repository test maintenance only with fresh execution and preserves stored immutable policies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-repo-test-')); roots.push(root)
  const store = join(root, '.host'), fixed = join(root, '.fixed'), file = 'tests/routing.test.cjs'
  await mkdir(join(root, 'tests'))
  await writeFile(join(root, file), 'const assert = require("node:assert"); assert.equal("old", "old")\n')
  await freezeCheckDefinitions(root, store, false, true, 4, true)
  await freezeCheckDefinitions(root, fixed, false, true, 4)
  const before = await captureCheck(root, root, 'node', ['--test', file], false, 4)
  const updated = 'const assert = require("node:assert"); assert.equal("merged", "merged")\n'
  await expect(assertCheckEdit(root, store, file, updated)).resolves.toBeUndefined()
  await expect(assertCheckEdit(root, fixed, file, updated)).rejects.toMatchObject({ code: 'FROZEN_TEST_CHANGE' })
  await writeFile(join(root, file), updated)
  expect((await finishCheck(root, before, store)).stable).toBe(false)
  const current = await captureCheck(root, root, 'node', ['--test', file], false, 4)
  expect(await finishCheck(root, current, store)).toMatchObject({ stable: true, definitionChanged: false })
  expect((await finishCheck(root, current, fixed)).definitionChanged).toBe(true)
  await freezeCheckDefinitions(root, fixed, false, true, 4, true)
  await expect(assertCheckEdit(root, fixed, file, updated)).rejects.toMatchObject({ code: 'FROZEN_TEST_CHANGE' })
})
