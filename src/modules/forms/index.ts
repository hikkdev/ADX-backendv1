/**
 * Forms — FM-1 (27 Sep 2026): the form builder and its door.
 *
 * The owner: forms get "their OWN builder (Content › Forms) built on the flow
 * field vocabulary but never writing into a platform record". A form's
 * questions are versioned draft → published with history and restore; its
 * answers land in `FormSubmission` and, by the form's destination, in a lead
 * (the lead hunt's inbound door), a support ticket, or nowhere else.
 */
import { registerFormResolver } from '../layouts';
import { publishedFormView } from './forms.service';

export { formRouter, appFormRouter } from './forms.routes';
export { publishedFormView } from './forms.service';
export type { PublishedFormView, FormSummary, FormVersionView } from './forms.service';
export { FIELD_KINDS, FIELD_KIND_META, fieldKinds, validateDefinition, definitionSchema } from './form-schema';
export type { FormDefinition, FormField, FormScreen, FieldKind } from './form-schema';
export { validateAnswers, answerLines } from './form-answers';

/**
 * The port a page's `form` block reads a published form through, so
 * `layouts` never imports `forms`: registered at module load with the same
 * view `GET /app/forms/:key` answers; `null` when nothing is published or
 * the form is archived, which the clients draw as nothing.
 */
registerFormResolver((key) => publishedFormView(key));

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
