import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PB-1 — the doors.
 *
 * Pinned: the desk is ADMIN-only; an address in a PATCH needs
 * `content.addresses` on top of `content.edit` — the owner: "Only admins
 * can change the addresses." — and so does every redirect written by hand;
 * a content page becomes a Studio page only with both the edit and the
 * approve power; the routing table, the sitemap and a page resolved are
 * read without a token, and a previewed page is never cached by a proxy.
 */

const { service } = vi.hoisted(() => ({
  service: {
    listPages: vi.fn(),
    updatePage: vi.fn(),
    createRedirect: vi.fn(),
    createFromContent: vi.fn(),
    routesTable: vi.fn(),
    sitemap: vi.fn(),
    resolvePage: vi.fn(),
  },
}));

vi.mock('../site-pages.service', async (importOriginal) => ({ ...(await importOriginal<typeof import('../site-pages.service')>()), ...service }));

import { PERMISSIONS, signAccessToken } from '../../../shared/auth';
import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { appPagesRouter, appSiteRouter, siteRouter } from '../site-pages.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/site', siteRouter);
  api.use('/app/site', appSiteRouter);
  api.use('/app/pages', appPagesRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const superAdmin = tokenFor(['ADMIN'], 'usr_super');
const editor = signAccessToken('usr_editor', ['ADMIN'], undefined, { perms: PERMISSIONS.filter((id) => id !== 'content.addresses') });
const viewer = signAccessToken('usr_viewer', ['ADMIN'], undefined, { perms: ['content.view', 'content.edit'] });
const publisher = tokenFor(['PUBLISHER'], 'usr_pub');

beforeEach(() => {
  vi.clearAllMocks();
  service.listPages.mockResolvedValue([]);
  service.updatePage.mockResolvedValue({ key: 'diwali' });
  service.createRedirect.mockResolvedValue({ id: 'rd_1' });
  service.createFromContent.mockResolvedValue({ key: 'careers' });
  service.routesTable.mockResolvedValue({ version: 'abc', pages: [], redirects: [] });
  service.sitemap.mockResolvedValue([]);
  service.resolvePage.mockResolvedValue({ key: 'diwali', blocks: [] });
});

describe('the desk', () => {
  it('is ADMIN-only', async () => {
    expect((await request(app()).get('/api/v1/site/pages')).status).toBe(401);
    expect((await request(app()).get('/api/v1/site/pages').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    expect((await request(app()).get('/api/v1/site/pages').set('Authorization', `Bearer ${superAdmin}`)).status).toBe(200);
  });

  it('lets an editor change the title but not the address — that takes content.addresses', async () => {
    const title = await request(app()).patch('/api/v1/site/pages/diwali').set('Authorization', `Bearer ${editor}`).send({ title: 'Diwali 2026' });
    expect(title.status).toBe(200);
    expect(service.updatePage).toHaveBeenCalledWith('diwali', { title: 'Diwali 2026' }, expect.objectContaining({ userId: 'usr_editor' }));

    const address = await request(app()).patch('/api/v1/site/pages/diwali').set('Authorization', `Bearer ${editor}`).send({ path: '/festive' });
    expect(address.status).toBe(403);
    expect(address.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Only an admin with content.addresses may change an address', details: { missing: ['content.addresses'] } });
    expect(service.updatePage).toHaveBeenCalledTimes(1);

    const allowed = await request(app()).patch('/api/v1/site/pages/diwali').set('Authorization', `Bearer ${superAdmin}`).send({ path: '/festive' });
    expect(allowed.status).toBe(200);
    expect(service.updatePage).toHaveBeenLastCalledWith('diwali', { path: '/festive' }, expect.anything());
  });

  it('refuses an empty patch and a key that names no page', async () => {
    expect((await request(app()).patch('/api/v1/site/pages/diwali').set('Authorization', `Bearer ${superAdmin}`).send({})).status).toBe(400);
    expect((await request(app()).patch('/api/v1/site/pages/Not%20A%20Key').set('Authorization', `Bearer ${superAdmin}`).send({ title: 'x' })).status).toBe(404);
    expect(service.updatePage).not.toHaveBeenCalled();
  });

  it('writes a redirect only with content.addresses', async () => {
    const refused = await request(app()).post('/api/v1/site/redirects').set('Authorization', `Bearer ${editor}`).send({ fromPath: '/old', toPath: '/spaces' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.details).toEqual({ missing: ['content.addresses'] });
    const made = await request(app()).post('/api/v1/site/redirects').set('Authorization', `Bearer ${superAdmin}`).send({ fromPath: '/old', toPath: '/spaces' });
    expect(made.status).toBe(201);
    expect(service.createRedirect).toHaveBeenCalledWith({ fromPath: '/old', toPath: '/spaces', permanent: true }, expect.anything());
    expect((await request(app()).delete('/api/v1/site/redirects/rd_1').set('Authorization', `Bearer ${editor}`)).status).toBe(403);
    // content.addresses alone does not remove one — a DELETE names the delete power too.
    const addressOnly = signAccessToken('usr_address', ['ADMIN'], undefined, { perms: ['content.view', 'content.addresses'] });
    const partial = await request(app()).delete('/api/v1/site/redirects/rd_1').set('Authorization', `Bearer ${addressOnly}`);
    expect(partial.status).toBe(403);
    expect(partial.body.error.details).toEqual({ missing: ['content.delete'] });
  });

  it('turns a content page into a Studio page only with edit and approve together', async () => {
    expect((await request(app()).post('/api/v1/site/pages/from-content/careers').set('Authorization', `Bearer ${viewer}`)).status).toBe(403);
    expect((await request(app()).post('/api/v1/site/pages/from-content/careers').set('Authorization', `Bearer ${superAdmin}`)).status).toBe(201);
    expect(service.createFromContent).toHaveBeenCalledWith('careers', expect.anything());
  });
});

describe('the public reads', () => {
  it('answer without a token', async () => {
    const routes = await request(app()).get('/api/v1/app/site/routes');
    expect(routes.status).toBe(200);
    expect(routes.body.data).toEqual({ version: 'abc', pages: [], redirects: [] });
    expect((await request(app()).get('/api/v1/app/site/sitemap')).status).toBe(200);
    const page = await request(app()).get('/api/v1/app/pages/diwali?side=advertiser&preview=tok');
    expect(page.status).toBe(200);
    expect(service.resolvePage).toHaveBeenCalledWith('diwali', expect.objectContaining({ side: 'ADVERTISER', preview: 'tok' }), undefined);
    expect(page.headers['cache-control']).toBeUndefined();
  });

  it('read a token as its side, refuse a bad key, and never let a proxy cache a preview', async () => {
    service.resolvePage.mockResolvedValueOnce({ key: 'diwali', blocks: [], preview: true });
    const preview = await request(app()).get('/api/v1/app/pages/diwali').set('Authorization', `Bearer ${publisher}`);
    expect(preview.status).toBe(200);
    expect(service.resolvePage).toHaveBeenCalledWith('diwali', expect.anything(), ['PUBLISHER']);
    expect(preview.headers['cache-control']).toBe('no-store');
    expect((await request(app()).get('/api/v1/app/pages/Not%20A%20Key')).status).toBe(404);
    expect((await request(app()).get('/api/v1/app/pages/diwali?side=robot')).status).toBe(400);
  });
});
