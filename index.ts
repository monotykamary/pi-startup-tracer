/**
 * pi-startup-tracer
 *
 * Instruments pi's ExtensionRunner to trace per-handler and per-emit timing,
 * plus native PI_TIMING module-import/factory diagnostics (no loader patch).
 * Must be listed FIRST in settings.json packages.
 *
 * All output goes to <agent dir>/logs/startup-tracer.jsonl (default ~/.pi/agent/logs)
 * Each line is a JSON object: { ts, type, ... }
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { AgentSession, getAgentDir } from '@earendil-works/pi-coding-agent';
import { instrumentRunner } from './instrument.js';

const LOG_DIR = join(getAgentDir(), 'logs');
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
          // If resolvedPath is the package dir (no file extension), just return the name
          if (file === name || !file.includes('.')) return name;
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

function patchRunner(): void {
  const prototype = AgentSession.prototype;
  const original = prototype.bindExtensions;
  const marker = Symbol.for('pi-startup-tracer.bind.v1');
  if ((original as any)[marker]) return;
  const wrapped: typeof original = async function (this: AgentSession, ...args) {
    // Capture the actual runner from the mapped host constructor, never a
    // second unbundled module imported beside the CLI's bundled runtime.
    instrumentRunner(Object.getPrototypeOf(this.extensionRunner), write, extName);
    return original.apply(this, args);
  };
  Object.defineProperty(wrapped, marker, { value: true });
  prototype.bindExtensions = wrapped;
}

export default async function defineExtension(pi: ExtensionAPI): Promise<void> {
  const factoryStart = performance.now();

  await patchRunner();
  // loadExtension is private in 1.0 and ESM exports are immutable. Native
  // PI_TIMING traces both module import and factory duration without replacing
  // the loader or bypassing its transactional registration/rollback.
  write({ type: 'loader', native: 'PI_TIMING=1', enabled: process.env.PI_TIMING === '1' });

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

  pi.on('session_shutdown', async () => {
    record('session_shutdown');
    await writeQueue;
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
