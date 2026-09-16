import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES, EVENT_REGISTRY, isRegisteredEvent, variablesOf } from '../templates';

/**
 * E10-2: the events catalogue is the contract between the code that raises
 * an event and the copy written against it.
 *
 * This walks `src/modules` for every `notify(` call outside the dispatcher
 * and checks the event it names is in `EVENT_REGISTRY` — a module that
 * starts raising a new event has to say what variables it supplies before
 * a template author can be offered them. The check is textual on purpose,
 * the way `sms-call-sites.test.ts` reads `sendSms(`: an event that arrives
 * through a variable is one the reviewer cannot see, so the one constant
 * in use (`ANNOUNCEMENT_EVENT`) is resolved from the same file.
 */
const MODULES = path.resolve(__dirname, '../..');
const SELF = new Set(['notifications/dispatch.service.ts', 'notifications/index.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated' || entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The event each `notify(` call names — a literal, or a `*_EVENT` constant defined in the same file. */
function eventsIn(source: string): string[] {
  const events: string[] = [];
  for (const match of source.matchAll(/\bnotify\(\s*(?:'([A-Z][A-Z0-9_]*)'|([A-Z][A-Z0-9_]*_EVENT)\b)/g)) {
    if (match[1]) {
      events.push(match[1]);
      continue;
    }
    const constant = new RegExp(`const ${match[2]!} = '([A-Z][A-Z0-9_]*)'`).exec(source);
    events.push(constant ? constant[1]! : `<unresolved ${match[2]!}>`);
  }
  return events;
}

/** `notify(` occurrences on code lines — comment lines (`//`, `/*`, ` *`) are prose, not calls. */
function callsIn(source: string): number {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .reduce((n, line) => n + (line.match(/\bnotify\(/g)?.length ?? 0), 0);
}

describe('the events registry', () => {
  const files = walk(MODULES)
    .map((file) => ({ file: path.relative(MODULES, file).replace(/\\/g, '/'), source: fs.readFileSync(file, 'utf8') }))
    .filter(({ file, source }) => !SELF.has(file) && /\bnotify\(/.test(source));
  const sites = files.flatMap(({ file, source }) => eventsIn(source).map((event) => ({ file, event })));

  it('finds the callers (fails loudly if the dispatcher is renamed)', () => {
    expect(sites.length).toBeGreaterThan(5);
  });

  it('recognises the event of every notify() call — a call it cannot read is a call it cannot check', () => {
    // A `notify(event, …)` through a variable or a template literal would
    // otherwise slip past `eventsIn` unseen; the count has to reconcile.
    for (const { file, source } of files) {
      expect(eventsIn(source).length, `${file}: a notify() call names its event in a form this test cannot read`).toBe(callsIn(source));
    }
  });

  it('lists every event a module raises through notify()', () => {
    for (const site of sites) {
      expect(isRegisteredEvent(site.event), `${site.file} raises ${site.event}, which EVENT_REGISTRY does not list`).toBe(true);
    }
  });

  it('names the raising module on each entry it lists', () => {
    for (const site of sites) {
      const entry = EVENT_REGISTRY.find((e) => e.event === site.event)!;
      const module = site.file.split('/')[0]!;
      expect(entry.raisedBy, `${site.event} is raised by ${module}`).toContain(module);
    }
  });

  it('supplies every variable the seeded copy for the event names', () => {
    for (const seed of DEFAULT_TEMPLATES) {
      const entry = EVENT_REGISTRY.find((e) => e.event === seed.event);
      expect(entry, `${seed.key} answers ${seed.event}, which is not registered`).toBeDefined();
      for (const name of variablesOf(seed.subject, seed.emailBody, seed.smsBody, seed.pushTitle, seed.pushBody)) {
        expect(entry!.variables, `${seed.key} names {{${name}}}, which ${seed.event} does not supply`).toContain(name);
      }
    }
  });

  it('has no duplicate events and no entry without a raiser or a variable list', () => {
    const events = EVENT_REGISTRY.map((e) => e.event);
    expect(new Set(events).size).toBe(events.length);
    for (const entry of EVENT_REGISTRY) {
      expect(entry.raisedBy.length, entry.event).toBeGreaterThan(0);
      expect(Array.isArray(entry.variables), entry.event).toBe(true);
    }
  });
});
