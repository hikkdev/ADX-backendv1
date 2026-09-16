import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSentryEnvelope, createErrorSink, parseSentryDsn, stackFrames } from '../error-sink';

const fetchImpl = vi.fn();

beforeEach(() => {
  fetchImpl.mockReset();
  fetchImpl.mockResolvedValue({ ok: true, status: 200 });
});

const context = { requestId: 'req-1', path: '/api/v1/orders', method: 'POST', status: 500, code: 'INTERNAL_ERROR' };

describe('error sink selection', () => {
  it("'none' never calls out", async () => {
    const sink = createErrorSink({ kind: 'none' }, fetchImpl);
    await sink.report(new Error('boom'), context);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("'webhook' without a URL degrades to a no-op rather than throwing", async () => {
    const sink = createErrorSink({ kind: 'webhook' }, fetchImpl);
    await sink.report(new Error('boom'), context);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("'webhook' POSTs a compact summary: request id, path, status, code, message, stack head", async () => {
    const sink = createErrorSink({ kind: 'webhook', webhookUrl: 'https://hooks.example/adx' }, fetchImpl);
    const err = new Error('database exploded');
    await sink.report(err, context);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.example/adx');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      service: 'adx-backend',
      requestId: 'req-1',
      path: '/api/v1/orders',
      method: 'POST',
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'database exploded',
      name: 'Error',
    });
    expect(body.stack.split('\n').length).toBeLessThanOrEqual(6);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("'sentry' posts an envelope to the DSN's envelope endpoint with the auth header", async () => {
    const sink = createErrorSink(
      { kind: 'sentry', sentryDsn: 'https://abc123@o1.ingest.sentry.io/4509' },
      fetchImpl,
    );
    await sink.report(new Error('boom'), context);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://o1.ingest.sentry.io/api/4509/envelope/');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Sentry-Auth']).toContain('sentry_key=abc123');
    expect(headers['Content-Type']).toBe('application/x-sentry-envelope');

    const lines = String(init.body).split('\n');
    expect(lines).toHaveLength(3);
    const header = JSON.parse(lines[0]!);
    const item = JSON.parse(lines[1]!);
    const event = JSON.parse(lines[2]!);
    expect(header.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(item.type).toBe('event');
    expect(event.event_id).toBe(header.event_id);
    expect(event.level).toBe('error');
    expect(event.tags).toEqual({ requestId: 'req-1', path: '/api/v1/orders' });
    expect(event.exception.values[0]).toMatchObject({ type: 'Error', value: 'boom' });
    expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
  });

  /*
   * The whole point of a sink is that it is beside the request, never in
   * front of it. A dead webhook must not turn a 500 into a hang or a crash.
   */
  it('never throws, whatever the transport does', async () => {
    fetchImpl.mockRejectedValue(new Error('ECONNREFUSED'));
    const sink = createErrorSink({ kind: 'webhook', webhookUrl: 'https://hooks.example/adx' }, fetchImpl);
    await expect(sink.report(new Error('boom'), context)).resolves.toBeUndefined();

    fetchImpl.mockImplementation(() => {
      throw new Error('sync failure');
    });
    await expect(sink.report('a string, not an Error', context)).resolves.toBeUndefined();
  });
});

describe('sentry envelope pieces', () => {
  it('parses a DSN into key, host and project', () => {
    expect(parseSentryDsn('https://key@host.example/12')).toEqual({
      publicKey: 'key',
      endpoint: 'https://host.example/api/12/envelope/',
    });
    expect(parseSentryDsn('not a dsn')).toBeNull();
  });

  it('turns a V8 stack into frames, oldest call first as Sentry expects', () => {
    const stack = [
      'Error: boom',
      '    at inner (/srv/app/src/a.ts:10:5)',
      '    at outer (/srv/app/src/b.ts:20:7)',
      '    at /srv/app/src/c.ts:30:9',
    ].join('\n');
    const frames = stackFrames(stack);
    expect(frames).toEqual([
      { filename: '/srv/app/src/c.ts', function: '<anonymous>', lineno: 30, colno: 9 },
      { filename: '/srv/app/src/b.ts', function: 'outer', lineno: 20, colno: 7 },
      { filename: '/srv/app/src/a.ts', function: 'inner', lineno: 10, colno: 5 },
    ]);
  });

  it('builds an event that carries the type, value and tags', () => {
    const envelope = buildSentryEnvelope(new TypeError('bad'), context, 'https://key@host.example/12');
    const event = JSON.parse(envelope.split('\n')[2]!);
    expect(event.exception.values[0].type).toBe('TypeError');
    expect(event.extra).toMatchObject({ method: 'POST', status: 500, code: 'INTERNAL_ERROR' });
  });
});
