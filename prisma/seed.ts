import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';
import crypto from 'crypto';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const QR_SECRET = process.env.QR_SECRET ?? 'qr_dev_secret_change_in_prod_min16';

function signQrToken(payload: object): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', QR_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

async function main() {
  console.log('🌱 Seeding database...');

  // ─── Agent user ───────────────────────────────────────────────────────────
  const agent = await prisma.user.upsert({
    where: { mobile: '+919876543210' },
    update: { name: 'Shivam Kumar', email: 'shivam.kumar@adx.in', language: 'en' },
    create: { mobile: '+919876543210', name: 'Shivam Kumar', email: 'shivam.kumar@adx.in', language: 'en' },
  });

  // Roles
  await prisma.userRole.upsert({
    where: { userId_role: { userId: agent.id, role: 'ADMIN' } },
    update: {},
    create: { userId: agent.id, role: 'ADMIN' },
  });
  await prisma.userRole.upsert({
    where: { userId_role: { userId: agent.id, role: 'AGENT_PUBLISHER' } },
    update: {},
    create: { userId: agent.id, role: 'AGENT_PUBLISHER' },
  });

  // Agent profile
  const agentProfile = await prisma.agentProfile.upsert({
    where: { userId: agent.id },
    update: { city: 'Bengaluru', state: 'Karnataka', tier: 'SILVER' },
    create: { userId: agent.id, city: 'Bengaluru', state: 'Karnataka', tier: 'SILVER' },
  });

  console.log(`✅ Agent: ${agent.mobile} (${agent.name})`);

  // ─── Agent Publisher user (no admin) ─────────────────────────────────────
  const agentPub = await prisma.user.upsert({
    where: { mobile: '+919876543211' },
    update: { name: 'Ravi Shankar', language: 'en' },
    create: { mobile: '+919876543211', name: 'Ravi Shankar', language: 'en' },
  });

  await prisma.userRole.upsert({
    where: { userId_role: { userId: agentPub.id, role: 'AGENT_PUBLISHER' } },
    update: {},
    create: { userId: agentPub.id, role: 'AGENT_PUBLISHER' },
  });

  await prisma.agentProfile.upsert({
    where: { userId: agentPub.id },
    update: { city: 'Patna', state: 'Bihar', tier: 'BRONZE' },
    create: { userId: agentPub.id, city: 'Patna', state: 'Bihar', tier: 'BRONZE' },
  });

  console.log(`✅ Agent Publisher: ${agentPub.mobile} (${agentPub.name})`);

  // ─── New agent (bare account — no profile, triggers onboarding flow) ──────
  const newAgent = await prisma.user.upsert({
    where: { mobile: '+919876543212' },
    update: {},
    create: { mobile: '+919876543212' },
  });
  await prisma.userRole.upsert({
    where: { userId_role: { userId: newAgent.id, role: 'AGENT_PUBLISHER' } },
    update: {},
    create: { userId: newAgent.id, role: 'AGENT_PUBLISHER' },
  });
  await prisma.agentProfile.upsert({
    where: { userId: newAgent.id },
    update: {},
    create: { userId: newAgent.id },
  });

  console.log(`✅ New agent (onboarding): ${newAgent.mobile}`);

  // ─── Sites ────────────────────────────────────────────────────────────────
  const site1 = await prisma.site.upsert({
    where: { id: 'site-nalanda-001' },
    update: { latitude: 25.1558, longitude: 85.4962 },
    create: {
      id: 'site-nalanda-001',
      name: 'Meghi Chowk Digital Board',
      address: 'Main Road, Meghi Nongawan, Bihar Sharif',
      latitude: 25.1558,
      longitude: 85.4962,
      assetType: 'DIGITAL',
    },
  });

  const site2 = await prisma.site.upsert({
    where: { id: 'site-kargil-001' },
    update: { latitude: 25.1521, longitude: 85.4937 },
    create: {
      id: 'site-kargil-001',
      name: 'Nongawan Bus Stand Transit Shelter',
      address: 'Bus Stand Road, Nongawan, Bihar Sharif',
      latitude: 25.1521,
      longitude: 85.4937,
      assetType: 'TRANSIT',
    },
  });

  const site3 = await prisma.site.upsert({
    where: { id: 'site-hospital-001' },
    update: { latitude: 25.1572, longitude: 85.4978 },
    create: {
      id: 'site-hospital-001',
      name: 'Bihar Sharif Road Hoarding',
      address: 'Bihar Sharif Road, Meghi, Nalanda',
      latitude: 25.1572,
      longitude: 85.4978,
      assetType: 'BILLBOARD',
    },
  });

  // ─── QR codes for sites ───────────────────────────────────────────────────
  for (const site of [site1, site2, site3]) {
    const existing = await prisma.qrCode.findFirst({ where: { refId: site.id, type: 'SITE' } });
    if (!existing) {
      const tempToken = `pending_${crypto.randomUUID()}`;
      const qr = await prisma.qrCode.create({
        data: { type: 'SITE', refId: site.id, allowedRoles: ['AGENT_PUBLISHER', 'AGENT_ADVERTISER'], token: tempToken },
      });
      const payload = { id: qr.id, type: 'SITE', refId: site.id, iat: Date.now() };
      const token = signQrToken(payload);
      await prisma.qrCode.update({ where: { id: qr.id }, data: { token } });
      await prisma.site.update({ where: { id: site.id }, data: { qrCodeId: qr.id } });
    }
  }

  console.log('✅ Sites + QR codes created');

  // Resolve newAgentProfile now that sites exist
  const newAgentProfile = await prisma.agentProfile.findUniqueOrThrow({ where: { userId: newAgent.id } });

  // ─── Publishers ───────────────────────────────────────────────────────────
  const pub1 = await prisma.publisher.upsert({
    where: { id: 'pub-adx-1098' },
    update: {},
    create: {
      id: 'pub-adx-1098',
      agentId: agentProfile.id,
      name: 'Sree Kumar Bhusan',
      mobile: '+919000000001',
      email: 'sree.kumar@example.com',
      type: 'INDIVIDUAL',
      city: 'MG Road',
      state: 'Karnataka',
      kycStatus: 'VERIFIED',
    },
  });

  const pub2 = await prisma.publisher.upsert({
    where: { id: 'pub-adx-2031' },
    update: {},
    create: {
      id: 'pub-adx-2031',
      agentId: agentProfile.id,
      name: 'Al Noor Ads LLP',
      mobile: '+919000000002',
      type: 'BUSINESS',
      city: 'Indiranagar',
      state: 'Karnataka',
      kycStatus: 'VERIFIED',
    },
  });

  const pub3 = await prisma.publisher.upsert({
    where: { id: 'pub-adx-3110' },
    update: {},
    create: {
      id: 'pub-adx-3110',
      agentId: agentProfile.id,
      name: 'Metro Media NGO',
      mobile: '+919000000003',
      type: 'NGO',
      city: 'Park Avenue',
      state: 'Karnataka',
      kycStatus: 'PENDING',
    },
  });

  const pub4 = await prisma.publisher.upsert({
    where: { id: 'pub-adx-4420' },
    update: {},
    create: {
      id: 'pub-adx-4420',
      agentId: agentProfile.id,
      name: 'Priya Verma',
      mobile: '+919000000004',
      type: 'INDIVIDUAL',
      city: 'City Center',
      state: 'Karnataka',
      kycStatus: 'VERIFIED',
    },
  });

  // KYC records
  for (const pubId of [pub1.id, pub2.id, pub3.id, pub4.id]) {
    await prisma.publisherKyc.upsert({
      where: { publisherId: pubId },
      update: {},
      create: { publisherId: pubId },
    });
  }

  // Listings
  const listings = [
    { id: 'listing-001', publisherId: pub1.id, agentId: agentProfile.id, title: 'Billboard - MG Road', category: 'OUTDOOR' as const, address: 'MG Road, Bengaluru', monthlyPrice: 15000, size: '40ft x 20ft', status: 'ACTIVE' as const },
    { id: 'listing-002', publisherId: pub1.id, agentId: agentProfile.id, title: 'Digital Signage', category: 'MEDIA' as const, address: 'MG Road, Bengaluru', monthlyPrice: 20000, size: '25ft x 10ft', status: 'ACTIVE' as const },
    { id: 'listing-003', publisherId: pub1.id, agentId: agentProfile.id, title: 'Poster - City Center', category: 'INDOOR' as const, address: 'City Center Mall, Bengaluru', monthlyPrice: 5000, size: '5ft x 3ft', status: 'DRAFT' as const },
    { id: 'listing-004', publisherId: pub2.id, agentId: agentProfile.id, title: 'Digital Gantry', category: 'MEDIA' as const, address: 'Indiranagar, Bengaluru', monthlyPrice: 22000, size: '30ft x 12ft', status: 'ACTIVE' as const },
    { id: 'listing-005', publisherId: pub3.id, agentId: agentProfile.id, title: 'Transit Shelter Panel', category: 'TRANSIT' as const, address: 'Park Avenue, Bengaluru', monthlyPrice: 8500, size: '12ft x 6ft', status: 'PENDING_REVIEW' as const },
    { id: 'listing-006', publisherId: pub4.id, agentId: agentProfile.id, title: 'Mall Atrium Poster', category: 'INDOOR' as const, address: 'City Center Mall, Bengaluru', monthlyPrice: 7000, size: '8ft x 6ft', status: 'ACTIVE' as const },
  ];

  for (const l of listings) {
    await prisma.listing.upsert({
      where: { id: l.id },
      update: {},
      create: l,
    });
  }

  console.log('✅ Publishers + listings created');

  // ─── Advertisers + orders ─────────────────────────────────────────────────
  const advertisers = [
    { id: 'adv-airtel', mobile: '+918000000001', name: 'Airtel', email: 'airtel@example.com' },
    { id: 'adv-hdfc', mobile: '+918000000002', name: 'HDFC Bank', email: 'hdfc@example.com' },
    { id: 'adv-swiggy', mobile: '+918000000003', name: 'Swiggy', email: 'swiggy@example.com' },
    { id: 'adv-jio', mobile: '+918000000004', name: 'Reliance Jio', email: 'jio@example.com' },
    { id: 'adv-amazon', mobile: '+918000000005', name: 'Amazon', email: 'amazon@example.com' },
    { id: 'adv-flipkart', mobile: '+918000000006', name: 'Flipkart', email: 'flipkart@example.com' },
  ];

  for (const advertiser of advertisers) {
    const user = await prisma.user.upsert({
      where: { mobile: advertiser.mobile },
      update: { name: advertiser.name, email: advertiser.email },
      create: advertiser,
    });

    await prisma.userRole.upsert({
      where: { userId_role: { userId: user.id, role: 'ADVERTISER' } },
      update: {},
      create: { userId: user.id, role: 'ADVERTISER' },
    });
  }

  const advertiserByMobile = Object.fromEntries(
    await Promise.all(
      advertisers.map(async (advertiser) => {
        const user = await prisma.user.findUniqueOrThrow({ where: { mobile: advertiser.mobile } });
        return [advertiser.mobile, user.id] as const;
      }),
    ),
  );

  const orders = [
    { id: 'order-adx-9001', advertiserMobile: '+918000000001', listingId: 'listing-001', agentId: newAgentProfile.id, status: 'PENDING_AGENT' as const, budget: 1500, campaignName: 'Airtel 5G Rollout' },
    { id: 'order-adx-9002', advertiserMobile: '+918000000002', listingId: 'listing-002', agentId: agentProfile.id, status: 'IN_PROGRESS' as const, budget: 2000, campaignName: 'Credit Card Q2' },
    { id: 'order-adx-9003', advertiserMobile: '+918000000003', listingId: 'listing-003', agentId: newAgentProfile.id, status: 'PENDING_AGENT' as const, budget: 1800, campaignName: 'Swiggy One Launch' },
    { id: 'order-adx-9981', advertiserMobile: '+918000000004', listingId: 'listing-004', agentId: agentProfile.id, status: 'PENDING_APPROVAL' as const, budget: 2500, campaignName: 'Jio 5G Launch' },
    { id: 'order-adx-9824', advertiserMobile: '+918000000005', listingId: 'listing-005', agentId: agentProfile.id, status: 'PENDING_APPROVAL' as const, budget: 1800, campaignName: 'Prime Day 2024' },
    { id: 'order-adx-9770', advertiserMobile: '+918000000006', listingId: 'listing-006', agentId: agentProfile.id, status: 'PENDING_AGENT' as const, budget: 2200, campaignName: 'Big Billion Days' },
  ];

  for (const order of orders) {
    await prisma.order.upsert({
      where: { id: order.id },
      update: {},
      create: {
        id: order.id,
        advertiserId: advertiserByMobile[order.advertiserMobile],
        listingId: order.listingId,
        agentId: order.agentId,
        status: order.status,
        budget: order.budget,
        campaignName: order.campaignName,
      },
    });
  }

  console.log('✅ Advertisers + orders created');

  // ─── Earnings transactions ─────────────────────────────────────────────────
  const txs = [
    { id: 'tx-001', title: 'Billboard #1234', amount: 40500, type: 'ORDER_COMPLETION' as const },
    { id: 'tx-002', title: 'Billboard #1235', amount: 35200, type: 'ORDER_COMPLETION' as const },
    { id: 'tx-003', title: 'Billboard #1236', amount: 50800, type: 'ORDER_COMPLETION' as const },
    { id: 'tx-004', title: 'Billboard #1237', amount: 60300, type: 'ORDER_COMPLETION' as const },
    { id: 'tx-005', title: 'Billboard #1238', amount: 45700, type: 'ORDER_COMPLETION' as const },
  ];

  for (const tx of txs) {
    await prisma.transaction.upsert({
      where: { id: tx.id },
      update: {},
      create: { ...tx, agentId: agentProfile.id },
    });
  }

  console.log('✅ Earnings transactions created');

  // ─── Notifications ────────────────────────────────────────────────────────
  const notifs = [
    { id: 'notif-001', type: 'BOOKING' as const, title: 'New booking assigned', subtitle: 'Billboard - MG Road needs verification today.', message: 'A new verification order has been assigned near MG Road. Check in at the location, scan the site QR, and upload the required proof photos before the end of the scheduled window.', suggestedAction: 'Open the order detail and start route guidance when you are ready to travel.', relatedId: 'order-adx-9981', read: false },
    { id: 'notif-002', type: 'PAYOUT' as const, title: 'Withdrawal processed', subtitle: 'Your payout of Rs.5,000 has been transferred.', message: 'Your withdrawal request of Rs.5,000 has been successfully processed and transferred to your registered bank account. The amount should reflect within 1-2 business days.', suggestedAction: 'Check your earnings dashboard for the updated balance and transaction history.', read: false },
    { id: 'notif-003', type: 'KYC' as const, title: 'KYC update required', subtitle: 'A publisher document needs a clearer re-upload.', message: 'The Aadhaar document submitted for publisher onboarding was rejected due to poor image quality. Please re-upload a clear, well-lit photo of the front and back of the document.', suggestedAction: 'Go to the KYC section and re-upload the required documents to avoid delays.', read: true },
    { id: 'notif-004', type: 'MESSAGE' as const, title: 'New message received', subtitle: 'You have a new message from the support team.', message: 'The ADX support team has sent you a message regarding your recent support ticket. Please review the message and respond at your earliest convenience.', suggestedAction: 'Open the message thread and reply to the support team to resolve your ticket.', read: false },
  ];

  for (const n of notifs) {
    await prisma.notification.upsert({
      where: { id: n.id },
      update: {},
      create: { ...n, userId: agent.id },
    });
  }

  console.log('✅ Notifications created');

  // ─── Support tickets ───────────────────────────────────────────────────────
  const ticket1 = await prisma.supportTicket.upsert({
    where: { id: 'ticket-sup-2041' },
    update: {},
    create: { id: 'ticket-sup-2041', userId: agent.id, title: 'Payout not credited', category: 'payout', description: 'Withdrawal request WD-2025-019 is still pending after the scheduled payout window. Bank transfer reference is not visible yet.', status: 'OPEN', relatedOrderId: 'order-adx-9981' },
  });

  const ticket2 = await prisma.supportTicket.upsert({
    where: { id: 'ticket-sup-2042' },
    update: {},
    create: { id: 'ticket-sup-2042', userId: agent.id, title: 'Publisher onboarding stuck', category: 'kyc', description: 'Publisher onboarding is waiting for additional verification documents.', status: 'OPEN' },
  });

  const ticket3 = await prisma.supportTicket.upsert({
    where: { id: 'ticket-sup-2043' },
    update: {},
    create: { id: 'ticket-sup-2043', userId: agent.id, title: 'QR code damaged at site', category: 'order', description: 'The on-site QR code is damaged and needs replacement before the next audit.', status: 'OPEN', relatedOrderId: 'order-adx-9981' },
  });

  // Ticket messages
  const msgs = [
    { ticketId: ticket1.id, authorName: 'Shivam Kumar', message: 'The payout was expected yesterday, but I do not see it in my bank account.' },
    { ticketId: ticket1.id, authorName: 'ADX Support', message: 'We are checking the bank reference. Please allow up to one business day while we verify the transfer status.' },
    { ticketId: ticket2.id, authorName: 'Shivam Kumar', message: 'The publisher has submitted details, but onboarding is not moving forward.' },
    { ticketId: ticket3.id, authorName: 'Shivam Kumar', message: 'The QR code at the site is damaged and cannot be scanned.' },
  ];

  for (const msg of msgs) {
    const existing = await prisma.ticketMessage.findFirst({ where: { ticketId: msg.ticketId, message: msg.message } });
    if (!existing) {
      await prisma.ticketMessage.create({ data: { ...msg, authorId: agent.id } });
    }
  }

  console.log('✅ Support tickets + messages created');

  // ─── Milestones ───────────────────────────────────────────────────────────
  // Progress is derived on read from real counters (DR 05); the seed only
  // plants the templates and the agent's rows. A `target` is a count in the
  // unit of the type: onboardings, visits, rupees, on-time arrivals.
  const milestoneTemplates = [
    { id: 'ms-tmpl-001', type: 'ONBOARDING' as const, title: 'Onboard 10 publishers', description: 'Onboard publishers to unlock bonuses', target: 10, rewardAmount: '5000.00', sortOrder: 1, windowDays: 30 },
    { id: 'ms-tmpl-002', type: 'ACTIVITY' as const, title: 'Complete 10 visits', description: 'Complete field visits and verifications', target: 10, rewardAmount: '3000.00', sortOrder: 2, windowDays: 30 },
    { id: 'ms-tmpl-003', type: 'REVENUE' as const, title: 'Earn ₹50,000', description: 'Credited incentives in the window', target: 50000, rewardAmount: '10000.00', sortOrder: 3, windowDays: 90 },
    { id: 'ms-tmpl-004', type: 'QUALITY' as const, title: '20 on-time arrivals', description: 'Arrive on time at twenty slots', target: 20, rewardAmount: '5000.00', sortOrder: 4, unlockAfter: 2 },
  ];

  for (const t of milestoneTemplates) {
    await prisma.milestoneTemplate.upsert({
      where: { id: t.id },
      // Everything but the id, so an edit here reaches an existing database.
      update: { type: t.type, title: t.title, description: t.description, target: t.target, rewardAmount: t.rewardAmount, sortOrder: t.sortOrder, windowDays: t.windowDays ?? null, unlockAfter: t.unlockAfter ?? null },
      create: t,
    });

    await prisma.agentMilestone.upsert({
      where: { agentId_templateId: { agentId: agentProfile.id, templateId: t.id } },
      update: {},
      create: { agentId: agentProfile.id, templateId: t.id },
    });
  }

  console.log('✅ Milestones created');

  // ─── Training resources ───────────────────────────────────────────────────
  const resources = [
    { id: 'train-001', title: 'Publisher onboarding essentials', category: 'KYC', duration: '8 min', subtitle: 'KYC handoff', topic: 'Verification', status: 'Payouts', statusVariant: 'warning' },
    { id: 'train-002', title: 'QR verification playbook', category: 'Verification', duration: '6 min', subtitle: 'Scan fallback guide', topic: 'Agreement signed', status: 'In fulfillment', statusVariant: 'info' },
    { id: 'train-003', title: 'Payouts & dispute handling', category: 'Payouts', duration: '10 min', subtitle: 'Payout disputes', topic: 'Failed payout', status: 'Needs review', statusVariant: 'warning' },
    { id: 'train-004', title: 'Multi-order route planning', category: 'Resources', duration: '5 min', subtitle: 'Route basics', topic: 'Order batching', status: 'In fulfillment', statusVariant: 'info' },
  ];

  for (const r of resources) {
    await prisma.trainingResource.upsert({
      where: { id: r.id },
      update: {},
      create: r,
    });
  }

  console.log('✅ Training resources created');

  // ─── Training curriculum (DR 05) ──────────────────────────────────────────
  // Five modules, each with a short quiz, the way the index frame draws them.
  // Sequential: each waits on the one before it. Created active because the
  // questions land in the same pass; through the API a module starts inactive.
  const curriculum = [
    { id: 'tm-001', ordinal: 1, title: 'Welcome to ADX', summary: 'What the platform is and what an agent does', durationMins: 6, takeaways: ['ADX matches advertisers to spaces publishers own', 'An agent brings both sides on and keeps them happy'] },
    { id: 'tm-002', ordinal: 2, title: 'Onboarding a publisher', summary: 'The door-to-door code, KYC and the first listing', durationMins: 12, takeaways: ['The publisher approves your code before you can act', 'KYC is verified before money moves'] },
    { id: 'tm-003', ordinal: 3, title: 'Site visits and proof', summary: 'Photographs, check-ins and what ops looks for', durationMins: 10, takeaways: ['Four photographs, one map pin', 'A visit pays when it is completed, not when it is booked'] },
    { id: 'tm-004', ordinal: 4, title: 'Selling a package', summary: 'Plans, add-ons and the payment link', durationMins: 9, takeaways: ['The advertiser pays through the link; you never take money', 'Your commission is recorded when the sale is paid'] },
    { id: 'tm-005', ordinal: 5, title: 'Earnings and payouts', summary: 'Incentives, the wallet and withdrawals', durationMins: 8, takeaways: ['Every incentive is verified before it is credited', 'Withdrawals go to a verified bank account'] },
  ];
  for (const m of curriculum) {
    await prisma.trainingModule.upsert({
      where: { id: m.id },
      update: { ordinal: m.ordinal, title: m.title, summary: m.summary, durationMins: m.durationMins, takeaways: m.takeaways, unlockAfterOrdinal: m.ordinal > 1 ? m.ordinal - 1 : null },
      create: {
        id: m.id,
        ordinal: m.ordinal,
        title: m.title,
        summary: m.summary,
        durationMins: m.durationMins,
        lessonBody: `# ${m.title}\n\n${m.summary}.`,
        takeaways: m.takeaways,
        unlockAfterOrdinal: m.ordinal > 1 ? m.ordinal - 1 : null,
        passPercent: 80,
        isActive: true,
        questions: {
          create: [
            { ordinal: 1, prompt: `Which statement about "${m.title}" is true?`, options: { create: [
              { ordinal: 1, label: m.takeaways[0]!, isCorrect: true },
              { ordinal: 2, label: 'An agent collects cash from the advertiser', isCorrect: false },
              { ordinal: 3, label: 'KYC is optional for a publisher', isCorrect: false },
              { ordinal: 4, label: 'A visit pays when it is booked', isCorrect: false },
            ] } },
            { ordinal: 2, prompt: 'What does ADX verify before money moves?', options: { create: [
              { ordinal: 1, label: 'Nothing — money moves on booking', isCorrect: false },
              { ordinal: 2, label: 'KYC', isCorrect: true },
              { ordinal: 3, label: 'The agent\'s rating', isCorrect: false },
              { ordinal: 4, label: 'The listing\'s photographs', isCorrect: false },
            ] } },
          ],
        },
      },
    });
  }

  console.log('✅ Training curriculum created');

  // ─── Order milestone templates ────────────────────────────────────────────
  const tmplSurvey = await prisma.orderMilestoneTemplate.upsert({
    where: { id: 'omt-survey-001' },
    update: {},
    create: {
      id: 'omt-survey-001',
      title: 'Site Survey',
      description: 'Inspect the site, confirm dimensions, and fill in the survey form.',
      type: 'SURVEY',
      requirements: [
        { kind: 'checklist_item', label: 'Site dimensions confirmed' },
        { kind: 'checklist_item', label: 'Visibility assessment done' },
        { kind: 'photo', label: 'Wide-angle site photo' },
        { kind: 'location_checkin' },
      ],
      estimatedDurationMins: 20,
    },
  });

  const tmplInstallation = await prisma.orderMilestoneTemplate.upsert({
    where: { id: 'omt-install-001' },
    update: {},
    create: {
      id: 'omt-install-001',
      title: 'Creative Installation',
      description: 'Confirm creative material is installed correctly at the site.',
      type: 'INSTALLATION',
      requirements: [
        { kind: 'photo', label: 'Installed creative — full view' },
        { kind: 'photo', label: 'Installed creative — close-up' },
        { kind: 'checklist_item', label: 'Creative is undamaged' },
        { kind: 'checklist_item', label: 'Alignment and placement correct' },
        { kind: 'qr_scan' },
      ],
      estimatedDurationMins: 30,
    },
  });

  const tmplVerification = await prisma.orderMilestoneTemplate.upsert({
    where: { id: 'omt-verify-001' },
    update: {},
    create: {
      id: 'omt-verify-001',
      title: 'Site Verification',
      description: 'Submit proof photos and confirm the ad is live and visible.',
      type: 'VERIFICATION',
      requirements: [
        { kind: 'photo', label: 'Wide-angle shot' },
        { kind: 'photo', label: 'Close-up of creative' },
        { kind: 'photo', label: 'Landmark / surroundings' },
        { kind: 'checklist_item', label: 'Ad is undamaged' },
        { kind: 'checklist_item', label: 'Lighting / visibility acceptable' },
        { kind: 'qr_scan' },
        { kind: 'location_checkin' },
      ],
      estimatedDurationMins: 25,
    },
  });

  /*
   * The guided site-verification visit the agent app's AG-22/AG-23 frames are
   * drawn against: a mirror decal in a gym, photographed four ways.
   *
   * Seeded because it is the first template to use `optional`, and because the
   * four labels here are what the capture sequence prints on screen — the app
   * holds no list of its own. Rename one and the agent is asked for the new
   * name; add a fifth and there are five frames.
   */
  await prisma.orderMilestoneTemplate.upsert({
    where: { id: 'omt-verify-mirror-001' },
    update: {},
    create: {
      id: 'omt-verify-mirror-001',
      title: 'Mirror Decal Verification',
      description: 'Photograph the decal, the fixture and the zone it sits in.',
      type: 'VERIFICATION',
      requirements: [
        { kind: 'photo', label: 'The mirror decal' },
        { kind: 'photo', label: 'Decal from an angle' },
        { kind: 'photo', label: 'Mirror & fixture' },
        // The wide context shot. Useful, and not worth sending an agent back
        // across town for on its own.
        { kind: 'photo', label: 'Reception / locker zone', optional: true },
        { kind: 'location_checkin' },
      ],
      estimatedDurationMins: 15,
    },
  });

  const tmplHealthCheck = await prisma.orderMilestoneTemplate.upsert({
    where: { id: 'omt-health-001' },
    update: {},
    create: {
      id: 'omt-health-001',
      title: 'Health Check',
      description: 'Periodic site visit to confirm the ad is still in good condition.',
      type: 'HEALTH_CHECK',
      requirements: [
        { kind: 'photo', label: 'Current state of the creative' },
        { kind: 'checklist_item', label: 'No damage or vandalism' },
        { kind: 'checklist_item', label: 'Surroundings are clear' },
        { kind: 'location_checkin' },
      ],
      estimatedDurationMins: 15,
    },
  });

  console.log('✅ Order milestone templates created');

  // ─── Milestone plan ───────────────────────────────────────────────────────
  const plan = await prisma.milestonePlan.upsert({
    where: { id: 'plan-standard-001' },
    update: {},
    create: {
      id: 'plan-standard-001',
      name: 'Standard Campaign Plan',
      description: 'Survey → Installation → Verification → Health Check',
    },
  });

  const planItems = [
    { id: 'plan-item-001', planId: plan.id, templateId: tmplSurvey.id, order: 1 },
    { id: 'plan-item-002', planId: plan.id, templateId: tmplInstallation.id, order: 2 },
    { id: 'plan-item-003', planId: plan.id, templateId: tmplVerification.id, order: 3 },
    { id: 'plan-item-004', planId: plan.id, templateId: tmplHealthCheck.id, order: 4, isOptional: true },
  ];

  for (const item of planItems) {
    await prisma.milestonePlanItem.upsert({
      where: { id: item.id },
      update: {},
      create: item,
    });
  }

  console.log('✅ Milestone plan created');

  // ─── Dispatched order milestones (for the agent's ACCEPTED order) ──────────
  // order-adx-9002 is ACCEPTED — this is what the agent should see as field tasks
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const dayAfter = new Date(Date.now() + 48 * 60 * 60 * 1000);

  const orderMilestones = [
    {
      id: 'om-9002-survey',
      orderId: 'order-adx-9002',
      templateId: tmplSurvey.id,
      planId: plan.id,
      assignedAgentId: agentProfile.id,
      status: 'IN_PROGRESS' as const,
      order: 1,
      dueDate: tomorrow,
    },
    {
      id: 'om-9002-install',
      orderId: 'order-adx-9002',
      templateId: tmplInstallation.id,
      planId: plan.id,
      assignedAgentId: agentProfile.id,
      status: 'DISPATCHED' as const,
      order: 2,
      dueDate: dayAfter,
    },
  ];

  for (const om of orderMilestones) {
    await prisma.orderMilestone.upsert({
      where: { id: om.id },
      update: {},
      create: om,
    });
  }

  // Also seed a health check on the VERIFICATION order so the agent has variety
  const inThreeDays = new Date(Date.now() + 72 * 60 * 60 * 1000);
  await prisma.orderMilestone.upsert({
    where: { id: 'om-9981-health' },
    update: {},
    create: {
      id: 'om-9981-health',
      orderId: 'order-adx-9981',
      templateId: tmplHealthCheck.id,
      planId: plan.id,
      assignedAgentId: agentProfile.id,
      status: 'DISPATCHED' as const,
      order: 1,
      dueDate: inThreeDays,
    },
  });

  console.log('✅ Order milestones dispatched to agent');

  // ─── Payout method ────────────────────────────────────────────────────────
  // `BankAccount` left with the retired banking module (DR 04); the wallet's
  // payout method is the record that replaced it.
  await prisma.payoutMethod.upsert({
    where: { id: 'bank-agent-001' },
    update: {},
    create: {
      id: 'bank-agent-001',
      userId: agent.id,
      type: 'BANK',
      accountHolder: 'Shivam Kumar',
      bankName: 'State Bank of India',
      accountNumber: '31298765432100',
      ifscCode: 'SBIN0001234',
      isDefault: true,
      status: 'VERIFIED',
      verifiedAt: new Date(),
    },
  });

  console.log('✅ Payout method created');

  console.log('\n✅ Seed complete!');
  console.log(`   Agent mobile: +919876543210`);
  console.log(`   OTP: call POST /auth/otp/send — code will print to console (dev mode)`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
