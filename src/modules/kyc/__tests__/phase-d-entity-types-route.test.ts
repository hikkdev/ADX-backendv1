import express, { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { kycEntityRequestSchema, kycRequestSchema } from '../kyc.schema';
import { kycEntityTypeRouter } from '../entity-types.routes';

/**
 * Phase D (the owner, 1 Oct 2026) — `GET /kyc/entity-types`: the legal forms
 * each party may verify as, for the picker the apps, the website and the
 * console draw before a Digio start. Any signed-in user; nobody signed out.
 * And the desk's request body, which now carries the form.
 */

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/kyc', kycEntityTypeRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

describe('GET /kyc/entity-types', () => {
  it('answers each party’s allowed forms in the enum’s order, labelled', async () => {
    for (const roles of [['PUBLISHER'], ['ADVERTISER'], ['PARTNER'], ['ADMIN'], ['AGENT_PUBLISHER']] as const) {
      const res = await request(app()).get('/api/v1/kyc/entity-types').set('Authorization', `Bearer ${tokenFor([...roles], 'usr_1')}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: {
          PUBLISHER: [
            { value: 'INDIVIDUAL', label: 'Individual' },
            { value: 'SOLE_PROPRIETOR', label: 'Sole proprietor' },
            { value: 'COMPANY', label: 'Company' },
            { value: 'LLP_PARTNERSHIP', label: 'LLP or partnership' },
            { value: 'NON_PROFIT', label: 'Non-profit (NGO, trust, society, Section 8)' },
            { value: 'GOVERNMENT_EDUCATION', label: 'Government or education' },
            { value: 'OTHER_ENTITY', label: 'Other entity (HUF, co-operative, AOP, …)' },
            { value: 'POLITICAL', label: 'Political party or candidate' },
          ],
          ADVERTISER: [
            { value: 'INDIVIDUAL', label: 'Individual' },
            { value: 'SOLE_PROPRIETOR', label: 'Sole proprietor' },
            { value: 'COMPANY', label: 'Company' },
            { value: 'LLP_PARTNERSHIP', label: 'LLP or partnership' },
            { value: 'NON_PROFIT', label: 'Non-profit (NGO, trust, society, Section 8)' },
            { value: 'GOVERNMENT_EDUCATION', label: 'Government or education' },
            { value: 'OTHER_ENTITY', label: 'Other entity (HUF, co-operative, AOP, …)' },
            { value: 'POLITICAL', label: 'Political party or candidate' },
          ],
          PRINT_PARTNER: [
            { value: 'INDIVIDUAL', label: 'Individual' },
            { value: 'SOLE_PROPRIETOR', label: 'Sole proprietor' },
            { value: 'COMPANY', label: 'Company' },
            { value: 'LLP_PARTNERSHIP', label: 'LLP or partnership' },
          ],
        },
      });
    }
  });

  it('is 401 signed out', async () => {
    const res = await request(app()).get('/api/v1/kyc/entity-types');
    expect(res.status).toBe(401);
  });
});

describe('the desk’s request body', () => {
  it('for a publisher, advertiser or print partner takes an entity type beside the channel and the note', () => {
    expect(kycEntityRequestSchema.parse({})).toEqual({ channel: 'DIGIO' });
    expect(kycEntityRequestSchema.parse({ entityType: 'company' })).toEqual({ channel: 'DIGIO', entityType: 'COMPANY' });
    expect(kycEntityRequestSchema.parse({ channel: 'manual', note: 'Come by', entityType: 'NON_PROFIT' })).toEqual({ channel: 'MANUAL', note: 'Come by', entityType: 'NON_PROFIT' });
    expect(kycEntityRequestSchema.safeParse({ entityType: 'TRUST' }).success).toBe(false);
  });

  it('for an agent or an employee does not — their workflow comes from who they are', () => {
    expect(kycRequestSchema.parse({ entityType: 'COMPANY' })).toEqual({ channel: 'DIGIO' });
  });
});
