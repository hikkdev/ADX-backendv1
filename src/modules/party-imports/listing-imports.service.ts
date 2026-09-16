import type { Request } from 'express';
import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { haversineMeters } from '../../shared/geo';
import { geocodeAddress } from '../../shared/maps';
import { Decimal, money } from '../../shared/money';
import { findAgentProfile } from '../agents';
import { assertCanCreateForPublisher, createListing, updateListing, type ListingActor, type ListingDraft } from '../listings';
import { citySupport, resolveCity } from '../pricing';
import { floorFor } from '../rate-cards';
import { attachListingToAttempt, createAttempt } from '../supply';
import { prismaPartyImportsRepository as repository } from './prisma-party-imports.repository';
import { getImport, type RawImportRow } from './party-imports.service';
import type { ImportCounts, ImportPublisher, MatchedListing, NewImportRow, PartyImportOutcome, SpotVocabulary } from './party-imports.repository';
import { listingRowSchema, rateCardRowSchema, type ListingRow, type RateCardRow } from './party-imports.schema';

/**
 * Lot U — a publisher's spots and their rate card, imported through the
 * party-import kit (Lot S): validate with a per-row plan, commit row by row
 * with the resumable marker, revoke, report.csv.
 *
 * The module still writes nothing of its own. A spot is created through
 * `listings.createListing` (photos, the loop, the instant-booking gate, the
 * surge stamp, the vocabulary — everything a console Create does) and filed
 * under ONE supply attempt per import through `supply.attachListingToAttempt`,
 * so the publisher accepts one agreement for the whole file; the agreement's
 * conditional-publication clause covers the spots whose documents are not in
 * yet. A rate is set through `listings.updateListing`, which is how a typed
 * rate lands — `ratePerDaySetAt` stamped by the listings repository, the surge
 * stamp recorded. Nothing here ever makes a listing ACTIVE.
 *
 * Who may: ADMIN, or an agent under the act rule an agent's own listing
 * creation uses (`listings.assertCanCreateForPublisher` — the agent who
 * onboarded the publisher, or one under a live LISTINGS grant).
 */

/** Another publisher's spot this close is probably the same wall. */
export const DUPLICATE_RADIUS_M = 25;
const DAYS_PER_MONTH = 30;

type RowInput = { fileName?: string | undefined; note?: string | undefined; rows: RawImportRow[] };

/** The columns a LISTING merge may fill on an existing spot — the ones the platform's own edit door takes. */
const MERGEABLE_LISTING_FIELDS = ['description', 'subType', 'mediaTypeId', 'sizeClassId', 'materialId'] as const;

type ListingPlan =
  | { action: 'CREATE'; warnings: string[] }
  | { action: 'MERGE'; targetId: string; fill: Record<string, string>; warnings: string[] };

type RatePlan = { action: 'SET'; targetId: string; ratePerDay: string; slotsTotal?: number; from: string | null; warnings: string[] };

type RowResult = { action: 'CREATED' | 'MERGED' | 'SKIPPED' | 'FAILED'; targetId: string | null; attemptId?: string; at: string };

type RowData = Record<string, unknown> & { plan?: ListingPlan | RatePlan | null; result?: RowResult | null };

const isApiError = (err: unknown): err is ApiError => err instanceof ApiError;

/* ── Shared helpers ────────────────────────────────────────────────────── */

/** The publisher the import is for (404), and whether this caller may act for them (403). */
async function requirePublisher(publisherId: string, actor: ListingActor): Promise<ImportPublisher> {
  const publisher = await repository.findPublisher(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  await assertCanCreateForPublisher(publisherId, actor);
  return publisher;
}

/** The shape pass: one message per bad row, naming the field. */
function parseRows<T>(rows: RawImportRow[], schema: { safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string; code: string }[] } } }) {
  return rows.map((raw) => {
    const result = schema.safeParse(raw.data);
    if (result.success) return { rowNumber: raw.rowNumber, raw: raw.data, row: result.data, message: null as string | null };
    const issue = result.error.issues[0];
    const field = issue?.path[0] !== undefined ? String(issue.path[0]) : 'row';
    const value = raw.data[field];
    const blank = value === undefined || value === null || value === '';
    const message = issue?.message.endsWith(' is required') ? issue.message : blank && issue?.code === 'invalid_type' ? `${field} is required` : `${field}: ${issue?.message ?? 'invalid'}`;
    return { rowNumber: raw.rowNumber, raw: raw.data, row: null as T | null, message };
  });
}

/** "12, M.G. Road, Pune" and "12 MG ROAD PUNE" are one address. */
export const normaliseAddress = (address: string): string => address.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const labelOf = (listing: { displayId: string | null; title: string }) => listing.displayId ?? listing.title;

/** Two decimals, from either shape the file may carry. */
function rateOf(row: { ratePerDay?: string | undefined; monthlyPrice?: string | undefined }): string {
  if (row.ratePerDay !== undefined) return money(row.ratePerDay);
  return money(new Decimal(row.monthlyPrice ?? '0').dividedBy(DAYS_PER_MONTH));
}

