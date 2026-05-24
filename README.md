<div align="center">

# ⏱ pi-startup-tracer

Instrument pi's extension lifecycle to identify **startup and resume bottlenecks** — per-extension load time, per-handler invocation time, and per-emit totals, all written to a structured JSONL log.

</div>

---

## Overview

pi-startup-tracer monkey-patches pi's `ExtensionRunner.emit` and extension loader to capture timing at every level:

| Trace type | What it measures |
|---|---|
| `ext` | Time to load each extension (jiti transpile + factory call) |
| `handler` | Time each event handler takes (per extension, per event) |
| `emit` | Total time for all handlers of a given event, plus handler count |
| `event` | Pi lifecycle events (`session_start`, `turn_end`, etc.) with elapsed ms since tracer init |
| `factory` | Time the tracer itself took to initialize and apply patches |
| `error` | Patch failures or diagnostic messages |

All output is appended to `~/.pi/agent/logs/startup-tracer.jsonl` — one JSON object per line, `ts`-timestamped.

**Must be listed FIRST** in your `settings.json` packages so the monkey-patches are applied before any other extension loads.

---

## Example output

A fresh `pi` launch against 15 extensions:

```jsonl
{"ts":"2026-05-24T07:08:54.832Z","type":"factory","ext":"pi-startup-tracer","ms":0}
{"ts":"2026-05-24T07:08:55.015Z","type":"event","event":"session_start","ms":184,"reason":"startup"}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-tps/index.ts","event":"session_start","ms":1}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-wafer-provider/index.ts","event":"session_start","ms":0}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-deepseek-provider/index.ts","event":"session_start","ms":0}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-messenger-swarm/index.js","event":"session_start","ms":10}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-messenger-swarm/index.js","event":"session_start","ms":1}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-computer-use/computer-use.ts","event":"session_start","ms":1}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-warp-kitty-images/index.ts","event":"session_start","ms":0}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-double-esc/double-esc.ts","event":"session_start","ms":0}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-hide-providers/hide-providers.ts","event":"session_start","ms":0}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-crof-provider/index.ts","event":"session_start","ms":0}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-lilac-provider/index.ts","event":"session_start","ms":0}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-retry/retry.ts","event":"session_start","ms":1}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-code-previews/index.ts","event":"session_start","ms":2}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-neuralwatt-provider/index.ts","event":"session_start","ms":1}
{"ts":"2026-05-24T07:08:55.015Z","type":"handler","ext":"pi-startup-tracer","event":"session_start","ms":0}
{"ts":"2026-05-24T07:08:55.015Z","type":"emit","event":"session_start","handlers":15,"ms":17}
```

From this: `session_start` arrived 184 ms after tracer init. The slowest handler was `pi-messenger-swarm` at 10 ms. The entire `session_start` emit (15 handlers) took 17 ms total.

---

## Quick queries

```bash
# Last 20 entries
tail -20 ~/.pi/agent/logs/startup-tracer.jsonl | jq .

# Only emit summaries (event totals)
cat ~/.pi/agent/logs/startup-tracer.jsonl | jq 'select(.type=="emit")'

# Only slow handlers (> 10ms)
cat ~/.pi/agent/logs/startup-tracer.jsonl | jq 'select(.type=="handler" and .ms > 10)'

# Session start timeline
cat ~/.pi/agent/logs/startup-tracer.jsonl | jq 'select(.event=="session_start")'
```

---

## Entry types

### `ext` — Extension load time

```jsonl
{"ts":"...","type":"ext","name":"pi-messenger-swarm","path":"../../VCS/.../pi-messenger","ms":462}
```

| Field | Description |
|---|---|
| `name` | Package name (from `package.json` or `pi-` path segment) |
| `path` | Raw extension path from `settings.json` |
| `ms` | Load time (jiti transpile + factory call) |

### `handler` — Per-handler invocation

```jsonl
{"ts":"...","type":"handler","ext":"pi-messenger-swarm/index.js","event":"session_start","ms":10}
```

| Field | Description |
|---|---|
| `ext` | Package name + entry file |
| `event` | Event type (`session_start`, `turn_end`, etc.) |
| `ms` | Handler execution time |

### `emit` — Per-event totals

```jsonl
{"ts":"...","type":"emit","event":"session_start","handlers":15,"ms":17}
```

| Field | Description |
|---|---|
| `event` | Event type |
| `handlers` | Number of handlers invoked |
| `ms` | Total time for all handlers |

### `event` — Pi lifecycle milestones

```jsonl
{"ts":"...","type":"event","event":"session_start","ms":184,"reason":"startup"}
```

| Field | Description |
|---|---|
| `event` | Lifecycle event name |
| `ms` | Elapsed ms since tracer init |
| `reason` | Event-specific context (e.g. `startup` / `resume`) |

### `factory` — Tracer init time

```jsonl
{"ts":"...","type":"factory","ext":"pi-startup-tracer","ms":0}
```

### `error` — Diagnostic messages

```jsonl
{"ts":"...","type":"error","msg":"runner patch failed: Cannot find module ..."}
```

---

## Extension name resolution

Extension names are resolved in this priority:

1. **`package.json` `name` field** — Walks up from the entry file to find `package.json`, strips `@scope/` prefix
2. **`pi-` path segment** — Scans path segments right-to-left for a `pi-` prefix
3. **Parent directory** — Falls back to `parentDir/file.ext`

Names are cached per extension path so the filesystem walk only happens once.

---

## How it works

Two monkey-patches applied at factory time:

1. **`ExtensionRunner.prototype.emit`** — Wraps the handler dispatch loop to time each handler invocation and the total emit. Writes `{ type: "handler" }` per handler and `{ type: "emit" }` after all handlers complete.

2. **`loadExtension` (loader module)** — Wraps each extension load (jiti transpile + factory) to measure per-extension initialization. Writes `{ type: "ext" }` for each loaded extension.

The tracer also subscribes to pi lifecycle events (`session_start`, `session_shutdown`, `turn_start`, `turn_end`) and writes `{ type: "event" }` entries with elapsed milliseconds.

All file writes are asynchronous and serialized through a promise queue — no blocking I/O.

---

## Installation

### Option 1: Local path in settings.json

Add as the **first** entry in your `packages` array:

```json
{
  "packages": [
    "../../path/to/pi-startup-tracer",
    "...other extensions..."
  ]
}
```

### Option 2: Install via pi package

```bash
pi install https://github.com/monotykamary/pi-startup-tracer
```

> ⚠️ Must be listed first so the monkey-patches are applied before other extensions load.

---

## Limitations

- **Monkey-patching** — Relies on pi's internal `ExtensionRunner` and loader module paths. May break across pi updates if the internal API changes.
- **Hardcoded dist path** — Uses `require.cache` fallback to locate pi's `dist/` directory if the default path doesn't match your install.
- **File writes** — Log file grows unbounded. Rotate or clear `~/.pi/agent/logs/startup-tracer.jsonl` manually.

---

## License

MIT
