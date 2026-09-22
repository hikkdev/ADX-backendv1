import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LH6 (the Lead Hunt, 22 Sep 2026) — the outreach hub.
 *
 * Pinned, as the brief asks: every adapter's NOT_CONFIGURED path (a manual
 * send answers without a row, a sequence step leaves a SKIPPED row); the
 * window rule on the three Meta channels (WhatsApp free text inside the
 * day, an approved template outside it, nothing without one; Instagram and
 * Messenger replies only inside the window — no cold DMs, D13);
 * stop-on-any-reply (an inbound on any channel stops the run, moves the
 * lead to ENGAGED, lands the hand-off task and the push); the consent line
 * gating a recording; webhook idempotence (a replayed message id writes
 * nothing twice, a status never downgrades); the attribution stamps
 * (firstContact on the first send, engaged on the reply — D14);
 * reachability per lead (no number, no address, no thread); quiet hours
 * (QUEUED, flushed by the tick) and the weekly cap per lead, with the reply
 * exemption; sequences (enrolment on temperature, a step sent, a CALL step
 * as a task, completion, deactivation); the missed-call and IVR doors.
 *
 * The outreach repository is an in-memory fake so the services run whole;
 * the lead repository, the doors and the adapters' config are mocked.
 */

type Row = Record<string, unknown> & { id: string };
type NewRow = Record<string, unknown>;