/** Resolves a name or a slug against a controlled list, case-insensitively. */
function lookup<T extends { id: string; name: string; slug: string }>(list: T[], value: string): T | undefined {
  const wanted = value.trim().toLowerCase();
  return list.find((item) => item.slug.toLowerCase() === wanted || item.name.toLowerCase() === wanted);
}

/** The floor of the card in force for this kind of spot in this city, memoised for the batch; null where no card reaches. */
function floorReader() {
  const cities = new Map<string, Promise<string | null>>();
  const floors = new Map<string, Promise<{ floor: string } | null>>();
  return async (mediaTypeId: string | null | undefined, city: string | null | undefined): Promise<string | null> => {
    if (!mediaTypeId) return null;
    const cityKey = city?.toLowerCase() ?? '';
    if (!cities.has(cityKey)) cities.set(cityKey, city ? repository.findCityIdByName(city) : Promise.resolve(null));
    const cityId = await cities.get(cityKey)!;
    const key = `${mediaTypeId}:${cityId ?? ''}`;
    if (!floors.has(key)) floors.set(key, floorFor(mediaTypeId, cityId));
    return (await floors.get(key)!)?.floor ?? null;
  };
}

const belowFloor = (rate: string, floor: string | null) => floor !== null && new Decimal(rate).lessThan(new Decimal(floor));
const floorWarning = (rate: string, floor: string) => `Rate ${rate}/day is below the ADX floor ${floor}/day; the publish gate will hold it until ADX signs the price off`;

/** The listing fields of the file that a merge may fill, as strings, from a parsed row. */
function mergeableOf(data: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of MERGEABLE_LISTING_FIELDS) {
    const value = data[key];
    if (typeof value === 'string' && value !== '') fields[key] = value;
  }
  return fields;
}

/** What `incoming` would fill on `listing`: the empty columns only, and the rate only when the listing has none. */
function listingBlanks(listing: MatchedListing, incoming: Record<string, string>, rate: string | null, claimed?: Set<string>): Record<string, string> {
  const fill: Record<string, string> = {};
  for (const key of MERGEABLE_LISTING_FIELDS) {
    const value = incoming[key];
    if (value === undefined) continue;
    const current = listing.fields[key];
    if ((current === null || current === undefined || current === '') && !claimed?.has(`${listing.id}:${key}`)) fill[key] = value;
  }
  if (rate !== null && listing.ratePerDay === null && !claimed?.has(`${listing.id}:ratePerDay`)) fill['ratePerDay'] = rate;
  return fill;
}

/* ── LISTING: validate ─────────────────────────────────────────────────── */

/**
 * The plan for a publisher's spots. Per row: the vocabulary resolved against
 * the controlled lists (INVALID naming the field when unknown); the city
 * through `pricing.resolveCity` (unknown warns, kept as typed); a row
 * without coordinates geocoded through the maps seam (a WARNING when it
 * answers null — or throws for want of a key — never a failure); a rate under
 * the ADX floor a WARNING; the same externalRef as a row an earlier import
 * committed, or the same normalised address as one of the publisher's
 * listings, a MERGE filling only the blanks (never a set rate) or SKIPPED;
 * a duplicate inside the batch SKIPPED; another publisher's listing within
 * 25 m a WARNING that still creates. Nothing refuses the batch.
 */
