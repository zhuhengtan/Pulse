import { createRequire } from 'node:module'
import { afterAll, describe, expect, it } from 'vitest'
import { cp, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolRegistry } from '@hunterzhu/pulse-tool-sdk'
import { createDocumentTools } from '@hunterzhu/pulse-adapters'

const fixtureRoot = resolve('tests/fixtures')
const temporaryRoots: string[] = []

async function registryFor(root: string): Promise<ToolRegistry> {
  const canonicalRoot = await realpath(root)
  const registry = new ToolRegistry({ workspaceRoots: [canonicalRoot], allowNetwork: false })
  for (const definition of createDocumentTools(canonicalRoot)) registry.register(definition)
  return registry
}

describe('workspace document tools', () => {
  afterAll(async () => { await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))) })

  it('extracts bounded PDF text and metadata through the ToolRegistry contract', async () => {
    const registry = await registryFor(fixtureRoot)
    const result = await registry.execute('document.pdf.read', { path: 'document-tools.pdf' }, new AbortController().signal)
    expect(result).toMatchObject({ title: 'Pulse PDF Fixture', author: 'Pulse Tests', totalPages: 1, firstPage: 1, lastPage: 1, truncated: false })
    expect(result.text).toContain('Pulse PDF fixture text')

    const bounded = await registry.execute('document.pdf.read', { path: 'document-tools.pdf', maxChars: 8 }, new AbortController().signal)
    expect(bounded.text.length).toBeLessThanOrEqual(8)
    expect(bounded.truncated).toBe(true)
    await expect(registry.execute('document.pdf.read', { path: 'document-tools.pdf', startPage: 2 }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_PDF_PAGE_RANGE' })
  })

  it('lists workbook metadata and returns a bounded selected-sheet preview without evaluating formulas', async () => {
    const registry = await registryFor(fixtureRoot)
    const metadata = await registry.execute('document.xlsx.inspect', { path: 'document-tools.xlsx' }, new AbortController().signal)
    expect(metadata).toMatchObject({ creator: 'Pulse Fixture', title: 'Quarterly Demo', sheetCount: 2, worksheets: [{ name: 'Summary', rowCount: 3, columnCount: 2 }, { name: 'Notes' }] })
    expect(metadata.worksheets[0]?.preview).toBeUndefined()

    const preview = await registry.execute('document.xlsx.inspect', { path: 'document-tools.xlsx', sheet: 'Summary', maxRows: 2, maxColumns: 2 }, new AbortController().signal)
    expect(preview.worksheets[0]?.preview).toEqual([{ row: 1, cells: ['Metric', 'Value'] }, { row: 2, cells: ['Revenue', 42] }])
    expect(preview.truncated).toBe(true)
    await expect(registry.execute('document.xlsx.inspect', { path: 'document-tools.xlsx', sheet: 'Missing' }, new AbortController().signal)).rejects.toMatchObject({ code: 'XLSX_SHEET_NOT_FOUND' })
  })

  it('preserves sparse column positions and reports truncation beyond the preview range', async () => {
    const ExcelJS = createRequire(resolve('packages/adapters/package.json'))('exceljs')
    const root = await mkdtemp(join(tmpdir(), 'pulse-sparse-docs-'))
    temporaryRoots.push(root)
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Sparse').getCell('Z1').value = 'sparse value'
    await workbook.xlsx.writeFile(join(root, 'sparse.xlsx'))
    const registry = await registryFor(root)
    const result = await registry.execute('document.xlsx.inspect', { path: 'sparse.xlsx', sheet: 'Sparse', maxColumns: 50 }, new AbortController().signal)
    expect(result.worksheets[0]?.preview?.[0]?.cells[25]).toBe('sparse value')
    expect(result.truncated).toBe(false)
    const limited = await registry.execute('document.xlsx.inspect', { path: 'sparse.xlsx', sheet: 'Sparse', maxColumns: 20 }, new AbortController().signal)
    expect(limited.truncated).toBe(true)
  })

  it('rejects paths escaping the workspace and malformed or oversized inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-docs-'))
    temporaryRoots.push(root)
    await cp(join(fixtureRoot, 'document-tools.pdf'), join(root, 'in-workspace.pdf'))
    const outside = await mkdtemp(join(tmpdir(), 'pulse-docs-outside-'))
    temporaryRoots.push(outside)
    await symlink(join(outside, 'secret.pdf'), join(root, 'escape.pdf'))
    const registry = await registryFor(root)
    await expect(registry.execute('document.pdf.read', { path: '../outside.pdf' }, new AbortController().signal)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
    await expect(registry.execute('document.pdf.read', { path: 'escape.pdf' }, new AbortController().signal)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
    await expect(registry.execute('document.xlsx.inspect', { path: 'in-workspace.pdf' }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_XLSX_ARCHIVE' })
  })
})
