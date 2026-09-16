import { Prisma, prisma } from '../../../shared/database';
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
  const { panNumber: _pan, type, ...rest } = fields;
  return { ...rest, ...(type ? { type: type as PublisherType } : {}) };
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
            const publisher = await tx.publisher.create({
              data: {
                mobile,
                name,
                displayId,
                ...publisherColumns(fields),
                // Lot X-B: the key beside the typed city.
                ...(fields.city !== undefined ? { cityId: action.cityId ?? null } : {}),
                agentId: null,
                kycStatus: 'PENDING',
                onboardingStatus: 'PENDING_ONBOARDING',
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
  for (const [key, value] of Object.entries(incoming) as [keyof ImportPublisherFields, string | undefined][]) {
    if (value === undefined) continue;
    const current = key === 'panNumber' ? publisher.kyc?.panNumber : publisher[key];
    if (current === null || current === undefined || current === '') fill[key] = value;
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