export async function validateListingImport(publisherId: string, input: RowInput, actor: ListingActor, req?: Request) {
  const publisher = await requirePublisher(publisherId, actor);
  const parsed = parseRows<ListingRow>(input.rows, listingRowSchema);

  const [own, refs, vocabulary] = await Promise.all([repository.listPublisherListings(publisherId), repository.findExternalRefs(publisherId), repository.listSpotVocabulary()]);
  const ownById = new Map(own.map((listing) => [listing.id, listing]));
  const byAddress = new Map<string, MatchedListing>();
  for (const listing of own) if (!byAddress.has(normaliseAddress(listing.address))) byAddress.set(normaliseAddress(listing.address), listing);
  const floorOf = floorReader();

  // First pass: shape, vocabulary, city, coordinates. Kept apart from the
  // plan so the nearby read can be one query over every point of the batch.
  type Resolved = { rowNumber: number; raw: Record<string, unknown>; row: ListingRow | null; data: Record<string, unknown>; warnings: string[]; message: string | null; point: { latitude: number; longitude: number } | null };
  const resolved: Resolved[] = [];
  const seen = new Map<string, number>();
  const geocodeCache = new Map<string, Promise<{ latitude: number; longitude: number } | null>>();
  // Lot V: a new spot lands only where the city's rollout stage has supply
  // intake on — the same gate `createListing` applies at commit, answered
  // here per distinct city so the report says so before anything runs. A
  // merge into a spot already on the platform is not new inventory.
  const closedCities = new Map<string, string>();
  const closedCityFor = async (city: string): Promise<string | null> => {
    if (!closedCities.has(city)) {
      const view = await citySupport(city);
      closedCities.set(city, view.resolved && !view.switches.supplyIntake ? `${view.city!.name} (${view.stage!.toLowerCase()})` : '');
    }
    return closedCities.get(city) || null;
  };
  for (const item of parsed) {
    if (!item.row) {
      resolved.push({ rowNumber: item.rowNumber, raw: item.raw, row: null, data: item.raw, warnings: [], message: item.message, point: null });
      continue;
    }
    const row = item.row;
    const data: Record<string, unknown> = { ...row };
    const warnings: string[] = [];

    // A duplicate inside the batch is the later row — decided before any
    // lookup, so a twin costs no geocode.
    const key = row.externalRef ? `ref:${row.externalRef}` : `addr:${normaliseAddress(row.address)}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      resolved.push({ rowNumber: item.rowNumber, raw: item.raw, row, data, warnings, message: `Duplicate of row ${earlier} in this file`, point: null });
      continue;
    }
    seen.set(key, item.rowNumber);

    const invalid = resolveVocabulary(row, data, vocabulary);
    if (invalid) {
      resolved.push({ rowNumber: item.rowNumber, raw: item.raw, row: null, data, warnings, message: invalid, point: null });
      continue;
    }

    if (row.city) {
      const canonical = await resolveCity(row.city);
      if (canonical) data['city'] = canonical;
      else warnings.push(`City "${row.city}" is not in the catalogue; kept as typed`);
    }

    // A spot already on the platform cannot take coordinates from a file
    // (the platform's own edit door does not move a pin), so it is not
    // geocoded; the plan below decides what it fills.
    const existing = (row.externalRef && refs.get(row.externalRef) ? ownById.get(refs.get(row.externalRef)!) : undefined) ?? byAddress.get(normaliseAddress(row.address));
    const closed = !existing && row.city ? await closedCityFor(row.city) : null;
    if (closed) {
      resolved.push({ rowNumber: item.rowNumber, raw: item.raw, row, data, warnings, message: `ADX is not taking new listings in ${closed}`, point: null });
      continue;
    }
    let point: { latitude: number; longitude: number } | null = row.latitude !== undefined && row.longitude !== undefined ? { latitude: Number(row.latitude), longitude: Number(row.longitude) } : null;
    if (!point && !existing) {
      const query = [row.address, data['city'] as string | undefined, row.state].filter(Boolean).join(', ');
      if (!geocodeCache.has(query)) geocodeCache.set(query, geocodeQuietly(query));
      point = await geocodeCache.get(query)!;
      if (point) {
        data['latitude'] = String(point.latitude);
        data['longitude'] = String(point.longitude);
        data['geocoded'] = true;
      } else {
        warnings.push('No coordinates — place it on the map before publishing');
      }
    }
    resolved.push({ rowNumber: item.rowNumber, raw: item.raw, row, data, warnings, message: null, point });
  }

  // One read for every point of the batch, then the exact radius in memory.
  const points = resolved.flatMap((item) => (item.point && item.message === null ? [item.point] : []));
  const nearby = await repository.findListingsNear(points, publisherId, DUPLICATE_RADIUS_M);

  // Second pass: the plan, in order, so a merge does not fill a column an
  // earlier row of the batch already claimed.
  const claimed = new Set<string>();
  const rows: NewImportRow[] = [];
  const counts: ImportCounts = { rowCount: parsed.length, createdCount: 0, mergedCount: 0, skippedCount: 0, warningCount: 0, invalidCount: 0 };

  for (const item of resolved) {
    if (!item.row) {
      counts.invalidCount += 1;
      rows.push({ rowNumber: item.rowNumber, data: { ...item.data, plan: null }, outcome: 'INVALID', targetId: null, message: item.message });
      continue;
    }
    if (item.message) {
      counts.skippedCount += 1;
      rows.push({ rowNumber: item.rowNumber, data: { ...item.data, plan: null }, outcome: 'SKIPPED', targetId: null, message: item.message });
      continue;
    }
    const { row, data, warnings } = item;
    const rate = rateOf(row);
    data['ratePerDayResolved'] = rate;

    const byRef = row.externalRef ? refs.get(row.externalRef) : undefined;
    const existing = (byRef ? ownById.get(byRef) : undefined) ?? byAddress.get(normaliseAddress(row.address));
    if (existing) {
      const fill = listingBlanks(existing, mergeableOf(data), rate, claimed);
      for (const column of Object.keys(fill)) claimed.add(`${existing.id}:${column}`);
      const plan: ListingPlan = { action: 'MERGE', targetId: existing.id, fill, warnings };
      const how = byRef ? `externalRef ${row.externalRef}` : 'the same address';
      const rateNote = existing.ratePerDay !== null && !fill['ratePerDay'] ? `; rate kept at ${existing.ratePerDay}` : '';
      if (fill['ratePerDay']) {
        const floor = await floorOf(fill['mediaTypeId'] ?? existing.fields['mediaTypeId'], (data['city'] as string | undefined) ?? existing.fields['city']);
        if (belowFloor(rate, floor)) warnings.push(floorWarning(rate, floor!));
      }
      let message: string;
      let outcome: PartyImportOutcome;
      if (Object.keys(fill).length === 0) {
        outcome = 'SKIPPED';
        counts.skippedCount += 1;
        message = `Already on the platform as ${labelOf(existing)} (${how}); nothing to add${rateNote}`;
      } else {
        outcome = 'MERGED';
        counts.mergedCount += 1;
        message = `Merges into ${labelOf(existing)} (${how}): fills ${Object.keys(fill).join(', ')}${rateNote}`;
      }
      if (warnings.length) message = `${message}. ${warnings.join('. ')}`;
      rows.push({ rowNumber: item.rowNumber, data: { ...data, plan }, outcome, targetId: existing.id, message });
      continue;
    }

    const floor = await floorOf(data['mediaTypeId'] as string | undefined, data['city'] as string | undefined);
    if (belowFloor(rate, floor)) warnings.push(floorWarning(rate, floor!));
    if (item.point) {
      const twin = nearby
        .map((other) => ({ other, metres: haversineMeters(item.point!.latitude, item.point!.longitude, other.latitude, other.longitude) }))
        .filter(({ metres }) => metres <= DUPLICATE_RADIUS_M)
        .sort((a, b) => a.metres - b.metres)[0];
      if (twin) warnings.push(`Possible duplicate of ${labelOf(twin.other)} — another publisher's spot ${Math.round(twin.metres)} m away`);
    }

    const plan: ListingPlan = { action: 'CREATE', warnings };
    counts.createdCount += 1;
    if (warnings.length) counts.warningCount += 1;
    const outcome: PartyImportOutcome = warnings.length ? 'WARNING' : 'CREATED';
    const message = warnings.length ? `Will create under the batch's agreement; ${warnings.join('. ')}` : "Will create under the batch's agreement";
    rows.push({ rowNumber: item.rowNumber, data: { ...data, plan }, outcome, targetId: null, message });
  }

  const created = await repository.createImport({
    party: 'LISTING',
    fileName: input.fileName ?? `rows-${new Date().toISOString().slice(0, 10)}.json`,
    note: input.note ?? null,
    uploadedById: actor.userId,
    publisherId,
    rows,
    counts,
  });
  await logActivity(actor.userId, 'LISTING_IMPORT_VALIDATED', {
    req,
    targetType: 'PartyImport',
    targetId: created.id,
    module: 'party-imports',
    metadata: { publisherId, publisherDisplayId: publisher.displayId, fileName: created.fileName, counts },
  });
  return created;
}