const { leadsRepo, outreach, agents, notifications, work, uploads, integrations, settings, state } = vi.hoisted(() => {
  const state = {
    now: new Date('2026-09-22T09:00:00.000Z'),
    quietUntil: null as Date | null,
    channels: {} as Record<string, unknown>,
    sms: { authKey: 'k', primaryRail: 'msg91', templates: {} } as Record<string, unknown>,
    email: { host: 'smtp', primary: 'SMTP', mode: 'SMTP' } as Record<string, unknown>,
    leads: new Map<string, Row>(),
    templates: new Map<string, Row>(),
  };
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;
  const conversations: Row[] = [];
  const messages: Row[] = [];
  const sequences: Row[] = [];
  const runs: Row[] = [];
  const outreach = {
    conversations,
    messages,
    sequences,
    runs,
    reset() {
      conversations.length = 0;
      messages.length = 0;
      sequences.length = 0;
      runs.length = 0;
    },
    async findConversation(leadId: string, channel: string) {
      return conversations.find((c) => c['leadId'] === leadId && c['channel'] === channel) ?? null;
    },
    async findConversationByThread(channel: string, providerThreadId: string) {
      const c = conversations.find((x) => x['channel'] === channel && x['providerThreadId'] === providerThreadId);
      return c ? { ...c, lead: state.leads.get(c['leadId'] as string) } : null;
    },
    async createConversation(data: NewRow) {
      const row = { providerThreadId: null, windowClosesAt: null, lastInboundAt: null, lastOutboundAt: null, createdAt: state.now, updatedAt: state.now, ...data, id: id('conv') };
      conversations.push(row);
      return row;
    },
    async updateConversation(cid: string, patch: Row) {
      const row = conversations.find((c) => c.id === cid);
      if (!row) return { ...patch, id: cid };
      Object.assign(row, patch);
      return row;
    },
    async listConversations(leadId: string) {
      return conversations.filter((c) => c['leadId'] === leadId);
    },
    async listMessages(leadId: string) {
      return messages.filter((m) => m['leadId'] === leadId);
    },
    async createMessage(data: NewRow) {
      const row = { providerId: null, error: null, scheduledFor: null, sequenceRunId: null, recordingFileId: null, consentPlayed: null, outcome: null, durationSec: null, providerCallId: null, maskedNumber: null, byAgentId: null, byUserId: null, templateKey: null, ...data, id: id('msg') };
      messages.push(row);
      return row;
    },
    async updateMessage(mid: string, patch: Row) {
      const row = messages.find((m) => m.id === mid)!;
      Object.assign(row, patch);
      return row;
    },
    async findMessage(mid: string) {
      return messages.find((m) => m.id === mid) ?? null;
    },
    async findMessageByProviderId(channel: string, providerId: string) {
      return messages.find((m) => m['channel'] === channel && m['providerId'] === providerId) ?? null;
    },
    async findMessageByCallId(providerCallId: string) {
      return messages.find((m) => m['providerCallId'] === providerCallId) ?? null;
    },
    async countOutboundBetween(leadId: string, from: Date, to: Date) {
      return messages.filter((m) => m['leadId'] === leadId && m['direction'] === 'OUTBOUND' && ['QUEUED', 'SENT', 'DELIVERED', 'READ'].includes(m['status'] as string) && (m['at'] as Date) >= from && (m['at'] as Date) < to).length;
    },
    async dueQueuedMessages(now: Date) {
      return messages.filter((m) => m['status'] === 'QUEUED' && m['direction'] === 'OUTBOUND' && m['scheduledFor'] && (m['scheduledFor'] as Date) <= now);
    },
    async lastOutbound(leadId: string) {
      return [...messages].reverse().find((m) => m['leadId'] === leadId && m['direction'] === 'OUTBOUND') ?? null;
    },
    async recordingsBefore(cutoff: Date) {
      return messages.filter((m) => m['recordingFileId'] && (m['at'] as Date) < cutoff).map((m) => ({ id: m.id, recordingFileId: m['recordingFileId'] as string }));
    },
    async channelStats() {
      return [];
    },
    async listSequences() {
      return sequences.map((s) => ({ ...s, activeRuns: runs.filter((r) => r['sequenceId'] === s.id && !r['stoppedAt']).length, totalRuns: runs.filter((r) => r['sequenceId'] === s.id).length }));
    },
    async findSequence(sid: string) {
      return sequences.find((s) => s.id === sid) ?? null;
    },
    async createSequence(data: NewRow) {
      const row = { createdAt: state.now, updatedAt: state.now, ...data, id: id('seq') };
      sequences.push(row);
      return row;
    },
    async updateSequence(sid: string, patch: Row) {
      const row = sequences.find((s) => s.id === sid)!;
      Object.assign(row, patch);
      return row;
    },
    async findActiveSequence(side: string, temperature: string) {
      return [...sequences].reverse().find((s) => s['side'] === side && s['temperature'] === temperature && s['isActive']) ?? null;
    },
    async countSequences() {
      return sequences.length;
    },
    async findActiveRun(leadId: string) {
      const run = [...runs].reverse().find((r) => r['leadId'] === leadId && !r['stoppedAt']);
      return run ? { ...run, sequence: sequences.find((s) => s.id === run['sequenceId']) } : null;
    },
    async listRuns(leadId: string) {
      return runs.filter((r) => r['leadId'] === leadId).map((r) => ({ ...r, sequence: sequences.find((s) => s.id === r['sequenceId']) }));
    },
    async createRun(data: NewRow) {
      const row = { stoppedAt: null, stopReason: null, ...data, id: id('run') };
      runs.push(row);
      return row;
    },
    async updateRun(rid: string, patch: Row) {
      const row = runs.find((r) => r.id === rid)!;
      Object.assign(row, patch);
      return row;
    },
    async dueRuns(now: Date) {
      return runs.filter((r) => !r['stoppedAt'] && r['nextAt'] && (r['nextAt'] as Date) <= now).map((r) => ({ ...r, sequence: sequences.find((s) => s.id === r['sequenceId']), lead: state.leads.get(r['leadId'] as string) }));
    },
    async stopRuns(leadId: string, at: Date, reason: string) {
      let n = 0;
      for (const r of runs) {
        if (r['leadId'] === leadId && !r['stoppedAt']) {
          Object.assign(r, { stoppedAt: at, stopReason: reason, nextAt: null });
          n += 1;
        }
      }
      return n;
    },
    async inbox() {
      return { items: [], total: 0, byChannel: {} };
    },
    async listProposals() {
      return [];
    },
    async teleQueue() {
      return { items: [], total: 0 };
    },
    async findCaller(userId: string) {
      return userId === 'usr_agent' ? { id: userId, name: 'Asha', mobile: '+919000000001' } : userId === 'usr_admin' ? { id: userId, name: 'Desk', mobile: '+919000000002' } : null;
    },
    async findAgentUser(agentId: string) {
      return agentId === 'agt_1' ? { userId: 'usr_agent', name: 'Asha', mobile: '+919000000001' } : null;
    },
  };
  const leadsRepo = {
    findById: vi.fn(async (leadId: string) => state.leads.get(leadId) ?? null),
    update: vi.fn(async (leadId: string, patch: Row) => {
      const row = state.leads.get(leadId);
      if (row) Object.assign(row, patch);
      return row;
    }),
    logActivity: vi.fn(async () => undefined),
    findByPhones: vi.fn(async (phones: string[]) => [...state.leads.values()].filter((l) => phones.includes(l['phoneNormalised'] as string)).map((l) => ({ id: l.id, displayId: null, phoneNormalised: l['phoneNormalised'] }))),
    findAccountsByPhones: vi.fn(async () => []),
    findByExternalKeys: vi.fn(async (keys: string[]) => [...state.leads.values()].filter((l) => keys.includes(l['externalKey'] as string)).map((l) => ({ id: l.id, externalKey: l['externalKey'] }))),
    create: vi.fn(async (data: NewRow) => {
      const row = { stage: 'SOURCED', status: 'NEW', attribution: null, firstContactedAt: null, claimedByAgentId: null, claimExpiresAt: null, assignedAgentId: null, ...data, id: id('lead') };
      state.leads.set(row.id, row);
      return row;
    }),
    findCommsTemplate: vi.fn(async (key: string) => state.templates.get(key) ?? null),
    attributionCounts: vi.fn(async () => []),
    findForScoring: vi.fn(async () => null),
    findSourceByKey: vi.fn(async () => ({ id: 'src_1' })),
    createSource: vi.fn(async () => ({ id: 'src_1' })),
    candidateAgents: vi.fn(async () => []),
    findAgentBrief: vi.fn(),
    territoriesCovering: vi.fn(async () => []),
    findByNameAndCity: vi.fn(async () => []),
  };
  const agents = {
    findAgentProfile: vi.fn(async (userId: string) => (userId === 'usr_agent' ? { id: 'agt_1', userId, tier: 'SILVER' } : null)),
    requireAgentProfile: vi.fn(),
    findAgentTier: vi.fn(async () => 'SILVER'),
    assertAgentAcceptsWork: vi.fn(),
    agentMeetsGrade: vi.fn(async () => true),
    getRoutingSettings: vi.fn(async () => ({ enforce: false })),
  };
  const notifications = {
    notify: vi.fn(async (event: string, _userId: string | null, _vars: unknown, opts: { channels?: string[] } = {}) => {
      if (event === 'LEAD_OUTREACH') return { notificationId: null, templateKey: 'lead-outreach', deliveries: (opts.channels ?? []).map((channel) => ({ channel, deliveryId: `dlv_${channel.toLowerCase()}` })) };
      return { notificationId: 'ntf_1', templateKey: null, deliveries: [] };
    }),
    quietHoursDeferral: vi.fn(() => state.quietUntil),
    weekWindowIST: vi.fn((now: Date) => ({ start: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), end: new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000) })),
    renderText: vi.fn((text: string, vars: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '')),
    renderHtml: vi.fn((text: string, vars: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '')),
  };
  const work = {
    createSystemTask: vi.fn(async () => ({ id: 'tsk_1', displayId: 'TSK-1', created: true })),
    completeTaggedTasks: vi.fn(async () => 0),
    openTaggedTasks: vi.fn(async () => []),
  };
  const uploads = {
    storeGeneratedFile: vi.fn(async () => ({ id: 'file_rec_1' })),
    purgeStoredFile: vi.fn(async () => true),
    findUploadedFile: vi.fn(),
  };
  const integrations = {
    getEffectiveLeadChannelsConfig: vi.fn(async () => ({ ...state.channels, telephony: { consentLine: 'This call may be recorded for quality', ...((state.channels as { telephony?: Record<string, unknown> }).telephony ?? {}) } })),
    getEffectiveSmsConfig: vi.fn(async () => state.sms),
    getEffectiveEmailConfig: vi.fn(async () => state.email),
    getEffectiveLeadFormsConfig: vi.fn(async () => ({})),
    getEffectiveMapsConfig: vi.fn(async () => ({ googleServerKey: null })),
    DEFAULT_CONSENT_LINE: 'This call may be recorded for quality',
    DEFAULT_IVR: { greeting: 'Welcome to ADX.', publisherPrompt: 'Press 1.', advertiserPrompt: 'Press 2.' },
  };
  const settings = {
    comms: { quietHours: { from: '21:00', to: '08:00', tz: 'Asia/Kolkata' }, weeklyCapPerUser: 3 },
    leads: { scoring: { weights: { fitMax: 30, intentMax: 35, recencyMin: -25, sourceMax: 15, agentFlag: 10 }, recency: { afterDays7: -5, afterDays21: -15, afterDays45: -25 }, thresholds: { hot: 70, warm: 40 }, agentFlagDays: 14, intent: {}, fit: { defaultCategory: 12, categoryBySide: { PUBLISHER: {}, ADVERTISER: {} }, importanceBonus: { KEY: 4, ENTERPRISE: 8 }, localityBonus: 6, localityRadiusM: 1000 } }, claims: { holdHours: 72, caps: { BRONZE: 10, SILVER: 20, GOLD: 40, PLATINUM: null }, cooldownDays: 7 }, referralCredit: 250, priority: { topUp: 200, monthlyCap: 25000 } },
  };
  return { leadsRepo, outreach, agents, notifications, work, uploads, integrations, settings, state };
});

