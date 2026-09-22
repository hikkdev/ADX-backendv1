import { INTENT_SIGNALS, temperatureOf, type IntentSignal, type LeadScoringPolicy } from '../../shared/lead-scoring';

/**
 * LH1: the score, as arithmetic. Pure — the service reads the rows and the
 * policy, this decides; the tests pin every signal without a database.
 */

export type ScoreSignal = 'FIT' | 'INTENT' | 'RECENCY' | 'SOURCE' | 'AGENT_FLAG';

export type ScoreReason = {
  signal: ScoreSignal;
  points: number;
  /** One sentence the lead page and the app print: "Opened the invite link". */
  note: string;
};

export type ScoreInput = {
  side: 'PUBLISHER' | 'ADVERTISER' | string;
  category: string | null;
  importance: string | null;
  createdAt: Date;
  lastTouchedAt: Date | null;
  agentFlaggedHotAt: Date | null;
  /** The source's learned quality (0–15) and its kind; null for a lead with no source row. */
  source: { quality: number; kind: string } | null;
  /** The intent-bearing activity rows of the last 90 days. */
  activity: { kind: string; at: Date }[];
  /** Live listings within the policy's radius; null when the lead has no point. */
  liveListingsNearby: number | null;
};

export type ScoreResult = {
  score: number;
  temperature: 'HOT' | 'WARM' | 'COLD';
  reasons: ScoreReason[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const INTENT_NOTE: Record<IntentSignal, string> = {
  CALLED: 'Spoke on a call',
  MESSAGED: 'Messaged',
  FOLLOW_UP: 'A follow-up was set',
  VISIT_BOOKED: 'A visit is booked',
  VISIT_DONE: 'A visit was made',
  ENGAGED: 'They replied',
  LINK_OPENED: 'Opened the invite link',
  PROPOSAL_SENT: 'A proposal went out',
  TOUCH_LOGGED: 'Reached on another channel',
  INBOUND: 'Came to ADX themselves',
};

const isIntent = (kind: string): kind is IntentSignal => (INTENT_SIGNALS as readonly string[]).includes(kind);

/** Fit: category × side, the band, the locality's supply. 0..fitMax. */
export function fitPoints(input: ScoreInput, policy: LeadScoringPolicy): ScoreReason {
  const side = input.side === 'ADVERTISER' ? 'ADVERTISER' : 'PUBLISHER';
  const table = policy.fit.categoryBySide[side];
  const key = input.category?.trim().toLowerCase() ?? '';
  const categoryPoints = key && table[key] !== undefined ? table[key]! : policy.fit.defaultCategory;
  let points = categoryPoints;
  const notes: string[] = [key && table[key] !== undefined ? `${input.category} is a strong ${side.toLowerCase()} lead` : 'Category not weighted'];
  if (input.importance === 'KEY') {
    points += policy.fit.importanceBonus.KEY;
    notes.push('Key account');
  } else if (input.importance === 'ENTERPRISE') {
    points += policy.fit.importanceBonus.ENTERPRISE;
    notes.push('Enterprise account');
  }
  if (input.liveListingsNearby !== null) {
    // A publisher lead where supply is thin fills a gap; an advertiser lead where supply is rich is easy to serve.
    const thin = input.liveListingsNearby < 3;
    const rich = input.liveListingsNearby >= 5;
    if ((side === 'PUBLISHER' && thin) || (side === 'ADVERTISER' && rich)) {
      points += policy.fit.localityBonus;
      notes.push(side === 'PUBLISHER' ? 'Few live spots nearby' : `${input.liveListingsNearby} live spots nearby`);
    }
  }
  return { signal: 'FIT', points: clamp(points, 0, policy.weights.fitMax), note: notes.join(' · ') };
}

/** Intent: what they did, summed over the thread's last 90 days, capped. 0..intentMax. */
export function intentPoints(input: ScoreInput, policy: LeadScoringPolicy): ScoreReason {
  let points = 0;
  const seen = new Map<IntentSignal, number>();
  for (const row of input.activity) {
    if (!isIntent(row.kind)) continue;
    points += policy.intent[row.kind];
    seen.set(row.kind, (seen.get(row.kind) ?? 0) + 1);
  }
  if (input.source?.kind === 'INBOUND' || input.source?.kind === 'ADS' || input.source?.kind === 'QR' || input.source?.kind === 'REFERRAL') {
    points += policy.intent.INBOUND;
    seen.set('INBOUND', 1);
  }
  const top = [...seen.entries()].sort((a, b) => policy.intent[b[0]] * b[1] - policy.intent[a[0]] * a[1]).slice(0, 2);
  const note = top.length ? top.map(([kind, count]) => (count > 1 ? `${INTENT_NOTE[kind]} (×${count})` : INTENT_NOTE[kind])).join(' · ') : 'No response yet';
  return { signal: 'INTENT', points: clamp(points, 0, policy.weights.intentMax), note };
}

/** Recency: days since the last touch (the creation when nobody touched them). recencyMin..0. */
export function recencyPoints(input: ScoreInput, policy: LeadScoringPolicy, now: Date): ScoreReason {
  const since = input.lastTouchedAt ?? input.createdAt;
  const days = Math.floor((now.getTime() - since.getTime()) / DAY_MS);
  let points = 0;
  if (days >= 45) points = policy.recency.afterDays45;
  else if (days >= 21) points = policy.recency.afterDays21;
  else if (days >= 7) points = policy.recency.afterDays7;
  const note = days === 0 ? 'Touched today' : days < 7 ? `Touched ${days} day${days === 1 ? '' : 's'} ago` : `Nothing for ${days} days`;
  return { signal: 'RECENCY', points: clamp(points, policy.weights.recencyMin, 0), note };
}

/** Source quality: the source's own learned figure. 0..sourceMax. */
export function sourcePoints(input: ScoreInput, policy: LeadScoringPolicy): ScoreReason {
  if (!input.source) return { signal: 'SOURCE', points: 0, note: 'Source unknown' };
  const points = clamp(Math.round(input.source.quality), 0, policy.weights.sourceMax);
  return { signal: 'SOURCE', points, note: `${input.source.kind.charAt(0)}${input.source.kind.slice(1).toLowerCase()} source` };
}

/** The agent's flag, while it lives. 0 or agentFlag. */
export function agentFlagPoints(input: ScoreInput, policy: LeadScoringPolicy, now: Date): ScoreReason {
  if (!input.agentFlaggedHotAt) return { signal: 'AGENT_FLAG', points: 0, note: 'Not flagged' };
  const ageDays = (now.getTime() - input.agentFlaggedHotAt.getTime()) / DAY_MS;
  if (ageDays > policy.agentFlagDays) return { signal: 'AGENT_FLAG', points: 0, note: 'Flag expired' };
  const left = Math.max(0, Math.ceil(policy.agentFlagDays - ageDays));
  return { signal: 'AGENT_FLAG', points: policy.weights.agentFlag, note: `Flagged hot by the agent (${left} day${left === 1 ? '' : 's'} left)` };
}

export function computeScore(input: ScoreInput, policy: LeadScoringPolicy, now = new Date()): ScoreResult {
  const reasons = [fitPoints(input, policy), intentPoints(input, policy), recencyPoints(input, policy, now), sourcePoints(input, policy), agentFlagPoints(input, policy, now)];
  const score = clamp(reasons.reduce((sum, reason) => sum + reason.points, 0), 0, 100);
  return { score, temperature: temperatureOf(score, policy.thresholds), reasons };
}

/** Temperature order, hottest first — the map and the list sort on it. */
export const TEMPERATURE_RANK: Record<'HOT' | 'WARM' | 'COLD', number> = { HOT: 0, WARM: 1, COLD: 2 };

/**
 * LH1: a source's quality from its own 90-day conversion rate. A referral
 * from a live publisher converting at 30 % is the ceiling; a scraped row at
 * 2 % is one point. Fewer than `minSample` leads keep the figure it had —
 * three leads are not a rate.
 */
export function learnedQuality(created: number, converted: number, current: number, max: number, minSample = 20): number {
  if (created < minSample) return current;
  const rate = converted / created;
  return clamp(Math.round(rate * 50), 1, max);
}

/** "Warmed up: opened your link" / "Cooled: nothing for 21 days" — the activity note when the temperature moves. */
export function temperatureChangeNote(from: 'HOT' | 'WARM' | 'COLD' | null, to: 'HOT' | 'WARM' | 'COLD', reasons: ScoreReason[]): string {
  const warmer = from === null || TEMPERATURE_RANK[to] < TEMPERATURE_RANK[from];
  const driver = warmer
    ? [...reasons].filter((r) => r.points > 0).sort((a, b) => b.points - a.points)[0]
    : [...reasons].sort((a, b) => a.points - b.points)[0];
  const label = to === 'HOT' ? 'Hot' : to === 'WARM' ? 'Warm' : 'Cold';
  return `${warmer ? 'Warmed up' : 'Cooled'} to ${label}${driver ? `: ${driver.note}` : ''}`;
}
