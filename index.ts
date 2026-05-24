/**
 * pi-startup-tracer
 *
 * Measures wall-clock time between extension lifecycle events to identify
 * startup and resume bottlenecks. Must be listed FIRST in settings.json
 * packages to capture the full extension loading pipeline.
 *
 * What it measures:
 *   factory → session_start   = remaining extension loads + runtime init
 *   session_shutdown duration   = total shutdown handler chain time
 *   shutdown → session_start   = session teardown + rebuild + resume overhead
 *
 * Enable verbose output with PI_TRACER_VERBOSE=1.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export default function defineExtension(pi: ExtensionAPI): void {
  const ts = {
    factory: performance.now(),
    sessionStart: 0,
    sessionEnd: 0,
    turnStart: 0,
    turnEnd: 0,
  };

  const history: Array<{ event: string; ms: number; delta: string }> = [];

  function record(event: string): void {
    const now = performance.now();
    const elapsed = Math.round(now - ts.factory);
    history.push({ event, ms: elapsed, delta: '' });
    ts[event as keyof typeof ts] = now;
  }

  function report(ctx: ExtensionContext, reason: string): void {
    const now = performance.now();
    const lines: string[] = [`⏱ Startup trace (${reason})`];

    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      const prev = i > 0 ? history[i - 1].ms : 0;
      const delta = h.ms - prev;
      lines.push(`  ${h.event.padEnd(28)} +${String(delta).padStart(5)}ms  (total ${h.ms}ms)`);
    }

    const total = Math.round(now - ts.factory);
    lines.push(`  ${'total'.padEnd(28)} ${String(total).padStart(6)}ms`);

    ctx.ui.notify(lines.join('\n'), 'info');

    if (process.env.PI_TRACER_VERBOSE === '1') {
      console.error(`[pi-startup-tracer] ${reason} report:\n${lines.join('\n')}`);
    }
  }

  pi.on('session_start', (_event: unknown, ctx: ExtensionContext) => {
    record('session_start');
    const reason = (_event as { reason?: string })?.reason ?? 'unknown';
    report(ctx, reason);
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
