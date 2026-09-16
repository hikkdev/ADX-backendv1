import { randomUUID } from 'crypto';
import { env } from '../../config/env';
import { logger } from '../logging/logger';

/**
 * Where a server error goes after it has been logged.
 *
 * Three adapters, chosen by ERROR_SINK: `none` (the default, and what every
 * developer machine runs), `webhook` (a compact JSON summary POSTed to
 * ERROR_WEBHOOK_URL — a Slack/Teams relay, an incident tool), and `sentry`
 * (a minimal Sentry envelope over plain HTTP to the DSN's envelope endpoint,
 * built here rather than through the SDK so the process carries no new
 * dependency and no global instrumentation).
 *
 * Every adapter is fire-and-forget with a 3s ceiling and never throws: the
 * sink sits beside the request, never in front of it. A dead webhook must not
 * turn a 500 into a hang, and a bad DSN must not turn a job tick into a crash.
 */

export type ErrorSinkKind = 'none' | 'webhook' | 'sentry';

export interface ErrorSinkConfig {
  kind: ErrorSinkKind;
  webhookUrl?: string | undefined;
  sentryDsn?: string | undefined;
  environment?: string | undefined;
}

/** What the caller knows about where the error happened. Every field is optional: a job has no request. */
export interface ErrorContext {
  requestId?: string | undefined;
  path?: string | undefined;
  method?: string | undefined;
  status?: number | undefined;
  code?: string | undefined;
  /** For jobs: which tick failed. */
  tag?: string | undefined;
  extra?: Record<string, unknown> | undefined;
}

export interface ErrorSink {
  readonly kind: ErrorSinkKind;
  report(err: unknown, context: ErrorContext): Promise<void>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<unknown>;

const TIMEOUT_MS = 3_000;
const STACK_HEAD_LINES = 6;
const SERVICE = 'adx-backend';

function asError(err: unknown): { name: string; message: string; stack: string | undefined } {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { name: 'Error', message: typeof err === 'string' ? err : 'Non-error thrown', stack: undefined };
}

function stackHead(stack: string | undefined): string | undefined {
  return stack?.split('\n').slice(0, STACK_HEAD_LINES).join('\n');
}

/* ── webhook ─────────────────────────────────────────────────────── */

export function buildWebhookSummary(err: unknown, context: ErrorContext, environment?: string) {
  const error = asError(err);
  return {
    service: SERVICE,
    environment,
    at: new Date().toISOString(),
    requestId: context.requestId,
    method: context.method,
    path: context.path,
    status: context.status,
    code: context.code,
    tag: context.tag,
    name: error.name,
    message: error.message,
    stack: stackHead(error.stack),
    extra: context.extra,
  };
}

/* ── sentry ──────────────────────────────────────────────────────── */

export interface SentryFrame {
  filename: string;
  function: string;
  lineno: number;
  colno: number;
}

/**
 * V8's `at fn (file:line:col)` lines into Sentry frames. Sentry orders frames
 * oldest call first — the opposite of a printed stack — so the list is
 * reversed. Lines that are not frames (the message line, "at <anonymous>"
 * without a location) are dropped rather than guessed at.
 */
export function stackFrames(stack: string | undefined): SentryFrame[] {
  if (!stack) return [];
  const frames: SentryFrame[] = [];
  for (const line of stack.split('\n')) {
    const match = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!match) continue;
    frames.push({
      filename: match[2]!,
      function: match[1] ?? '<anonymous>',
      lineno: Number(match[3]),
      colno: Number(match[4]),
    });
  }
  return frames.reverse();
}

/** `https://<key>@<host>/<project>` → the envelope endpoint and the key that authorises it. */
export function parseSentryDsn(dsn: string): { publicKey: string; endpoint: string } | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const project = url.pathname.replace(/^\/+|\/+$/g, '');
  if (!url.username || !project) return null;
  const base = url.pathname.slice(0, url.pathname.lastIndexOf(project)).replace(/\/+$/, '');
  return {
    publicKey: url.username,
    endpoint: `${url.protocol}//${url.host}${base}/api/${project}/envelope/`,
  };
}

export function buildSentryEnvelope(err: unknown, context: ErrorContext, dsn: string, environment?: string): string {
  const error = asError(err);
  const eventId = randomUUID().replace(/-/g, '');
  const now = new Date().toISOString();
  const event = {
    event_id: eventId,
    timestamp: now,
    platform: 'node',
    level: 'error',
    logger: SERVICE,
    server_name: SERVICE,
    environment,
    exception: {
      values: [
        {
          type: error.name,
          value: error.message,
          stacktrace: { frames: stackFrames(error.stack) },
        },
      ],
    },
    tags: { requestId: context.requestId ?? 'none', path: context.path ?? context.tag ?? 'none' },
    extra: {
      method: context.method,
      status: context.status,
      code: context.code,
      tag: context.tag,
      ...context.extra,
    },
  };
  const header = { event_id: eventId, sent_at: now, dsn };
  const item = { type: 'event', content_type: 'application/json' };
  return `${JSON.stringify(header)}\n${JSON.stringify(item)}\n${JSON.stringify(event)}`;
}

/* ── assembly ────────────────────────────────────────────────────── */

const noopSink: ErrorSink = { kind: 'none', report: async () => undefined };

export function createErrorSink(config: ErrorSinkConfig, fetchImpl: FetchLike = globalThis.fetch): ErrorSink {
  const send = async (url: string, init: RequestInit): Promise<void> => {
    try {
      await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (cause) {
      // Logged at warn: the original error already went to the error log, and
      // a sink that fails must not look like a second incident.
      logger.warn('Error sink delivery failed', { sink: config.kind, cause: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  if (config.kind === 'webhook') {
    const url = config.webhookUrl;
    if (!url) {
      logger.warn('ERROR_SINK=webhook but ERROR_WEBHOOK_URL is unset; errors are not being forwarded');
      return noopSink;
    }
    return {
      kind: 'webhook',
      report: (err, context) =>
        send(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildWebhookSummary(err, context, config.environment)),
        }),
    };
  }

  if (config.kind === 'sentry') {
    const dsn = config.sentryDsn;
    const parsed = dsn ? parseSentryDsn(dsn) : null;
    if (!dsn || !parsed) {
      logger.warn('ERROR_SINK=sentry but SENTRY_DSN is unset or malformed; errors are not being forwarded');
      return noopSink;
    }
    return {
      kind: 'sentry',
      report: (err, context) =>
        send(parsed.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-sentry-envelope',
            'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=${SERVICE}/1.0, sentry_key=${parsed.publicKey}`,
          },
          body: buildSentryEnvelope(err, context, dsn, config.environment),
        }),
    };
  }

  return noopSink;
}

let defaultSink: ErrorSink | null = null;

/** The process-wide sink, built from the environment on first use. */
function sink(): ErrorSink {
  if (!defaultSink) {
    defaultSink = createErrorSink({
      kind: env.ERROR_SINK,
      webhookUrl: env.ERROR_WEBHOOK_URL,
      sentryDsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
    });
  }
  return defaultSink;
}

/** Test seam: swap the process-wide sink. Pass null to rebuild from env on next use. */
export function setErrorSink(next: ErrorSink | null): void {
  defaultSink = next;
}

/**
 * Forward one error to the configured sink. Fire-and-forget: the returned
 * promise never rejects and callers need not await it. The error handler
 * calls this for every 5xx; every job tick calls it from its catch.
 */
export function reportError(err: unknown, context: ErrorContext = {}): Promise<void> {
  try {
    return sink()
      .report(err, context)
      .catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}
