/**
 * pi-startup-tracer
 *
 * Instruments pi's ExtensionRunner to trace per-handler and per-emit timing,
 * plus per-extension load (transpile + factory) via loader patching.
 * Must be listed FIRST in settings.json packages.
 *
 * All output goes to ~/.pi/agent/logs/startup-tracer.jsonl
 * Each line is a JSON object: { ts, type, ... }
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const LOG_DIR = join(homedir(), '.pi', 'agent', 'logs');
const LOG_PATH = join(LOG_DIR, 'startup-tracer.jsonl');

let writeQueue = Promise.resolve();

function write(entry: Record<string, unknown>): void {
  mkdirSync(LOG_DIR, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  writeQueue = writeQueue.then(
    () => writeFile(LOG_PATH, line, { flag: 'a' }).catch(() => {}),
  );
}

const extNameCache = new Map<string, string>();

function extName(extPath: string, resolvedPath?: string): string {
  const key = resolvedPath || extPath;
  const cached = extNameCache.get(key);
  if (cached) return cached;

  const result = deriveExtName(extPath, resolvedPath);
  extNameCache.set(key, result);
  return result;
}

function deriveExtName(extPath: string, resolvedPath?: string): string {
  // For the runner ext objects: ext.path + ext.resolvedPath are both available
  // ext.path = what was in settings.json or the local resolved dir (e.g. "../../VCS/.../pi-messenger")
  // ext.resolvedPath = absolute path to the entry file

  // Try reading package.json name from the extension directory
  const entryFile = resolvedPath || extPath;
  const pkgName = readPkgName(entryFile);
  if (pkgName) return pkgName;

  // Walk path segments looking for a "pi-" prefix
  const full = resolvedPath || extPath;
  const parts = full.split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].startsWith('pi-')) {
      const file = basename(full);
      return `${parts[i]}/${file}`;
    }
  }

  // Fallback: parent dirname
  const parent = basename(dirname(full));
  const file = basename(full);
  return parent === file ? file : `${parent}/${file}`;
}

function readPkgName(entryFile: string): string | undefined {
  // Walk up from entry file looking for package.json
  let dir = dirname(entryFile);
  for (let i = 0; i < 5; i++) {
    const pkgPath = join(dir, 'package.json');
    try {
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.name) {
          const name = pkg.name.replace(/^@[^/]+\//, ''); // strip @scope/
          const file = basename(entryFile);
          return `${name}/${file}`;
        }
      }
    } catch { /* skip */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function findPiDist(): string | undefined {
  const candidates = [
    '/Users/monotykamary/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist',
  ];
  for (const d of candidates) {
    if (existsSync(join(d, 'core/extensions/runner.js'))) return d;
  }
  for (const path of Object.keys((globalThis as any).require?.cache ?? {})) {
    const match = path.match(/(.+\/pi-coding-agent\/dist)\//);
    if (match) return match[1];
  }
  return undefined;
}

let runnerPatched = false;

async function patchRunner(): Promise<void> {
  if (runnerPatched) return;

  try {
    const piDist = findPiDist();
    if (!piDist) { write({ type: 'error', msg: 'could not locate pi dist/' }); return; }
    const runnerPath = join(piDist, 'core/extensions/runner.js');
    const runnerMod: any = await import(runnerPath);
    const Runner = runnerMod?.ExtensionRunner;
    if (!Runner) return;

    const origEmit = Runner.prototype.emit;

    Runner.prototype.emit = async function (event: { type: string }) {
      const emitStart = performance.now();
      const ctx = this.createContext();
      let result: any;
      const handlers: Array<{ ext: string; event: string; ms: number }> = [];

      for (const ext of this.extensions) {
        const extHandlers = ext.handlers.get(event.type);
        if (!extHandlers || extHandlers.length === 0) continue;
        for (const handler of extHandlers) {
          const hStart = performance.now();
          try {
            const handlerResult = await handler(event, ctx);
            handlers.push({ ext: extName(ext.path, ext.resolvedPath), event: event.type, ms: performance.now() - hStart });
            if (this.isSessionBeforeEvent(event) && handlerResult) {
              result = handlerResult;
              if (result.cancel) return result;
            }
          } catch (err) {
            handlers.push({ ext: extName(ext.path, ext.resolvedPath), event: event.type, ms: performance.now() - hStart });
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
      for (const h of handlers) {
        write({ type: 'handler', ext: h.ext, event: h.event, ms: Math.round(h.ms) });
      }
      write({ type: 'emit', event: event.type, handlers: handlers.length, ms: emitMs });
      return result;
    };

    runnerPatched = true;
  } catch (e) {
    write({ type: 'error', msg: `runner patch failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}

async function patchLoader(): Promise<void> {
  try {
    const piDist = findPiDist();
    if (!piDist) { write({ type: 'error', msg: 'could not locate pi dist/' }); return; }
    const loaderPath = join(piDist, 'core/extensions/loader.js');
    const loaderMod: any = await import(loaderPath);
    const origLoad = loaderMod?.loadExtension;
    if (typeof origLoad !== 'function') return;

    loaderMod.loadExtension = async function (extPath: string, ...rest: unknown[]) {
      const name = extName(extPath);
      const t0 = performance.now();
      const result = await origLoad.call(this, extPath, ...rest);
      write({ type: 'ext', name, path: extPath, ms: Math.round(performance.now() - t0) });
      return result;
    };
  } catch (e) {
    write({ type: 'error', msg: `loader patch failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}

export default async function defineExtension(pi: ExtensionAPI): Promise<void> {
  const factoryStart = performance.now();

  await Promise.all([patchRunner(), patchLoader()]);

  write({ type: 'factory', ext: 'pi-startup-tracer', ms: Math.round(performance.now() - factoryStart) });

  const history: Array<{ event: string; ms: number }> = [];

  function record(event: string, data?: Record<string, unknown>): void {
    const elapsed = Math.round(performance.now() - factoryStart);
    history.push({ event, ms: elapsed });
    write({ type: 'event', event, ms: elapsed, ...data });
  }

  pi.on('session_start', (_event: unknown, ctx: ExtensionContext) => {
    const reason = (_event as { reason?: string })?.reason ?? 'unknown';
    record('session_start', { reason });
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
