import { randomBytes } from 'crypto';
import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import { AiUnavailableError, complete } from '../../shared/ai';
import { assertLandingPageQuota, recordLandingPageGeneration } from '../ai';
import { createNotification } from '../notifications';
import { prismaCampaignsRepository as repository } from './prisma-campaigns.repository';
import { getCampaign, type Actor } from './campaigns.service';
import { landingBlockSchema, type LandingBlock, type LandingTheme, type LandingPageListQuery } from './campaigns.schema';
import type { CampaignAggregate, LandingPageRow, LandingPageSummaryRow, LandingPageView } from './campaigns.repository';

/**
 * Lot E (Q7/Q106): the page a printed QR leads to when the advertiser gave
 * no destination of their own.
 *
 * Before this, a code without a `destinationUrl` resolved to a line of plain
 * text — the scan counted, and then nothing. The builder gives the campaign
 * a page: five blocks drafted from the brief by the configured model, edited
 * as JSON by the advertiser (or their agent), published at `/p/:slug`, and
 * rendered here as one self-contained HTML document with a beacon that
 * reports the view and every tap back to the code that brought the visitor.
 *
 * The backend renders it rather than an app, because the reader is a
 * stranger with a phone in front of a hoarding: no login, no bundle, no
 * external asset a slow connection has to fetch before the offer shows.
 *
 * Q139: no age question at launch. Nothing here asks the visitor anything
 * beyond the optional name and phone on the contact form, and that form's
 * submission is counted, not stored — a lead capture is a later decision.
 */

/* ------------------------------------------------------------------ */
/* Slugs                                                               */
/* ------------------------------------------------------------------ */

/** Lower-case, URL-safe, and unlike a package payment token: those are long and random. */
const SUFFIX_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function suffix(length = 4): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += SUFFIX_ALPHABET[bytes[index]! % SUFFIX_ALPHABET.length];
  }
  return out;
}

export function slugBase(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base || 'campaign';
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugBase(name);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = `${base}-${suffix()}`;
    if (!(await repository.landingSlugExists(candidate))) return candidate;
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not allocate a page address');
}

/* ------------------------------------------------------------------ */
/* Drafting from the brief                                             */
/* ------------------------------------------------------------------ */

const SYSTEM = [
  'You draft the landing page a person reaches after scanning a QR code on an out-of-home advertisement in India.',
  'Answer with ONE JSON object and nothing else — no prose, no code fence.',
  'Shape: {"hero":{"headline":string,"subheadline":string},"offer":{"title":string,"body":string,"highlight":string},"cta":{"label":string},"contact":{"note":string}}.',
  'Headline under 60 characters, subheadline under 160, offer body two or three plain sentences, CTA label under 30 characters.',
  'Plain English. No invented prices, discounts, dates or claims that were not in the brief. No superlatives.',
].join(' ');

function briefLines(campaign: CampaignAggregate): string {
  const markets = campaign.targetMarkets.length ? campaign.targetMarkets.join(', ') : campaign.targetMarket;
  const lines = Object.entries({
    Campaign: campaign.name,
    Brand: campaign.brandName ?? campaign.brand?.name ?? campaign.advertiser.companyName ?? campaign.advertiser.name,
    Product: campaign.productName,
    Industry: [campaign.industry, campaign.subCategory].filter(Boolean).join(' / ') || undefined,
    Goal: campaign.goal,
    'Brand awareness': campaign.awareness,
    Strategy: campaign.strategy,
    Audience: campaign.persona,
    Where: campaign.targetLocation ?? markets ?? undefined,
    Runs:
      campaign.startDate && campaign.endDate
        ? `${campaign.startDate.toISOString().slice(0, 10)} to ${campaign.endDate.toISOString().slice(0, 10)}`
        : undefined,
  })
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    .map(([label, value]) => `${label}: ${String(value).trim()}`);
  return lines.join('\n');
}

/** The first JSON object in a model's answer, however it was wrapped. */
export function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const str = (value: unknown, max: number, fallback = ''): string =>
  (typeof value === 'string' ? value.trim() : fallback).slice(0, max);

/**
 * The five blocks, from the model's answer and the brief.
 *
 * The model writes the words; the structure is ours. A CTA with the
 * campaign's own destination becomes a link with the code's UTM tags; one
 * without opens the form. The gallery starts as three empty frames — the
 * advertiser drops their photographs in through the PATCH.
 */
