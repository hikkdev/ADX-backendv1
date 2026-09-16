import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import {
  effectiveEmailMode,
  getIntegrationsConfig,
  isPublicOsmTileTemplate,
  resolveAudiencePolicy,
  resolveAudienceProviders,
  updateIntegrationsConfig,
  type AudiencePolicyPatch,
  type IntegrationsConfig,
  type OsmConfig,
} from '../../shared/integrations';
import { AUDIENCE_FIELD_CATALOGUE, AUDIENCE_FIELD_GROUPS, AUDIENCE_FIELD_PATTERN, AUDIENCE_TEST_POINT, testAudienceVendor } from '../../shared/audience';
import { readEtherealAccount, testEmailDoor } from '../../shared/email';
import { toIntegrationsResponse, type IntegrationsReadExtras } from './integrations.mapper';
import { audienceTestSchema, emailTestSchema, patchSchemas, sectionSchema } from './integrations.schema';

/**
 * AE-B: what the read carries beside the row. Under `mode: 'ETHEREAL'` the
 * cached test inbox's login name (a read never creates one — the first send
 * or the test route does); under SMTP nothing.
 */
async function readExtras(cfg: IntegrationsConfig): Promise<IntegrationsReadExtras> {
  if (effectiveEmailMode(cfg) !== 'ETHEREAL') return {};
  const account = await readEtherealAccount();
  return { ethereal: { user: account?.user ?? null } };
}

// GET /integrations — current effective config (DB override, falling back to
// .env). Secrets are always masked; the raw value never leaves the server.
export async function getIntegrationsHandler(_req: Request, res: Response): Promise<void> {
  const cfg = await getIntegrationsConfig();
  res.json({ success: true, data: toIntegrationsResponse(cfg, await readExtras(cfg)) });
}

