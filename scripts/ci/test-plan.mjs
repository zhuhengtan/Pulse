import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
export async function testFiles(root) {
  const files = []
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}/${entry.name}`
      if (path === 'tests/live' || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(join(directory, entry.name), path)
      else if (entry.name.endsWith('.test.ts')) files.push(path)
    }
  }
  await visit(join(root, 'tests'), 'tests')
  return files.sort()
}
export function splitTests(files, timings = {}, count = 4) {
  if (count !== 4 || new Set(files).size !== files.length || files.length < count) throw Error('INVALID_TEST_INVENTORY')
  const bins = Array.from({ length: count }, (_, index) => ({ index: index + 1, milliseconds: 0, files: [] }))
  const weight = file => Number.isFinite(timings[file]) && timings[file] > 0 ? timings[file] : 60000
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const bin = [...bins].sort((a, b) => a.milliseconds - b.milliseconds || a.index - b.index)[0]
    bin.files.push(file); bin.milliseconds += weight(file)
  }
  for (const bin of bins) bin.files.sort((a, b) => Number(b.includes('hooks-')) - Number(a.includes('hooks-')) || weight(b) - weight(a) || a.localeCompare(b))
  verifyPartition(files, bins)
  return bins
}
export function verifyPartition(files, bins) {
  const assigned = bins.flatMap(bin => bin.files)
  if (bins.length !== 4 || bins.some((bin, i) => bin.index !== i + 1 || bin.files.length === 0) || assigned.length !== files.length || new Set(assigned).size !== assigned.length || [...assigned].sort().some((file, i) => file !== [...files].sort()[i])) throw Error('TEST_PARTITION_INCOMPLETE')
}
export async function makeTestPlan(root, shard) {
  const all = await testFiles(root)
  const timings = JSON.parse(await readFile(new URL('./windows-test-timings.json', import.meta.url), 'utf8'))
  const bins = splitTests(all, timings)
  if (shard !== undefined && (!Number.isInteger(shard) || shard < 1 || shard > 4)) throw Error('INVALID_TEST_SHARD')
  return { schema: 1, inventoryHash: createHash('sha256').update(JSON.stringify(all)).digest('hex'), totalFiles: all.length, shard: shard ?? null, files: shard === undefined ? all : bins[shard - 1].files, bins }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await makeTestPlan(process.cwd()), null, 2))
