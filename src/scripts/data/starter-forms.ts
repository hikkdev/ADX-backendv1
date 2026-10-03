import type { FormAudience, FormDestination, LayoutSurface } from '../../shared/database';
import type { FormDefinition } from '../../modules/forms';
import type { Block } from '../../modules/layouts';
import { stableBlockId } from '../../modules/layouts/block-registry';

/**
 * FM-2 (28 Sep 2026): the four starter forms, and where each goes on the
 * website.
 *
 * Content › Forms was empty, and the owner asked why. The platform's own
 * forms (the listing wizard, onboarding, the job checklist, referrals, …)
 * are fixed flows that write a listing, a verification, a job or a lead, so
 * they live where that record lives. The website had no general enquiry
 * form at all. These four are the questions a visitor most often has,
 * written once here and handed to the forms desk as DRAFTS — the owner
 * reads them, edits them in the builder and publishes them; this file
 * never publishes anything.
 *
 * Each is held to the builder's own rules (`validateDefinition`), and each
 * LEAD form asks for a phone, since the lead hunt's inbound door needs one.
 */

export type StarterForm = {
  key: string;
  title: string;
  description: string;
  destination: FormDestination;
  leadSide: 'PUBLISHER' | 'ADVERTISER' | null;
  audience: FormAudience;
  definition: FormDefinition;
};

/** The tick-box line every lead form carries — plain words, one purpose. */
const LEAD_CONSENT = 'I agree that ADX may call or email me about this, and use these details for nothing else.';

export const STARTER_FORMS: readonly StarterForm[] = [
  {
    key: 'contact-adx',
    title: 'Contact ADX',
    description: 'A question about a booking, a payment, a listing or an account — it reaches the ADX support team as a ticket.',
    destination: 'SUPPORT',
    leadSide: null,
    audience: 'PUBLIC',
    definition: {
      screens: [
        {
          key: 'main',
          fields: [
            { id: 'name', kind: 'text', label: 'Your name', required: true, maxLength: 120 },
            { id: 'email', kind: 'email', label: 'Email', required: true, placeholder: 'you@example.com' },
            { id: 'phone', kind: 'phone', label: 'Phone', placeholder: 'If a call is easier' },
            {
              id: 'topic',
              kind: 'select',
              label: 'What is it about?',
              options: [
                { value: 'booking', label: 'A booking' },
                { value: 'payments', label: 'Payments' },
                { value: 'listing', label: 'My listing' },
                { value: 'account', label: 'My account' },
                { value: 'other', label: 'Something else' },
              ],
            },
            { id: 'message', kind: 'textarea', label: 'Your message', required: true, maxLength: 2000 },
          ],
        },
      ],
      submitLabel: 'Send',
      successMessage: 'Thanks — the ADX team will write back within one working day.',
      consentText: 'I agree that ADX may use these details to answer this message, and for nothing else.',
      contactMap: { name: 'name', email: 'email', phone: 'phone' },
    },
  },
  {
    key: 'advertise-with-us',
    title: 'Advertise with us',
    description: 'A business that wants to advertise — it joins the advertiser pipeline in Leads.',
    destination: 'LEAD',
    leadSide: 'ADVERTISER',
    audience: 'PUBLIC',
    definition: {
      screens: [
        {
          key: 'main',
          fields: [
            { id: 'name', kind: 'text', label: 'Your name', maxLength: 120 },
            { id: 'company', kind: 'text', label: 'Company or brand', maxLength: 120 },
            { id: 'email', kind: 'email', label: 'Email', placeholder: 'you@company.com' },
            { id: 'phone', kind: 'phone', label: 'Phone', required: true },
            { id: 'city', kind: 'city', label: 'Where do you want to advertise?' },
            {
              id: 'budget',
              kind: 'select',
              label: 'Budget',
              options: [
                { value: 'under_25k', label: 'Under ₹25,000' },
                { value: 'from_25k_to_1l', label: '₹25,000 – ₹1,00,000' },
                { value: 'from_1l_to_5l', label: '₹1,00,000 – ₹5,00,000' },
                { value: 'above_5l', label: 'Above ₹5,00,000' },
                { value: 'not_sure', label: 'Not sure yet' },
              ],
            },
            { id: 'when', kind: 'date', label: 'When would you like to start?' },
            { id: 'message', kind: 'textarea', label: 'Anything else we should know?', maxLength: 2000 },
          ],
        },
      ],
      submitLabel: 'Send',
      successMessage: 'Thanks — someone from the ADX team will call you soon to plan it with you.',
      consentText: LEAD_CONSENT,
      contactMap: { name: 'name', email: 'email', phone: 'phone' },
    },
  },
  {
    key: 'list-your-space',
    title: 'List your space',
    description: 'Somebody with a space to rent out for advertising — it joins the publisher pipeline in Leads.',
    destination: 'LEAD',
    leadSide: 'PUBLISHER',
    audience: 'PUBLIC',
    definition: {
      screens: [
        {
          key: 'main',
          fields: [
            { id: 'name', kind: 'text', label: 'Your name', maxLength: 120 },
            { id: 'phone', kind: 'phone', label: 'Phone', required: true },
            { id: 'email', kind: 'email', label: 'Email', placeholder: 'you@example.com' },
            { id: 'city', kind: 'city', label: 'City', required: true },
            { id: 'category', kind: 'category', label: 'What kind of space is it?' },
            { id: 'location', kind: 'location', label: 'Where is it? Drop a pin on the map' },
            { id: 'message', kind: 'textarea', label: 'Tell us about it', maxLength: 2000 },
          ],
        },
      ],
      submitLabel: 'Send',
      successMessage: 'Thanks — someone from the ADX team will call you soon about listing your space.',
      consentText: LEAD_CONSENT,
      contactMap: { name: 'name', email: 'email', phone: 'phone' },
    },
  },
  {
    key: 'promote-your-event',
    title: 'Promote your event',
    description: 'An organiser who wants an event promoted — it joins the advertiser pipeline in Leads.',
    destination: 'LEAD',
    leadSide: 'ADVERTISER',
    audience: 'PUBLIC',
    definition: {
      screens: [
        {
          key: 'main',
          fields: [
            { id: 'event_name', kind: 'text', label: 'Event name', maxLength: 120 },
            { id: 'organiser', kind: 'text', label: 'Organiser', maxLength: 120 },
            { id: 'email', kind: 'email', label: 'Email', placeholder: 'you@example.com' },
            { id: 'phone', kind: 'phone', label: 'Phone', required: true },
            { id: 'event_date', kind: 'date', label: 'Event date' },
            { id: 'city', kind: 'city', label: 'City' },
            { id: 'venue', kind: 'location', label: 'Where is the event? Drop a pin on the map' },
            { id: 'promotion', kind: 'textarea', label: 'What do you want promoted?', maxLength: 2000 },
          ],
        },
      ],
      submitLabel: 'Send',
      successMessage: 'Thanks — someone from the ADX team will call you soon about promoting your event.',
      consentText: LEAD_CONSENT,
      contactMap: { name: 'organiser', email: 'email', phone: 'phone' },
    },
  },
];

