import { aziraTest } from './azira';
import { geoiqTest } from './geoiq';
import type { AudienceVendor, AudienceVendorTest } from './types';

/**
 * AC-B2: the vendor test behind the integrations card.
 *
 * One fixed point so two tests compare and nobody's spot is spent on a
 * probe: MG Road, Bengaluru. The radius is the row's `catchmentRadiusM`,
 * clamped to what the vendor allows. The answer is a plain verdict — key
 * present, host reachable, key authorised, the vendor's effective status
 * and its own sentence, which mapped fields came back — never a key, and
 * never a throw for anything the vendor did: the card prints the verdict.
 */
export const AUDIENCE_TEST_POINT = { lat: 12.9755, lng: 77.6068, label: 'MG Road, Bengaluru' } as const;

export async function testAudienceVendor(vendor: AudienceVendor): Promise<AudienceVendorTest> {
  return vendor === 'GEOIQ' ? geoiqTest(AUDIENCE_TEST_POINT) : aziraTest(AUDIENCE_TEST_POINT);
}