vi.mock('../prisma-leads.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prisma-leads.repository')>();
  return { prismaLeadsRepository: leadsRepo, distanceM: actual.distanceM };
});
vi.mock('../prisma-outreach.repository', () => ({ prismaOutreachRepository: outreach }));
vi.mock('../../agents', () => agents);
vi.mock('../../notifications', () => notifications);
vi.mock('../../work', () => work);
vi.mock('../../uploads', () => uploads);
vi.mock('../../payouts', () => ({ rateFor: vi.fn(async () => '100.00'), recordIncentiveOnce: vi.fn() }));
vi.mock('../../pricing', () => ({ cityKeyFor: vi.fn(async () => ({ cityId: null })), withCityKey: vi.fn(async (x: unknown) => x), citySupport: vi.fn(async () => ({ resolved: false })) }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn(async () => 'LED-0100') }));
vi.mock('../../qr', () => ({ getQrById: vi.fn() }));
vi.mock('../../wallets', () => ({ ensureWallet: vi.fn(), move: vi.fn() }));
vi.mock('../../visits', () => ({ createVisit: vi.fn() }));
vi.mock('../../../shared/integrations', () => integrations);
vi.mock('../../../shared/integrations/integration-config', () => integrations);
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => settings) }));
vi.mock('../../../shared/cache', () => ({ redis: { set: vi.fn(async () => 'OK'), get: vi.fn(async () => null), del: vi.fn(async () => 1) } }));

import { metaSignature } from '../../../shared/outreach';
import { callStatus, ivrChoice, logCall, missedCall, placeCall, purgeRecordings, RECORDING_RETENTION_DAYS } from '../calls.service';
import { recordInbound, windowAfter, windowOpen } from '../conversations.service';
import { flushQueued, logTouch, outboundRuling, reachability, receiveWebhook, sendMessage, threadView } from '../outreach.service';
import { DEFAULT_SEQUENCES, enrol, ensureDefaultSequences, onTemperature, readSteps, tickSequences } from '../sequences.service';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const lead = (over: Record<string, unknown> = {}): Row => ({
  id: 'lead_1',
  displayId: 'LED-0001',
  side: 'PUBLISHER',
  businessName: 'Sharma Stores',
  contactName: 'Ravi Sharma',
  phone: '+919876543210',
  phoneNormalised: '+919876543210',
  email: 'ravi@sharma.in',
  city: 'Pune',
  stage: 'SCORED',
  status: 'NEW',
  temperature: 'WARM',
  attribution: null,
  firstContactedAt: null,
  assignedAgentId: 'agt_1',
  claimedByAgentId: null,
  claimExpiresAt: null,
  lastTouchedAt: null,
  ...over,
});

const agentActor = { userId: 'usr_agent', agentId: 'agt_1' };

beforeEach(() => {
  vi.clearAllMocks();
  outreach.reset();
  state.leads.clear();
  state.templates.clear();
  state.channels = {};
  state.quietUntil = null;
  state.now = new Date('2026-09-22T09:00:00.000Z');
  state.leads.set('lead_1', lead());
  state.templates.set('lead-seq-publisher-nudge', { id: 't2', key: 'lead-seq-publisher-nudge', subject: 'Your estimate', emailBody: '<p>Want yours priced?</p>', smsBody: 'Hi {{contactName}}, want your estimate? {{link}}', pushBody: null, channels: ['SMS', 'EMAIL', 'WHATSAPP'] });
  state.templates.set('lead-seq-publisher-intro', { id: 't1', key: 'lead-seq-publisher-intro', subject: 'Earn from {{businessName}}', emailBody: '<p>Hi {{contactName}}, {{agentName}} here.</p>', smsBody: 'Hi {{contactName}}, {{agentName}} from ADX about {{businessName}}. {{link}}', pushBody: null, channels: ['SMS', 'EMAIL', 'WHATSAPP'] });
  vi.unstubAllGlobals();
});

describe('LH6: NOT_CONFIGURED on every adapter', () => {
  it.each(['WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'GOOGLE_BUSINESS'] as const)('%s answers NOT_CONFIGURED on a manual send, with no row', async (channel) => {
    const outcome = await sendMessage({ leadId: 'lead_1', channel, body: 'Hello', actor: agentActor, source: 'MANUAL' }, state.now);
    expect(outcome).toMatchObject({ outcome: 'SKIPPED', reason: 'NOT_CONFIGURED', message: null });
    expect(outreach.messages).toHaveLength(0);
  });

  it('SMS and email are NOT_CONFIGURED when their comms doors are empty', async () => {
    state.sms = {};
    state.email = {};
    expect(await sendMessage({ leadId: 'lead_1', channel: 'SMS', body: 'Hi', actor: agentActor, source: 'MANUAL' }, state.now)).toMatchObject({ outcome: 'SKIPPED', reason: 'NOT_CONFIGURED' });
    expect(await sendMessage({ leadId: 'lead_1', channel: 'EMAIL', body: 'Hi', actor: agentActor, source: 'MANUAL' }, state.now)).toMatchObject({ outcome: 'SKIPPED', reason: 'NOT_CONFIGURED' });
    state.sms = { authKey: 'k', primaryRail: 'msg91', templates: {} };
    state.email = { host: 'smtp', primary: 'SMTP', mode: 'SMTP' };
  });

  it('a sequence step that cannot go leaves a SKIPPED row naming why, and the run moves on', async () => {
    const outcome = await sendMessage({ leadId: 'lead_1', channel: 'WHATSAPP', templateKey: 'lead-seq-publisher-intro', actor: { userId: null, agentId: 'agt_1' }, source: 'SEQUENCE', sequenceRunId: 'run_x' }, state.now);
    expect(outcome).toMatchObject({ outcome: 'SKIPPED', reason: 'NOT_CONFIGURED' });
    expect(outreach.messages).toHaveLength(1);
    expect(outreach.messages[0]).toMatchObject({ status: 'SKIPPED', error: 'NOT_CONFIGURED', channel: 'WHATSAPP', sequenceRunId: 'run_x', templateKey: 'lead-seq-publisher-intro' });
    // Nothing was stamped: the lead was never contacted.
    expect(state.leads.get('lead_1')!['attribution']).toBeNull();
  });

  it('click-to-call answers INTEGRATION_NOT_CONFIGURED (503) and points at the phone', async () => {
    await expect(placeCall('lead_1', { ...agentActor, userId: 'usr_agent' })).rejects.toMatchObject({ statusCode: 503, code: 'INTEGRATION_NOT_CONFIGURED' });
    expect(outreach.messages).toHaveLength(0);
    // ... so the agent dials by hand and logs the outcome.
    const logged = await logCall('lead_1', agentActor, { outcome: 'ANSWERED', durationSec: 90, note: 'Wants a visit Thursday', at: state.now });
    expect(logged).toMatchObject({ channel: 'CALL', direction: 'OUTBOUND', outcome: 'ANSWERED', durationSec: 90, status: 'DELIVERED' });
    expect(state.leads.get('lead_1')!['attribution']).toMatchObject({ firstContact: { channel: 'CALL' } });
    expect(work.completeTaggedTasks).toHaveBeenCalledWith('LEAD', 'lead_1', 'callback', expect.any(Date));
  });
});

