import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIGIO_WORKFLOW_TEMPLATES,
  DIGIO_TEMPLATE_ID_PATTERN,
  DIGIO_WORKFLOW_KEYS,
  DIGIO_WORKFLOW_LABELS,
  digioWorkflows,
  workflowKeyFor,
  workflowTemplateId,
} from '../digio-workflows';
import { digioDecisionOf, isStaleDigioCallback } from '../digio-callback';

/**
 * Phase D (the owner, 1 Oct 2026): the twenty-five Digio KYC workflows and
 * which one each request names — sales agents on the field agent workflow,
 * political publishers on the publisher "Other entities" one, part-time
 * employees on the full-time one until the owner says otherwise.
 */

describe('the twenty-five workflows', () => {
  it('are the owner’s twenty-five, each with a KTP… default and a label', () => {
    expect(DIGIO_WORKFLOW_KEYS).toHaveLength(25);
    for (const key of DIGIO_WORKFLOW_KEYS) {
      expect(DEFAULT_DIGIO_WORKFLOW_TEMPLATES[key]).toMatch(DIGIO_TEMPLATE_ID_PATTERN);
      expect(DIGIO_WORKFLOW_LABELS[key]).toBeTruthy();
    }
    expect(new Set(Object.values(DEFAULT_DIGIO_WORKFLOW_TEMPLATES)).size).toBe(25);
  });

  it('keeps the ids exactly as the owner’s document has them', () => {
    expect(DEFAULT_DIGIO_WORKFLOW_TEMPLATES).toMatchObject({
      AGENT: 'KTP2610010306408243IR71R3AROTQNN',
      'PUBLISHER.OTHER_ENTITY': 'KTP2610010440468859RHQ93W3ZR6H58',
      'ADVERTISER.POLITICAL': 'KTP261001052617020C8K7M6HA846LI6',
      'PRINT_PARTNER.COMPANY': 'KTP2610010613526217KEIXUUG4MP2QL',
      'EMPLOYEE.FULL_TIME': 'KTP261001060045852S9A5UOLMEW92VJ',
      'EMPLOYEE.INTERN_CONTRACT': 'KTP26100106044372673RIO8R1PYPPJG',
      'SPOT.MEDIA': 'KTP261001062349355CXZ7URFIGSOBVO',
    });
  });
});

describe('which workflow a request names', () => {
  it('maps every party and entity type onto its key', () => {
    const cases: [Parameters<typeof workflowKeyFor>[0], string | null][] = [
      [{ party: 'PUBLISHER', entityType: 'INDIVIDUAL' }, 'PUBLISHER.INDIVIDUAL'],
      [{ party: 'PUBLISHER', entityType: 'SOLE_PROPRIETOR' }, 'PUBLISHER.SOLE_PROPRIETOR'],
      [{ party: 'PUBLISHER', entityType: 'COMPANY' }, 'PUBLISHER.COMPANY'],
      [{ party: 'PUBLISHER', entityType: 'LLP_PARTNERSHIP' }, 'PUBLISHER.LLP_PARTNERSHIP'],
      [{ party: 'PUBLISHER', entityType: 'NON_PROFIT' }, 'PUBLISHER.NON_PROFIT'],
      [{ party: 'PUBLISHER', entityType: 'GOVERNMENT_EDUCATION' }, 'PUBLISHER.GOVERNMENT_EDUCATION'],
      [{ party: 'PUBLISHER', entityType: 'OTHER_ENTITY' }, 'PUBLISHER.OTHER_ENTITY'],
      // The owner, 1 Oct 2026: political publishers verify on "Other entities".
      [{ party: 'PUBLISHER', entityType: 'POLITICAL' }, 'PUBLISHER.OTHER_ENTITY'],
      [{ party: 'ADVERTISER', entityType: 'INDIVIDUAL' }, 'ADVERTISER.INDIVIDUAL'],
      [{ party: 'ADVERTISER', entityType: 'SOLE_PROPRIETOR' }, 'ADVERTISER.SOLE_PROPRIETOR'],
      [{ party: 'ADVERTISER', entityType: 'COMPANY' }, 'ADVERTISER.COMPANY'],
      [{ party: 'ADVERTISER', entityType: 'LLP_PARTNERSHIP' }, 'ADVERTISER.LLP_PARTNERSHIP'],
      [{ party: 'ADVERTISER', entityType: 'NON_PROFIT' }, 'ADVERTISER.NON_PROFIT'],
      [{ party: 'ADVERTISER', entityType: 'GOVERNMENT_EDUCATION' }, 'ADVERTISER.GOVERNMENT_EDUCATION'],
      [{ party: 'ADVERTISER', entityType: 'OTHER_ENTITY' }, 'ADVERTISER.OTHER_ENTITY'],
      [{ party: 'ADVERTISER', entityType: 'POLITICAL' }, 'ADVERTISER.POLITICAL'],
      [{ party: 'PRINT_PARTNER', entityType: 'INDIVIDUAL' }, 'PRINT_PARTNER.INDIVIDUAL'],
      [{ party: 'PRINT_PARTNER', entityType: 'SOLE_PROPRIETOR' }, 'PRINT_PARTNER.SOLE_PROPRIETOR'],
      [{ party: 'PRINT_PARTNER', entityType: 'COMPANY' }, 'PRINT_PARTNER.COMPANY'],
      [{ party: 'PRINT_PARTNER', entityType: 'LLP_PARTNERSHIP' }, 'PRINT_PARTNER.LLP_PARTNERSHIP'],
      // A print shop has no non-profit or political workflow.
      [{ party: 'PRINT_PARTNER', entityType: 'NON_PROFIT' }, null],
      [{ party: 'PRINT_PARTNER', entityType: 'POLITICAL' }, null],
      // Not known yet: no workflow — the KYC start asks before it gets here.
      [{ party: 'PUBLISHER', entityType: null }, null],
      [{ party: 'ADVERTISER' }, null],
      // The owner, 1 Oct 2026: field and sales agents alike; no entity type consulted.
      [{ party: 'AGENT' }, 'AGENT'],
      [{ party: 'AGENT', entityType: 'COMPANY' }, 'AGENT'],
      // Part time goes through the full-time workflow until the owner says otherwise.
      [{ party: 'EMPLOYEE', employmentType: 'FULL_TIME' }, 'EMPLOYEE.FULL_TIME'],
      [{ party: 'EMPLOYEE', employmentType: 'PART_TIME' }, 'EMPLOYEE.FULL_TIME'],
      [{ party: 'EMPLOYEE', employmentType: null }, 'EMPLOYEE.FULL_TIME'],
      [{ party: 'EMPLOYEE', employmentType: 'CONTRACT' }, 'EMPLOYEE.INTERN_CONTRACT'],
      [{ party: 'EMPLOYEE', employmentType: 'INTERN' }, 'EMPLOYEE.INTERN_CONTRACT'],
    ];
    for (const [input, key] of cases) expect([input, workflowKeyFor(input)]).toEqual([input, key]);
  });

  it('reaches twenty-two of the twenty-five — the three spot workflows wait for listing verification', () => {
    const reached = new Set<string>();
    for (const party of ['PUBLISHER', 'ADVERTISER', 'PRINT_PARTNER'] as const) {
      for (const entityType of ['INDIVIDUAL', 'SOLE_PROPRIETOR', 'COMPANY', 'LLP_PARTNERSHIP', 'NON_PROFIT', 'GOVERNMENT_EDUCATION', 'OTHER_ENTITY', 'POLITICAL'] as const) {
        const key = workflowKeyFor({ party, entityType });
        if (key) reached.add(key);
      }
    }
    reached.add(workflowKeyFor({ party: 'AGENT' })!);
    for (const employmentType of ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] as const) reached.add(workflowKeyFor({ party: 'EMPLOYEE', employmentType })!);
    expect(reached.size).toBe(22);
    expect(DIGIO_WORKFLOW_KEYS.filter((key) => !reached.has(key))).toEqual(['SPOT.TRANSIT', 'SPOT.OUTDOOR', 'SPOT.MEDIA']);
  });
});