/** The controlled lists: a name or a slug, or INVALID naming the field. Writes the ids onto the row. */
function resolveVocabulary(row: ListingRow, data: Record<string, unknown>, vocabulary: SpotVocabulary): string | null {
  if (row.mediaType) {
    const found = lookup(vocabulary.mediaTypes, row.mediaType);
    if (!found) return `mediaType: unknown media type "${row.mediaType}"`;
    data['mediaTypeId'] = found.id;
  }
  if (row.sizeClass) {
    const found = lookup(vocabulary.sizeClasses, row.sizeClass);
    if (!found) return `sizeClass: unknown size class "${row.sizeClass}"`;
    data['sizeClassId'] = found.id;
  }
  if (row.material) {
    const found = lookup(vocabulary.materials, row.material);
    if (!found) return `material: unknown material "${row.material}"`;
    data['materialId'] = found.id;
  }
  return null;
}

/**
 * The maps seam, as an import needs it: a point or null. The seam throws
 * 503 for want of a key, 429 on quota, 502 when the vendor is down — none of
 * which is a reason to fail a row; the row warns and ops place it by hand.
 */
async function geocodeQuietly(query: string): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const place = await geocodeAddress(query);
    return place ? { latitude: place.latitude, longitude: place.longitude } : null;
  } catch (err) {
    if (isApiError(err)) return null;
    throw err;
  }
}

/* ── LISTING: commit ───────────────────────────────────────────────────── */

/** What a CREATE row hands `listings.createListing` — the console's own door. */
function draftFrom(data: Record<string, unknown>, publisherId: string, agentId: string | null): ListingDraft {
  const text = (key: string): string | undefined => (typeof data[key] === 'string' && data[key] !== '' ? (data[key] as string) : undefined);
  const photos = text('photos')
    ?.split('|')
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => ({ url, type: 'main' }));
  return {
    publisherId,
    ...(agentId ? { agentId } : {}),
    title: text('title')!,
    category: text('category') as ListingDraft['category'],
    ...(text('subType') ? { subType: text('subType')! } : {}),
    ...(text('description') ? { description: text('description')! } : {}),
    address: text('address')!,
    ...(text('city') ? { city: text('city')! } : {}),
    ...(text('latitude') && text('longitude') ? { latitude: Number(text('latitude')), longitude: Number(text('longitude')) } : {}),
    ...(text('size') ? { size: text('size')! } : {}),
    ...(text('mediaTypeId') ? { mediaTypeId: text('mediaTypeId')! } : {}),
    ...(text('sizeClassId') ? { sizeClassId: text('sizeClassId')! } : {}),
    ...(text('materialId') ? { materialId: text('materialId')! } : {}),
    ...(text('ratePerDay') ? { ratePerDay: text('ratePerDay')! } : { monthlyPrice: Number(text('monthlyPrice')) }),
    ...(text('slotsTotal') ? { slotsTotal: Number(text('slotsTotal')) } : {}),
    ...(text('instantBooking') === 'yes' ? { instantBooking: true } : {}),
    ...(photos?.length ? { photos } : {}),
  };
}