describe('LH6: reachability per lead', () => {
  it('says which channels would go for this lead, and why the rest would not', async () => {
    state.channels = { whatsapp: { bsp: 'INTERAKT', apiKey: 'k', templates: { 'lead-seq-publisher-intro': { name: 'lead_intro' } } }, instagram: { pageId: 'p', accessToken: 't' } };
    const states = await reachability(state.leads.get('lead_1') as never, state.now);
    const by = Object.fromEntries(states.map((s) => [s.channel, s]));
    expect(by['SMS']).toMatchObject({ reachable: true, mode: 'FREEFORM', address: '+91 •••10' });
    expect(by['EMAIL']).toMatchObject({ reachable: true, mode: 'FREEFORM', address: 'r***@sharma.in' });
    expect(by['WHATSAPP']).toMatchObject({ reachable: true, mode: 'TEMPLATE', configured: true, provider: 'interakt' });
    expect(by['INSTAGRAM']).toMatchObject({ reachable: false, configured: true, reason: expect.stringContaining('no cold DMs') });
    expect(by['MESSENGER']).toMatchObject({ reachable: false, configured: false });
    expect(by['CALL']).toMatchObject({ reachable: false, configured: false, reason: expect.stringContaining('dial from your phone') });
    expect(by['LINKEDIN']).toMatchObject({ reachable: true, mode: 'MANUAL' });
    expect(by['IN_PERSON']).toMatchObject({ reachable: true, mode: 'MANUAL' });
  });

  it('no number: SMS, WhatsApp and the call are out; no address: email is out; a closed lead: everything', async () => {
    state.channels = { whatsapp: { bsp: 'INTERAKT', apiKey: 'k' }, telephony: { provider: 'TWILIO', accountSid: 'AC', apiToken: 't', callerIds: ['+918000000000'] } };
    state.leads.set('lead_1', lead({ phone: null, phoneNormalised: null, email: null }));
    const by = Object.fromEntries((await reachability(state.leads.get('lead_1') as never, state.now)).map((s) => [s.channel, s]));
    expect(by['SMS']).toMatchObject({ reachable: false, reason: 'No phone number on this lead' });
    expect(by['WHATSAPP']).toMatchObject({ reachable: false, reason: 'No phone number on this lead' });
    expect(by['CALL']).toMatchObject({ reachable: false, reason: 'No phone number on this lead' });
    expect(by['EMAIL']).toMatchObject({ reachable: false, reason: 'No email address on this lead' });
    state.leads.set('lead_1', lead({ stage: 'LOST' }));
    const closed = await reachability(state.leads.get('lead_1') as never, state.now);
    expect(closed.every((s) => !s.reachable && s.reason === 'This lead is closed')).toBe(true);
  });
});

