import { ApiError } from '../../shared/errors';
import { prismaAdvertisementRepository as repository } from './prisma-advertisements.repository';
import { canAccess, visibilityFilter, type Caller } from './advertisements.policy';
import type { CreateAdvertisementInput, UpdateAdvertisementInput } from './advertisements.schema';

export async function listAdvertisements(
  caller: Caller,
  opts: { page: number; pageSize: number; advertiserId?: string },
) {
  const where = visibilityFilter(caller, opts.advertiserId);
  const { items, total } = await repository.findPage(where, opts.page, opts.pageSize);
  return {
    items,
    meta: {
      page: opts.page,
      pageSize: opts.pageSize,
      total,
      totalPages: Math.ceil(total / opts.pageSize),
    },
  };
}

/**
 * Loads an advertisement the caller is allowed to see, or throws 404.
 * An advertisement that exists but belongs to another advertiser is reported as
 * missing, not forbidden.
 */
export async function getAccessibleAdvertisement(id: string, caller: Caller) {
  const advertisement = await repository.findById(id);
  if (!canAccess(caller, advertisement)) {
    throw new ApiError(404, 'NOT_FOUND', 'Advertisement not found');
  }
  return advertisement!;
}

export async function createAdvertisement(caller: Caller, input: CreateAdvertisementInput) {
  const { advertiserId: requestedAdvertiserId, ...rest } = input;
  if (requestedAdvertiserId && !caller.isAdmin) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Only admins can create an advertisement on behalf of another advertiser',
    );
  }
  return repository.create({ advertiserId: requestedAdvertiserId ?? caller.userId, ...rest });
}

export async function updateAdvertisement(
  id: string,
  caller: Caller,
  data: UpdateAdvertisementInput,
) {
  await getAccessibleAdvertisement(id, caller);
  return repository.update(id, data);
}

export async function deleteAdvertisement(id: string, caller: Caller) {
  await getAccessibleAdvertisement(id, caller);
  await repository.remove(id);
}
