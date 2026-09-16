import { describe, expect, it } from 'vitest';
import { ParseError, parseFeed, parseHtml, parseJson, pathValue } from '../scraper/scraper.parse';

/**
 * The parser is the fragile half of the scraper: it reads somebody else's
 * markup, and that markup changes without warning. Kept pure so it can be
 * tested without a network, and tested hard because a wrong read here becomes a
 * surge window that lifts real prices.
 */

describe('HTML', () => {
    const page = `
    <div class="event">
      <h3>IPL Final</h3>
      <span class="from">2026-05-24</span>
      <span class="to">2026-05-25</span>
      <span class="where">Wankhede Stadium</span>
      <span class="city">Mumbai</span>
      <span class="lift">25%</span>
    </div>
    <div class="event">
      <h3>Ganesh Chaturthi</h3>
      <span class="from">2026-09-14</span>
      <span class="city">Mumbai</span>
    </div>`;

    const map = {
        container: '.event',
        name: 'h3',
        startsAt: '.from',
        endsAt: '.to',
        venue: '.where',
        city: '.city',
        uplift: '.lift',
    };

    it('reads every record the container matches', () => {
        const records = parseHtml(page, map);
        expect(records).toHaveLength(2);
        expect(records[0]?.name).toBe('IPL Final');
        expect(records[0]?.venue).toBe('Wankhede Stadium');
        expect(records[0]?.startsAt?.toISOString().slice(0, 10)).toBe('2026-05-24');
    });

    it('leaves absent fields null rather than inventing them', () => {
        const records = parseHtml(page, map);
        expect(records[1]?.endsAt).toBeNull();
        expect(records[1]?.venue).toBeNull();
        expect(records[1]?.upliftPct).toBeNull();
    });

    /**
     * A record with no name cannot become a window an operator would recognise
     * in a list, so it is dropped rather than published as "Untitled".
     */
    it('drops a record with no name', () => {
        const records = parseHtml('<div class="event"><span class="from">2026-01-01</span></div>', map);
        expect(records).toHaveLength(0);
    });

    it('returns nothing when the selectors match nothing', () => {
        // The site-redesign case. Empty is right; the run reports NO_MATCHES.
        expect(parseHtml('<main><p>Nothing here</p></main>', map)).toHaveLength(0);
    });

    it('refuses a field map with no container or name', () => {
        expect(() => parseHtml(page, { name: 'h3' })).toThrow(ParseError);
        expect(() => parseHtml(page, { container: '.event' })).toThrow(ParseError);
    });
});

describe('uplift', () => {
    const one = (lift: string) =>
        parseHtml(`<div class="e"><h3>X</h3><span class="l">${lift}</span></div>`, {
            container: '.e',
            name: 'h3',
            uplift: '.l',
        })[0]?.upliftPct;

    it('accepts a percentage and a fraction, since sources write both', () => {
        expect(one('25%')).toBe('0.2500');
        expect(one('0.25')).toBe('0.2500');
    });

    /**
     * A bare "25" read as a fraction is a 2400% lift. Guessing which was meant
     * would eventually guess wrong on a live price, so it is refused and the
     * source default applies instead.
     */
    it('refuses a bare number above one rather than guessing', () => {
        expect(one('25')).toBeNull();
    });

    it('refuses nonsense', () => {
        expect(one('lots')).toBeNull();
        expect(one('-10%')).toBeNull();
    });
});

describe('dates', () => {
    /**
     * An unreadable date must not fall back to today: a window silently dated
     * now would lift prices across a period the event never occupied.
     */
    it('leaves an unreadable date null', () => {
        const records = parseHtml(
            '<div class="e"><h3>X</h3><span class="d">next Tuesday-ish</span></div>',
            { container: '.e', name: 'h3', startsAt: '.d' }
        );
        expect(records[0]?.startsAt).toBeNull();
    });
});

describe('JSON', () => {
    const body = JSON.stringify({
        data: {
            events: [
                { title: 'Diwali Mela', start: '2026-11-08', venue: { name: 'BKC' }, id: 'e1' },
                { title: 'Kala Ghoda', start: '2026-02-01', id: 'e2' },
            ],
        },
    });

    it('reads an array at a dotted path', () => {
        const records = parseJson(body, {
            container: 'data.events',
            name: 'title',
            startsAt: 'start',
            ref: 'id',
        });
        expect(records).toHaveLength(2);
        expect(records[0]?.externalRef).toBe('e1');
    });

    it('reads nested values by path', () => {
        expect(pathValue(JSON.parse(body), 'data.events')).toHaveLength(2);
        expect(pathValue({ a: { b: 'c' } }, 'a.b')).toBe('c');
        expect(pathValue({ a: 1 }, 'a.b.c')).toBeUndefined();
    });

    it('says so when the path holds nothing array-shaped', () => {
        expect(() => parseJson(body, { container: 'data.missing', name: 'title' })).toThrow(
            ParseError
        );
    });

    it('says so when the body is not JSON at all', () => {
        expect(() => parseJson('<html></html>', { name: 'title' })).toThrow(ParseError);
    });
});

describe('feeds', () => {
    const rss = `<?xml version="1.0"?>
    <rss><channel>
      <item>
        <title>Sunburn Goa</title>
        <pubDate>2026-12-28T00:00:00Z</pubDate>
        <guid>sunburn-2026</guid>
      </item>
    </channel></rss>`;

    /**
     * A feed has a fixed shape, so the field map is optional here. Asking an
     * operator to configure `title` and `pubDate` would be asking them to
     * restate a standard.
     */
    it('reads a feed with no field map at all', () => {
        const records = parseFeed(rss, {});
        expect(records).toHaveLength(1);
        expect(records[0]?.name).toBe('Sunburn Goa');
        expect(records[0]?.externalRef).toBe('sunburn-2026');
        expect(records[0]?.startsAt?.toISOString().slice(0, 10)).toBe('2026-12-28');
    });

    it('reads Atom entries as well as RSS items', () => {
        const atom = `<?xml version="1.0"?>
        <feed><entry><title>NH7 Weekender</title><published>2026-11-20T00:00:00Z</published></entry></feed>`;
        expect(parseFeed(atom, {})[0]?.name).toBe('NH7 Weekender');
    });
});
