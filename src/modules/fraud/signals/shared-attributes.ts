import type { PayoutHandle, StoredSignal } from './types';

/**
 * The shared attributes behind the linked-accounts graph — 28 Sep 2026.
 *
 * The console draws `GET /fraud/cases/:id/linked` as a bipartite graph: the
 * accounts on one side, the things they share on the other ("PAN ••••234F",
 * "HDFC ••4821", "Device 4f2a"). This file names those things, one per
 * linking signal that tied the subject to somebody, with a MASKED display
 * value: the desk needs to tell one PAN from another at a glance, never to
 * read the PAN. A full PAN, account number, UPI id, mobile or address never
 * leaves here — each mask keeps at most four characters of the value, and a
 * value too short to mask safely keeps none.
 *
 * Pure: the service reads the subject's handles (payout methods, sign-in
 * subnets, device tokens) and hands them in.
 */

/** One shared attribute: the signal, what the desk calls it, the masked value, and how many linked accounts share it. */
export type SharedAttribute = {
  signal: string;
  label: string;
  /** Masked — "PAN ••••234F", "HDFC ••4821", "Device 4f2a", "103.21.58.x/24", "Mobile ••3210"; the label for any other signal. */
  display: string;
  /** Linked accounts (the subject not counted) this signal ties the subject to. */
  accounts: number;
};

/** What the desk calls each signal key — the console's `SIGNAL_LABEL`, so the two read the same. */
export const SIGNAL_LABELS: Readonly<Record<string, string>> = {
  SHARED_PAN: 'PAN number',
  SHARED_BANK: 'Payout account',
  SHARED_IP_SUBNET: 'IP subnet',
  SHARED_PHONE_ACROSS_ROLES: 'Mobile across roles',
  SHARED_DEVICE: 'Device fingerprint',
  BANK_NAME_MISMATCH: 'Payout account in another name',
  DUPLICATE_LISTING_PHOTOS: 'Duplicate listing photos',
  PROOF_FAR_FROM_SITE: 'Installation proofs far from site',
  SELF_DEALING: 'Self-dealing',
  COMMISSION_FARMING: 'Commission farming',
  REFUND_DISPUTE_RATE: 'Refund and dispute rate',
  WITHDRAW_AFTER_CREDIT: 'Withdrawal straight after credit',
  LISTING_VELOCITY: 'Listing velocity',
};

export const signalLabel = (key: string): string => SIGNAL_LABELS[key] ?? key;

const MASK = '••';

/**
 * The tail a mask may keep: the last four of a value of eight or more
 * characters, the last two of five to seven, nothing of anything shorter —
 * so no mask ever answers a whole value.
 */
export function maskedTail(value: string | null | undefined): string {
  const clean = (value ?? '').replace(/[^0-9A-Za-z]/g, '');
  if (clean.length >= 8) return clean.slice(-4);
  if (clean.length >= 5) return clean.slice(-2);
  return '';
}

/** "ABCDE1234F" → "PAN ••••234F". */
export function maskPan(pan: string | null | undefined): string {
  return `PAN ${MASK}${MASK}${maskedTail(pan).toUpperCase()}`;
}

/**
 * The bank's short name for the caption: a leading acronym of the typed
 * name ("HDFC Bank" → HDFC, "ICICI Bank" → ICICI), else the IFSC's bank code
 * (its first four letters), else the typed name's initials ("State Bank of
 * India" → SBI), else "Bank".
 */
export function bankShortName(bankName: string | null | undefined, ifscCode: string | null | undefined): string {
  const name = (bankName ?? '').trim();
  const first = name.split(/\s+/)[0] ?? '';
  if (/^[A-Z]{2,6}$/.test(first)) return first;
  const ifsc = (ifscCode ?? '').trim().toUpperCase();
  if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return ifsc.slice(0, 4);
  const initials = name
    .split(/\s+/)
    .filter((word) => word && !/^(of|the|and|ltd|limited|co)$/i.test(word))
    .map((word) => word[0]!.toUpperCase())
    .join('');
  if (initials.length >= 2 && initials.length <= 6) return initials;
  return 'Bank';
}

