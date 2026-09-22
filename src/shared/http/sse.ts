import type { Request, Response } from 'express';
import { logger } from '../logging';

/**
 * Server-sent events, the one way this backend pushes to a browser — the
 * live chat's inbox (Lot I) and, LT-1, the ops live map. Headers, the
 * `retry:` hint, a comment heartbeat that keeps proxies from closing an
 * idle stream, and a writer that goes quiet the moment the socket does.
 */
export const SSE_HEARTBEAT_MS = 25 * 1000;
export const SSE_RETRY_MS = 3000;

export type SseWriter = {
  send(event: string, data: unknown, id?: string): void;
  comment(text: string): void;
  close(): void;
  readonly closed: boolean;
};

export function openSse(req: Request, res: Response, onClose: () => void, options: { heartbeatMs?: number; retryMs?: number; tag?: string } = {}): SseWriter {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`retry: ${options.retryMs ?? SSE_RETRY_MS}\n\n`);

  let closed = false;
  const heartbeat = setInterval(() => {
    if (closed) return;
    res.write(`: ping ${Date.now()}\n\n`);
  }, options.heartbeatMs ?? SSE_HEARTBEAT_MS);

  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      onClose();
    } catch (err) {
      logger.warn(`${options.tag ?? 'SSE'} stream close hook failed`, { reason: err instanceof Error ? err.message : String(err) });
    }
    res.end();
  };
  req.on('close', finish);
  res.on('close', finish);

  return {
    get closed() {
      return closed;
    },
    send(event, data, id) {
      if (closed) return;
      const lines = [`event: ${event}`];
      if (id) lines.push(`id: ${id}`);
      lines.push(`data: ${JSON.stringify(data)}`);
      res.write(`${lines.join('\n')}\n\n`);
    },
    comment(text) {
      if (closed) return;
      res.write(`: ${text}\n\n`);
    },
    close: finish,
  };
}
