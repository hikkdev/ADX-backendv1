import { inspect } from 'util';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const PII_KEYS = [
  'aadhaar',
  'accountnumber',
  'authorization',
  'cookie',
  'ifsc',
  'mobile',
  'otp',
  'pan',
  'password',
  'phone',
  'refreshtoken',
  'token',
  'upi',
];

function getMinLevel(): LogLevel {
  return process.env['NODE_ENV'] === 'production' ? 'info' : 'debug';
}

function shouldRedact(key: string): boolean {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return PII_KEYS.some((piiKey) => normalizedKey.includes(piiKey));
}

function scrubPII(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => scrubPII(item, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = shouldRedact(key) ? '[REDACTED]' : scrubPII(item, seen);
  }
  return result;
}

function write(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVELS[level] < LEVELS[getMinLevel()]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta === undefined ? {} : { meta: scrubPII(meta) }),
  };

  const output =
    process.env['NODE_ENV'] === 'production'
      ? JSON.stringify(entry)
      : inspect(entry, { colors: true, depth: 6 });

  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${output}\n`);
}

export const logger = {
  debug: (message: string, meta?: unknown) => write('debug', message, meta),
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta),
};