/** One form block to put on a page: which form, its heading, and the section it follows (`null`: the end of the page). */
export type StarterPlacement = { formKey: string; heading: string; after: string | null };

/**
 * Where the four go. A form block draws nothing until its form is
 * published, so a page carrying one is safe before then — and these are
 * drafts anyway, published by the owner or not at all.
 */
export const STARTER_PLACEMENTS: readonly { surface: LayoutSurface; blocks: readonly StarterPlacement[] }[] = [
  { surface: 'WEB_HELP', blocks: [{ formKey: 'contact-adx', heading: 'Write to us', after: 'help_contact' }] },
  {
    surface: 'WEB_ADVERTISE',
    blocks: [
      { formKey: 'advertise-with-us', heading: 'Advertise with us', after: 'advertise_hero' },
      { formKey: 'promote-your-event', heading: 'Promote your event', after: null },
    ],
  },
  { surface: 'WEB_PUBLISHERS', blocks: [{ formKey: 'list-your-space', heading: 'List your space', after: 'publishers_steps' }] },
];

/** The form block for a starter form on a surface — its id stable, so the same run always writes the same block. */
export function starterFormBlock(surface: LayoutSurface, placement: StarterPlacement): Block {
  return { id: stableBlockId(surface, `form:${placement.formKey}`), type: 'form', props: { formKey: placement.formKey, heading: placement.heading } };
}

export type Placed = {
  blocks: Block[];
  /** The forms put on the page, each with the section it follows (`null`: the end) and whether the section it wanted was missing. */
  added: { formKey: string; after: string | null; anchorMissing: boolean }[];
  /** Forms whose block the page already carries — left where the owner put them. */
  present: string[];
};

/**
 * The page's blocks with the starter forms added: each after its section
 * when the page still has that section, else at the end; a form the page
 * already carries (a block naming its key, wherever it sits) is not added
 * again. Nothing already on the page moves or changes.
 */
export function placeStarterForms(surface: LayoutSurface, base: readonly Block[], placements: readonly StarterPlacement[]): Placed {
  const blocks = [...base];
  const added: Placed['added'] = [];
  const present: string[] = [];
  const carries = (formKey: string) => blocks.some((block) => block.type === 'form' && (block.props as { formKey?: unknown }).formKey === formKey);
  for (const placement of placements) {
    if (carries(placement.formKey)) {
      present.push(placement.formKey);
      continue;
    }
    const block = starterFormBlock(surface, placement);
    const anchor = placement.after === null ? -1 : blocks.findIndex((candidate) => candidate.type === placement.after);
    if (anchor === -1) blocks.push(block);
    else blocks.splice(anchor + 1, 0, block);
    added.push({ formKey: placement.formKey, after: anchor === -1 ? null : placement.after, anchorMissing: placement.after !== null && anchor === -1 });
  }
  return { blocks, added, present };
}
