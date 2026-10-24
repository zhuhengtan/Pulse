/** A trailing slash identifies a directory reference without changing the document schema. */
export function mentionLocation(query: string): { directory: string; filter: string } {
  const slash = query.lastIndexOf('/')
  return { directory: slash < 0 ? '' : query.slice(0, slash + 1), filter: query.slice(slash + 1) }
}
export function parentMentionDirectory(directory: string): string {
  const parts = directory.replace(/\/$/, '').split('/')
  parts.pop()
  return parts.length ? `${parts.join('/')}/` : ''
}
