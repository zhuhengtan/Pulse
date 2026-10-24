# @hunterzhu/pulse-data

Pulse's local conversation data service. The server and desktop client share a SQLite-backed store through a local IPC service; one writer owns each data directory.

This package is normally installed with `@hunterzhu/pulse-server` or the Pulse desktop client. It requires Node.js 22.13 or newer. Existing file-based conversation data must follow Pulse's migration workflow; do not replace or delete a user's data directory to initialize it.

Source and release information: [Pulse](https://github.com/zhuhengtan/Pulse).

Licensed under PolyForm Noncommercial 1.0.0. Commercial use requires separate permission.
