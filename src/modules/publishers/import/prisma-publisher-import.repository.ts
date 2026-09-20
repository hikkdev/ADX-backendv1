import { type Gender, Prisma, prisma } from '../../../shared/database';
import type { PublisherImportStatus, PublisherType } from '../../../shared/database';
import type {
  CommitAction,
  ImportCounts,
  ImportPublisherFields,
  NewImportRow,
  PublisherImportRepository,
} from './publisher-import.repository';

const matchSelect = {
  id: true,
  displayId: true,
  mobile: true,
  name: true,
  email: true,
  type: true,
  gstin: true,
  address: true,
  city: true,
  state: true,
  contactName: true,
  contactMobile: true,
  contactEmail: true,
  kyc: { select: { panNumber: true } },
} as const;

const withRows = { rows: { orderBy: { rowNumber: 'asc' as const } } } as const;

/** The publisher columns out of an import row's fields; `panNumber` is the KYC row's. */
function publisherColumns(fields: ImportPublisherFields) {
  // QR-13: the person's columns go to the User row, not the publisher's.
  const { panNumber: _pan, type, firstName: _f, lastName: _l, dateOfBirth: _d, gender: _g, ...rest } = fields;
  return { ...rest, ...(type ? { type: type as PublisherType } : {}) };
}

/** QR-13: the four basics the readiness rule counts — with them in, an imported onboarding opens complete. */
function basicsIn(fields: ImportPublisherFields & { name: string }): boolean {
  return Boolean(fields.name && fields.email && fields.address && fields.dateOfBirth);
}

/**
 * QR-13: the account an imported row signs in as — opened with the PUBLISHER
 * role, or adopted when the number already has one (the person's fields
 * filled where empty, the role granted). Inside the commit's transaction.
 */
async function ensureAccountTx(
  tx: Prisma.TransactionClient,
  input: { mobile: string; displayId: string; name: string; email?: string; firstName?: string; lastName?: string; dateOfBirth?: string; gender?: string },
): Promise<string> {
  const dateOfBirth = input.dateOfBirth ? new Date(`${input.dateOfBirth}T00:00:00.000Z`) : undefined;
  const gender = input.gender as Gender | undefined;
  const existing = await tx.user.findUnique({ where: { mobile: input.mobile }, include: { roles: { select: { role: true } } } });
  if (existing) {
    const fill: Record<string, unknown> = {};
    if (existing.firstName === null && input.firstName !== undefined) fill['firstName'] = input.firstName;
    if (existing.lastName === null && input.lastName !== undefined) fill['lastName'] = input.lastName;
    if (existing.dateOfBirth === null && dateOfBirth !== undefined) fill['dateOfBirth'] = dateOfBirth;
    if (existing.gender === null && gender !== undefined) fill['gender'] = gender;
    if (existing.name === null) fill['name'] = input.name;
    if (existing.email === null && input.email !== undefined) fill['email'] = input.email;
    if (!existing.roles.some((r) => r.role === 'PUBLISHER')) fill['roles'] = { create: { role: 'PUBLISHER' } };
    if (Object.keys(fill).length > 0) await tx.user.update({ where: { id: existing.id }, data: fill });
    return existing.id;
  }
  const created = await tx.user.create({
    data: {
      mobile: input.mobile,
      displayId: input.displayId,
      name: input.name,
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
      ...(dateOfBirth !== undefined ? { dateOfBirth } : {}),
      ...(gender !== undefined ? { gender } : {}),
      roles: { create: { role: 'PUBLISHER' } },
    },
    select: { id: true },
  });
  return created.id;
}