/**
 * The second step for a publisher's spots — per row, resumable, as Lot S.
 *
 * The first run opens ONE supply attempt for the publisher and writes its id
 * on the import; a resumed run reads it back and reuses it, so the batch sits
 * under one agreement however many runs it took. Every CREATE goes through
 * `listings.createListing` and then `supply.attachListingToAttempt` — DRAFT,
 * then AWAITING_AGREEMENT; never ACTIVE, which only the attempt flow and the
 * desk reach. A MERGE goes through `listings.updateListing`. The listings are
 * re-read once at commit: a spot that joined between validation and commit
 * (by reference or by address) is merged into, not duplicated.
 *
 * The agreement is NOT sent here: the answer carries `attemptId` and the
 * console offers "Send the agreement" — `POST /supply/attempts/:id/request-acceptance`.
 */
export async function commitListingImport(id: string, actor: ListingActor, byUserId: string, req?: Request) {
  const found = await getImport('listings', id);
  const publisherId = found.publisherId;
  if (!publisherId) throw new ApiError(409, 'CONFLICT', 'This import names no publisher');
  await requirePublisher(publisherId, actor);
  if (found.status !== 'VALIDATED') {
    throw new ApiError(409, 'CONFLICT', found.status === 'COMMITTED' ? 'This import has already been committed' : 'This import was revoked');
  }

  const actionable = found.rows.filter((row) => {
    const data = row.data as RowData;
    return data.plan && (!data.result || data.result.action === 'FAILED');
  });

  // The attempt: the one an earlier run opened, or a new one — once.
  let attemptId = found.attemptId;
  if (!attemptId && actionable.some((row) => (row.data as RowData).plan?.action === 'CREATE')) {
    const attempt = await createAttempt({
      publisherId,
      origin: actor.isAdmin ? 'ADMIN_BULK' : 'AGENT',
      createdByUserId: byUserId,
      sourceFilename: found.fileName,
      note: `Listing import ${id}`,
    });
    attemptId = attempt.id;
    await repository.setAttempt(id, attemptId);
  }
  // An agent's import stamps the agent on each spot, as the agent's own Create does; an admin's carries none.
  const agentId = actor.isAdmin ? null : ((await findAgentProfile(byUserId))?.id ?? null);

  const [own, refs] = await Promise.all([repository.listPublisherListings(publisherId), repository.findExternalRefs(publisherId)]);
  const ownById = new Map(own.map((listing) => [listing.id, listing]));
  const byAddress = new Map<string, MatchedListing>();
  for (const listing of own) if (!byAddress.has(normaliseAddress(listing.address))) byAddress.set(normaliseAddress(listing.address), listing);

  const now = new Date();
  const results = new Map<string, { result: RowResult; outcome: PartyImportOutcome }>();

  for (const row of actionable) {
    const data = row.data as RowData;
    const plan = data.plan as ListingPlan;
    const stamp = async (result: RowResult, outcome: PartyImportOutcome | undefined, message?: string | null) => {
      await repository.stampRow(row.id, { data: { ...data, result }, targetId: result.targetId, ...(outcome ? { outcome } : {}), ...(message !== undefined ? { message } : {}) });
      results.set(row.id, { result, outcome: outcome ?? row.outcome });
    };
    const meta = { importId: id, rowNumber: row.rowNumber, source: 'import' as const };

    try {
      const ref = typeof data['externalRef'] === 'string' ? (data['externalRef'] as string) : null;
      const address = typeof data['address'] === 'string' ? (data['address'] as string) : '';
      const joined = plan.action === 'CREATE' ? ((ref && refs.get(ref) && ownById.get(refs.get(ref)!)) || byAddress.get(normaliseAddress(address)) || null) : null;
      const target = plan.action === 'MERGE' ? (ownById.get(plan.targetId) ?? null) : joined;

      if (plan.action === 'MERGE' || target) {
        if (!target) {
          await stamp({ action: 'SKIPPED', targetId: null, at: now.toISOString() }, 'SKIPPED', `Listing ${(plan as { targetId: string }).targetId} is no longer on the platform; nothing done`);
          continue;
        }
        const rate = typeof data['ratePerDayResolved'] === 'string' ? (data['ratePerDayResolved'] as string) : null;
        // Recomputed against the listing as it is now, so a column filled since validation is not overwritten.
        const fill = listingBlanks(target, plan.action === 'MERGE' ? plan.fill : mergeableOf(data), plan.action === 'MERGE' ? (plan.fill['ratePerDay'] ?? null) : rate);
        if (Object.keys(fill).length === 0) {
          const message = plan.action === 'CREATE' ? `Already on the platform as ${labelOf(target)} (joined after validation); nothing to add` : `Nothing left to fill on ${labelOf(target)}`;
          await stamp({ action: 'SKIPPED', targetId: target.id, at: now.toISOString() }, 'SKIPPED', message);
          continue;
        }
        await updateListing(target.id, fill);
        await logActivity(byUserId, 'LISTING_UPDATED', {
          req,
          module: 'party-imports',
          targetType: 'Listing',
          targetId: target.id,
          diff: auditDiff({ ...target.fields, ratePerDay: target.ratePerDay }, { ...target.fields, ratePerDay: target.ratePerDay, ...fill }),
          metadata: { ...meta, fields: Object.keys(fill) },
        });
        const message = plan.action === 'CREATE' ? `Merged into ${labelOf(target)}: this spot joined after validation; filled ${Object.keys(fill).join(', ')}` : undefined;
        await stamp({ action: 'MERGED', targetId: target.id, at: now.toISOString() }, 'MERGED', message);
        continue;
      }

      const created = await createListing(draftFrom(data, publisherId, agentId));
      await logActivity(byUserId, 'LISTING_CREATED', {
        req,
        module: 'party-imports',
        targetType: 'Listing',
        targetId: created.id,
        metadata: { ...meta, publisherId, attemptId, title: created.title },
      });
      // Under the batch's one agreement. A refusal here leaves the listing a
      // DRAFT the publisher can still submit; the row says so rather than
      // pretending it was not created.
      let attached: string | null = null;
      try {
        if (attemptId) {
          await attachListingToAttempt(attemptId, created.id);
          attached = attemptId;
        }
      } catch (err) {
        if (!isApiError(err)) throw err;
        await stamp({ action: 'CREATED', targetId: created.id, at: now.toISOString() }, 'WARNING', `Created as a draft, but not under the agreement: ${err.message}`);
        continue;
      }
      // A WARNING row keeps its outcome: the report still shows what ops were told.
      await stamp({ action: 'CREATED', targetId: created.id, ...(attached ? { attemptId: attached } : {}), at: now.toISOString() }, row.outcome === 'WARNING' ? undefined : 'CREATED');
    } catch (err) {
      if (!isApiError(err)) throw err;
      await stamp({ action: 'FAILED', targetId: null, at: now.toISOString() }, 'INVALID', `Not ${plan.action === 'MERGE' ? 'merged' : 'created'}: ${err.message}`);
    }
  }

  const counts = countResults(found.rows, results);
  const committed = await repository.finishCommit(id, counts, now);
  await logActivity(byUserId, 'LISTING_IMPORT_COMMITTED', {
    req,
    targetType: 'PartyImport',
    targetId: id,
    module: 'party-imports',
    metadata: { publisherId, attemptId, fileName: committed.fileName, counts },
  });
  return { ...committed, attemptId: committed.attemptId ?? attemptId ?? null };
}

