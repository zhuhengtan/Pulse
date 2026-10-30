import { ToolError } from '@hunterzhu/pulse-tool-sdk'

const TEST_SOURCE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i
const TEST_OFFICE = /(?:^|\/)[^/]*\.(?:test|spec)\.[^/]+$/i
const TEST_DIR = /(?:^|\/)(?:tests|__tests__)(?:\/|$)/i
const PLAN_GATE = /(?:^|\/)docs\/plans(?:\/|$)/i

export type OfficeOutputKind = 'docx' | 'xlsx' | 'pptx' | 'png'

const extensions: Record<OfficeOutputKind, string> = { docx: '.docx', xlsx: '.xlsx', pptx: '.pptx', png: '.png' }

/** Refuse Pulse storage, plan-gate files, and test sources before any bytes are written. */
export function assertOfficeOutputPath(kind: OfficeOutputKind, target: string): void {
  const path = target.replaceAll('\\', '/')
  if (path.includes('\0') || path.split('/').includes('.pulse')) throw new ToolError('INVALID_DRAFT_TARGET', 'Office output cannot modify Pulse configuration or draft storage.')
  if (PLAN_GATE.test(path)) throw new ToolError('PLAN_PATH_NOT_ALLOWED', 'Office tools cannot write plan-gate files.')
  if (TEST_SOURCE.test(path) || TEST_OFFICE.test(path) || TEST_DIR.test(path)) throw new ToolError('FROZEN_TEST_CHANGE', 'Office tools cannot modify test sources.')
  const extension = extensions[kind]
  if (!path.toLowerCase().endsWith(extension)) throw new ToolError('OFFICE_TARGET_EXTENSION', `This tool only writes ${extension} files.`)
}
