# Project folder access

A project's primary folder is the default execution directory for new conversations.
Every other folder added in the project editor is available read-only. The execution
folder keeps its existing approval and write policy; adding a folder never grants it
write access. A folder already inside the execution folder retains the permissions it
already had there.

## Using the folders

- Relative paths resolve against the execution folder.
- Use absolute paths for another project folder. `fs.read`, `fs.list`, `fs.search`,
  `fs.glob`, `fs.view_image`, artifact recording/downloads, and the enabled PDF,
  spreadsheet, DOCX, and PPTX readers accept these paths.
- Search and glob inspect the requested folder, not all project folders implicitly.
- Shell commands can use an added folder as `cwd` and read its files. The OS sandbox
  still grants writes only to the execution folder and its private temporary paths.
  Shell approvals remain required under the selected approval mode. Remembered
  bounded-read recommendations remain limited to the primary workspace.
- Editing, moving, deleting, and creating files in added folders is not authorized by
  the read grant. Document writers and PDF rendering outputs remain primary-bound.
- Symlink escapes and changed canonical roots are rejected. Home directories, volume
  roots, and ancestors of the home directory cannot be added as shell read grants.

## Execution snapshots

Each new run stores a canonical folder-access snapshot. Child agents and parallel
lanes use the same registry and snapshot. Editing project folders affects the next
new run, not an active run or recovery of that run. Old single-folder runs stay
single-folder when recovered. A missing or redirected saved root fails closed.

Existing conversations keep their execution directory, even after the project's
primary folder changes. Isolated workspaces do not automatically regain access to
the original primary project directory. Imported runs do not inherit source-machine
additional folders; a new run can capture the destination project's local folders.
