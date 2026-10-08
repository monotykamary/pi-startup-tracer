import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { getPackageDir } from '@earendil-works/pi-coding-agent';
import { instrumentRunner } from '../instrument.ts';

const { ExtensionRunner } = await import(join(getPackageDir(), 'dist/core/extensions/runner.js'));
const logs: Record<string, unknown>[] = [];
instrumentRunner(ExtensionRunner.prototype, entry => logs.push(entry), path => path);

function runner(handlers: Map<string, Function[]>) {
  const value = Object.create(ExtensionRunner.prototype);
  value.extensions = [{ path: 'test', handlers }];
  value.createContext = () => ({});
  value.emitError = (e: unknown) => { logs.push({ type: 'error', e }); };
  return value;
}

test('native snapshot/unsubscribe ordering survives tracing and double installation', async () => {
  const calls: string[] = [];
  const second = () => { calls.push('second'); };
  const list = [() => { calls.push('first'); list.splice(list.indexOf(second), 1); }, second];
  const value = runner(new Map([['session_start', list]]));
  const original = ExtensionRunner.prototype.emit;
  instrumentRunner(ExtensionRunner.prototype, () => { throw new Error('duplicate'); }, String);
  expect(ExtensionRunner.prototype.emit).toBe(original);
  await value.emit({ type: 'session_start' });
  expect(calls).toEqual(['first', 'second']);
  expect(logs.filter(e => e.type === 'handler').length).toBe(2);
});

test('native cancellation and handler failures still use Pi policy', async () => {
  const value = runner(new Map([['session_before_compact', [() => { throw new Error('first'); }, () => ({ cancel: true }), () => { throw new Error('must not run'); }]] ]));
  expect(await value.emit({ type: 'session_before_compact' })).toEqual({ cancel: true });
  expect(logs.some(e => e.type === 'error')).toBe(true);
});

test('actionable boundary entries and continuation compose in native order', async () => {
  const value = runner(new Map([['turn_end', [() => ({ entries: [{ type: 'custom', customType: 'test', data: 1 }], continue: true }), (event: any) => { expect(event.continue).toBe(true); expect(event.context).toEqual(event.entries); return { continue: false }; }]] ]));
  const result = await value.emitBoundary({ type: 'turn_end' }, async (entries: unknown[]) => entries);
  expect(result.valid).toBe(true);
  expect(result.continue).toBe(false);
  expect(result.entries).toHaveLength(1);
});

test('native tool-result redaction also drops stale structured content', async () => {
  const value = runner(new Map([['tool_result', [() => ({ content: [{ type: 'text', text: 'redacted' }] })]] ]));
  const result = await value.emitToolResult({ type: 'tool_result', toolName: 'probe', toolCallId: 'parent/1', parentToolCallId: 'parent', content: [{ type: 'text', text: 'secret' }], structuredContent: { secret: true }, isError: false, input: {} });
  expect(result.content).toEqual([{ type: 'text', text: 'redacted' }]);
  expect(result.structuredContent).toBeUndefined();
});

test('tracing preserves nested tool_call blocking, mutations and fail-closed errors', async () => {
  const event = { type: 'tool_call', toolName: 'probe', toolCallId: 'parent/1', parentToolCallId: 'parent', input: { value: 1 } };
  const seen: unknown[] = [];
  const value = runner(new Map([['tool_call', [
    (e: typeof event) => { seen.push(e); e.input.value = 2; },
    (e: typeof event) => { expect(e.input.value).toBe(2); return { block: true, reason: 'blocked' }; },
    () => { throw new Error('must not run after block'); },
  ]]]));
  expect(await value.emitToolCall(event)).toEqual({ block: true, reason: 'blocked' });
  expect(seen).toEqual([event]);
  expect(event.parentToolCallId).toBe('parent');
  const failing = runner(new Map([['tool_call', [() => { throw new Error('fail closed'); }]]]));
  await expect(failing.emitToolCall(event)).rejects.toThrow('fail closed');
});

test('raw stream handlers remain ordered and errors do not stop notification dispatch', async () => {
  const data = Object.freeze({ type: 'parsed-provider-event', ordinal: 1 });
  const event = { type: 'provider_stream_event', provider: 'offline', api: 'offline-api', model: 'test', data };
  const order: string[] = [];
  const value = runner(new Map([['provider_stream_event', [
    async (e: typeof event) => { expect(e.data).toBe(data); await Promise.resolve(); order.push('first'); },
    () => { order.push('error'); throw new Error('observer only'); },
    (e: typeof event) => { expect(e).toBe(event); order.push('last'); },
  ]]]));
  expect(await value.emit(event)).toBeUndefined();
  expect(order).toEqual(['first', 'error', 'last']);
  expect(logs.some(e => e.type === 'error' && (e.e as any)?.event === 'provider_stream_event')).toBe(true);
  expect(data).toEqual({ type: 'parsed-provider-event', ordinal: 1 });
});

test('agent_settled forwards aborted and remains notification-only under tracing', async () => {
  const seen: boolean[] = [];
  const value = runner(new Map([['agent_settled', [(e: { aborted: boolean }) => { seen.push(e.aborted); return { continue: true }; }]]]));
  expect(await value.emit({ type: 'agent_settled', aborted: true })).toBeUndefined();
  expect(await value.emit({ type: 'agent_settled', aborted: false })).toBeUndefined();
  expect(seen).toEqual([true, false]);
});
