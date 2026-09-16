import { Decimal } from '../../shared/money';

/**
 * "Rupees Twelve Lakh Thirty-Four Thousand Five Hundred and Six and Paise
 * Fifty Only" — the line every Indian tax invoice carries under its total.
 * Indian grouping (lakh, crore), not thousands/millions.
 */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest) {
    if (hundreds) parts.push('and');
    if (rest < 20) parts.push(ONES[rest] as string);
    else {
      const tens = TENS[Math.floor(rest / 10)] as string;
      const ones = rest % 10;
      parts.push(ones ? `${tens}-${ONES[ones]}` : tens);
    }
  }
  return parts.join(' ');
}

/** A whole number in Indian words. Zero is "Zero". */
export function integerInWords(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('integerInWords takes a non-negative number');
  let n = Math.floor(value);
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${integerInWords(crore)} Crore`);
  if (lakh) parts.push(`${belowThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${belowThousand(thousand)} Thousand`);
  if (n) parts.push(belowThousand(n));
  return parts.join(' ');
}

/** The invoice line, for any decimal amount. A negative amount reads as its magnitude. */
export function amountInWords(amount: Decimal | string | number): string {
  const value = new Decimal(amount).abs();
  const rupees = value.floor();
  const paise = value.minus(rupees).times(100).round().toNumber();
  const words = `Rupees ${integerInWords(rupees.toNumber())}`;
  return paise > 0 ? `${words} and Paise ${integerInWords(paise)} Only` : `${words} Only`;
}