describe('an override from the settings', () => {
  it('wins over the default for its own workflow, blank or missing falls back', () => {
    const overrides = { AGENT: 'KTP2610019999999999OVERRIDE00001', 'PUBLISHER.COMPANY': '   ' };
    expect(workflowTemplateId('AGENT', overrides)).toBe('KTP2610019999999999OVERRIDE00001');
    expect(workflowTemplateId('PUBLISHER.COMPANY', overrides)).toBe(DEFAULT_DIGIO_WORKFLOW_TEMPLATES['PUBLISHER.COMPANY']);
    expect(workflowTemplateId('ADVERTISER.INDIVIDUAL', overrides)).toBe(DEFAULT_DIGIO_WORKFLOW_TEMPLATES['ADVERTISER.INDIVIDUAL']);
    expect(workflowTemplateId('ADVERTISER.INDIVIDUAL', null)).toBe(DEFAULT_DIGIO_WORKFLOW_TEMPLATES['ADVERTISER.INDIVIDUAL']);
  });

  it('shows on the settings card as OVERRIDE, every other row DEFAULT', () => {
    const rows = digioWorkflows({ 'EMPLOYEE.FULL_TIME': 'KTP2610019999999999OVERRIDE00002' });
    expect(rows).toHaveLength(25);
    expect(rows.find((row) => row.key === 'EMPLOYEE.FULL_TIME')).toEqual({
      key: 'EMPLOYEE.FULL_TIME',
      label: DIGIO_WORKFLOW_LABELS['EMPLOYEE.FULL_TIME'],
      templateId: 'KTP2610019999999999OVERRIDE00002',
      source: 'OVERRIDE',
    });
    expect(rows.filter((row) => row.source === 'DEFAULT')).toHaveLength(24);
    expect(rows.map((row) => row.key)).toEqual(DIGIO_WORKFLOW_KEYS);
  });
});

describe('a Digio callback', () => {
  it('verifies on approved, rejects on rejected, and reads anything else — known or not — as PENDING', () => {
    expect(digioDecisionOf('approved')).toBe('VERIFIED');
    expect(digioDecisionOf('APPROVED')).toBe('VERIFIED');
    expect(digioDecisionOf('rejected')).toBe('REJECTED');
    for (const status of ['pending', 'cancelled', 'approval_pending', 'requested', 'expired', '', undefined]) expect(digioDecisionOf(status)).toBe('PENDING');
  });

  it('never moves a decided record back to PENDING', () => {
    expect(isStaleDigioCallback('VERIFIED', 'PENDING')).toBe(true);
    expect(isStaleDigioCallback('REJECTED', 'PENDING')).toBe(true);
    expect(isStaleDigioCallback('PENDING', 'PENDING')).toBe(false);
    expect(isStaleDigioCallback('NEEDS_INFO', 'PENDING')).toBe(false);
    // A decision always lands.
    expect(isStaleDigioCallback('VERIFIED', 'REJECTED')).toBe(false);
    expect(isStaleDigioCallback('REJECTED', 'VERIFIED')).toBe(false);
  });
});
