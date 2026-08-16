import { prisma } from '../lib/prisma';
import { APP_ENUMS } from '../constants/appEnums';

const ONBOARD_FLOW = {
  label: 'Onboarding',
  screens: [
    {
      key: 'select-profile',
      title: 'Select Profile Type',
      subtitle: 'Choose the category that best describes you',
      step: 1,
      totalSteps: 1,
      ctaLabel: 'Continue',
      fields: [
        {
          id: 'profile_type',
          type: 'selectable-cards',
          label: 'Profile Type',
          required: true,
          branching: true,
          options: [
            { id: 'individual', title: 'Individual', description: 'Personal spaces, homes, personal vehicles' },
            { id: 'business', title: 'Business / Agency', description: 'Commercial spaces, fleet, multiple locations' },
            { id: 'ngo', title: 'NGO / Trust', description: 'Non-profit locations, community spaces' },
            { id: 'political', title: 'Political Party', description: 'Party Rallies and Campaigning' },
          ],
        },
      ],
    },
  ],
  branches: {
    individual: {
      id: 'individual', title: 'Individual', description: 'Personal spaces, homes, personal vehicles',
      screens: [
        {
          key: 'screen-1', title: 'Upload Documents',
          subtitle: 'Upload clear front and back images or use Digio for instant verification.',
          step: 1, totalSteps: 3, ctaLabel: 'Save and Continue',
          fields: [
            { type: 'image-upload', id: 'aadhaar', label: 'Aadhaar Card', required: true, dual: true, frontLabel: 'Front', backLabel: 'Back' },
            { type: 'image-upload', id: 'pan', label: 'PAN Card', required: true },
          ],
        },
        {
          key: 'screen-2', title: 'Personal Details',
          subtitle: 'Fill in your personal information as per your ID proof.',
          step: 2, totalSteps: 3, ctaLabel: 'Save and Continue',
          fields: [
            { type: 'text', id: 'full_name', label: 'Full Name', placeholder: 'As per Aadhaar card', required: true },
            { type: 'phone', id: 'mobile', label: 'Mobile Number', required: true },
            { type: 'text', id: 'email', label: 'Email Address', placeholder: 'e.g. name@example.com', keyboardType: 'email-address', autoCapitalize: 'none' },
            { type: 'select', id: 'state', label: 'State', placeholder: 'Select your state', required: true, options: [{ label: 'Karnataka', value: 'KA' }, { label: 'Maharashtra', value: 'MH' }, { label: 'Tamil Nadu', value: 'TN' }, { label: 'Delhi', value: 'DL' }] },
          ],
        },
        {
          key: 'screen-3', title: 'Ad Spot Details',
          subtitle: 'Describe the ad space you are listing.',
          step: 3, totalSteps: 3, ctaLabel: 'Submit',
          fields: [
            { type: 'selectable-cards', id: 'spot_type', label: 'Spot Type', required: true, options: [{ id: 'wall', title: 'Wall / Exterior', description: 'Painted walls, building facades' }, { id: 'vehicle', title: 'Vehicle', description: 'Car, bike, auto wraps' }, { id: 'indoor', title: 'Indoor Display', description: 'Shops, offices, waiting areas' }] },
            { type: 'textarea', id: 'description', label: 'Description', placeholder: 'Describe the location and visibility of your ad spot...' },
            { type: 'slider', id: 'price', label: 'Monthly Price (₹)', min: 500, max: 50000, step: 500 },
            { type: 'switch', id: 'available_now', label: 'Available immediately', description: 'Turn off if the spot is not yet available' },
          ],
        },
      ],
    },
    business: {
      id: 'business', title: 'Business / Agency', description: 'Commercial spaces, fleet, multiple locations',
      screens: [
        {
          key: 'screen-1', title: 'Business Documents',
          subtitle: 'Upload your business registration and GST documents.',
          step: 1, totalSteps: 2, ctaLabel: 'Save and Continue',
          fields: [
            { type: 'image-upload', id: 'gst_certificate', label: 'GST Certificate', required: true },
            { type: 'image-upload', id: 'registration', label: 'Business Registration', required: true },
          ],
        },
        {
          key: 'screen-2', title: 'Business Details',
          subtitle: 'Enter your business information.',
          step: 2, totalSteps: 2, ctaLabel: 'Submit',
          fields: [
            { type: 'text', id: 'business_name', label: 'Business Name', placeholder: 'Registered business name', required: true },
            { type: 'text', id: 'gst_number', label: 'GST Number', placeholder: 'e.g. 29ABCDE1234F1Z5', autoCapitalize: 'characters', required: true },
            { type: 'select', id: 'business_type', label: 'Business Type', placeholder: 'Select type', options: [{ label: 'Sole Proprietorship', value: 'sole' }, { label: 'Partnership', value: 'partnership' }, { label: 'Private Limited', value: 'pvt_ltd' }] },
            { type: 'textarea', id: 'address', label: 'Registered Address', placeholder: 'Full address as per registration', required: true },
          ],
        },
      ],
    },
    ngo: {
      id: 'ngo', title: 'NGO / Trust', description: 'Non-profit locations, community spaces',
      screens: [
        {
          key: 'screen-1', title: 'NGO Details',
          subtitle: 'Enter your organization details.',
          step: 1, totalSteps: 1, ctaLabel: 'Submit',
          fields: [
            { type: 'text', id: 'org_name', label: 'Organization Name', placeholder: 'Registered name', required: true },
            { type: 'text', id: 'reg_number', label: 'Registration Number', placeholder: 'e.g. MH/2020/0012345', required: true },
            { type: 'image-upload', id: 'reg_certificate', label: 'Registration Certificate', required: true },
            { type: 'textarea', id: 'mission', label: 'Mission Statement', placeholder: "Brief description of your organization's mission" },
          ],
        },
      ],
    },
    political: {
      id: 'political', title: 'Political Party', description: 'Party Rallies and Campaigning',
      screens: [
        {
          key: 'screen-1', title: 'Party Details',
          subtitle: 'Enter your political party information.',
          step: 1, totalSteps: 1, ctaLabel: 'Submit',
          fields: [
            { type: 'text', id: 'party_name', label: 'Party Name', placeholder: 'Registered party name', required: true },
            { type: 'image-upload', id: 'ec_certificate', label: 'Election Commission Certificate', required: true },
            { type: 'select', id: 'state', label: 'State / Constituency', placeholder: 'Select state', options: [{ label: 'Karnataka', value: 'KA' }, { label: 'Maharashtra', value: 'MH' }, { label: 'Tamil Nadu', value: 'TN' }, { label: 'Delhi', value: 'DL' }] },
            { type: 'checkbox', id: 'eci_compliance', label: 'ECI Compliance', description: 'I confirm this campaign complies with Election Commission of India guidelines.', required: true },
          ],
        },
      ],
    },
  },
};