export function blocksFrom(
  draft: Record<string, unknown>,
  campaign: CampaignAggregate,
  destinationUrl: string | null
): LandingBlock[] {
  const hero = (draft['hero'] ?? {}) as Record<string, unknown>;
  const offer = (draft['offer'] ?? {}) as Record<string, unknown>;
  const cta = (draft['cta'] ?? {}) as Record<string, unknown>;
  const contact = (draft['contact'] ?? {}) as Record<string, unknown>;
  const brand = campaign.brandName ?? campaign.brand?.name ?? campaign.advertiser.name;

  const blocks: LandingBlock[] = [
    {
      type: 'hero',
      headline: str(hero['headline'], 120, `${brand}`),
      subheadline: str(hero['subheadline'], 240, campaign.productName ?? ''),
      imageUrl: null,
    },
    {
      type: 'offer',
      title: str(offer['title'], 120, 'What we offer'),
      body: str(offer['body'], 800, ''),
      highlight: str(offer['highlight'], 80),
    },
    {
      type: 'cta',
      label: str(cta['label'], 60, 'Get in touch'),
      href: destinationUrl,
    },
    {
      type: 'contact',
      note: str(contact['note'], 240, 'Leave your name and number and we will call you back.'),
      formEnabled: true,
    },
    { type: 'gallery', images: [], placeholders: 3 },
  ];

  // Every block through the same validator the PATCH uses, so a page the
  // model drafted and a page a person typed are held to one shape.
  return blocks.map((block) => landingBlockSchema.parse(block));
}

type QrConfig = { destinationUrl?: string };

/**
 * Drafts (or redrafts) the page from the brief.
 *
 * Refused on a PUBLISHED page: a redraft would replace, in one call, what a
 * printed code is already sending people to. Edit it, or have ADX unpublish
 * it first. E7-2 (Lot E addendum 2): the same regeneration quota the listing
 * drafts use — `ai.assertLandingPageQuota` before the model (429
 * QUOTA_EXHAUSTED when spent), an `AiGeneration` row (advertiserId,
 * subjectKey = campaign id, kind LANDING_PAGE) after it answers, so a vendor
 * outage spends nothing — beside the audit row with the vendor and model.
 */
export async function generateLandingPage(campaignId: string, actor: Actor): Promise<LandingPageRow> {
  const campaign = await getCampaign(campaignId, actor);
  const existing = await repository.findLandingPage(campaignId);
  if (existing?.status === 'PUBLISHED') {
    throw new ApiError(
      409,
      'CONFLICT',
      'This page is live. Edit it, or ask ADX to unpublish it before drafting a new one.'
    );
  }

  const quota = await assertLandingPageQuota(campaign.advertiserId, campaignId);

  let result;
  try {
    result = await complete({
      system: SYSTEM,
      prompt: `Draft the landing page for this campaign.\n\n${briefLines(campaign)}`,
      maxTokens: 600,
      temperature: 0.7,
    });
  } catch (cause) {
    if (cause instanceof AiUnavailableError) {
      throw new ApiError(503, 'AI_UNAVAILABLE', cause.message);
    }
    throw new ApiError(502, 'AI_FAILED', (cause as Error).message);
  }

  const draft = extractJson(result.text);
  if (!draft) {
    throw new ApiError(502, 'AI_FAILED', 'The model did not answer with a page. Try again.');
  }

  // Recorded once the model has answered with a page — an outage or an
  // unreadable answer spends no draft.
  await recordLandingPageGeneration({
    advertiserId: campaign.advertiserId,
    campaignId,
    provider: result.provider,
    model: result.model,
    output: result.text,
  });

  const destination = ((campaign.trackingConfig ?? {}) as QrConfig).destinationUrl ?? null;
  const blocks = blocksFrom(draft, campaign, destination);

  const page = existing
    ? await repository.updateLandingPage(campaignId, {
        blocks: blocks as never,
        generatedByAi: true,
        version: existing.version + 1,
      })
    : await repository.createLandingPage({
        campaignId,
        slug: await uniqueSlug(campaign.name),
        blocks: blocks as never,
        theme: null,
        generatedByAi: true,
        createdByUserId: actor.userId,
      });

  await logActivity(actor.userId, 'LANDING_PAGE_GENERATED', {
    targetType: 'LandingPage',
    targetId: page.id,
    module: 'campaigns',
    metadata: {
      campaignId,
      version: page.version,
      provider: result.provider,
      model: result.model,
      redraft: existing !== null,
      quota: { used: quota.used + 1, quota: quota.quota, paid: quota.paid },
    },
  });

  return page;
}

