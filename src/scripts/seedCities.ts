import { closeDatabase, prisma } from '../shared/database';

/**
 * Cities, with the other spellings that mean the same place.
 *
 * The aliases are the reason this table exists. Several Indian cities were
 * officially renamed and both names remain in daily use, in advertising
 * paperwork especially — so a surge window naming Bangalore has to cover spots
 * recorded in Bengaluru. Comparing the raw strings meant it covered none of
 * them, silently.
 *
 * A starting list, not a closed one. A name that resolves to nothing simply
 * never matches on city, which is a visible failure rather than a wrong match.
 *
 * Idempotent — safe to re-run. Aliases are refreshed on each run so adding one
 * here is all it takes; the canonical name is left as ops last edited it.
 */

const CITIES: { slug: string; name: string; state: string; aliases: string[] }[] = [
  { slug: 'mumbai', name: 'Mumbai', state: 'Maharashtra', aliases: ['bombay', 'greater-mumbai'] },
  { slug: 'delhi', name: 'Delhi', state: 'Delhi', aliases: ['new-delhi', 'ncr', 'delhi-ncr'] },
  { slug: 'bengaluru', name: 'Bengaluru', state: 'Karnataka', aliases: ['bangalore', 'bengaluru-urban'] },
  { slug: 'chennai', name: 'Chennai', state: 'Tamil Nadu', aliases: ['madras'] },
  { slug: 'kolkata', name: 'Kolkata', state: 'West Bengal', aliases: ['calcutta'] },
  { slug: 'hyderabad', name: 'Hyderabad', state: 'Telangana', aliases: ['secunderabad'] },
  { slug: 'pune', name: 'Pune', state: 'Maharashtra', aliases: ['poona', 'pimpri-chinchwad'] },
  { slug: 'ahmedabad', name: 'Ahmedabad', state: 'Gujarat', aliases: ['amdavad'] },
  { slug: 'surat', name: 'Surat', state: 'Gujarat', aliases: [] },
  { slug: 'jaipur', name: 'Jaipur', state: 'Rajasthan', aliases: [] },
  { slug: 'lucknow', name: 'Lucknow', state: 'Uttar Pradesh', aliases: [] },
  { slug: 'kanpur', name: 'Kanpur', state: 'Uttar Pradesh', aliases: ['cawnpore'] },
  { slug: 'nagpur', name: 'Nagpur', state: 'Maharashtra', aliases: [] },
  { slug: 'indore', name: 'Indore', state: 'Madhya Pradesh', aliases: [] },
  { slug: 'bhopal', name: 'Bhopal', state: 'Madhya Pradesh', aliases: [] },
  { slug: 'visakhapatnam', name: 'Visakhapatnam', state: 'Andhra Pradesh', aliases: ['vizag', 'vishakhapatnam'] },
  { slug: 'patna', name: 'Patna', state: 'Bihar', aliases: [] },
  { slug: 'vadodara', name: 'Vadodara', state: 'Gujarat', aliases: ['baroda'] },
  { slug: 'ludhiana', name: 'Ludhiana', state: 'Punjab', aliases: [] },
  { slug: 'agra', name: 'Agra', state: 'Uttar Pradesh', aliases: [] },
  { slug: 'nashik', name: 'Nashik', state: 'Maharashtra', aliases: ['nasik'] },
  { slug: 'faridabad', name: 'Faridabad', state: 'Haryana', aliases: [] },
  { slug: 'gurugram', name: 'Gurugram', state: 'Haryana', aliases: ['gurgaon'] },
  { slug: 'noida', name: 'Noida', state: 'Uttar Pradesh', aliases: ['gautam-buddha-nagar'] },
  { slug: 'rajkot', name: 'Rajkot', state: 'Gujarat', aliases: [] },
  { slug: 'varanasi', name: 'Varanasi', state: 'Uttar Pradesh', aliases: ['banaras', 'benares'] },
  { slug: 'amritsar', name: 'Amritsar', state: 'Punjab', aliases: [] },
  { slug: 'coimbatore', name: 'Coimbatore', state: 'Tamil Nadu', aliases: ['kovai'] },
  { slug: 'kochi', name: 'Kochi', state: 'Kerala', aliases: ['cochin', 'ernakulam'] },
  { slug: 'thiruvananthapuram', name: 'Thiruvananthapuram', state: 'Kerala', aliases: ['trivandrum'] },
  { slug: 'chandigarh', name: 'Chandigarh', state: 'Chandigarh', aliases: [] },
  { slug: 'guwahati', name: 'Guwahati', state: 'Assam', aliases: ['gauhati'] },
  { slug: 'bhubaneswar', name: 'Bhubaneswar', state: 'Odisha', aliases: [] },
  { slug: 'raipur', name: 'Raipur', state: 'Chhattisgarh', aliases: [] },
  { slug: 'ranchi', name: 'Ranchi', state: 'Jharkhand', aliases: [] },
  { slug: 'dehradun', name: 'Dehradun', state: 'Uttarakhand', aliases: ['dehra-dun'] },
  { slug: 'mysuru', name: 'Mysuru', state: 'Karnataka', aliases: ['mysore'] },
  { slug: 'madurai', name: 'Madurai', state: 'Tamil Nadu', aliases: [] },
  { slug: 'jodhpur', name: 'Jodhpur', state: 'Rajasthan', aliases: [] },
  { slug: 'thane', name: 'Thane', state: 'Maharashtra', aliases: [] },
  { slug: 'navi-mumbai', name: 'Navi Mumbai', state: 'Maharashtra', aliases: ['new-bombay'] },
  { slug: 'ghaziabad', name: 'Ghaziabad', state: 'Uttar Pradesh', aliases: [] },
  { slug: 'prayagraj', name: 'Prayagraj', state: 'Uttar Pradesh', aliases: ['allahabad'] },
  { slug: 'puducherry', name: 'Puducherry', state: 'Puducherry', aliases: ['pondicherry'] },
];

async function main(): Promise<void> {
  for (const city of CITIES) {
    await prisma.city.upsert({
      where: { slug: city.slug },
      // Aliases refresh so adding one to this file is enough; the display name
      // is left alone in case ops has corrected it.
      update: { aliases: city.aliases },
      create: city,
    });
  }
  console.log(`Cities seeded: ${CITIES.length}.`);
  await closeDatabase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
