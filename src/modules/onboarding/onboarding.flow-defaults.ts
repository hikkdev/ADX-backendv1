/**
 * Flow templates the platform ships with.
 *
 * Seeded lazily on read rather than by a migration, so a fresh install and an
 * upgrade both converge without a deploy step. Bump a `version` to roll a
 * change out — see `ensureDefaultFlowTemplates`.
 */
export const defaultFlowTemplates = [
  {
    key: 'publisher-onboarding',
    userType: 'PUBLISHER',
    name: 'Publisher Onboarding',
    description: 'Publisher account setup and KYC capture flow.',
    version: 2,
    steps: [
      { label: 'User Type' },
      { label: 'Account Type' },
      { label: 'Publisher Info' },
      { label: 'Contact Person' },
      { label: 'E-KYC Documents' },
      { label: 'KYC Capture' },
      { label: 'Review' },
    ],
    schema: {
      accountTypes: ['INDIVIDUAL', 'BUSINESS', 'NGO'],
      requiredIdentityFields: ['name', 'businessName', 'mobile', 'contactPersonMobile'],
    },
  },
  {
    key: 'advertiser-onboarding',
    userType: 'ADVERTISER',
    name: 'Advertiser Onboarding',
    description: 'Advertiser brand setup and KYC capture flow.',
    version: 2,
    steps: [
      { label: 'User Type' },
      { label: 'Brand Type' },
      { label: 'Brand Info' },
      { label: 'Contact Person' },
      { label: 'E-KYC Documents' },
      { label: 'KYC Capture' },
      { label: 'Review' },
    ],
    schema: {
      accountTypes: ['SOLO', 'REGISTERED', 'NGO'],
      requiredIdentityFields: ['brandLegalIdentity', 'brandName', 'mobile', 'primaryContactMobile'],
    },
  },
  {
    key: 'partner-onboarding',
    userType: 'PARTNER',
    name: 'Partner Onboarding',
    description: 'External partner onboarding flow.',
    version: 2,
    steps: [
      { label: 'User Type' },
      { label: 'Partner Type' },
      { label: 'Partner Info' },
      { label: 'Contact Person' },
      { label: 'Agreement Docs' },
      { label: 'Commercials' },
      { label: 'Review' },
    ],
    schema: {
      accountTypes: ['CHANNEL', 'TECHNOLOGY', 'STRATEGIC'],
      requiredIdentityFields: ['partnerLegalName', 'partnerDisplayName', 'mobile'],
    },
  },
  // Lot D (Q131): the intake form is the onboarding record for agents and
  // employees. `side` is which market the agent works; the documents are
  // recorded on the KYC twin (`/agent-kyc`, `/employee-kyc`) after approval.
  {
    key: 'agent-onboarding',
    userType: 'AGENT',
    name: 'Agent Onboarding',
    description: 'Field agent intake: identity, territory and the side they work.',
    version: 1,
    steps: [
      { label: 'User Type' },
      { label: 'Side' },
      { label: 'Agent Info' },
      { label: 'Territory' },
      { label: 'KYC Capture' },
      { label: 'Review' },
    ],
    schema: {
      accountTypes: ['PUBLISHER', 'ADVERTISER'],
      requiredIdentityFields: ['name', 'mobile', 'side'],
    },
  },
  {
    key: 'employee-onboarding',
    userType: 'EMPLOYEE',
    name: 'Employee Onboarding',
    description: 'Staff intake: HR record, documents and the optional console login.',
    version: 1,
    steps: [
      { label: 'User Type' },
      { label: 'Employee Info' },
      { label: 'Department' },
      { label: 'HR Documents' },
      { label: 'KYC Capture' },
      { label: 'Console Access' },
      { label: 'Review' },
    ],
    schema: {
      accountTypes: ['FULL_TIME', 'CONTRACT', 'INTERN'],
      requiredIdentityFields: ['name', 'mobile', 'department'],
    },
  },
] as const;
