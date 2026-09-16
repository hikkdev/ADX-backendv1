/**
 * The little that backup and restore need to know about a connection string,
 * without ever printing one — Lot E (decision 95).
 */

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The database on the URL's path, or null when there is none. */
export function databaseNameOf(url: string): string | null {
  const parsed = parse(url);
  if (!parsed) return null;
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  return name.length > 0 ? name : null;
}

/** The same server, credentials and options, pointed at another database. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/**
 * Scrubs a tool's output before it is logged. pg_dump and pg_restore echo the
 * host and user on a failed connect, and libpq will happily repeat a password
 * that arrived in the wrong place; none of that belongs in a log line.
 */
export function redactUrl(text: string, url: string): string {
  const parsed = parse(url);
  if (!parsed) return text.split(url).join('[redacted]');
  const secrets = [url, decodeURIComponent(parsed.password), parsed.password, parsed.hostname, parsed.username]
    .filter((s): s is string => Boolean(s && s.length >= 3));
  return secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}