/* ------------------------------------------------------------------ */
/* Reading, editing, publishing                                        */
/* ------------------------------------------------------------------ */

export async function getLandingPage(campaignId: string, actor: Actor): Promise<LandingPageRow> {
  await getCampaign(campaignId, actor);
  const page = await repository.findLandingPage(campaignId);
  if (!page) throw new ApiError(404, 'NOT_FOUND', 'This campaign has no landing page yet. Generate one first.');
  return page;
}

/** The public address of a page — what `GET /p/:slug` answers on. */
export const landingPageUrl = (slug: string): string => `/p/${slug}`;

/** The page as every builder read answers it: the row with its `url` beside the blocks. */
export function withLandingUrl<T extends { slug: string }>(page: T): T & { url: string } {
  return { ...page, url: landingPageUrl(page.slug) };
}

/**
 * E11-2: what `GET /campaigns/:id` carries — enough for the detail screen to
 * say the campaign has a page and whether it is live, without the blocks.
 * One narrow read through the relation; null when there is no page.
 */
export type LandingPageSummary = LandingPageSummaryRow & { url: string };

export async function landingPageSummary(campaignId: string): Promise<LandingPageSummary | null> {
  const page = await repository.landingPageSummary(campaignId);
  if (!page) return null;
  return {
    id: page.id,
    slug: page.slug,
    status: page.status,
    url: landingPageUrl(page.slug),
    publishedAt: page.publishedAt,
  };
}

/**
 * An edit. Applies at once, live page included — the advertiser fixing a
 * typo on a page a hoarding points at should not need ADX to take it down
 * first. Every edit is a version, so the trail can say what the page said
 * when a given scan happened.
 */
export async function patchLandingPage(
  campaignId: string,
  actor: Actor,
  patch: { blocks?: LandingBlock[] | undefined; theme?: LandingTheme | null | undefined }
): Promise<LandingPageRow> {
  const page = await getLandingPage(campaignId, actor);
  const updated = await repository.updateLandingPage(campaignId, {
    ...(patch.blocks === undefined ? {} : { blocks: patch.blocks as never }),
    ...(patch.theme === undefined ? {} : { theme: patch.theme as never }),
    version: page.version + 1,
  });
  await logActivity(actor.userId, 'LANDING_PAGE_UPDATED', {
    targetType: 'LandingPage',
    targetId: page.id,
    module: 'campaigns',
    metadata: { campaignId, version: updated.version, fields: Object.keys(patch) },
  });
  return updated;
}

/** A page needs something to say before a code may send people to it. */
function assertPublishable(blocks: unknown): void {
  const parsed = Array.isArray(blocks) ? blocks : [];
  if (!parsed.some((block) => (block as { type?: string }).type === 'hero')) {
    throw new ApiError(409, 'CONFLICT', 'The page needs a hero block before it can be published.');
  }
}

export async function publishLandingPage(campaignId: string, actor: Actor): Promise<LandingPageRow> {
  const page = await getLandingPage(campaignId, actor);
  if (page.status === 'PUBLISHED') return page;
  assertPublishable(page.blocks);
  const published = await repository.updateLandingPage(campaignId, {
    status: 'PUBLISHED',
    publishedAt: new Date(),
  });
  await logActivity(actor.userId, 'LANDING_PAGE_PUBLISHED', {
    targetType: 'LandingPage',
    targetId: page.id,
    module: 'campaigns',
    metadata: { campaignId, slug: page.slug, version: page.version },
  });
  return published;
}

/**
 * ADX takes a page down — content that should not be on a hoarding's other
 * end. The code keeps resolving: it falls back to the plain page the scan
 * always had, so the count is never lost. The campaign's owner is told why.
 */
