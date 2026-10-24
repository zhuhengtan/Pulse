# @hunterzhu/pulse-data

Pulse's local conversation data service. The server and desktop client share a SQLite-backed store through a local IPC service; one writer owns each data directory.

This package is normally installed with `@hunterzhu/pulse-server` or the Pulse desktop client. It requires Node.js 22.13 or newer. Existing file-based conversation data must follow Pulse's migration workflow; do not replace or delete a user's data directory to initialize it.

Call `await data.close()` when disposing a `ConversationData` client. It drains prior requests and waits for the final client's writer to release the database and lock. Other connected clients keep their writer running; unexpected disconnects retain a short reconnection grace period.

Source and release information: [Pulse](https://github.com/zhuhengtan/Pulse).

Licensed under PolyForm Noncommercial 1.0.0. Commercial use requires separate permission.
