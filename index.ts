/**
 * pi-startup-tracer
 *
 * Instruments pi's ExtensionRunner to trace per-handler and per-emit timing,
 * plus per-extension load (transpile + factory) via loader patching.
 * Must be listed FIRST in settings.json packages.
 *
 * All output goes to stderr: [pi-startup-tracer] ...
 * Set PI_TRACER_SILENT=1 to suppress.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const TRACE_ENABLED = process.env.PI_TRACER_SILENT !== '1';

function log(...args: unknown[]): void {
  if (TRACE_ENABLED) console.error('[pi-startup-tracer]', ...args);
}

let runnerPatched = false;

async function patchRunner(): Promise<void> {
  if (runnerPatched) return;

  try {
    const runnerMod: any = await import(
      '@earendil-works/pi-coding-agent/dist/core/extensions/runner.js' as any
    );
    const Runner = runnerMod?.ExtensionRunner;
    if (!Runner) return;

    const origEmit = Runner.prototype.emit;

    Runner.prototype.emit = async function (event: { type: string }) {
      const emitStart = performance.now();
      const ctx = this.createContext();
      let result: any;
      const timed: Array<{ ext: string; ms: number }> = [];

      for (const ext of this.extensions) {
        const handlers = ext.handlers.get(event.type);
        if (!handlers || handlers.length === 0) continue;
        for (const handler of handlers) {
          const hStart = performance.now();
          try {
            const handlerResult = await handler(event, ctx);
            timed.push({ ext: ext.path.split('/').pop() || ext.path, ms: performance.now() - hStart });
            if (this.isSessionBeforeEvent(event) && handlerResult) {
              result = handlerResult;
              if (result.cancel) return result;
            }
          } catch (err) {
            timed.push({ ext: ext.path.split('/').pop() || ext.path, ms: performance.now() - hStart });
            this.emitError({
              extensionPath: ext.path,
              event: event.type,
              error: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            });
          }
        }
      }

      const emitMs = Math.round(performance.now() - emitStart);
      for (const t of timed) {
        log(`[handler] ${t.ext} ${event.type}: ${Math.round(t.ms)}ms`);
      }
      log(`[emit] ${event.type}: ${emitMs}ms`);
      return result;
    };

    runnerPatched = true;
  } catch (e) {
    log(`runner patch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function patchLoader(): Promise<void> {
  try {
    const loaderMod: any = await import(
      '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js' as any
    );
    const origLoad = loaderMod?.loadExtension;
    if (typeof origLoad !== 'function') return;

    loaderMod.loadExtension = async function (extPath: string, ...rest: unknown[]) {
      const name = extPath.split('/').pop() || extPath;
      const t0 = performance.now();
      const result = await origLoad.call(this, extPath, ...rest);
      log(`[ext] ${name}: ${Math.round(performance.now() - t0)}ms`);
      return result;
    };
  } catch (e) {
    log(`loader patch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export default async function defineExtension(pi: ExtensionAPI): Promise<void> {
  const factoryStart = performance.now();

  await Promise.all([patchRunner(), patchLoader()]);

  log(`factory (self): ${Math.round(performance.now() - factoryStart)}ms`);

  const history: Array<{ event: string; ms: number }> = [];

  function record(event: string): void {
    const elapsed = Math.round(performance.now() - factoryStart);
    history.push({ event, ms: elapsed });
    log(`[event] ${event} at ${elapsed}ms`);
  }

  function showReport(reason: string): void {
    const lines: string[] = [`\u23F1 Startup trace (${reason})`];
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      const prev = i > 0 ? history[i - 1].ms : 0;
      const delta = h.ms - prev;
      lines.push(`  ${h.event.padEnd(30)} +${String(delta).padStart(5)}ms  (${h.ms}ms total)`);
    }
    lines.push(`  ${'TOTAL'.padEnd(30)} ${String(Math.round(performance.now() - factoryStart)).padStart(6)}ms`);
    for (const line of lines) log(line);
  }

  pi.on('session_start', (_event: unknown, ctx: ExtensionContext) => {
    record('session_start');
    showReport((_event as { reason?: string })?.reason ?? 'unknown');
  });

  pi.on('session_shutdown', () => {
    record('session_shutdown');
  });

  pi.on('session_tree', () => {
    record('session_tree');
  });

  pi.on('turn_start', () => {
    record('turn_start');
  });

  pi.on('turn_end', () => {
    record('turn_end');
  });
}
