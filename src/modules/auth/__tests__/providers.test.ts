import { beforeEach, describe, expect, it, vi } from 'vitest';

const { env, facebook } = vi.hoisted(() => ({ env: { GOOGLE_CLIENT_ID: undefined as string | undefined }, facebook: vi.fn() }));
vi.mock('../../../config/env', () => ({ env }));
vi.mock('../facebook/facebook.service', () => ({ loadFacebookConfig: facebook }));

import { authProviders } from '../providers.controller';

describe('GET /auth/providers', () => {
  beforeEach(() => {
    env.GOOGLE_CLIENT_ID = undefined;
    facebook.mockResolvedValue({});
  });

  it('answers null for a door that is not set up', async () => {
    expect(await authProviders()).toEqual({ google: null, facebook: null });
  });

  it('answers the public ids only — never the Facebook secret, and not an app id without its secret', async () => {
    env.GOOGLE_CLIENT_ID = 'web-client.apps.googleusercontent.com';
    facebook.mockResolvedValue({ appId: '1234', appSecret: 'shh' });
    const answer = await authProviders();
    expect(answer).toEqual({ google: { webClientId: 'web-client.apps.googleusercontent.com' }, facebook: { appId: '1234' } });
    expect(JSON.stringify(answer)).not.toContain('shh');
    facebook.mockResolvedValue({ appId: '1234' });
    expect((await authProviders()).facebook).toBeNull();
  });
});
