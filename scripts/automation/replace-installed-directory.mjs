import { access, rename, rm } from 'node:fs/promises'

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Replace destination with source using a same-filesystem backup.
 * If a previous attempt stopped after moving the live tree aside, that backup is restored before trying again.
 * The backup is deleted only after the new tree is in place. A failed restore leaves the backup where it is.
 * Moving a non-empty directory this way is not a gap-free atomic replacement. */
export async function replaceInstalledDirectory(destination, source, io = { rename, rm }) {
  const backup = `${destination}.bak`
  const live = await pathExists(destination)
  const saved = await pathExists(backup)
  if (!live && saved) await io.rename(backup, destination)
  else if (saved) await io.rm(backup, { recursive: true, force: true })
  let backedUp = false
  try {
    try {
      await io.rename(destination, backup)
      backedUp = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await io.rename(source, destination)
  } catch (error) {
    if (backedUp) {
      try {
        await io.rm(destination, { recursive: true, force: true })
        await io.rename(backup, destination)
      } catch (restoreError) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { restoreError })
      }
    }
    throw error
  }
  await io.rm(backup, { recursive: true, force: true })
}
