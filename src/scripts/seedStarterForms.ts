import '../config/load-env';
import { closeDatabase, type LayoutSurface } from '../shared/database';
import { redis } from '../shared/cache';
import { systemUserId } from '../modules/users';
import { createForm, listForms, saveDraft as saveFormDraft } from '../modules/forms/forms.service';
import { validateDefinition } from '../modules/forms/form-schema';
import { assertValidBlocks, assertValidMeta, getSurface, saveDraft as saveLayoutDraft } from '../modules/layouts/layouts.service';
import { STARTER_FORMS, STARTER_PLACEMENTS, placeStarterForms, type StarterForm } from './data/starter-forms';

/**
 * FM-2 (28 Sep 2026): the four starter forms, as DRAFTS, and a draft of each
 * website page that shows one.
 *
 *   npm run seed:starter-forms              write them
 *   npm run seed:starter-forms -- --check   say what would be written, write nothing
 *
 * Everything goes through the desks' own services, so a form is checked
 * exactly as the console's builder checks it (`createForm`, then
 * `saveDraft` with the questions) and a page exactly as the layout desk
 * checks it (`saveDraft` on the surface). Nothing is ever published: the
 * owner reads the drafts, edits them and publishes them from the console.
 *
 * Idempotent, and never over the owner's work:
 * - a form whose key exists — live, draft, archived, edited or not — is left
 *   alone;
 * - a page that already has a draft is left alone (that draft is somebody's
 *   work in progress);
 * - a page that already carries a form's block is not given a second one;
 * - otherwise the draft is the page's live version (its blocks and its SEO),
 *   or its defaults when nothing is live, with the form block after its
 *   section — at the end when the live page no longer has that section.
 *
 * Audited as the system user, through the services' own entries
 * (FORM_CREATED, FORM_DRAFTED, LAYOUT_DRAFTED).
 */

export type FormOutcome = { key: string; title: string; outcome: 'created' | 'would-create' | 'exists'; line: string };
export type PageOutcome = { surface: LayoutSurface; outcome: 'drafted' | 'would-draft' | 'has-draft' | 'already-placed'; line: string };
export type StarterReport = { forms: FormOutcome[]; pages: PageOutcome[] };

const fieldCount = (form: StarterForm) => form.definition.screens.reduce((sum, screen) => sum + screen.fields.length, 0);
const plumbing = (form: StarterForm) => `${form.destination}${form.leadSide ? ` (${form.leadSide})` : ''}, ${form.audience}, ${fieldCount(form)} fields`;

export async function seedStarterForms(options: { check: boolean; actor: { userId: string } }): Promise<StarterReport> {
  const { check, actor } = options;

  // Every definition is checked before anything is written, so a bad one
  // cannot leave a form made with an empty draft behind it.
  for (const form of STARTER_FORMS) validateDefinition(form.definition, form.audience);

  const taken = new Set((await listForms()).map((form) => form.key));
  const forms: FormOutcome[] = [];
  for (const form of STARTER_FORMS) {
    const named = `${form.key} "${form.title}"`;
    if (taken.has(form.key)) {
      forms.push({ key: form.key, title: form.title, outcome: 'exists', line: `${named}: exists — left alone` });
      continue;
    }
    if (check) {
      forms.push({ key: form.key, title: form.title, outcome: 'would-create', line: `${named}: would create — ${plumbing(form)}, as draft v1` });
      continue;
    }
    await createForm({ key: form.key, title: form.title, description: form.description, destination: form.destination, leadSide: form.leadSide, audience: form.audience }, actor);
    const draft = await saveFormDraft(form.key, { definition: form.definition, changeNote: 'Starter form (seed:starter-forms) — read it, edit it, then publish' }, actor);
    forms.push({ key: form.key, title: form.title, outcome: 'created', line: `${named}: created — ${plumbing(form)}, draft v${draft.number}, not published` });
  }

  const pages: PageOutcome[] = [];
  for (const { surface, blocks: placements } of STARTER_PLACEMENTS) {
    const { live, draft, defaults } = await getSurface(surface);
    if (draft) {
      pages.push({ surface, outcome: 'has-draft', line: `${surface}: has a draft (v${draft.number}) — left alone` });
      continue;
    }
    const from = live ? `live v${live.number}` : 'the defaults';
    const placed = placeStarterForms(surface, live ? live.blocks : defaults, placements);
    if (placed.added.length === 0) {
      pages.push({ surface, outcome: 'already-placed', line: `${surface}: ${from} already carries ${placed.present.join(', ')} — left alone` });
      continue;
    }
    const where = placed.added
      .map((add) => `${add.formKey} ${add.after ? `after ${add.after}` : add.anchorMissing ? `at the end (${from} has no ${placements.find((p) => p.formKey === add.formKey)?.after})` : 'at the end'}`)
      .join('; ');
    if (check) {
      await assertValidBlocks(surface, placed.blocks);
      if (live?.meta) await assertValidMeta(live.meta);
      pages.push({ surface, outcome: 'would-draft', line: `${surface}: would save a draft from ${from} — ${where}` });
      continue;
    }
    const saved = await saveLayoutDraft(
      surface,
      {
        blocks: placed.blocks,
        ...(live?.meta ? { meta: live.meta } : {}),
        changeNote: `Starter forms: ${placed.added.map((add) => add.formKey).join(', ')} — drawn once published (seed:starter-forms)`,
      },
      actor,
    );
    pages.push({ surface, outcome: 'drafted', line: `${surface}: draft v${saved.number} saved from ${from} — ${where}; not published` });
  }

  return { forms, pages };
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  // A check writes nothing, so it names nobody — `systemUserId` would make the system user when it is missing.
  const userId = check ? 'check-only' : await systemUserId();
  if (!userId) throw new Error('No system user to write as — run the backend once (or `npm run seed`) so it exists.');
  const report = await seedStarterForms({ check, actor: { userId } });
  console.log(check ? 'Starter forms — check only, nothing written' : 'Starter forms');
  for (const form of report.forms) console.log(`  ${form.line}`);
  console.log(check ? 'Pages — check only, nothing written' : 'Pages');
  for (const page of report.pages) console.log(`  ${page.line}`);
  console.log('Nothing was published. Publish the forms in Content › Forms and the pages in Studio (Content › Pages → Open in Studio) when they read right.');
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabase();
      // The modules above open the shared ioredis client at load; its socket would keep the process alive (seedGeo.ts).
      redis.disconnect();
    });
}