/** The counts as the commit left them: this run's results over what earlier runs stamped. */
function countResults(rows: { id: string; outcome: PartyImportOutcome; data: unknown }[], results: Map<string, { result: RowResult; outcome: PartyImportOutcome }>) {
  const counts = { createdCount: 0, mergedCount: 0, skippedCount: 0, warningCount: 0, invalidCount: 0 };
  for (const row of rows) {
    const landed = results.get(row.id);
    const result = landed?.result ?? (row.data as RowData).result;
    const outcome = landed?.outcome ?? row.outcome;
    if (result?.action === 'CREATED') {
      counts.createdCount += 1;
      if (outcome === 'WARNING') counts.warningCount += 1;
    } else if (result?.action === 'MERGED') {
      counts.mergedCount += 1;
      if (outcome === 'WARNING') counts.warningCount += 1;
    } else if (outcome === 'SKIPPED' || result?.action === 'SKIPPED') counts.skippedCount += 1;
    else if (outcome === 'INVALID' || result?.action === 'FAILED') counts.invalidCount += 1;
  }
  return counts;
}

/* ── RATE_CARD: validate ───────────────────────────────────────────────── */

/** A calendar day in UTC, for the effectiveFrom rule. */
const todayIso = (now: Date) => now.toISOString().slice(0, 10);

/**
 * The plan for a publisher's rate card. `listing` is resolved against the
 * publisher's own listings by displayId, then by externalRef (from the rows
 * earlier LISTING imports committed), then by exact title — in that order;
 * unmatched is INVALID naming the reference, and a title two listings share
 * is INVALID rather than a guess. An unchanged rate (and loop) is SKIPPED;
 * a rate under the ADX floor, or a listing with a booking running, is a
 * WARNING that still sets — the accrual snapshots of the running order keep
 * the rate they were placed at. `effectiveFrom` is today when omitted; a
 * future day is INVALID ("future rates are not supported") — the sweep that
 * would apply a planned rate is deliberately not built (see the README).
 */