export async function unpublishLandingPage(
  campaignId: string,
  adminUserId: string,
  reason: string
): Promise<LandingPageView> {
  const page = await repository.findLandingPage(campaignId);
  if (!page) throw new ApiError(404, 'NOT_FOUND', 'This campaign has no landing page.');
  if (page.status !== 'PUBLISHED') {
    throw new ApiError(409, 'CONFLICT', 'This page is not published.');
  }
  const campaign = await repository.findCampaignBare(campaignId);

  const updated = await repository.updateLandingPage(campaignId, { status: 'DRAFT', publishedAt: null });
  await logActivity(adminUserId, 'LANDING_PAGE_UNPUBLISHED', {
    targetType: 'LandingPage',
    targetId: page.id,
    module: 'campaigns',
    metadata: { campaignId, slug: page.slug, version: page.version, reason },
  });

  if (campaign) {
    void createNotification({
      userId: campaign.createdByUserId,
      type: 'SYSTEM',
      title: 'Your landing page was taken down',
      subtitle: campaign.name,
      message: `ADX unpublished the landing page for "${campaign.name}". ${reason} Scans still count; edit the page and publish it again.`,
      relatedId: campaignId,
      relatedType: 'CAMPAIGN',
    }).catch(() => {});
  }

  // T-B: the answer is the review list's row — the page with its campaign
  // and advertiser beside it — so the desk updates the row it just acted on.
  return (await repository.findLandingPageView(campaignId)) ?? { ...updated, campaign: null };
}

export async function listLandingPages(query: LandingPageListQuery) {
  return repository.listLandingPages(query);
}

