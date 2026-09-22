import { z } from 'zod';

/**
 * LH1 (the Lead Hunt, 22 Sep 2026): the scoring policy — decision D10.
 *
 * Five signals, one score: fit 0–30 (what the business is, for the side),
 * intent 0–35 (what they did), recency −25–0 (how long since anybody
 * touched them), source quality 0–15 (learned per source), the agent's
 * flag +10 for 14 days. Hot at 70, warm at 40, cold below. Every number
 * lives here so ops tunes the hunt without a deploy; `platform-settings`
 * carries it under `leads.scoring`.
 */

/** The intent signals the activity thread can carry, each worth points toward the 35. */
export const INTENT_SIGNALS = [
  'CALLED',
  'MESSAGED',
  'FOLLOW_UP',
  'VISIT_BOOKED',
  'VISIT_DONE',
  'ENGAGED',
  'LINK_OPENED',
  'PROPOSAL_SENT',
  'TOUCH_LOGGED',
  'INBOUND',
] as const;
export type IntentSignal = (typeof INTENT_SIGNALS)[number];

const points = (max: number) => z.number().int().min(0).max(max);

export const leadScoringSchema = z.object({
  /** The ceiling of each signal; the score is their sum, clamped 0–100. */
  weights: z.object({
    fitMax: points(50),
    intentMax: points(50),
    /** Negative: the most recency can take away. */
    recencyMin: z.number().int().min(-50).max(0),
    sourceMax: points(30),
    agentFlag: points(30),
  }),
  /** Days without a touch → points taken away (D10: −5 at 7, −15 at 21, −25 at 45). */
  recency: z.object({
    afterDays7: z.number().int().min(-50).max(0),
    afterDays21: z.number().int().min(-50).max(0),
    afterDays45: z.number().int().min(-50).max(0),
  }),
  thresholds: z.object({
    /** Score at or above which a lead is HOT. */
    hot: z.number().int().min(1).max(100),
    /** Score at or above which a lead is WARM; below is COLD. */
    warm: z.number().int().min(0).max(99),
  }),
  /** How long the agent's "this one is hot" is worth its points. */
  agentFlagDays: z.number().int().min(1).max(90),
  /** Points per intent signal on the thread; summed over the last 90 days, capped at `intentMax`. */
  intent: z.object(Object.fromEntries(INTENT_SIGNALS.map((key) => [key, points(35)])) as Record<IntentSignal, z.ZodNumber>),
  fit: z.object({
    /** A category nobody listed. */
    defaultCategory: points(30),
    /** Category (lower-cased, as typed) → points, per side. */
    categoryBySide: z.object({
      PUBLISHER: z.record(z.string(), points(30)),
      ADVERTISER: z.record(z.string(), points(30)),
    }),
    /** AG-5's band on top of the category. */
    importanceBonus: z.object({ KEY: points(30), ENTERPRISE: points(30) }),
    /** Locality balance: a publisher lead where supply is thin, an advertiser lead where supply is rich. */
    localityBonus: points(30),
    /** The radius the locality balance is read over. */
    localityRadiusM: z.number().int().min(200).max(5000),
  }),
});
export type LeadScoringPolicy = z.infer<typeof leadScoringSchema>;

export const DEFAULT_LEAD_SCORING: LeadScoringPolicy = {
  weights: { fitMax: 30, intentMax: 35, recencyMin: -25, sourceMax: 15, agentFlag: 10 },
  recency: { afterDays7: -5, afterDays21: -15, afterDays45: -25 },
  thresholds: { hot: 70, warm: 40 },
  agentFlagDays: 14,
  intent: {
    CALLED: 5,
    MESSAGED: 5,
    FOLLOW_UP: 5,
    VISIT_BOOKED: 20,
    VISIT_DONE: 20,
    ENGAGED: 15,
    LINK_OPENED: 10,
    PROPOSAL_SENT: 5,
    TOUCH_LOGGED: 5,
    // Twenty, so a business that came to ADX itself lands warm on the default fit and a typical inbound source's quality.
    INBOUND: 20,
  },
  fit: {
    defaultCategory: 12,
    categoryBySide: {
      PUBLISHER: {
        gym: 22,
        cafe: 20,
        café: 20,
        restaurant: 20,
        'shop front': 22,
        'shop': 18,
        mall: 24,
        'hoarding owner': 24,
        'print vendor': 20,
        rwa: 22,
        'apartment': 20,
        'building': 20,
        salon: 18,
        pharmacy: 16,
        'petrol pump': 20,
        'coaching centre': 10,
        clinic: 12,
      },
      ADVERTISER: {
        'coaching centre': 24,
        clinic: 22,
        'real estate': 24,
        'real-estate': 24,
        franchise: 22,
        d2c: 20,
        'd2c brand': 20,
        agency: 24,
        'media agency': 24,
        restaurant: 18,
        gym: 16,
        salon: 16,
        retail: 18,
        automobile: 20,
        'car dealer': 20,
        jewellery: 20,
        'print vendor': 6,
        'hoarding owner': 6,
      },
    },
    importanceBonus: { KEY: 4, ENTERPRISE: 8 },
    localityBonus: 6,
    localityRadiusM: 1000,
  },
};

/** The temperature a score lands in under the thresholds. */
export function temperatureOf(score: number, thresholds: LeadScoringPolicy['thresholds']): 'HOT' | 'WARM' | 'COLD' {
  if (score >= thresholds.hot) return 'HOT';
  if (score >= thresholds.warm) return 'WARM';
  return 'COLD';
}