// PUT /integrations — body: { section: 'sms'|'email'|'storage'|'kyc'|'twilio'|'googleMaps'|'razorpay'|'stripe'|'branding'|'hrms'|'workTool'|'maps'|'audience', patch: {...} }
// Any field omitted (or sent empty) from `patch` keeps its existing stored
// value — since secrets are never sent back to the client, the form can't
// round-trip the real value anyway, only a deliberately-entered new one.
export async function updateIntegrationsHandler(req: Request, res: Response): Promise<void> {
  // Lot D (Q129): the KYC screen calls its section `digio`; the row calls it `kyc`.
  const sectionParsed = sectionSchema.safeParse(req.body?.section === 'digio' ? 'kyc' : req.body?.section);
  if (!sectionParsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid or missing "section"', sectionParsed.error.flatten());
  }

  const section = sectionParsed.data;
  const patchParsed = patchSchemas[section].safeParse(req.body?.patch ?? {});
  if (!patchParsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', patchParsed.error.flatten());
  }

  const before = await getIntegrationsConfig();
  let patch: Record<string, unknown> = patchParsed.data;
  // Y-B: the audience row holds the enabled SET and a full policy. A legacy
  // `provider` in the patch becomes the set (NONE = empty) and the legacy
  // key is cleared; a partial `policy` is laid over the stored one and the
  // defaults so the row never holds half a policy.
  if (section === 'audience') {
    const { provider: legacy, providers, policy, ...rest } = patchParsed.data as z.output<(typeof patchSchemas)['audience']>;
    patch = { ...rest };
    if (providers !== undefined) patch.providers = providers;
    else if (legacy !== undefined) patch.providers = resolveAudienceProviders({ provider: legacy });
    if (patch.providers !== undefined && before.audience?.provider !== undefined) patch.provider = null;
    if (policy !== undefined) {
      const stored = before.audience?.policy ?? {};
      const merged: AudiencePolicyPatch = {
        footfall: { ...stored.footfall, ...policy.footfall },
        demographics: { ...stored.demographics, ...policy.demographics },
        affinities: { ...stored.affinities, ...policy.affinities },
      };
      patch.policy = resolveAudiencePolicy(merged);
    }
  }
  // Z-B: the OSM sub-object is merged over the stored one (a section write
  // swaps whole keys; this key is a form of its own), blank keeps and null
  // clears back to the default, and `publicTiles` is written from the
  // template so the row says what the read will warn about. Selecting OSM
  // — or staying on it — without a contact email is refused: the public
  // Nominatim's usage policy requires one, and the adapter sends it.
  if (section === 'maps') {
    const { osm: osmPatch, ...rest } = patchParsed.data as z.output<(typeof patchSchemas)['maps']>;
    patch = { ...rest };
    const storedOsm: OsmConfig = before.maps?.osm ?? {};
    let nextOsm: OsmConfig | undefined;
    if (osmPatch !== undefined) {
      const merged: Record<string, unknown> = { ...storedOsm };
      for (const [key, value] of Object.entries(osmPatch)) {
        if (value === null) delete merged[key];
        else if (value !== undefined && value !== '') merged[key] = value;
      }
      nextOsm = merged as OsmConfig;
      nextOsm.publicTiles = isPublicOsmTileTemplate(nextOsm.tileUrlTemplate);
      patch.osm = nextOsm;
    }
    const nextProvider = rest.provider ?? before.maps?.provider ?? 'GOOGLE';
    if (nextProvider === 'OSM' && !(nextOsm ?? storedOsm).contactEmail?.trim()) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'OpenStreetMap needs a contact email: the public Nominatim usage policy requires one on every request.', {
        fieldErrors: { 'osm.contactEmail': ['Required to select OpenStreetMap'] },
        formErrors: [],
      });
    }
  }
  await updateIntegrationsConfig(section, patch);
  await logActivity(req.user!.sub, 'INTEGRATION_CONFIG_UPDATED', req, { section, fields: Object.keys(patchParsed.data) });

  // Lot D (Q129): the provider switch is a state change ops will want to find
  // in the trail by name, with what it was and what it became.
  if (section === 'kyc' && 'kycProvider' in patchParsed.data && patchParsed.data.kycProvider) {
    await logActivity(req.user!.sub, 'KYC_PROVIDER_CHANGED', {
      req,
      targetType: 'AppConfig',
      targetId: 'integrations',
      module: 'integrations',
      diff: auditDiff({ kycProvider: before.kyc?.kycProvider ?? 'DIGIO' }, { kycProvider: patchParsed.data.kycProvider }),
      metadata: { by: 'ops' },
    });
  }

  // AE-B: the SMTP door's mode moves every outbound email between a real
  // host and the Ethereal test inbox — named in the trail with what it was
  // and what it became, never the password.
  if (section === 'email' && 'mode' in patchParsed.data && patchParsed.data.mode) {
    await logActivity(req.user!.sub, 'EMAIL_MODE_CHANGED', {
      req,
      targetType: 'AppConfig',
      targetId: 'integrations',
      module: 'integrations',
      diff: auditDiff({ mode: effectiveEmailMode(before) }, { mode: patchParsed.data.mode }),
      metadata: { fields: Object.keys(patchParsed.data) },
    });
  }

  // Lot E (Q98): the HR tool is a link the whole console follows, so a change
  // of provider or portal is named in the trail with its before and after —
  // never the API key.
  if (section === 'hrms') {
    const linkFields = ['provider', 'portalUrl', 'employeeLinkTemplate'] as const;
    const beforeLink = Object.fromEntries(linkFields.map((f) => [f, before.hrms?.[f] ?? null]));
    const afterLink = Object.fromEntries(
      linkFields.map((f) => [f, f in patchParsed.data ? ((patchParsed.data as Record<string, unknown>)[f] ?? null) : (before.hrms?.[f] ?? null)]),
    );
    await logActivity(req.user!.sub, 'HRMS_CONFIG_UPDATED', {
      req,
      targetType: 'AppConfig',
      targetId: 'integrations',
      module: 'integrations',
      diff: auditDiff(beforeLink, afterLink, linkFields),
      metadata: { fields: Object.keys(patchParsed.data) },
    });
  }

  // G7 (Q101/Q109): a change of maps or audience vendor moves every phone's
  // tiles and every analytics screen's audience panel, so the switch is
  // named in the trail with what it was and what it became — never a key.
  if (section === 'maps' && 'provider' in patchParsed.data && patchParsed.data.provider) {
    await logActivity(req.user!.sub, 'MAPS_PROVIDER_CHANGED', {
      req,
      targetType: 'AppConfig',
      targetId: 'integrations',
      module: 'integrations',
      diff: auditDiff({ provider: before.maps?.provider ?? 'GOOGLE' }, { provider: patchParsed.data.provider }),
      metadata: { fields: Object.keys(patchParsed.data) },
    });
  }
  // Y-B: a change of the enabled set or of the blend policy moves every
  // analytics screen's audience panel — named in the trail with the set
  // and the policy before and after, never a key.
  if (section === 'audience' && (patch.providers !== undefined || patch.policy !== undefined)) {
    const beforeProviders = resolveAudienceProviders(before.audience);
    const beforePolicy = resolveAudiencePolicy(before.audience?.policy);
    const afterProviders = (patch.providers as string[] | undefined) ?? beforeProviders;
    const afterPolicy = patch.policy ?? beforePolicy;
    await logActivity(req.user!.sub, 'AUDIENCE_PROVIDER_CHANGED', {
      req,
      targetType: 'AppConfig',
      targetId: 'integrations',
      module: 'integrations',
      diff: auditDiff({ providers: beforeProviders, policy: beforePolicy }, { providers: afterProviders, policy: afterPolicy }),
      metadata: { fields: Object.keys(patchParsed.data) },
    });
  }

  // T-B: the write answers the same masked view the GET answers — re-read
  // after the store so the screen updates its state from the answer.
  const after = await getIntegrationsConfig();
  res.json({ success: true, data: { message: `${section} configuration updated`, ...toIntegrationsResponse(after, await readExtras(after)) } });
}