describe('LH6: the window rule on the three Meta channels', () => {
  const fetchOk = (answer: unknown) => {
    const fn = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  it('WhatsApp: free text inside the day after their message; an approved template outside it; nothing without one', async () => {
    state.channels = { whatsapp: { bsp: 'META', phoneNumberId: '1', accessToken: 't' } };
    // Outside the window, no template mapped: unreachable.
    const cold = await sendMessage({ leadId: 'lead_1', channel: 'WHATSAPP', body: 'Hi', actor: agentActor, source: 'MANUAL' }, state.now);
    expect(cold).toMatchObject({ outcome: 'SKIPPED', reason: 'NO_WINDOW' });
    // A template on the card: it goes as the template.
    state.channels = { whatsapp: { bsp: 'META', phoneNumberId: '1', accessToken: 't', templates: { 'lead-seq-publisher-intro': { name: 'lead_intro', params: ['contactName', 'agentName'] } } } };
    const fetchImpl = fetchOk({ messages: [{ id: 'wamid.t1' }] });
    const templated = await sendMessage({ leadId: 'lead_1', channel: 'WHATSAPP', templateKey: 'lead-seq-publisher-intro', actor: agentActor, source: 'MANUAL' }, state.now);
    expect(templated).toMatchObject({ outcome: 'SENT', message: { status: 'SENT', providerId: 'wamid.t1', templateKey: 'lead-seq-publisher-intro' } });
    const sentBody = JSON.parse(String((fetchImpl as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0]![1].body));
    expect(sentBody.type).toBe('template');
    expect(sentBody.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(['Ravi', 'Asha']);
    // Typed text outside the window with a template on the card but none named: told to pick one.
    const typed = await sendMessage({ leadId: 'lead_1', channel: 'WHATSAPP', body: 'Typed', actor: agentActor, source: 'MANUAL' }, new Date(state.now.getTime() + HOUR));
    expect(typed).toMatchObject({ outcome: 'SKIPPED', reason: 'NO_TEMPLATE' });
    // They reply: the window opens, free text goes.
    await recordInbound(state.leads.get('lead_1') as never, { channel: 'WHATSAPP', providerThreadId: 'wa:919876543210', providerMessageId: 'wamid.in1', body: 'Tell me more', at: new Date(state.now.getTime() + 2 * HOUR) });
    fetchOk({ messages: [{ id: 'wamid.f1' }] });
    const free = await sendMessage({ leadId: 'lead_1', channel: 'WHATSAPP', body: 'Gladly — when suits a visit?', actor: agentActor, source: 'MANUAL' }, new Date(state.now.getTime() + 3 * HOUR));
    expect(free).toMatchObject({ outcome: 'SENT', message: { providerId: 'wamid.f1', body: 'Gladly — when suits a visit?' } });
    // A day later the window has closed again.
    const conv = await outreach.findConversation('lead_1', 'WHATSAPP');
    expect(windowOpen(conv as never, new Date(state.now.getTime() + 27 * HOUR))).toBe(false);
  });

  it.each(['INSTAGRAM', 'MESSENGER'] as const)('%s: replies only, inside the window — no cold DMs (D13)', async (channel) => {
    state.channels = { instagram: { pageId: 'ig', accessToken: 't' }, messenger: { pageId: 'fb', accessToken: 't' } };
    const cold = await sendMessage({ leadId: 'lead_1', channel, body: 'Hi there', actor: agentActor, source: 'MANUAL' }, state.now);
    expect(cold).toMatchObject({ outcome: 'SKIPPED', reason: 'UNREACHABLE' });
    await recordInbound(state.leads.get('lead_1') as never, { channel, providerThreadId: 'scoped-1', providerMessageId: 'mid-1', body: 'Is the wall free?', at: state.now });
    fetchOk({ message_id: 'm_out' });
    const reply = await sendMessage({ leadId: 'lead_1', channel, body: 'Yes — from October', actor: agentActor, source: 'MANUAL' }, new Date(state.now.getTime() + HOUR));
    expect(reply).toMatchObject({ outcome: 'SENT', message: { providerId: 'm_out' } });
    const late = await sendMessage({ leadId: 'lead_1', channel, body: 'Still there?', actor: agentActor, source: 'MANUAL' }, new Date(state.now.getTime() + 25 * HOUR));
    expect(late).toMatchObject({ outcome: 'SKIPPED', reason: 'NO_WINDOW' });
    expect(windowAfter(state.now, 'COMMENT').getTime() - state.now.getTime()).toBe(7 * DAY);
  });
});

describe('LH6: the two rules on every outbound', () => {
  it('quiet hours queue the message and the tick flushes it; a reply inside the window is exempt', async () => {
    state.quietUntil = new Date('2026-09-23T02:30:00.000Z');
    const queued = await sendMessage({ leadId: 'lead_1', channel: 'SMS', body: 'Good evening', actor: agentActor, source: 'MANUAL' }, state.now);
    expect(queued).toMatchObject({ outcome: 'QUEUED', scheduledFor: state.quietUntil, message: { status: 'QUEUED' } });
    expect(notifications.notify).not.toHaveBeenCalledWith('LEAD_OUTREACH', expect.anything(), expect.anything(), expect.anything());
    // Not yet due: nothing leaves.
    expect(await flushQueued(new Date('2026-09-23T01:00:00.000Z'))).toEqual({ sent: 0, failed: 0 });
    state.quietUntil = null;
    expect(await flushQueued(new Date('2026-09-23T02:31:00.000Z'))).toEqual({ sent: 1, failed: 0 });
    expect(outreach.messages[0]).toMatchObject({ status: 'SENT', providerId: 'delivery:dlv_sms', scheduledFor: null });
    expect(state.leads.get('lead_1')!['attribution']).toMatchObject({ firstContact: { channel: 'SMS' } });
    // They wrote in the last day: a reply is a conversation, not outreach.
    state.quietUntil = new Date('2026-09-24T02:30:00.000Z');
    await recordInbound(state.leads.get('lead_1') as never, { channel: 'SMS', providerMessageId: 'sms-in-1', body: 'Yes', at: new Date('2026-09-23T15:00:00.000Z') });
    const conv = await outreach.findConversation('lead_1', 'SMS');
    const ruling = await outboundRuling({ id: 'lead_1' }, conv as never, new Date('2026-09-23T16:00:00.000Z'));
    expect(ruling).toMatchObject({ skip: null, deferUntil: null });
  });

  it('the weekly cap counts every channel on the lead — the fourth is withheld', async () => {
    for (const channel of ['SMS', 'EMAIL', 'SMS'] as const) {
      expect((await sendMessage({ leadId: 'lead_1', channel, body: `n ${channel}`, actor: agentActor, source: 'MANUAL' }, state.now)).outcome).toBe('SENT');
    }
    const fourth = await sendMessage({ leadId: 'lead_1', channel: 'EMAIL', body: 'once more', actor: agentActor, source: 'MANUAL' }, state.now);
    expect(fourth).toMatchObject({ outcome: 'SKIPPED', reason: 'WEEKLY_CAP', detail: '3 of 3 this week already' });
    const step = await sendMessage({ leadId: 'lead_1', channel: 'SMS', templateKey: 'lead-seq-publisher-intro', actor: { userId: null, agentId: null }, source: 'SEQUENCE' }, state.now);
    expect(step).toMatchObject({ outcome: 'SKIPPED', reason: 'WEEKLY_CAP', message: { status: 'SKIPPED', error: 'WEEKLY_CAP' } });
  });

  it('SMS and email leave by the dispatcher’s one door with the copy already rendered', async () => {
    const sent = await sendMessage({ leadId: 'lead_1', channel: 'EMAIL', templateKey: 'lead-seq-publisher-intro', actor: agentActor, source: 'MANUAL' }, state.now);
    expect(sent.outcome).toBe('SENT');
    expect(notifications.notify).toHaveBeenCalledWith(
      'LEAD_OUTREACH',
      null,
      expect.objectContaining({ subject: 'Earn from Sharma Stores', body: '<p>Hi Ravi, Asha here.</p>', agentName: 'Asha', contactName: 'Ravi' }),
      expect.objectContaining({ recipient: { email: 'ravi@sharma.in' }, channels: ['EMAIL'], immediate: true }),
    );
    expect(leadsRepo.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'MESSAGED', actorUserId: 'usr_agent' }));
    expect(state.leads.get('lead_1')).toMatchObject({ status: 'CONTACTED', stage: 'CONTACTED', attribution: { firstContact: { channel: 'EMAIL' } } });
  });
});

