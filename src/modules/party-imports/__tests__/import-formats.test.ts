import { describe, expect, it } from 'vitest';

/**
 * Lot U — the format guide: one JSON per import kind on the platform, and a
 * template.csv per kind. The guide is a column table kept beside each
 * validator, and this contract is what stops the two drifting: every key
 * the validator accepts appears in the guide, and every column the guide
 * names is one the validator accepts — for every kind, including the
 * imports other modules own (publishers, leads, market data, finance
 * reconciliation). The template is the header row and the two sample rows,
 * and every sample row is one the validator passes.
 */

import { parseCsv } from '../../../shared/csv';
import { publisherImportRowSchema, PUBLISHER_IMPORT_COLUMNS } from '../../publishers';
import { FORMAT_KINDS, formatGuide, formatGuides, schemaKeysOf, templateCsv, validateSample } from '../import-formats';
import {
  ADVERTISER_COLUMNS,
  AGENT_COLUMNS,
  EMPLOYEE_COLUMNS,
  LISTING_COLUMNS,
  PRINT_PARTNER_COLUMNS,
  RATE_CARD_COLUMNS,
  advertiserRowSchema,
  agentRowSchema,
  employeeRowSchema,
  listingRowSchema,
  printPartnerRowSchema,
  rateCardRowSchema,
} from '../party-imports.schema';

describe('the format guide', () => {
  it('describes every import kind on the platform, with the shape the console reads', () => {
    expect(FORMAT_KINDS).toEqual(['publishers', 'advertisers', 'agents', 'print-partners', 'employees', 'listings', 'rate-card', 'leads', 'market-data', 'finance-reconciliation']);
    for (const guide of formatGuides()) {
      expect(guide).toMatchObject({
        kind: expect.any(String),
        title: expect.any(String),
        purpose: expect.any(String),
        columns: expect.any(Array),
        rules: expect.any(Array),
        sampleRows: expect.any(Array),
        templateCsvUrl: `/api/v1/party-imports/formats/${guide.kind}/template.csv`,
      });
      expect(guide.columns.length).toBeGreaterThan(0);
      expect(guide.rules.length).toBeGreaterThan(0);
      expect(guide.sampleRows).toHaveLength(2);
      for (const column of guide.columns) {
        expect(column).toMatchObject({ name: expect.any(String), required: expect.any(Boolean), type: expect.stringMatching(/^(text|mobile|email|enum|number|money|date|url|list)$/), description: expect.any(String), example: expect.any(String) });
        if (column.type === 'enum') expect(column.enumValues?.length).toBeGreaterThan(0);
      }
    }
  });

  it.each(FORMAT_KINDS)('%s: every schema key is in the guide and every guide column is in the schema', (kind) => {
    const guide = formatGuide(kind);
    const named = guide.columns.map((column) => column.name);
    expect(new Set(named).size).toBe(named.length);
    expect([...named].sort()).toEqual([...schemaKeysOf(kind)].sort());
  });

  it.each(FORMAT_KINDS)('%s: the two sample rows pass the validator and the template is the header plus those rows', (kind) => {
    const guide = formatGuide(kind);
    for (const row of guide.sampleRows) expect(validateSample(kind, row)).toBeNull();
    const csv = templateCsv(kind);
    const [header, ...lines] = parseCsv(csv);
    expect(header).toEqual(guide.columns.map((column) => column.name));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(guide.columns.map((column) => guide.sampleRows[0]![column.name] ?? ''));
  });

  it('marks the required columns the validators require', () => {
    const required = (kind: (typeof FORMAT_KINDS)[number]) => formatGuide(kind).columns.filter((column) => column.required).map((column) => column.name);
    expect(required('publishers')).toEqual(['mobile']);
    expect(required('agents')).toEqual(['mobile', 'side']);
    expect(required('listings')).toEqual(['title', 'category', 'address']);
    expect(required('rate-card')).toEqual(['listing']);
    expect(required('leads')).toEqual(['side', 'businessName']);
    expect(required('market-data')).toEqual(['contributorName', 'mediaTypeSlug', 'sizeClassSlug', 'latitude', 'longitude', 'ratePerDay', 'observedAt']);
    expect(formatGuide('listings').rules.join(' ')).toContain('never refused');
    expect(formatGuide('rate-card').rules.join(' ')).toContain('future');
  });

  // The seven kinds whose guide is pinned to a column constant: the constant
  // is the zod object's own keys, so the chain guide == columns == validator
  // is closed and a key added to a row schema alone cannot slip past.
  it.each([
    ['publishers', PUBLISHER_IMPORT_COLUMNS, publisherImportRowSchema],
    ['advertisers', ADVERTISER_COLUMNS, advertiserRowSchema],
    ['agents', AGENT_COLUMNS, agentRowSchema],
    ['print-partners', PRINT_PARTNER_COLUMNS, printPartnerRowSchema],
    ['employees', EMPLOYEE_COLUMNS, employeeRowSchema],
    ['listings', LISTING_COLUMNS, listingRowSchema],
    ['rate-card', RATE_CARD_COLUMNS, rateCardRowSchema],
  ] as const)('%s: the column constant is exactly the keys of the zod row schema', (_kind, columns, schema) => {
    expect([...columns].sort()).toEqual(Object.keys(schema.shape).sort());
  });

  it('404s an unknown kind', () => {
    expect(() => formatGuide('spaceships' as never)).toThrow(expect.objectContaining({ statusCode: 404 }));
  });
});
