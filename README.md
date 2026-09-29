<div align="center">

# ⏱ pi-startup-tracer

**Startup and resume bottleneck detection for [pi](https://github.com/earendil-works/pi-coding-agent)**

_Per-handler and per-emit timings in JSONL, plus Pi's native per-extension startup timing._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

---

## Pi 0.99 compatibility (0.1.13)

Tested with Pi **0.99.0**. Host-provided Pi packages and TypeBox are peers (`*`), not bundled runtime dependencies; development uses exact Pi 0.99.0 pins and host-compatible TypeBox where needed.

Timing delegates to Pi's native dispatchers, preserving snapshot/unsubscribe behavior, cancellation, actionable boundaries and structured-result redaction. Set `PI_TIMING=1` before starting Pi for native module-import/factory timings; the private ESM loader is not replaced. The runner is captured through Pi's public mapped `AgentSession.bindExtensions`, preserving identity in SDK and bundled CLI hosts.

Run `bun run test:host` for the offline real-host load, native codemode/nested-call, module-identity and reload checks. Set `PI99_HOST_PACKAGE` to an installed Pi package directory to test that host explicitly; add `PI99_HOST_ENTRY=bundle` to check the bundled CLI runtime's constructors.

## Overview

pi-startup-tracer instruments Pi's native runner snapshots and dispatch methods without replacing event policy. Native `PI_TIMING=1` measures extension loading:

| Trace type | What it measures |
|---|---|
| Native startup timings | Module-import and factory durations on stderr (`PI_TIMING=1`) |
| `loader` | Whether native startup timing was enabled |
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

### Native extension-load timings

Start Pi with `PI_TIMING=1 pi` to print separate module-import and factory durations on stderr. Pi 0.99's `loadExtension` is private and cannot safely be replaced through immutable ESM exports. The JSONL `loader` record reports whether native timing was enabled; it does not invent unavailable `ext` measurements.

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

An idempotent prototype hook delegates every supported asynchronous `emit*` method to Pi. Timing wrappers are added to handler snapshots, not the original handler identities, so unsubscribe and in-flight snapshot semantics remain native. `finally` records timings for successful, failed and cancelled handlers. Actionable boundaries and transforming events retain Pi's validation and composition rules.

Loader timing uses native `PI_TIMING=1`; no loader exports or registration transactions are replaced.

The tracer also subscribes to pi lifecycle events (`session_start`, `session_shutdown`, `turn_start`, `turn_end`) and writes `{ type: "event" }` entries with elapsed milliseconds.

Log appends are asynchronous and serialized through a promise queue, which is flushed at session shutdown. Directory creation and cached package-name discovery use synchronous filesystem operations.

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
pi install npm:@monotykamary/pi-startup-tracer
```

Or install from GitHub:

```bash
pi install https://github.com/monotykamary/pi-startup-tracer
```

> ⚠️ Must be listed first so the monkey-patches are applied before other extensions load.

---

## Limitations

- **Monkey-patching** — Relies on Pi 0.99's internal runner methods and handler snapshot layout; future host changes require revalidation.
- **Runtime layout** — Resolves `dist/core/extensions/runner.js` from `getPackageDir()`. Standalone/embedded distributions are not covered by the Node-host probes.
- **File writes** — Log file grows unbounded. Rotate or clear `~/.pi/agent/logs/startup-tracer.jsonl` manually.

---

## License

MIT
