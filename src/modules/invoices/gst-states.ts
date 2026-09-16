/**
 * The GST state codes — the two digits at the front of every GSTIN, and the
 * key that decides whether a supply is intra-state (CGST + SGST) or
 * inter-state (IGST).
 *
 * `Advertiser.state` and `Publisher.state` are free text typed by a person,
 * so the lookup is by name, forgiving of case and the odd "&". A state that
 * cannot be resolved is treated as the supplier's own — for a service whose
 * recipient address is unknown the place of supply is the supplier's
 * location, which is the CGST + SGST case, and never a guess at IGST.
 */
export const GST_STATES: readonly { code: string; name: string }[] = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '25', name: 'Daman and Diu' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other Territory' },
];

const ALIASES: Record<string, string> = {
  orissa: '21',
  pondicherry: '34',
  'new delhi': '07',
  'delhi ncr': '07',
  bengaluru: '29',
  bangalore: '29',
  mumbai: '27',
  chennai: '33',
  hyderabad: '36',
  kolkata: '19',
  uttaranchal: '05',
};

const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The two-digit code for a state, from its name, a city that names one, or
 * the code itself. Null when nothing matches.
 */
export function gstStateCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{2}$/.test(trimmed)) {
    return GST_STATES.some((state) => state.code === trimmed) ? trimmed : null;
  }
  const key = normalise(trimmed);
  if (!key) return null;
  const alias = ALIASES[key];
  if (alias) return alias;
  const byName = GST_STATES.find((state) => normalise(state.name) === key);
  return byName?.code ?? null;
}

export function gstStateName(code: string | null | undefined): string | null {
  if (!code) return null;
  return GST_STATES.find((state) => state.code === code)?.name ?? null;
}

/** "29 - Karnataka", the way place of supply is printed. */
export function placeOfSupplyLabel(code: string | null | undefined): string | null {
  const name = gstStateName(code);
  return name ? `${code} - ${name}` : null;
}
