/**
 * Custom fields — CF-1 (27 Sep 2026): extra questions on a record type.
 *
 * A definition per publisher / advertiser / listing / lead question, a value
 * per record — kept in `CustomFieldValue`, never in the record's columns.
 * The desk defines and answers; the record's owner answers what is marked
 * `editableByOwner`, on their own record only; a lead has no owner.
 */
export { customFieldRouter, appCustomFieldRouter } from './custom-fields.routes';
export { ENTITY_GROUP } from './custom-fields.schema';
export { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_KINDS, KIND_LABEL } from './custom-fields.schema';
export type { CustomFieldEntityKey, CustomFieldKind } from './custom-fields.schema';
export { listDefs, valuesFor } from './custom-fields.service';
export type { DefView, ValuesView, FieldWithValue } from './custom-fields.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