describe('LH6: inbound — stop on any reply, the hand-off, idempotence', () => {
  it('a WhatsApp reply stops the run, moves the lead to ENGAGED with the channel stamped, tasks and pushes the holder', async () => {
    state.channels = { whatsapp: { bsp: 'META', phoneNumberId: '1', accessToken: 't', appSecret: 'secret' } };
    await ensureDefaultSequences();
    const { run } = await enrol('lead_1', { now: state.now });
    expect(run).not.toBeNull();
    const envelope = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { contacts: [{ wa_id: '919876543210', profile: { name: 'Ravi' } }], messages: [{ from: '919876543210', id: 'wamid.reply', timestamp: String(Math.floor(state.now.getTime() / 1000) + 600), type: 'text', text: { body: 'Yes, call me' } }] } }] }] };
    const raw = Buffer.from(JSON.stringify(envelope));
    const input = { headers: { 'x-hub-signature-256': metaSignature('secret', raw) }, rawBody: raw, body: envelope };
    const first = await receiveWebhook('meta', input, state.now);
    expect(first).toEqual({ received: 1, statuses: 0, ignored: 0 });
    const stopped = outreach.runs.find((r) => r.id === run!.id)!;
    expect(stopped).toMatchObject({ stopReason: 'REPLIED' });
    expect(stopped['stoppedAt']).toBeTruthy();
    expect(state.leads.get('lead_1')).toMatchObject({ stage: 'ENGAGED', attribution: { engaged: { channel: 'WHATSAPP' } } });
    expect(work.createSystemTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reply to Sharma Stores on WhatsApp', tag: 'reply', assigneeUserIds: ['usr_agent'], linkedId: 'lead_1' }), expect.any(Date));
    expect(notifications.notify).toHaveBeenCalledWith('LEAD_REPLY_RECEIVED', 'usr_agent', expect.objectContaining({ businessName: 'Sharma Stores', channel: 'WhatsApp', preview: 'Yes, call me', deepLink: 'adx://lead/lead_1' }), expect.anything());
    // The same webhook again: nothing new.
    const replay = await receiveWebhook('meta', input, state.now);
    expect(replay).toEqual({ received: 0, statuses: 0, ignored: 1 });
    expect(outreach.messages.filter((m) => m['direction'] === 'INBOUND')).toHaveLength(1);
    const conv = await outreach.findConversation('lead_1', 'WHATSAPP');
    expect(conv).toMatchObject({ providerThreadId: 'wa:919876543210' });
    expect(windowOpen(conv as never, new Date(state.now.getTime() + 20 * HOUR))).toBe(true);
  });

  it('a status never downgrades and a replayed status is harmless', async () => {
    state.channels = { whatsapp: { bsp: 'META', phoneNumberId: '1', accessToken: 't', appSecret: 'secret' } };
    await outreach.createMessage({ conversationId: 'c', leadId: 'lead_1', direction: 'OUTBOUND', channel: 'WHATSAPP', body: 'x', providerId: 'wamid.out', status: 'SENT', at: state.now });
    const post = async (status: string) => {
      const envelope = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.out', status, timestamp: '1758540000' }] } }] }] };
      const raw = Buffer.from(JSON.stringify(envelope));
      return receiveWebhook('meta', { headers: { 'x-hub-signature-256': metaSignature('secret', raw) }, rawBody: raw, body: envelope }, state.now);
    };
    expect(await post('read')).toEqual({ received: 0, statuses: 1, ignored: 0 });
    expect(outreach.messages[0]!['status']).toBe('READ');
    await post('delivered');
    expect(outreach.messages[0]!['status']).toBe('READ');
    await post('failed');
    expect(outreach.messages[0]).toMatchObject({ status: 'FAILED', error: 'failed' });
    expect(await post('read')).toEqual({ received: 0, statuses: 1, ignored: 0 });
    const unknown = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.nobody', status: 'read', timestamp: '1758540000' }] } }] }] };
    const raw = Buffer.from(JSON.stringify(unknown));
    expect(await receiveWebhook('meta', { headers: { 'x-hub-signature-256': metaSignature('secret', raw) }, rawBody: raw, body: unknown }, state.now)).toEqual({ received: 0, statuses: 0, ignored: 1 });
  });

  it('an Instagram comment from a stranger becomes a lead (they wrote to us), sided by what they said', async () => {
    state.channels = { instagram: { pageId: 'ig-page', accessToken: 't', appSecret: 'ig' } };
    const envelope = { object: 'instagram', entry: [{ time: state.now.getTime(), changes: [{ field: 'comments', value: { id: 'c-1', text: 'I have a wall on MG Road, can it earn?', from: { id: 'user-77', username: 'meena.k' }, created_time: Math.floor(state.now.getTime() / 1000) } }] }] };
    const raw = Buffer.from(JSON.stringify(envelope));
    const result = await receiveWebhook('meta', { headers: { 'x-hub-signature-256': metaSignature('ig', raw) }, rawBody: raw, body: envelope }, state.now);
    expect(result).toEqual({ received: 1, statuses: 0, ignored: 0 });
    expect(leadsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ side: 'PUBLISHER', businessName: 'meena.k', externalKey: 'instagram:user-77', source: 'instagram', interest: 'I have a wall on MG Road, can it earn?' }));
    const created = [...state.leads.values()].find((l) => l['externalKey'] === 'instagram:user-77')!;
    const conv = await outreach.findConversation(created.id, 'INSTAGRAM');
    expect(conv).toMatchObject({ providerThreadId: 'user-77' });
    // The comment reply window is seven days.
    expect((conv!['windowClosesAt'] as Date).getTime() - state.now.getTime()).toBe(7 * DAY);
  });

  it('a touch logged by hand: LinkedIn is TOUCH_LOGGED, stamps the first contact, and an inbound note engages', async () => {
    const touch = await logTouch('lead_1', agentActor, { channel: 'LINKEDIN', note: 'Connected and sent the deck', at: state.now });
    expect(touch).toMatchObject({ channel: 'LINKEDIN', direction: 'OUTBOUND', status: 'SENT', byAgentId: 'agt_1' });
    expect(leadsRepo.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'TOUCH_LOGGED', note: 'LinkedIn: Connected and sent the deck' }));
    expect(state.leads.get('lead_1')).toMatchObject({ stage: 'CONTACTED', attribution: { firstContact: { channel: 'LINKEDIN' } } });
    await logTouch('lead_1', agentActor, { channel: 'IN_PERSON', note: 'Walked in, asked for rates', direction: 'INBOUND', at: new Date(state.now.getTime() + HOUR) });
    expect(state.leads.get('lead_1')).toMatchObject({ stage: 'ENGAGED', attribution: { engaged: { channel: 'IN_PERSON' } } });
    await expect(sendMessage({ leadId: 'lead_1', channel: 'LINKEDIN', body: 'x', actor: agentActor, source: 'MANUAL' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('LH6: telephony', () => {
  const twilio = { provider: 'TWILIO', accountSid: 'AC', apiToken: 'tok', callerIds: ['+918000000000'], recordCalls: true, consentLine: 'This call may be recorded for quality' };

  it('places a call agent-first on a masked number and records only with the consent line', async () => {
    state.channels = { telephony: twilio };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sid: 'CA1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    const placed = await placeCall('lead_1', { ...agentActor, userId: 'usr_agent' }, {}, state.now);
    expect(placed).toMatchObject({ maskedNumber: '+918000000000', providerCallId: 'CA1', recording: true, consentLine: 'This call may be recorded for quality' });
    expect(placed.message).toMatchObject({ channel: 'CALL', status: 'QUEUED', consentPlayed: true, maskedNumber: '+918000000000', providerCallId: 'CA1' });
    const form = new URLSearchParams(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(form.get('To')).toBe('+919000000001');
    expect(form.get('From')).toBe('+918000000000');
    expect(form.get('Url')).toContain('record=1');
    // No consent line: no recording, whatever the card's switch says.
    state.channels = { telephony: { ...twilio, consentLine: '   ' } };
    integrations.getEffectiveLeadChannelsConfig.mockResolvedValueOnce({ telephony: { ...twilio, consentLine: undefined } } as never);
    integrations.getEffectiveLeadChannelsConfig.mockResolvedValueOnce({ telephony: { ...twilio, consentLine: undefined } } as never);
    const plain = await placeCall('lead_1', { ...agentActor, userId: 'usr_agent' }, { record: true }, state.now);
    expect(plain).toMatchObject({ recording: false, consentLine: null });
    expect(plain.message['consentPlayed']).toBeNull();
  });

  it('the status callback closes the call with its outcome and keeps the recording only when consent played', async () => {
    state.channels = { telephony: { ...twilio, webhookSecret: undefined } };
    const { twilioVoiceSignature } = await import('../../../shared/outreach');
    await outreach.createMessage({ conversationId: 'c', leadId: 'lead_1', direction: 'OUTBOUND', channel: 'CALL', body: 'Call placed', status: 'QUEUED', at: state.now, providerCallId: 'CA-consent', consentPlayed: true, byUserId: 'usr_agent' });
    await outreach.createMessage({ conversationId: 'c', leadId: 'lead_1', direction: 'OUTBOUND', channel: 'CALL', body: 'Call placed', status: 'QUEUED', at: state.now, providerCallId: 'CA-silent', consentPlayed: null, byUserId: 'usr_agent' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('audio'), { status: 200, headers: { 'content-type': 'audio/mpeg' } })));
    const url = 'http://localhost:3000/api/v1/webhooks/outreach/telephony/status';
    const post = (params: Record<string, string>) => callStatus({ headers: { 'x-twilio-signature': twilioVoiceSignature('tok', url, params) }, body: params, url }, state.now);
    const consented = await post({ CallSid: 'CA-consent', DialCallStatus: 'completed', DialCallDuration: '75', RecordingUrl: 'https://api.twilio.com/rec/RE1' });
    expect(consented).toEqual({ matched: true, outcome: 'ANSWERED', recorded: true });
    expect(uploads.storeGeneratedFile).toHaveBeenCalledWith('usr_agent', expect.objectContaining({ purpose: 'CALL_RECORDING', mimeType: 'audio/mpeg' }));
    expect(outreach.messages[0]).toMatchObject({ status: 'DELIVERED', outcome: 'ANSWERED', durationSec: 75, recordingFileId: 'file_rec_1' });
    expect(state.leads.get('lead_1')).toMatchObject({ stage: 'CONTACTED', attribution: { firstContact: { channel: 'CALL' } } });
    const silent = await post({ CallSid: 'CA-silent', DialCallStatus: 'no-answer', DialCallDuration: '0', RecordingUrl: 'https://api.twilio.com/rec/RE2' });
    expect(silent).toEqual({ matched: true, outcome: 'NO_ANSWER', recorded: false });
    expect(outreach.messages[1]).toMatchObject({ status: 'SENT', outcome: 'NO_ANSWER', recordingFileId: null });
    expect(uploads.storeGeneratedFile).toHaveBeenCalledTimes(1);
    // A callback the operator never placed: not matched, nothing written.
    expect(await post({ CallSid: 'CA-nobody', CallStatus: 'completed' })).toMatchObject({ matched: false });
    // The 90-day purge.
    outreach.messages[0]!['at'] = new Date(state.now.getTime() - (RECORDING_RETENTION_DAYS + 1) * DAY);
    expect(await purgeRecordings(state.now)).toBe(1);
    expect(uploads.purgeStoredFile).toHaveBeenCalledWith('file_rec_1');
    expect(outreach.messages[0]!['recordingFileId']).toBeNull();
  });

  it('a missed call finds the lead by number and lands a callback on the holder’s day; a stranger becomes a lead', async () => {
    state.channels = { telephony: { provider: 'EXOTEL', accountSid: 'a', apiKey: 'k', apiToken: 't', subdomain: 's', webhookSecret: 'hook' } };
    const known = await missedCall({ headers: {}, body: { CallFrom: '09876543210', CallTo: '08030000000', CallSid: 'ex-1' }, query: { token: 'hook' } }, state.now);
    expect(known).toEqual({ leadId: 'lead_1', taskId: 'tsk_1' });
    expect(work.createSystemTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Call back Sharma Stores', tag: 'callback', assigneeUserIds: ['usr_agent'] }), expect.any(Date));
    expect(notifications.notify).toHaveBeenCalledWith('LEAD_CALLBACK_REQUESTED', 'usr_agent', expect.objectContaining({ businessName: 'Sharma Stores' }), expect.anything());
    expect(state.leads.get('lead_1')).toMatchObject({ stage: 'ENGAGED' });
    const stranger = await missedCall({ headers: {}, body: { CallFrom: '9123456789', CallSid: 'ex-2' }, query: { token: 'hook' } }, state.now);
    expect(stranger.leadId).toBeTruthy();
    expect(leadsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ side: 'PUBLISHER', phoneNormalised: '+919123456789', source: 'missed-call' }));
    await expect(missedCall({ headers: {}, body: { CallFrom: '9123456789' }, query: { token: 'wrong' } }, state.now)).rejects.toMatchObject({ name: 'OutreachWebhookRejected' });
  });

  it('the IVR key press sides the caller — 1 a publisher, 2 an advertiser — and asks for a callback', async () => {
    state.channels = { telephony: { provider: 'EXOTEL', accountSid: 'a', apiKey: 'k', apiToken: 't', subdomain: 's', webhookSecret: 'hook' } };
    const two = await ivrChoice({ headers: {}, body: { CallFrom: '9111111111', digits: '"2"', CallSid: 'ex-ivr' }, query: { token: 'hook' } }, state.now);
    expect(two).toMatchObject({ side: 'ADVERTISER', taskId: 'tsk_1' });
    expect(two.twiml).toContain('call you back');
    expect(leadsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ side: 'ADVERTISER', source: 'ivr' }));
    const nothing = await ivrChoice({ headers: {}, body: { CallFrom: '9111111111', digits: '9' }, query: { token: 'hook' } }, state.now);
    expect(nothing).toMatchObject({ side: null, leadId: null });
  });
});

