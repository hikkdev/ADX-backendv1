import type { EmploymentType, KycEntityType } from '../database';

/**
 * Phase D (the owner, 1 Oct 2026) — which Digio KYC workflow a request names.
 *
 * Digio verifies a person or a business through a workflow built in its
 * dashboard, and the request must name one by `template_id`. The owner built
 * twenty-five in Digio PRODUCTION ("ADX Digio KYC Workflows"): one for agents,
 * one per legal form for publishers, advertisers and print partners, two for
 * employees and three for spots. Their ids ship here as the defaults, copied
 * from the owner's document; Settings › Integrations › Digio may override any
 * of them (`kyc.workflowTemplates` on the integrations row) without a deploy.
 *
 * The owner's routing decisions (1 Oct 2026):
 *   - sales agents use the field agent workflow — one AGENT key for both;
 *   - a political publisher verifies on the publisher "Other entities"
 *     workflow (advertisers have their own political one);
 *   - part-time employees go through the full-time workflow until the owner
 *     says otherwise; contract staff and interns share one.
 * The SPOT keys are for verifying a spot when it is listed — not wired yet
 * (Phase D §6 waits on Digio's response format), listed so the settings card
 * shows all twenty-five.
 *
 * Imports nothing from a module: the KYC services of five modules ask it, and
 * the integrations read draws the card from it.
 */

/** Who a Digio KYC request verifies. */
export const DIGIO_KYC_PARTIES = ['PUBLISHER', 'ADVERTISER', 'AGENT', 'PRINT_PARTNER', 'EMPLOYEE'] as const;
export type DigioKycParty = (typeof DIGIO_KYC_PARTIES)[number];

/** The twenty-five workflows and the template id each defaults to — exact strings from the owner's document. */
export const DEFAULT_DIGIO_WORKFLOW_TEMPLATES = {
  AGENT: 'KTP2610010306408243IR71R3AROTQNN',
  'PUBLISHER.INDIVIDUAL': 'KTP261001040743600LJTDRKKQJX52I7',
  'PUBLISHER.SOLE_PROPRIETOR': 'KTP2610010414215107PAQTRCWA15MH9',
  'PUBLISHER.COMPANY': 'KTP261001042249519XAHQ1QZQ8NTSH6',
  'PUBLISHER.LLP_PARTNERSHIP': 'KTP261001043029821KBY5W6MIRT8AH5',
  'PUBLISHER.NON_PROFIT': 'KTP261001043339245CSPZP7VJGDSJJX',
  'PUBLISHER.GOVERNMENT_EDUCATION': 'KTP261001043745628KB5W2BGMLSCS8M',
  'PUBLISHER.OTHER_ENTITY': 'KTP2610010440468859RHQ93W3ZR6H58',
  'ADVERTISER.INDIVIDUAL': 'KTP261001044441631C6LOZYN91JC9NF',
  'ADVERTISER.SOLE_PROPRIETOR': 'KTP261001044723855AH9Y39VDH4S25L',
  'ADVERTISER.COMPANY': 'KTP26100104502784323YQMCV19CW8HM',
  'ADVERTISER.LLP_PARTNERSHIP': 'KTP261001045257491BM49QX1UXNBG2I',
  'ADVERTISER.NON_PROFIT': 'KTP261001050016491512UR8EIKS2D86',
  'ADVERTISER.GOVERNMENT_EDUCATION': 'KTP261001050859618GXOMOZR73XBXJ9',
  'ADVERTISER.OTHER_ENTITY': 'KTP261001051625798GCFAVZBGJ19WUG',
  'ADVERTISER.POLITICAL': 'KTP261001052617020C8K7M6HA846LI6',
  'PRINT_PARTNER.INDIVIDUAL': 'KTP261001060717528VGFNERP3GZXBJU',
  'PRINT_PARTNER.SOLE_PROPRIETOR': 'KTP261001061121621SI1SKKYYE6QSLM',
  'PRINT_PARTNER.COMPANY': 'KTP2610010613526217KEIXUUG4MP2QL',
  'PRINT_PARTNER.LLP_PARTNERSHIP': 'KTP2610010615549436Z42BMRM9OY8BJ',
  'EMPLOYEE.FULL_TIME': 'KTP261001060045852S9A5UOLMEW92VJ',
  'EMPLOYEE.INTERN_CONTRACT': 'KTP26100106044372673RIO8R1PYPPJG',
  'SPOT.TRANSIT': 'KTP261001061911043NJSUULTFQW4D12',
  'SPOT.OUTDOOR': 'KTP261001062202963DV6D3TQZ5QRM1M',
  'SPOT.MEDIA': 'KTP261001062349355CXZ7URFIGSOBVO',
} as const;

export type DigioWorkflowKey = keyof typeof DEFAULT_DIGIO_WORKFLOW_TEMPLATES;
/** The keys in the document's order — the order the settings card lists them in. */
export const DIGIO_WORKFLOW_KEYS = Object.keys(DEFAULT_DIGIO_WORKFLOW_TEMPLATES) as DigioWorkflowKey[];

/**
 * How each workflow reads on the settings card — the owner's own names for
 * the templates in DigiStudio (1 Oct 2026), so a row on the Digio card can
 * be matched to its template there by eye. The legal-form PICKER a person
 * chooses from has its own labels (`shared/kyc-state/entity-type.ts`).
 */