export async function validateRateCardImport(publisherId: string, input: RowInput, actor: ListingActor, req?: Request) {
  const publisher = await requirePublisher(publisherId, actor);
  const parsed = parseRows<RateCardRow>(input.rows, rateCardRowSchema);
  const [own, refs] = await Promise.all([repository.listPublisherListings(publisherId), repository.findExternalRefs(publisherId)]);
  const resolve = listingResolver(own, refs);
  const today = todayIso(new Date());

  const running = await repository.listingsWithRunningBooking(own.map((listing) => listing.id));
  const floorOf = floorReader();
  const seen = new Map<string, number>();
  const rows: NewImportRow[] = [];
  const counts: ImportCounts = { rowCount: parsed.length, createdCount: 0, mergedCount: 0, skippedCount: 0, warningCount: 0, invalidCount: 0 };

  for (const item of parsed) {
    if (!item.row) {
      counts.invalidCount += 1;
      rows.push({ rowNumber: item.rowNumber, data: { ...item.raw, plan: null }, outcome: 'INVALID', targetId: null, message: item.message });
      continue;
    }
    const row = item.row;
    const data: Record<string, unknown> = { ...row };
    const invalid = (message: string) => {
      counts.invalidCount += 1;
      rows.push({ rowNumber: item.rowNumber, data: { ...data, plan: null }, outcome: 'INVALID', targetId: null, message });
    };

    if (row.effectiveFrom !== undefined && row.effectiveFrom > today) {
      invalid('effectiveFrom: future rates are not supported');
      continue;
    }
    const match = resolve(row.listing);
    if (match.kind === 'none') {
      invalid(`listing: no listing "${row.listing}" on this publisher`);
      continue;
    }
    if (match.kind === 'many') {
      invalid(`listing: "${row.listing}" names ${match.count} listings; use the displayId`);
      continue;
    }
    const listing = match.listing;
    const earlier = seen.get(listing.id);
    if (earlier !== undefined) {
      counts.skippedCount += 1;
      rows.push({ rowNumber: item.rowNumber, data: { ...data, plan: null }, outcome: 'SKIPPED', targetId: listing.id, message: `Duplicate of row ${earlier} in this file` });
      continue;
    }
    seen.set(listing.id, item.rowNumber);

    const rate = rateOf(row);
    const slotsTotal = row.slotsTotal !== undefined ? Number(row.slotsTotal) : undefined;
    const rateUnchanged = listing.ratePerDay !== null && new Decimal(listing.ratePerDay).equals(new Decimal(rate));
    const slotsUnchanged = slotsTotal === undefined || slotsTotal === listing.slotsTotal;
    if (rateUnchanged && slotsUnchanged) {
      counts.skippedCount += 1;
      rows.push({ rowNumber: item.rowNumber, data: { ...data, plan: null }, outcome: 'SKIPPED', targetId: listing.id, message: `${labelOf(listing)} is already at ${rate}/day; unchanged` });
      continue;
    }

    const warnings: string[] = [];
    const floor = await floorOf(listing.fields['mediaTypeId'], listing.fields['city']);
    if (belowFloor(rate, floor)) warnings.push(floorWarning(rate, floor!));
    if (running.has(listing.id)) warnings.push('A booking is running on this spot; its accrual snapshots keep the rate it was placed at — the new rate applies to bookings placed from now');

    const plan: RatePlan = { action: 'SET', targetId: listing.id, ratePerDay: rate, ...(slotsTotal !== undefined && slotsTotal !== listing.slotsTotal ? { slotsTotal } : {}), from: listing.ratePerDay, warnings };
    counts.mergedCount += 1;
    if (warnings.length) counts.warningCount += 1;
    const change = rateUnchanged ? `rate unchanged at ${rate}` : `${listing.ratePerDay ?? 'unpriced'} → ${rate}`;
    const loop = plan.slotsTotal !== undefined ? `; slots ${listing.slotsTotal} → ${plan.slotsTotal}` : '';
    let message = `Will set ${labelOf(listing)}: ${change}/day${loop}`;
    if (warnings.length) message = `${message}. ${warnings.join('. ')}`;
    rows.push({ rowNumber: item.rowNumber, data: { ...data, plan }, outcome: warnings.length ? 'WARNING' : 'MERGED', targetId: listing.id, message });
  }

  const created = await repository.createImport({
    party: 'RATE_CARD',
    fileName: input.fileName ?? `rows-${new Date().toISOString().slice(0, 10)}.json`,
    note: input.note ?? null,
    uploadedById: actor.userId,
    publisherId,
    rows,
    counts,
  });
  await logActivity(actor.userId, 'RATE_CARD_IMPORT_VALIDATED', {
    req,
    targetType: 'PartyImport',
    targetId: created.id,
    module: 'party-imports',
    metadata: { publisherId, publisherDisplayId: publisher.displayId, fileName: created.fileName, counts },
  });
  return created;
}

type ListingMatch = { kind: 'one'; listing: MatchedListing } | { kind: 'many'; count: number } | { kind: 'none' };

/** displayId, then externalRef, then exact title (case-insensitive) — in that order. */
function listingResolver(own: MatchedListing[], refs: Map<string, string>): (reference: string) => ListingMatch {
  const byId = new Map(own.map((listing) => [listing.id, listing]));
  const byDisplayId = new Map(own.flatMap((listing) => (listing.displayId ? [[listing.displayId.toLowerCase(), listing] as const] : [])));
  const byTitle = new Map<string, MatchedListing[]>();
  for (const listing of own) {
    const key = listing.title.trim().toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), listing]);
  }
  return (reference) => {
    const wanted = reference.trim();
    const byDisplay = byDisplayId.get(wanted.toLowerCase());
    if (byDisplay) return { kind: 'one', listing: byDisplay };
    const refId = refs.get(wanted);
    const byRef = refId ? byId.get(refId) : undefined;
    if (byRef) return { kind: 'one', listing: byRef };
    const titled = byTitle.get(wanted.toLowerCase()) ?? [];
    if (titled.length === 1) return { kind: 'one', listing: titled[0]! };
    if (titled.length > 1) return { kind: 'many', count: titled.length };
    return { kind: 'none' };
  };
}