describe('LH6: sequences', () => {
  it('seeds six defaults once, one per side and temperature, each step a channel with a template (or a call)', async () => {
    expect(await ensureDefaultSequences()).toBe(6);
    expect(await ensureDefaultSequences()).toBe(0);
    expect(DEFAULT_SEQUENCES.map((s) => `${s.side}:${s.temperature}`).sort()).toEqual(['ADVERTISER:COLD', 'ADVERTISER:HOT', 'ADVERTISER:WARM', 'PUBLISHER:COLD', 'PUBLISHER:HOT', 'PUBLISHER:WARM']);
    for (const s of DEFAULT_SEQUENCES) for (const step of readSteps(s.steps)) expect(step.channel === 'CALL' || step.templateKey).toBeTruthy();
    expect(readSteps([{ channel: 'LINKEDIN', delayHours: 1, templateKey: 'x' }, { channel: 'SMS', delayHours: -3, templateKey: ' k ' }])).toEqual([{ channel: 'SMS', delayHours: 0, templateKey: 'k' }]);
  });

  it('enrols on temperature, sends the due step, tasks a CALL step, completes, and stops when the lead moves on', async () => {
    await ensureDefaultSequences();
    await onTemperature('lead_1', 'WARM', null, state.now);
    const run = (await outreach.findActiveRun('lead_1'))!;
    expect(run).toMatchObject({ stepIndex: 0, nextAt: new Date(state.now.getTime() + 1 * HOUR) });
    // A second enrolment is a no-op; a temperature change re-enrols.
    expect((await enrol('lead_1', { now: state.now })).reason).toBe('ALREADY_RUNNING');
    state.leads.get('lead_1')!['temperature'] = 'HOT';
    await onTemperature('lead_1', 'HOT', 'WARM', state.now);
    expect(outreach.runs[0]).toMatchObject({ stopReason: 'TEMPERATURE_CHANGED' });
    const hot = (await outreach.findActiveRun('lead_1'))!;
    expect(hot.sequence!['name']).toBe('Publisher · hot');
    // Step 1 of the hot sequence is a call at once: a task on the holder's plate.
    const first = await tickSequences(state.now);
    expect(first).toMatchObject({ picked: 1, tasked: 1 });
    expect(work.createSystemTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Call Sharma Stores', tag: 'call', assigneeUserIds: ['usr_agent'] }), expect.any(Date));
    expect(await outreach.findActiveRun('lead_1')).toMatchObject({ stepIndex: 1, nextAt: new Date(state.now.getTime() + 2 * HOUR) });
    // Step 2 (WhatsApp, unconfigured) two hours on: a SKIPPED row, the run moves on.
    const second = await tickSequences(new Date(state.now.getTime() + 2 * HOUR));
    expect(second).toMatchObject({ picked: 1, skipped: 1 });
    expect(outreach.messages[outreach.messages.length - 1]).toMatchObject({ channel: 'WHATSAPP', status: 'SKIPPED', error: 'NOT_CONFIGURED', sequenceRunId: hot.id });
    // Step 3 (SMS) a day on: sent; the run completes.
    const third = await tickSequences(new Date(state.now.getTime() + 26 * HOUR));
    expect(third).toMatchObject({ picked: 1, sent: 1 });
    expect(outreach.messages[outreach.messages.length - 1]).toMatchObject({ channel: 'SMS', status: 'SENT', templateKey: 'lead-seq-publisher-nudge' });
    expect(outreach.runs[outreach.runs.length - 1]).toMatchObject({ stopReason: 'COMPLETED', stepIndex: 3 });
    // A lead past CONTACTED stops on the next tick rather than being written to again.
    state.leads.set('lead_2', lead({ id: 'lead_2', temperature: 'COLD' }));
    await enrol('lead_2', { now: state.now });
    state.leads.get('lead_2')!['stage'] = 'ENGAGED';
    const stopped = await tickSequences(new Date(state.now.getTime() + 25 * HOUR));
    expect(stopped).toMatchObject({ stopped: 1 });
    expect(outreach.runs[outreach.runs.length - 1]).toMatchObject({ leadId: 'lead_2', stopReason: 'STAGE_MOVED' });
    // A deactivated sequence stops its runs.
    state.leads.set('lead_3', lead({ id: 'lead_3', temperature: 'COLD', side: 'ADVERTISER' }));
    await enrol('lead_3', { now: state.now });
    const cold = outreach.sequences.find((s) => s['side'] === 'ADVERTISER' && s['temperature'] === 'COLD')!;
    cold['isActive'] = false;
    expect(await tickSequences(new Date(state.now.getTime() + 25 * HOUR))).toMatchObject({ stopped: 1 });
    expect(outreach.runs[outreach.runs.length - 1]).toMatchObject({ leadId: 'lead_3', stopReason: 'DEACTIVATED' });
    // No sequence for the pair, or no temperature: not enrolled, with why.
    state.leads.set('lead_4', lead({ id: 'lead_4', temperature: null }));
    expect((await enrol('lead_4')).reason).toBe('NO_TEMPERATURE');
    state.leads.set('lead_5', lead({ id: 'lead_5', stage: 'LOST' }));
    expect((await enrol('lead_5')).reason).toBe('CLOSED');
  });
});

describe('LH6: the thread view', () => {
  it('draws every message with a recording link when there is one, and the channel states beside', async () => {
    await outreach.createMessage({ conversationId: 'c', leadId: 'lead_1', direction: 'OUTBOUND', channel: 'CALL', body: 'Call answered', status: 'DELIVERED', at: state.now, recordingFileId: 'file_9', outcome: 'ANSWERED' });
    const view = await threadView('lead_1', state.now);
    expect(view.messages[0]).toMatchObject({ recordingUrl: '/api/v1/files/file_9' });
    expect(view.channels).toHaveLength(10);
    expect(view.channels.map((c) => c.channel)).toEqual(['CALL', 'WHATSAPP', 'SMS', 'EMAIL', 'INSTAGRAM', 'MESSENGER', 'GOOGLE_BUSINESS', 'LINKEDIN', 'IN_PERSON', 'OTHER']);
  });
});
