import { describe, expect, it, vi } from 'vitest';

/**
 * AG-4 (the owner, 20 Sep 2026): Cashfree's Verification Suite — the vehicle
 * RC lookup and the bank penny drop.
 *
 * Pinned: the sandbox host and the client pair on the wire; the RC row
 * shaped into ADX's facts whatever Cashfree's spelling; a refusal (an
 * unwhitelisted IP, an unknown number) and an outage as answers, never
 * throws; unconfigured means MANUAL; the fallback name match.
 */

import { lookupVehicleRc, nameMatchScore, normaliseVehicleNumber, shapeVehicleRc, verifyBankAccount } from '../cashfree-verification';

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as unknown as Response;
const cfg = { clientId: 'CF-TEST', clientSecret: 'cfsk_test', testMode: true };

describe('the vehicle RC lookup', () => {
  it('asks the sandbox with the client pair and shapes the row', async () => {
    const fetchImpl = vi.fn(async () =>
      reply(200, {
        reference_id: 'ref_1',
        status: 'VALID',
        reg_no: 'KA01AB1234',
        owner: 'DEEPAK RAO',
        vehicle_class: 'M-Cycle/Scooter(2WN)',
        manufacturer: 'HONDA MOTORCYCLE AND SCOOTER INDIA',
        vehicle_model: 'ACTIVA 6G',
        fuel_type: 'PETROL',
        reg_date: '2021-03-15',
        insurance_upto: '2027-03-14',
        fitness_upto: '2036-03-14',
        blacklist_status: 'NA',
        seating_capacity: '2',
      }),
    );
    const answer = await lookupVehicleRc('ka 01 ab-1234', fetchImpl, cfg);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://sandbox.cashfree.com/verification/vehicle-rc?vehicle_number=KA01AB1234',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ 'x-client-id': 'CF-TEST', 'x-client-secret': 'cfsk_test' }) }),
    );
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.facts).toMatchObject({
      registrationNumber: 'KA01AB1234',
      ownerName: 'DEEPAK RAO',
      vehicleClass: 'M-Cycle/Scooter(2WN)',
      maker: 'HONDA MOTORCYCLE AND SCOOTER INDIA',
      model: 'ACTIVA 6G',
      fuelType: 'PETROL',
      registrationDate: '2021-03-15',
      insuranceValidUntil: '2027-03-14',
      fitnessValidUntil: '2036-03-14',
      blacklisted: false,
      seatingCapacity: 2,
      status: 'VALID',
      referenceId: 'ref_1',
    });
    expect(answer.raw['owner']).toBe('DEEPAK RAO');
  });

  it('a refusal and an outage come back as answers, and no pair means manual', async () => {
    const refused = await lookupVehicleRc('KA01AB1234', vi.fn(async () => reply(403, { message: 'IP not whitelisted' })), cfg);
    expect(refused).toEqual({ ok: false, code: 'REFUSED', status: 403, message: 'IP not whitelisted' });

    const down = await lookupVehicleRc('KA01AB1234', vi.fn(async () => Promise.reject(new Error('ECONNRESET'))), cfg);
    expect(down).toMatchObject({ ok: false, code: 'UNAVAILABLE', message: 'ECONNRESET' });

    const manual = await lookupVehicleRc('KA01AB1234', vi.fn(), { testMode: true });
    expect(manual).toMatchObject({ ok: false, code: 'UNCONFIGURED' });

    expect(normaliseVehicleNumber('dl-3c ab 0001')).toBe('DL3CAB0001');
    expect(shapeVehicleRc('X', {}).ownerName).toBeNull();
  });
});

describe('the bank penny drop', () => {
  it('posts the account and reads the status and the name match', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { reference_id: 'b_1', account_status: 'VALID', name_at_bank: 'DEEPAK RAO', bank_name: 'HDFC Bank', name_match_score: '92.5', name_match_result: 'GOOD_PARTIAL_MATCH', utr: 'UTR1' }));
    const answer = await verifyBankAccount({ accountNumber: '1234 5678 90', ifsc: 'hdfc0001234', name: 'Deepak Rao', phone: '+919000000777' }, fetchImpl, cfg);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://sandbox.cashfree.com/verification/bank-account/sync',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ bank_account: '1234567890', ifsc: 'HDFC0001234', name: 'Deepak Rao', phone: '9000000777' }) }),
    );
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.facts).toMatchObject({ valid: true, nameAtBank: 'DEEPAK RAO', bankName: 'HDFC Bank', nameMatchScore: 92.5, referenceId: 'b_1', utr: 'UTR1' });
  });
});

describe('the fallback name match', () => {
  it('scores token overlap, initials included, and refuses to score a blank', () => {
    expect(nameMatchScore('Deepak Rao', 'DEEPAK RAO')).toBe(100);
    expect(nameMatchScore('Deepak K Rao', 'Deepak Kumar Rao')).toBe(100);
    expect(nameMatchScore('Deepak Rao', 'Anita Sharma')).toBe(0);
    expect(nameMatchScore('Deepak Rao', 'Deepak')).toBe(50);
    expect(nameMatchScore('', 'Deepak')).toBeNull();
  });
});
