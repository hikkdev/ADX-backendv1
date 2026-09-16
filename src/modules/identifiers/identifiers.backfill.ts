import { allocateIdentifier } from './identifiers.service';
import { prismaIdentifiersRepository as repository } from './prisma-identifiers.repository';

/**
 * Gives existing publishers the identifier they would have received.
 *
 * Processed oldest first and issued against each publisher's own `createdAt`,
 * not today, so PUB-1909-2601 genuinely means "joined 19 September 2026, first
 * that day" for rows that predate the feature. Issuing them all against today's
 * date would be quicker and would make every identifier a lie.
 *
 * Sequential on purpose: the allocator is atomic, but ordering only comes out
 * right if the oldest publisher asks for its number first.
 *
 * Safe to run repeatedly — it only ever selects rows still missing one.
 */
export async function backfillPublisherIdentifiers(batchSize = 500): Promise<{
  assigned: number;
  remaining: number;
}> {
  const pending = await repository.publishersMissingIdentifier(batchSize);

  let assigned = 0;
  for (const publisher of pending) {
    const displayId = await allocateIdentifier('PUBLISHER', publisher.createdAt);
    await repository.setPublisherIdentifier(publisher.id, displayId);
    assigned += 1;
  }

  const remaining = (await repository.publishersMissingIdentifier(1)).length;
  return { assigned, remaining };
}