/** The PUBLISHED page for a campaign's code to redirect to, or null. */
export async function publishedSlugFor(campaignId: string): Promise<string | null> {
  const page = await repository.findLandingPage(campaignId);
  return page?.status === 'PUBLISHED' ? page.slug : null;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** An href that can only be http(s) — the schema says so, and this says it again at the edge. */
function safeHref(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? escapeHtml(value) : null;
}

const e = escapeHtml;

function renderBlock(block: LandingBlock, index: number): string {
  switch (block.type) {
    case 'hero':
      return [
        `<header class="hero">`,
        block.imageUrl && safeHref(block.imageUrl)
          ? `<img class="hero-image" src="${safeHref(block.imageUrl)}" alt="">`
          : '',
        `<h1>${e(block.headline)}</h1>`,
        block.subheadline ? `<p class="sub">${e(block.subheadline)}</p>` : '',
        `</header>`,
      ].join('');
    case 'offer':
      return [
        `<section class="offer">`,
        `<h2>${e(block.title)}</h2>`,
        block.highlight ? `<p class="highlight">${e(block.highlight)}</p>` : '',
        block.body ? `<p>${e(block.body)}</p>` : '',
        `</section>`,
      ].join('');
    case 'cta': {
      const href = safeHref(block.href);
      const label = e(block.label);
      return href
        ? `<p class="cta"><a class="button" data-cta="${label}" href="${href}" rel="noopener">${label}</a></p>`
        : `<p class="cta"><a class="button" data-cta="${label}" href="#contact">${label}</a></p>`;
    }
    case 'contact':
      return [
        `<section class="contact" id="contact">`,
        `<h2>Get in touch</h2>`,
        block.note ? `<p>${e(block.note)}</p>` : '',
        block.phone ? `<p><a data-cta="Call" href="tel:${e(block.phone.replace(/[^+\d]/g, ''))}">${e(block.phone)}</a></p>` : '',
        block.email ? `<p><a data-cta="Email" href="mailto:${e(block.email)}">${e(block.email)}</a></p>` : '',
        block.address ? `<p>${e(block.address)}</p>` : '',
        block.hours ? `<p class="muted">${e(block.hours)}</p>` : '',
        block.formEnabled
          ? [
              `<form id="lead-form" autocomplete="on">`,
              `<label>Your name<input name="name" maxlength="80" required></label>`,
              `<label>Phone<input name="phone" type="tel" maxlength="20" required></label>`,
              `<button class="button" type="submit">Send</button>`,
              `</form>`,
              `<p id="lead-thanks" hidden>Thank you. We will be in touch.</p>`,
            ].join('')
          : '',
        `</section>`,
      ].join('');
    case 'gallery': {
      const frames = block.images
        .map((image) => {
          const src = safeHref(image.url);
          return src ? `<figure><img src="${src}" alt="${e(image.alt ?? '')}" loading="lazy"></figure>` : '';
        })
        .join('');
      const empties = Array.from({ length: block.placeholders }, () => `<figure class="placeholder" aria-hidden="true"></figure>`).join('');
      return frames || empties ? `<section class="gallery" data-block="${index}">${frames}${empties}</section>` : '';
    }
  }
}

const STYLES = (theme: LandingTheme | null) => {
  const primary = theme?.primaryColor ?? '#0f172a';
  const accent = theme?.accentColor ?? '#2563eb';
  const font = theme?.font === 'serif' ? 'Georgia, "Times New Roman", serif' : 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  return `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;font-family:${font};color:${primary};background:#fff;line-height:1.5}main{max-width:640px;margin:0 auto;padding:24px 16px 48px}.hero{text-align:center;padding:24px 0 8px}.hero-image{width:100%;max-height:320px;object-fit:cover;border-radius:12px;margin-bottom:16px}h1{font-size:1.9rem;line-height:1.2;margin:0 0 8px}h2{font-size:1.25rem;margin:24px 0 8px}.sub{font-size:1.05rem;opacity:.85;margin:0}.highlight{font-weight:700;color:${accent};margin:0 0 8px}.cta{text-align:center;margin:24px 0}.button{display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:600;font-size:1.05rem;border:0;cursor:pointer}.contact form{display:grid;gap:12px;margin-top:12px}.contact label{display:grid;gap:4px;font-size:.9rem}.contact input{font:inherit;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px}.muted{opacity:.7}.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-top:16px}.gallery figure{margin:0;aspect-ratio:4/3;border-radius:8px;overflow:hidden;background:#f1f5f9}.gallery img{width:100%;height:100%;object-fit:cover}.placeholder{border:2px dashed #cbd5e1}footer{text-align:center;font-size:.75rem;opacity:.6;margin-top:32px}[hidden]{display:none!important}`;
};

/**
 * The beacon. Reports VIEW on load, CTA_CLICK on any `[data-cta]` tap, and
 * FORM_SUBMIT when the contact form goes in — to `POST /t/:code/e`, the
 * code being the `c` the scan redirect appended. Without a code (someone
 * opened the page by its address) nothing is sent: an unattributed view is
 * not a measurement. `keepalive` so a tap that navigates away still lands.
 */
const BEACON = `(function(){var c=new URLSearchParams(location.search).get('c');if(!c||!/^[A-Z0-9]{4,16}$/.test(c))return;function send(t,l){try{var b={type:t};if(l)b.ctaLabel=String(l).slice(0,80);fetch('/t/'+c+'/e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b),keepalive:true}).catch(function(){})}catch(e){}}send('VIEW');Array.prototype.forEach.call(document.querySelectorAll('[data-cta]'),function(el){el.addEventListener('click',function(){send('CTA_CLICK',el.getAttribute('data-cta'))})});var f=document.getElementById('lead-form');if(f){f.addEventListener('submit',function(ev){ev.preventDefault();send('FORM_SUBMIT');f.hidden=true;var t=document.getElementById('lead-thanks');if(t)t.hidden=false})}})();`;

/**
 * One self-contained document. No stylesheet, script or font is fetched
 * from anywhere — the only outbound requests a visitor's phone makes are
 * the gallery images the advertiser chose and the beacon to this host.
 */
export function renderLandingPage(page: { blocks: unknown; theme: unknown }, title: string): string {
  const blocks = (Array.isArray(page.blocks) ? page.blocks : [])
    .map((block) => landingBlockSchema.safeParse(block))
    .filter((result) => result.success)
    .map((result) => result.data);
  const theme = (page.theme ?? null) as LandingTheme | null;
  const hero = blocks.find((block) => block.type === 'hero');
  const pageTitle = hero && hero.type === 'hero' ? hero.headline : title;

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${e(pageTitle)}</title>`,
    `<style>${STYLES(theme)}</style>`,
    '</head>',
    '<body>',
    '<main>',
    ...blocks.map((block, index) => renderBlock(block, index)),
    '<footer>Powered by ADX</footer>',
    '</main>',
    `<script>${BEACON}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}
