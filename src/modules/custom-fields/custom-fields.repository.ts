import type { CustomFieldDef, CustomFieldEntity, CustomFieldValue, Prisma } from '../../shared/database';

export type { CustomFieldDef, CustomFieldValue, CustomFieldEntity };

export type DefOption = { value: string; label: string };

export type DefPatch = Partial<{
  label: string;
  /** `null` stores a JSON null — the repository maps it; the service never touches the Prisma value namespace. */
  options: DefOption[] | null;
  hint: string | null;
  required: boolean;
  showOnDesk: boolean;
  showInApps: boolean;
  showOnWebsite: boolean;
  editableByOwner: boolean;
  sortOrder: number;
  archivedAt: Date | null;
}>;

export interface CustomFieldsRepository {
  listDefs(filter: { entity?: CustomFieldEntity | undefined; includeArchived: boolean }): Promise<CustomFieldDef[]>;
  defById(id: string): Promise<CustomFieldDef | null>;
  defByKey(entity: CustomFieldEntity, key: string): Promise<CustomFieldDef | null>;
  createDef(data: {
    entity: CustomFieldEntity;
    key: string;
    label: string;
    kind: string;
    options: DefOption[] | null;
    hint: string | null;
    required: boolean;
    showOnDesk: boolean;
    showInApps: boolean;
    showOnWebsite: boolean;
    editableByOwner: boolean;
    sortOrder: number;
    createdByUserId: string;
  }): Promise<CustomFieldDef>;
  updateDef(id: string, data: DefPatch): Promise<CustomFieldDef>;
  /** Whether the record a value hangs on exists — the publisher, advertiser, listing or lead by id. */
  entityExists(entity: CustomFieldEntity, entityId: string): Promise<boolean>;
  valuesFor(entity: CustomFieldEntity, entityId: string): Promise<CustomFieldValue[]>;
  /** Writes each value (create or replace) and deletes each cleared key, in one transaction. */
  writeValues(
    entity: CustomFieldEntity,
    entityId: string,
    writes: { defId: string; value: Prisma.InputJsonValue }[],
    clears: string[],
    byUserId: string,
  ): Promise<void>;
}