export const DIGIO_WORKFLOW_LABELS: Record<DigioWorkflowKey, string> = {
  AGENT: 'Field Agent (sales agents too)',
  'PUBLISHER.INDIVIDUAL': 'Publisher: Individual',
  'PUBLISHER.SOLE_PROPRIETOR': 'Publisher: Sole Proprietor',
  'PUBLISHER.COMPANY': 'Publisher: Company',
  'PUBLISHER.LLP_PARTNERSHIP': 'Publisher: LLP and Partnership',
  'PUBLISHER.NON_PROFIT': 'Publisher: Non Profit',
  'PUBLISHER.GOVERNMENT_EDUCATION': 'Publisher: Government and Education',
  'PUBLISHER.OTHER_ENTITY': 'Publisher: Other Entities (political too)',
  'ADVERTISER.INDIVIDUAL': 'Advertiser: Individual',
  'ADVERTISER.SOLE_PROPRIETOR': 'Advertiser: Sole Proprietor',
  'ADVERTISER.COMPANY': 'Advertiser: Company',
  'ADVERTISER.LLP_PARTNERSHIP': 'Advertiser: LLP and Partnership',
  'ADVERTISER.NON_PROFIT': 'Advertiser: Non Profit',
  'ADVERTISER.GOVERNMENT_EDUCATION': 'Advertiser: Government and Education',
  'ADVERTISER.OTHER_ENTITY': 'Advertiser: Other Entities',
  'ADVERTISER.POLITICAL': 'Advertiser: Political',
  'PRINT_PARTNER.INDIVIDUAL': 'Print Partner: Individual',
  'PRINT_PARTNER.SOLE_PROPRIETOR': 'Print Partner: Sole Proprietor',
  'PRINT_PARTNER.COMPANY': 'Print Partner: Company',
  'PRINT_PARTNER.LLP_PARTNERSHIP': 'Print Partner: LLP and Partnership',
  'EMPLOYEE.FULL_TIME': 'Employee: Full Time (part time too)',
  'EMPLOYEE.INTERN_CONTRACT': 'Employee: Intern and Contract',
  'SPOT.TRANSIT': 'Spot: Transit Vehicle',
  'SPOT.OUTDOOR': 'Spot: Outdoor',
  'SPOT.MEDIA': 'Spot: Media',
};

/**
 * What a template id looks like — Digio's `KTP…` ids are upper-case letters
 * and digits (the owner's are 32 long); an override is held to the shape so
 * a pasted name or a stray space is refused at the settings form rather than
 * by Digio on every request.
 */
export const DIGIO_TEMPLATE_ID_PATTERN = /^KTP[A-Z0-9]{10,61}$/;

export type DigioWorkflowOverrides = Partial<Record<DigioWorkflowKey, string>>;

export function isDigioWorkflowKey(value: string): value is DigioWorkflowKey {
  return Object.prototype.hasOwnProperty.call(DEFAULT_DIGIO_WORKFLOW_TEMPLATES, value);
}

/**
 * The workflow a request names, or null when there is none to name — a
 * publisher, advertiser or print partner whose entity type is not known yet
 * (the KYC start asks before it gets here), or a legal form the party has no
 * workflow for.
 */
export function workflowKeyFor(input: {
  party: DigioKycParty;
  entityType?: KycEntityType | null | undefined;
  employmentType?: EmploymentType | null | undefined;
}): DigioWorkflowKey | null {
  const { party, entityType, employmentType } = input;
  if (party === 'AGENT') return 'AGENT';
  if (party === 'EMPLOYEE') {
    return employmentType === 'CONTRACT' || employmentType === 'INTERN' ? 'EMPLOYEE.INTERN_CONTRACT' : 'EMPLOYEE.FULL_TIME';
  }
  if (!entityType) return null;
  if (party === 'PUBLISHER' && entityType === 'POLITICAL') return 'PUBLISHER.OTHER_ENTITY';
  const key = `${party}.${entityType}`;
  return isDigioWorkflowKey(key) ? key : null;
}

/** The override for the key when one is set (trimmed, non-empty), else the default. */
export function workflowTemplateId(key: DigioWorkflowKey, overrides?: DigioWorkflowOverrides | null): string {
  const override = overrides?.[key]?.trim();
  return override || DEFAULT_DIGIO_WORKFLOW_TEMPLATES[key];
}

export type DigioWorkflowView = { key: DigioWorkflowKey; label: string; templateId: string; source: 'DEFAULT' | 'OVERRIDE' };

/** All twenty-five as the settings card draws them — the id in force and where it came from. */
export function digioWorkflows(overrides?: DigioWorkflowOverrides | null): DigioWorkflowView[] {
  return DIGIO_WORKFLOW_KEYS.map((key) => {
    const override = overrides?.[key]?.trim();
    return {
      key,
      label: DIGIO_WORKFLOW_LABELS[key],
      templateId: override || DEFAULT_DIGIO_WORKFLOW_TEMPLATES[key],
      source: override ? ('OVERRIDE' as const) : ('DEFAULT' as const),
    };
  });
}
