import { describe, expect, it } from 'vitest';
import { calendarParts, previewIdentifier, renderIdentifier } from '../identifiers.service';

const FORMAT = {
  prefix: 'PUB',
  pattern: '{PREFIX}-{DD}{MM}-{YY}{SEQ}',
  seqPadding: 2,
  timeZone: 'Asia/Kolkata',
};

describe('rendering', () => {
  it('produces the agreed shape', () => {
    // 19 Sep 2026, first publisher that day.
    const at = new Date('2026-09-19T06:00:00.000Z');
    expect(renderIdentifier(FORMAT, at, 1, 'Asia/Kolkata')).toBe('PUB-1909-2601');
  });

  it('pads the sequence but does not cap it', () => {
    const at = new Date('2026-09-19T06:00:00.000Z');
    expect(renderIdentifier(FORMAT, at, 7, 'Asia/Kolkata')).toBe('PUB-1909-2607');
    // A day busier than the padding grows past it rather than wrapping onto an
    // identifier that already exists.
    expect(renderIdentifier(FORMAT, at, 143, 'Asia/Kolkata')).toBe('PUB-1909-26143');
  });

  it('honours the configured zone when deciding the day', () => {
    // 23:00 UTC on the 18th is already the 19th in Kolkata, and the identifier
    // has to agree with the person reading it.
    const at = new Date('2026-09-18T23:00:00.000Z');
    expect(calendarParts(at, 'Asia/Kolkata').dateKey).toBe('2026-09-19');
    expect(calendarParts(at, 'UTC').dateKey).toBe('2026-09-18');
    expect(renderIdentifier(FORMAT, at, 1, 'Asia/Kolkata')).toBe('PUB-1909-2601');
  });

  it('supports a four-digit year and a different layout', () => {
    const at = new Date('2026-09-19T06:00:00.000Z');
    expect(
      renderIdentifier(
        { prefix: 'EMP', pattern: '{PREFIX}/{YYYY}/{MM}/{SEQ}', seqPadding: 4 },
        at,
        12,
        'Asia/Kolkata',
      ),
    ).toBe('EMP/2026/09/0012');
  });

  it('leaves unknown text in the pattern alone', () => {
    const at = new Date('2026-09-19T06:00:00.000Z');
    expect(
      renderIdentifier({ prefix: 'ADV', pattern: 'IN-{PREFIX}-{SEQ}', seqPadding: 3 }, at, 5, 'UTC'),
    ).toBe('IN-ADV-005');
  });

  it('previews without consuming a sequence', () => {
    const at = new Date('2026-09-19T06:00:00.000Z');
    expect(previewIdentifier(FORMAT, at, 1)).toBe('PUB-1909-2601');
    expect(previewIdentifier(FORMAT, at, 1)).toBe('PUB-1909-2601');
  });
});

describe('the support series', () => {
  it('a ticket and a piece of feedback render on the same counter with their own prefixes', () => {
    const at = new Date('2026-09-11T06:00:00.000Z');
    expect(renderIdentifier({ ...FORMAT, prefix: 'TKT' }, at, 1, 'Asia/Kolkata')).toBe('TKT-1109-2601');
    expect(renderIdentifier({ ...FORMAT, prefix: 'FB' }, at, 3, 'Asia/Kolkata')).toBe('FB-1109-2603');
  });
});
