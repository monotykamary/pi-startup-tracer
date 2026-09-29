import { AsyncLocalStorage } from 'node:async_hooks';

type Handler = (...args: any[]) => any;
type Sink = (entry: Record<string, unknown>) => void;
const PATCH = Symbol.for('pi-startup-tracer.runner.v2');
const SLICE = Symbol.for('pi-startup-tracer.snapshot.v2');

/** Instrument Pi 0.99's handler snapshots, not its dispatch policy. Original
 * arrays/functions retain identity so native on() unsubscribe still works,
 * including when a handler unsubscribes a sibling during an active dispatch. */
export function instrumentRunner(prototype: any, sink: Sink, name: (path: string, resolved?: string) => string): void {
  if (prototype[PATCH]) return;
  if (typeof prototype.emit !== 'function' || typeof prototype.emitBoundary !== 'function') {
    throw new Error('Unsupported ExtensionRunner dispatch shape');
  }
  const invocation = new AsyncLocalStorage<{ handlers: number }>();
  const safeWrite: Sink = entry => { try { sink(entry); } catch { /* telemetry must not change dispatch */ } };
  const instrument = (runner: any) => {
    for (const ext of runner.extensions) {
      for (const [event, handlers] of ext.handlers as Map<string, Handler[]>) {
        if ((handlers as any)[SLICE]) continue;
        const wrappers = new WeakMap<Handler, Handler>();
        Object.defineProperty(handlers, 'slice', {
          configurable: true,
          value(start?: number, end?: number) {
            return Array.prototype.slice.call(this, start, end).map((handler: Handler) => {
              let wrapped = wrappers.get(handler);
              if (!wrapped) {
                wrapped = async function (this: unknown, ...args: unknown[]) {
                  const scope = invocation.getStore();
                  if (scope) scope.handlers++;
                  const begin = performance.now();
                  try { return await handler.apply(this, args); }
                  finally { safeWrite({ type: 'handler', ext: name(ext.path, ext.resolvedPath), event, ms: Math.round(performance.now() - begin) }); }
                };
                wrappers.set(handler, wrapped);
              }
              return wrapped;
            });
          },
        });
        Object.defineProperty(handlers, SLICE, { value: true });
      }
    }
  };
  for (const method of Object.getOwnPropertyNames(prototype)) {
    if (!method.startsWith('emit') || ['emitError', 'emitUIPromptEvent'].includes(method)) continue;
    const original = prototype[method];
    if (typeof original !== 'function' || original.constructor.name !== 'AsyncFunction') continue;
    prototype[method] = async function (...args: any[]) {
      instrument(this);
      const scope = { handlers: 0 };
      const start = performance.now();
      const event = args[0]?.type ?? method;
      return invocation.run(scope, async () => {
        try { return await original.apply(this, args); }
        finally { safeWrite({ type: 'emit', event, handlers: scope.handlers, ms: Math.round(performance.now() - start) }); }
      });
    };
  }
  Object.defineProperty(prototype, PATCH, { value: true });
}
