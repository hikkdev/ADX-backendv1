import { describe, expect, it } from 'vitest';
import { signAccessToken, verifyAccessToken } from '../jwt';

/** DR 07's "This device": the access token names the session row it was issued beside. */
describe('the access token and its session', () => {
  it('carries the session id when one is given, and nothing when not', () => {
    expect(verifyAccessToken(signAccessToken('usr_1', ['AGENT_PUBLISHER'], 'rt_abc')).sid).toBe('rt_abc');
    expect(verifyAccessToken(signAccessToken('usr_1', ['AGENT_PUBLISHER']))).not.toHaveProperty('sid');
  });
});