export const prismaPublisherImportRepository: PublisherImportRepository = {
  findPublishersByMobiles(mobiles: string[]) {
    if (mobiles.length === 0) return Promise.resolve([]);
    return prisma.publisher.findMany({ where: { mobile: { in: mobiles } }, select: matchSelect });
  },

  findPublishersByPans(pans: string[]) {
    if (pans.length === 0) return Promise.resolve([]);
    return prisma.publisher.findMany({ where: { kyc: { is: { panNumber: { in: pans } } } }, select: matchSelect });
  },

  createImport({ fileName, note, uploadedById, rows, counts }) {
    return prisma.publisherImport.create({
      data: {
        fileName,
        note,
        uploadedById,
        status: 'VALIDATED',
        ...counts,
        rows: {
          create: rows.map((row) => ({
            rowNumber: row.rowNumber,
            data: row.data as Prisma.InputJsonValue,
            outcome: row.outcome,
            publisherId: row.publisherId,
            message: row.message,
          })),
        },
      },
      include: withRows,
    });
  },

  listImports() {
    return prisma.publisherImport.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  },

  findImport(id: string) {
    return prisma.publisherImport.findUnique({ where: { id }, include: withRows });
  },

  commitImport(id: string, actions: CommitAction[], committedAt: Date) {
    // One transaction, deliberately: half a book on the platform is worse
    // than none, and a row stamped with a publisher that was never created
    // is a lie the report would repeat.
    return prisma.$transaction(
      async (tx) => {
        let created = 0;
        let merged = 0;

        for (const action of actions) {
          if (action.action === 'CREATE') {
            const { mobile, name, displayId, ...fields } = action.publisher;
            // Validation and commit are two requests; a publisher opened in
            // between with this number is merged into rather than duplicated.
            const raced = await tx.publisher.findUnique({ where: { mobile }, select: matchSelect });
            if (raced) {
              const fill = blanksOf(raced, { name, ...fields });
              await mergeInto(tx, raced.id, fill, action.cityId);
              await tx.publisherImportRow.update({ where: { id: action.rowId }, data: { publisherId: raced.id, outcome: 'MERGED', message: 'Merged: this number joined the book after validation' } });
              merged += 1;
              continue;
            }
            // QR-13: a row that names the person opens (or adopts) their account, and
            // with every basic in the onboarding is complete the moment it lands.
            const userId = action.account
              ? await ensureAccountTx(tx, {
                  mobile,
                  displayId: action.account.displayId,
                  name: `${fields.firstName ?? ''} ${fields.lastName ?? ''}`.trim() || name,
                  ...(fields.email !== undefined ? { email: fields.email } : {}),
                  ...(fields.firstName !== undefined ? { firstName: fields.firstName } : {}),
                  ...(fields.lastName !== undefined ? { lastName: fields.lastName } : {}),
                  ...(fields.dateOfBirth !== undefined ? { dateOfBirth: fields.dateOfBirth } : {}),
                  ...(fields.gender !== undefined ? { gender: fields.gender } : {}),
                })
              : null;
            const complete = userId !== null && basicsIn({ ...fields, name });
            const publisher = await tx.publisher.create({
              data: {
                mobile,
                name,
                displayId,
                ...publisherColumns(fields),
                // Lot X-B: the key beside the typed city.
                ...(fields.city !== undefined ? { cityId: action.cityId ?? null } : {}),
                agentId: null,
                ...(userId !== null ? { userId } : {}),
                // QR-14: the door.
                ...(action.onboardedBy ? { onboardedVia: 'IMPORT' as const, onboardedById: action.onboardedBy.userId, onboardedByRole: action.onboardedBy.role, onboardedAt: committedAt } : {}),
                kycStatus: 'PENDING',
                onboardingStatus: complete ? 'ONBOARDING_COMPLETE' : 'PENDING_ONBOARDING',
                ...(complete ? { activatedAt: new Date() } : {}),
                kyc: { create: { status: 'PENDING', ...(fields.panNumber ? { panNumber: fields.panNumber } : {}) } },
              },
              select: { id: true },
            });
            await tx.publisherImportRow.update({ where: { id: action.rowId }, data: { publisherId: publisher.id } });
            created += 1;
          } else {
            await mergeInto(tx, action.publisherId, action.fill, action.cityId);
            await tx.publisherImportRow.update({ where: { id: action.rowId }, data: { publisherId: action.publisherId } });
            merged += 1;
          }
        }

        return tx.publisherImport.update({
          where: { id },
          data: { status: 'COMMITTED', committedAt, createdCount: created, mergedCount: merged },
          include: withRows,
        });
      },
      { timeout: 120_000 },
    );
  },

  setStatus(id: string, status: PublisherImportStatus) {
    return prisma.publisherImport.update({ where: { id }, data: { status }, include: withRows });
  },
};

type Tx = Prisma.TransactionClient;
type Matched = { [K in keyof ImportPublisherFields]: string | null } & { kyc: { panNumber: string | null } | null };

/** The fields of `incoming` the publisher does not already hold. */
function blanksOf(publisher: Matched, incoming: ImportPublisherFields): ImportPublisherFields {
  const fill: ImportPublisherFields = {};
  for (const [key, value] of Object.entries(incoming) as [keyof ImportPublisherFields, unknown][]) {
    if (value === undefined) continue;
    // QR-13: the person's columns and the pin are not the publisher row's; a race-merge leaves them.
    if (['firstName', 'lastName', 'dateOfBirth', 'gender', 'latitude', 'longitude'].includes(key)) continue;
    const current = key === 'panNumber' ? publisher.kyc?.panNumber : publisher[key as keyof Matched];
    if (current === null || current === undefined || current === '') fill[key] = value as never;
  }
  return fill;
}

/** Writes only what a merge decided to fill; the PAN goes to the KYC row, created if the publisher has none. Lot X-B: a filled city carries its key. */
async function mergeInto(tx: Tx, publisherId: string, fill: ImportPublisherFields, cityId?: string | null): Promise<void> {
  const { panNumber, ...rest } = fill;
  if (Object.keys(rest).length) {
    await tx.publisher.update({ where: { id: publisherId }, data: { ...publisherColumns(rest), ...(rest.city !== undefined ? { cityId: cityId ?? null } : {}) } });
  }
  if (panNumber) {
    await tx.publisherKyc.upsert({
      where: { publisherId },
      update: { panNumber },
      create: { publisherId, panNumber, status: 'PENDING' },
    });
  }
}