// AE-B: POST /integrations/email/test { to } — one message through the one
// door (`shared/email`'s `sendEmail`: SMTP, Resend or the Ethereal inbox, as
// the row says) and a plain verdict the card prints. A missing host, a
// refused login, a Resend 4xx and a door that does not answer in 15 s are
// verdicts, never this route's 5xx. Audited INTEGRATION_TESTED with the
// provider and the verdict's flags — the SMTP password and the Resend key
// are masked out of every sentence before it leaves, and neither reaches
// the trail.
export async function testEmailDoorHandler(req: Request, res: Response): Promise<void> {
  const parsed = emailTestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  const verdict = await testEmailDoor(parsed.data.to);
  await logActivity(req.user!.sub, 'INTEGRATION_TESTED', {
    req,
    targetType: 'AppConfig',
    targetId: 'integrations',
    module: 'integrations',
    metadata: {
      section: 'email',
      provider: verdict.provider,
      verdict: { configured: verdict.configured, ok: verdict.ok, previewUrl: verdict.previewUrl },
    },
  });
  res.json({ success: true, data: verdict });
}

// AC-B2: GET /integrations/audience/fields — the field catalogue the console
// draws the GeoIQ variable map from: the named rows (footfall.daily required,
// the age / income bands, the three genders), the groups in drawing order
// (affinity free-form), and the pattern the PUT validates keys against.
export async function audienceFieldsHandler(_req: Request, res: Response): Promise<void> {
  res.json({
    success: true,
    data: {
      fields: AUDIENCE_FIELD_CATALOGUE,
      groups: AUDIENCE_FIELD_GROUPS,
      pattern: AUDIENCE_FIELD_PATTERN.source,
      testPoint: AUDIENCE_TEST_POINT,
    },
  });
}

// AC-B2: POST /integrations/audience/test { vendor } — asks the vendor ONCE
// at the fixed point with the stored key and answers a plain verdict the
// card prints. A refused key, a dead host or a 5xx from the vendor is a
// verdict, never this route's 5xx. Audited INTEGRATION_TESTED with the
// vendor and the verdict — the verdict carries no key, and neither does
// the trail.
export async function testAudienceVendorHandler(req: Request, res: Response): Promise<void> {
  const parsed = audienceTestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  const { vendor } = parsed.data;
  const verdict = await testAudienceVendor(vendor);
  await logActivity(req.user!.sub, 'INTEGRATION_TESTED', {
    req,
    targetType: 'AppConfig',
    targetId: 'integrations',
    module: 'integrations',
    metadata: {
      section: 'audience',
      vendor,
      verdict: {
        keyPresent: verdict.keyPresent,
        variablesMapped: verdict.variablesMapped,
        reachable: verdict.reachable,
        authorized: verdict.authorized,
        status: verdict.status,
        fieldsAnswered: verdict.fieldsAnswered.length,
        fieldsMissing: verdict.fieldsMissing.length,
      },
    },
  });
  res.json({ success: true, data: verdict });
}
