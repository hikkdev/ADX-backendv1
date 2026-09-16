import { describe, expect, it } from 'vitest';
import { CITY_STAGES, type CityStageValue } from '../../pricing';
import { DEFAULT_SWITCHES, STAGE_TRANSITIONS, canMove, mirrorOf, planRollout } from '../rollout.rules';

/**
 * The stage machine — Lot V. Every allowed move, every refused one, the
 * default switches a stage enters with, the overrides, the timestamps and
 * the `isActive` mirror, pinned without a database.
 */

const OFF = { supplyIntake: false, publishing: false, demand: false, agentOnboarding: false, printPartners: false, leadFeeds: false };
const ON = { supplyIntake: true, publishing: true, demand: true, agentOnboarding: true, printPartners: true, leadFeeds: true };
const NOW = new Date('2026-09-15T10:00:00Z');

const at = (stage: CityStageValue, extra: Partial<Parameters<typeof planRollout>[0]> = {}) => ({
  stage,
  switches: { ...DEFAULT_SWITCHES[stage] },
  launchedAt: null,
  pausedAt: null,
  withdrawnAt: null,
  ...extra,
});

describe('the transition table', () => {
  it('is exactly the owner\'s five stages and their moves', () => {
    expect(STAGE_TRANSITIONS).toEqual({
      PLANNED: ['SEEDING', 'LAUNCHED'],
      SEEDING: ['LAUNCHED', 'PAUSED', 'WITHDRAWN'],
      LAUNCHED: ['PAUSED', 'WITHDRAWN'],
      PAUSED: ['LAUNCHED', 'WITHDRAWN'],
      WITHDRAWN: ['SEEDING', 'LAUNCHED'],
    });
  });

  it('allows every listed move and refuses every other, including staying put through the table', () => {
    for (const from of CITY_STAGES) {
      for (const to of CITY_STAGES) {
        const allowed = STAGE_TRANSITIONS[from].includes(to);
        expect(canMove(from, to), `${from} -> ${to}`).toBe(allowed);
        if (from === to) continue;
        if (allowed) expect(planRollout(at(from), { stage: to }, NOW).stage).toBe(to);
        else expect(() => planRollout(at(from), { stage: to }, NOW)).toThrow(expect.objectContaining({ statusCode: 409, details: { from, to, allowed: STAGE_TRANSITIONS[from] } }));
      }
    }
  });

  it('refuses PLANNED -> PAUSED, PLANNED -> WITHDRAWN and LAUNCHED -> SEEDING by name', () => {
    expect(() => planRollout(at('PLANNED'), { stage: 'PAUSED' })).toThrow(/planned city cannot go paused/);
    expect(() => planRollout(at('PLANNED'), { stage: 'WITHDRAWN' })).toThrow(/cannot go withdrawn/);
    expect(() => planRollout(at('LAUNCHED'), { stage: 'SEEDING' })).toThrow(/launched city cannot go seeding/);
  });
});

describe('the default switches', () => {
  it('are: PLANNED all off; SEEDING intake, agents and leads; LAUNCHED all on; PAUSED and WITHDRAWN all off', () => {
    expect(DEFAULT_SWITCHES.PLANNED).toEqual(OFF);
    expect(DEFAULT_SWITCHES.SEEDING).toEqual({ ...OFF, supplyIntake: true, agentOnboarding: true, leadFeeds: true });
    expect(DEFAULT_SWITCHES.LAUNCHED).toEqual(ON);
    expect(DEFAULT_SWITCHES.PAUSED).toEqual(OFF);
    expect(DEFAULT_SWITCHES.WITHDRAWN).toEqual(OFF);
  });

  it('land on entering a stage, and the body overrides any of them', () => {
    const plain = planRollout(at('PLANNED'), { stage: 'SEEDING' }, NOW);
    expect(plain.switches).toEqual(DEFAULT_SWITCHES.SEEDING);
    expect(plain.flipped.sort()).toEqual(['agentOnboarding', 'leadFeeds', 'supplyIntake']);

    const tweaked = planRollout(at('PLANNED'), { stage: 'SEEDING', switches: { leadFeeds: false, printPartners: true } }, NOW);
    expect(tweaked.switches).toEqual({ ...DEFAULT_SWITCHES.SEEDING, leadFeeds: false, printPartners: true });
  });

  it('a switch-only patch keeps the stage and the other switches', () => {
    const plan = planRollout(at('PAUSED'), { switches: { supplyIntake: true } }, NOW);
    expect(plan.stage).toBe('PAUSED');
    expect(plan.switches).toEqual({ ...OFF, supplyIntake: true });
    expect(plan.flipped).toEqual(['supplyIntake']);
    expect(plan.changed).toBe(true);
  });

  it('naming the current stage is not a re-entry: the switches stay as ops left them', () => {
    const current = at('LAUNCHED', { switches: { ...ON, printPartners: false } });
    const plan = planRollout(current, { stage: 'LAUNCHED' }, NOW);
    expect(plan.switches).toEqual({ ...ON, printPartners: false });
    expect(plan.changed).toBe(false);
  });

  it('a patch that moves nothing reports no change', () => {
    expect(planRollout(at('LAUNCHED'), { switches: { demand: true } }, NOW).changed).toBe(false);
  });
});

describe('the mirror and the timestamps', () => {
  it('isActive mirrors the stage: SEEDING, LAUNCHED and PAUSED true; PLANNED and WITHDRAWN false', () => {
    expect(CITY_STAGES.map((s) => [s, mirrorOf(s)])).toEqual([
      ['PLANNED', false],
      ['SEEDING', true],
      ['LAUNCHED', true],
      ['PAUSED', true],
      ['WITHDRAWN', false],
    ]);
    expect(planRollout(at('PLANNED'), { stage: 'SEEDING' }, NOW).isActive).toBe(true);
    expect(planRollout(at('LAUNCHED'), { stage: 'WITHDRAWN' }, NOW).isActive).toBe(false);
  });

  it('stamps launchedAt, pausedAt and withdrawnAt on entry and clears the two "out" stamps on leaving', () => {
    const launched = planRollout(at('PLANNED'), { stage: 'LAUNCHED' }, NOW);
    expect(launched).toMatchObject({ launchedAt: NOW, pausedAt: null, withdrawnAt: null });

    const paused = planRollout({ ...at('LAUNCHED'), launchedAt: NOW }, { stage: 'PAUSED' }, new Date('2026-10-01T00:00:00Z'));
    expect(paused).toMatchObject({ launchedAt: NOW, pausedAt: new Date('2026-10-01T00:00:00Z') });

    const relaunched = planRollout({ ...at('PAUSED'), launchedAt: NOW, pausedAt: NOW }, { stage: 'LAUNCHED' }, new Date('2026-11-01T00:00:00Z'));
    expect(relaunched).toMatchObject({ launchedAt: new Date('2026-11-01T00:00:00Z'), pausedAt: null });

    const withdrawn = planRollout({ ...at('LAUNCHED'), launchedAt: NOW }, { stage: 'WITHDRAWN' }, NOW);
    expect(withdrawn).toMatchObject({ withdrawnAt: NOW, launchedAt: NOW, switches: OFF });

    const reentered = planRollout({ ...at('WITHDRAWN'), withdrawnAt: NOW }, { stage: 'SEEDING' }, NOW);
    expect(reentered).toMatchObject({ withdrawnAt: null, switches: DEFAULT_SWITCHES.SEEDING, isActive: true });
  });
});