const LISTING_FLOW = {
  label: 'Listing',
  screens: [
    {
      key: 'select-category',
      title: 'Select Category',
      subtitle: 'Choose the ad space category for this listing.',
      step: 1, totalSteps: 1, ctaLabel: 'Continue',
      fields: [
        {
          id: 'category',
          type: 'selectable-cards',
          label: 'Category',
          required: true,
          branching: true,
          options: [
            { id: 'indoor', title: 'Indoor', description: 'Malls, lobbies, cinemas, and indoor screens' },
            { id: 'outdoor', title: 'Outdoor', description: 'Billboards, kiosks, and roadside sites' },
            { id: 'transit', title: 'Transit', description: 'Bus shelters, cabs, metro, and airport' },
            { id: 'media', title: 'Media', description: 'DOOH screens, kiosks, and branded media' },
          ],
        },
      ],
    },
  ],
  branches: {
    indoor: {
      id: 'indoor', title: 'Indoor', description: 'Malls, lobbies, cinemas, and indoor screens',
      screens: [
        { key: 'screen-1', title: 'Listing details', subtitle: 'Enter the basic details for your indoor ad space.', step: 1, totalSteps: 5, ctaLabel: 'Continue', fields: [{ type: 'text', id: 'title', label: 'Listing title', placeholder: 'e.g. Mall Lobby Screen', required: true }, { type: 'select', id: 'sub_type', label: 'Space type', placeholder: 'Select type', required: true, options: [{ label: 'Mall / Shopping Center', value: 'mall' }, { label: 'Cinema / Multiplex', value: 'cinema' }, { label: 'Office Lobby', value: 'office' }, { label: 'Hotel / Resort', value: 'hotel' }] }, { type: 'text', id: 'size', label: 'Display size', placeholder: 'e.g. 10ft x 6ft', required: true }, { type: 'textarea', id: 'description', label: 'Description', placeholder: 'Describe the location, footfall, and visibility...' }] },
        { key: 'screen-2', title: 'Location & availability', step: 2, totalSteps: 5, ctaLabel: 'Continue', fields: [{ type: 'text', id: 'address', label: 'Full address', required: true }, { type: 'select', id: 'city', label: 'City', placeholder: 'Select city', required: true, options: [{ label: 'Bengaluru', value: 'bengaluru' }, { label: 'Mumbai', value: 'mumbai' }, { label: 'Delhi', value: 'delhi' }, { label: 'Chennai', value: 'chennai' }] }, { type: 'switch', id: 'available_now', label: 'Available immediately' }] },
        { key: 'screen-3', title: 'Pricing', step: 3, totalSteps: 5, ctaLabel: 'Continue', fields: [{ type: 'slider', id: 'monthly_price', label: 'Monthly price (₹)', min: 1000, max: 100000, step: 1000, required: true }, { type: 'select', id: 'pricing_model', label: 'Pricing model', placeholder: 'Select model', options: [{ label: 'Fixed monthly', value: 'fixed' }, { label: 'Per impression', value: 'impression' }, { label: 'Negotiable', value: 'negotiable' }] }] },
        { key: 'screen-4', title: 'Upload photos', step: 4, totalSteps: 5, ctaLabel: 'Continue', fields: [{ type: 'image-upload', id: 'main_photo', label: 'Main photo', required: true }, { type: 'image-upload', id: 'wide_photo', label: 'Wide angle shot' }] },
        { key: 'screen-5', title: 'Review & submit', step: 5, totalSteps: 5, ctaLabel: 'Submit listing', fields: [{ type: 'checkbox', id: 'terms', label: 'Terms agreement', description: 'I confirm that all information provided is accurate and I agree to ADX listing guidelines.', required: true }] },
      ],
    },
    outdoor: {
      id: 'outdoor', title: 'Outdoor', description: 'Billboards, kiosks, and roadside sites',
      screens: [
        { key: 'screen-1', title: 'Listing details', step: 1, totalSteps: 4, ctaLabel: 'Continue', fields: [{ type: 'text', id: 'title', label: 'Listing title', placeholder: 'e.g. Billboard, MG Road', required: true }, { type: 'select', id: 'sub_type', label: 'Space type', required: true, options: [{ label: 'Billboard / Hoarding', value: 'billboard' }, { label: 'Kiosk / Stand', value: 'kiosk' }, { label: 'Wall / Mural', value: 'wall' }] }, { type: 'text', id: 'size', label: 'Display size', placeholder: 'e.g. 40ft x 20ft', required: true }] },
        { key: 'screen-2', title: 'Location & availability', step: 2, totalSteps: 4, ctaLabel: 'Continue', fields: [{ type: 'text', id: 'address', label: 'Full address', required: true }, { type: 'select', id: 'city', label: 'City', required: true, options: [{ label: 'Bengaluru', value: 'bengaluru' }, { label: 'Mumbai', value: 'mumbai' }, { label: 'Delhi', value: 'delhi' }] }, { type: 'switch', id: 'available_now', label: 'Available immediately' }] },
        { key: 'screen-3', title: 'Pricing', step: 3, totalSteps: 4, ctaLabel: 'Continue', fields: [{ type: 'slider', id: 'monthly_price', label: 'Monthly price (₹)', min: 5000, max: 500000, step: 5000, required: true }] },
        { key: 'screen-4', title: 'Upload photos', step: 4, totalSteps: 4, ctaLabel: 'Submit listing', fields: [{ type: 'image-upload', id: 'main_photo', label: 'Main photo', required: true }, { type: 'checkbox', id: 'terms', label: 'Terms agreement', description: 'I confirm all information is accurate.', required: true }] },
      ],
    },
    transit: {
      id: 'transit', title: 'Transit', description: 'Bus shelters, cabs, metro, and airport',
      screens: [
        { key: 'screen-1', title: 'Listing details', step: 1, totalSteps: 3, ctaLabel: 'Continue', fields: [{ type: 'text', id: 'title', label: 'Listing title', required: true }, { type: 'select', id: 'sub_type', label: 'Transit type', required: true, options: [{ label: 'Bus shelter', value: 'bus' }, { label: 'Metro station', value: 'metro' }, { label: 'Airport', value: 'airport' }, { label: 'Cab / Vehicle', value: 'cab' }] }, { type: 'text', id: 'route', label: 'Route / Line', placeholder: 'e.g. Purple Line' }] },
        { key: 'screen-2', title: 'Pricing & availability', step: 2, totalSteps: 3, ctaLabel: 'Continue', fields: [{ type: 'slider', id: 'monthly_price', label: 'Monthly price (₹)', min: 2000, max: 200000, step: 2000, required: true }, { type: 'switch', id: 'available_now', label: 'Available immediately' }] },
        { key: 'screen-3', title: 'Upload photos', step: 3, totalSteps: 3, ctaLabel: 'Submit listing', fields: [{ type: 'image-upload', id: 'main_photo', label: 'Main photo', required: true }, { type: 'checkbox', id: 'terms', label: 'Terms agreement', required: true, description: 'I agree to ADX listing guidelines.' }] },
      ],
    },
    media: {
      id: 'media', title: 'Media', description: 'DOOH screens, kiosks, and branded media',
      screens: [
        { key: 'screen-1', title: 'Listing details', step: 1, totalSteps: 3, ctaLabel: 'Continue', fields: [{ type: 'text', id: 'title', label: 'Listing title', required: true }, { type: 'select', id: 'sub_type', label: 'Media type', required: true, options: [{ label: 'DOOH Screen', value: 'dooh' }, { label: 'Interactive Kiosk', value: 'kiosk' }, { label: 'Branded Vehicle', value: 'vehicle' }, { label: 'LED Display', value: 'led' }] }, { type: 'text', id: 'resolution', label: 'Screen resolution', placeholder: 'e.g. 1920x1080' }] },
        { key: 'screen-2', title: 'Pricing & availability', step: 2, totalSteps: 3, ctaLabel: 'Continue', fields: [{ type: 'slider', id: 'monthly_price', label: 'Monthly price (₹)', min: 5000, max: 300000, step: 5000, required: true }, { type: 'switch', id: 'available_now', label: 'Available immediately' }] },
        { key: 'screen-3', title: 'Upload photos', step: 3, totalSteps: 3, ctaLabel: 'Submit listing', fields: [{ type: 'image-upload', id: 'main_photo', label: 'Main photo', required: true }, { type: 'checkbox', id: 'terms', label: 'Terms agreement', required: true, description: 'I agree to ADX listing guidelines.' }] },
      ],
    },
  },
};

async function main() {
  const value = {
    flows: {
      onboarding: ONBOARD_FLOW,
      listing: LISTING_FLOW,
    },
    enums: APP_ENUMS,
  };

  await prisma.appConfig.upsert({
    where: { key: 'main' },
    update: { value },
    create: { key: 'main', value },
  });

  console.log('AppConfig seeded successfully.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