/* ── RATE_CARD: commit ─────────────────────────────────────────────────── */

/**
 * The second step for a rate card — per row, resumable. Each rate is set
 * through `listings.updateListing`, the door a typed rate goes through: the
 * listings repository stamps `ratePerDaySetAt`, the surge state is recorded,
 * the loop is re-checked. The reprice is audited per listing as
 * `LISTING_REPRICED_BY_IMPORT` with the before and after; a manual edit on
 * the console writes no reprice-log row and opens no price case, and neither
 * does this — the below-floor rate is warned about and the publish gate stays
 * the guard. A listing already at the rate since validation is SKIPPED.
 */
export async function commitRateCardImport(id: string, actor: ListingActor, byUserId: string, req?: Request) {
  const found = await getImport('rate-card', id);
  const publisherId = found.publisherId;
  if (!publisherId) throw new ApiError(409, 'CONFLICT', 'This import names no publisher');
  await requirePublisher(publisherId, actor);
  if (found.status !== 'VALIDATED') {
    throw new ApiError(409, 'CONFLICT', found.status === 'COMMITTED' ? 'This import has already been committed' : 'This import was revoked');
  }

  const actionable = found.rows.filter((row) => {
    const data = row.data as RowData;
    return data.plan && (!data.result || data.result.action === 'FAILED');
  });
  const own = await repository.listPublisherListings(publisherId);
  const ownById = new Map(own.map((listing) => [listing.id, listing]));
  const now = new Date();
  const results = new Map<string, { result: RowResult; outcome: PartyImportOutcome }>();

  for (const row of actionable) {
    const data = row.data as RowData;
    const plan = data.plan as RatePlan;
    const stamp = async (result: RowResult, outcome: PartyImportOutcome | undefined, message?: string | null) => {
      await repository.stampRow(row.id, { data: { ...data, result }, targetId: result.targetId, ...(outcome ? { outcome } : {}), ...(message !== undefined ? { message } : {}) });
      results.set(row.id, { result, outcome: outcome ?? row.outcome });
    };

    try {
      const listing = ownById.get(plan.targetId);
      if (!listing) {
        await stamp({ action: 'SKIPPED', targetId: null, at: now.toISOString() }, 'SKIPPED', `Listing ${plan.targetId} is no longer on the platform; nothing done`);
        continue;
      }
      const rateUnchanged = listing.ratePerDay !== null && new Decimal(listing.ratePerDay).equals(new Decimal(plan.ratePerDay));
      const slotsUnchanged = plan.slotsTotal === undefined || plan.slotsTotal === listing.slotsTotal;
      if (rateUnchanged && slotsUnchanged) {
        await stamp({ action: 'SKIPPED', targetId: listing.id, at: now.toISOString() }, 'SKIPPED', `${labelOf(listing)} is already at ${plan.ratePerDay}/day (set since validation); nothing done`);
        continue;
      }
      await updateListing(listing.id, {
        ...(rateUnchanged ? {} : { ratePerDay: plan.ratePerDay }),
        ...(plan.slotsTotal !== undefined && !slotsUnchanged ? { slotsTotal: plan.slotsTotal } : {}),
      });
      await logActivity(byUserId, 'LISTING_REPRICED_BY_IMPORT', {
        req,
        module: 'party-imports',
        targetType: 'Listing',
        targetId: listing.id,
        diff: auditDiff({ ratePerDay: listing.ratePerDay, ...(plan.slotsTotal !== undefined ? { slotsTotal: listing.slotsTotal } : {}) }, { ratePerDay: plan.ratePerDay, ...(plan.slotsTotal !== undefined ? { slotsTotal: plan.slotsTotal } : {}) }),
        metadata: { importId: id, rowNumber: row.rowNumber, source: 'import', publisherId, from: listing.ratePerDay, to: plan.ratePerDay, warnings: plan.warnings },
      });
      // A WARNING row keeps its outcome: the report still shows what ops were told.
      await stamp({ action: 'MERGED', targetId: listing.id, at: now.toISOString() }, row.outcome === 'WARNING' ? undefined : 'MERGED');
    } catch (err) {
      if (!isApiError(err)) throw err;
      await stamp({ action: 'FAILED', targetId: null, at: now.toISOString() }, 'INVALID', `Not set: ${err.message}`);
    }
  }

  const counts = countResults(found.rows, results);
  const committed = await repository.finishCommit(id, counts, now);
  await logActivity(byUserId, 'RATE_CARD_IMPORT_COMMITTED', {
    req,
    targetType: 'PartyImport',
    targetId: id,
    module: 'party-imports',
    metadata: { publisherId, fileName: committed.fileName, counts },
  });
  return committed;
}