/** A payout method as a caption: "HDFC ••4821" for an account, "UPI ••3210" for a UPI id (the part before the @). */
export function maskPayout(handle: Pick<PayoutHandle, 'accountNumber' | 'upiVpa' | 'bankName' | 'ifscCode'>): string {
  if (handle.accountNumber) return `${bankShortName(handle.bankName, handle.ifscCode)} ${MASK}${maskedTail(handle.accountNumber)}`;
  if (handle.upiVpa) return `UPI ${MASK}${maskedTail(handle.upiVpa.split('@')[0])}`;
  return 'Payout account';
}

/** A device token as a caption: its first four characters, of a token long enough that four say nothing. */
export function maskDevice(token: string | null | undefined, sessions?: number | null): string {
  const clean = (token ?? '').trim();
  const head = clean.length >= 12 ? ` ${clean.slice(0, 4)}` : '';
  return `Device${head}${sessions ? ` · ${sessions} ${sessions === 1 ? 'session' : 'sessions'}` : ''}`;
}

/** "103.21.58.0/24" → "103.21.58.x/24"; an IPv6 /64 keeps its first two hextets. Anything else is the label. */
export function maskSubnet(subnet: string | null | undefined): string {
  const value = (subnet ?? '').trim();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}\/24$/.exec(value);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x/24`;
  if (value.includes(':')) {
    const hextets = value.replace(/::\/64$/, '').split(':').filter(Boolean);
    if (hextets.length >= 2) return `${hextets[0]}:${hextets[1]}:x::/64`;
  }
  return signalLabel('SHARED_IP_SUBNET');
}

/** "+919999903210" → "Mobile ••3210". */
export function maskPhone(mobile: string | null | undefined): string {
  return `Mobile ${MASK}${maskedTail((mobile ?? '').replace(/\D/g, ''))}`;
}

/** The subject's own handles the masks are drawn from — read by the service for the signals that linked. */
export type AttributeHandles = {
  pan: string | null;
  mobile: string | null;
  payout: PayoutHandle[];
  subnets: string[];
  deviceTokens: string[];
};

/** A second handle of the same kind is counted, not shown: "103.21.58.x/24 +1". */
const more = (count: number) => (count > 1 ? ` +${count - 1}` : '');

function displayOf(signal: string, handles: AttributeHandles): string {
  switch (signal) {
    case 'SHARED_PAN':
      return handles.pan ? maskPan(handles.pan) : signalLabel(signal);
    case 'SHARED_BANK': {
      const accounts = handles.payout.filter((handle) => handle.accountNumber);
      const upis = handles.payout.filter((handle) => !handle.accountNumber && handle.upiVpa);
      const shown = accounts[0] ?? upis[0];
      return shown ? `${maskPayout(shown)}${more(accounts.length + upis.length)}` : signalLabel(signal);
    }
    case 'SHARED_IP_SUBNET':
      return handles.subnets.length ? `${maskSubnet(handles.subnets[0])}${more(handles.subnets.length)}` : signalLabel(signal);
    case 'SHARED_DEVICE':
      return handles.deviceTokens.length ? `${maskDevice(handles.deviceTokens[0])}${more(handles.deviceTokens.length)}` : signalLabel(signal);
    case 'SHARED_PHONE_ACROSS_ROLES':
      return handles.mobile ? maskPhone(handles.mobile) : signalLabel(signal);
    default:
      return signalLabel(signal);
  }
}

/**
 * One attribute per signal that linked somebody, in the registry's order,
 * with the number of distinct linked accounts that signal names. A signal
 * that linked nobody is not an attribute.
 */
export function sharedAttributes(signals: readonly StoredSignal[], handles: AttributeHandles): SharedAttribute[] {
  const out: SharedAttribute[] = [];
  for (const signal of signals) {
    const accounts = new Set((signal.links ?? []).map((party) => `${party.type}:${party.id}`)).size;
    if (accounts === 0) continue;
    out.push({ signal: signal.key, label: signalLabel(signal.key), display: displayOf(signal.key, handles), accounts });
  }
  return out;
}
