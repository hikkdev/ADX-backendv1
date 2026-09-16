import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER, requestId, sanitiseRequestId } from '../request-id';

function appWith() {
  const app = express();
  app.use(requestId);
  app.get('/echo', (req, res) => {
    res.json({ id: req.requestId });
  });
  return app;
}

describe('request id middleware', () => {
  it('mints a uuid when the client sent none, and echoes it on the response', async () => {
    const res = await request(appWith()).get('/echo');
    const header = res.headers[REQUEST_ID_HEADER];
    expect(header).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.id).toBe(header);
  });

  it('keeps an incoming id so a proxy trace joins up with ours', async () => {
    const res = await request(appWith()).get('/echo').set(REQUEST_ID_HEADER, 'edge-abc-123');
    expect(res.headers[REQUEST_ID_HEADER]).toBe('edge-abc-123');
    expect(res.body.id).toBe('edge-abc-123');
  });

  /*
   * The header is echoed back and written to every log line, so the client
   * must not be able to smuggle line breaks or a kilobyte of junk through it.
   */
  it('sanitises what the client sent: unsafe characters dropped, length capped', () => {
    expect(sanitiseRequestId('abc\r\nInjected: yes')).toBe('abcInjected:yes');
    expect(sanitiseRequestId('x'.repeat(200))).toHaveLength(64);
    expect(sanitiseRequestId('  spaced  ')).toBe('spaced');
    expect(sanitiseRequestId(['first', 'second'])).toBe('first');
  });

  it('mints rather than accepting an id that sanitises to nothing', async () => {
    expect(sanitiseRequestId('!!! ???')).toBeNull();
    expect(sanitiseRequestId(undefined)).toBeNull();
    const res = await request(appWith()).get('/echo').set(REQUEST_ID_HEADER, '   ');
    expect(res.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
