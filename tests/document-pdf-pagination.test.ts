import { expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPdf } from '../packages/adapters/src/documents/tools.js'

const firstPageText = 'AAAAAAAAAA'
const secondPageText = 'SECOND_PAGE_MUST_NOT_BE_LOST'
function twoPagePdf() {
  const stream = (text: string) => {
    const content = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`
    return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  }
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(firstPageText), stream(secondPageText),
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

it('PDF exact character boundary retains the unread second page cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-pdf-pagination-'))
  try {
    await writeFile(join(root, 'two.pdf'), twoPagePdf())
    const signal = new AbortController().signal
    const bounded = await readPdf(root, { path: 'two.pdf', startPage: 1, endPage: 2, offset: 0, maxChars: firstPageText.length }, signal)
    expect(bounded).toMatchObject({ text: firstPageText, truncated: true, nextPage: 2, nextOffset: 0 })
    const remaining = await readPdf(root, { path: 'two.pdf', startPage: bounded.nextPage!, offset: bounded.nextOffset!, maxChars: 50_000 }, signal)
    expect(remaining).toMatchObject({ text: secondPageText, truncated: false, nextPage: null, nextOffset: null })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([9, 10, 11, 12, 13, 50])('reads all PDF text across %i-character windows without losing characters or looping', async maxChars => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-pdf-pagination-'))
  try {
    await writeFile(join(root, 'two.pdf'), twoPagePdf())
    const signal = new AbortController().signal
    let startPage = 1, offset = 0, text = '', finished = false
    for (let count = 0; count < 12; count++) {
      const page = await readPdf(root, { path: 'two.pdf', startPage, offset, maxChars }, signal)
      text += page.text.replaceAll('\n', '')
      expect(page.text.length).toBeLessThanOrEqual(maxChars)
      if (page.nextPage === null) { finished = true; break }
      startPage = page.nextPage!
      offset = page.nextOffset!
    }
    expect(finished).toBe(true)
    expect(text).toBe(firstPageText + secondPageText)
  } finally { await rm(root, { recursive: true, force: true }) }
})
