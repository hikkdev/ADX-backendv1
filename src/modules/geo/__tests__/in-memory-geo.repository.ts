import { CITY_STAGES, type CityStageValue } from '../../pricing';
import type {
  CityCounts,
  CityKey,
  CityMatch,
  CityListFilter,
  GeoCityPatch,
  GeoCityRow,
  GeoDistrictRow,
  GeoRepository,
  GeoStateRow,
  LiveListingRef,
  ListingPoint,
  MapBounds,
  MapPoint,
  NewGeoCity,
  NewGeoDistrict,
  NewGeoState,
  NewRolloutEvent,
  RolloutEventRow,
  StageCounts,
} from '../geo.repository';
import { WIND_DOWN_MARK } from '../prisma-geo.repository';

/**
 * The `GeoRepository` over Maps — the same contract the Prisma one keeps
 * (`createMany` skips duplicates by slug and by GeoNames id; updates are
 * per row; the party counts come from whatever the test seeds into
 * `parties`), so the seed, the stage machine and the wind-down are pinned
 * without a database.
 */
export class InMemoryGeoRepository implements GeoRepository {
  states: GeoStateRow[] = [];
  districts: GeoDistrictRow[] = [];
  cities: GeoCityRow[] = [];
  events: RolloutEventRow[] = [];
  /**
   * What the party tables would say, keyed by lower-cased city spelling —
   * or, Lot X-B, by `id:<cityId>` for a row that carries the key (found
   * whatever it was typed as). A spelling entry stands for rows whose key
   * is null: a typed town, or a row from before an alias was taught.
   */
  parties = {
    publishers: new Map<string, number>(),
    listingsLive: new Map<string, LiveListingRef[]>(),
    /** Y-B: where the live listings are; a live listing not placed here has no coordinates. */
    listingPoints: new Map<string, ListingPoint[]>(),
    listingsTotal: new Map<string, number>(),
    advertisers: new Map<string, number>(),
    agents: new Map<string, { userId: string; side: 'publisher' | 'advertiser' }[]>(),
    printPartners: new Map<string, number>(),
    openLeads: new Map<string, number>(),
  };
  rateCards: { cityId: string | null; name: string }[] = [];
  vocabulary = true;
  writes = 0;
  private seq = 0;

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  /** Lot X-B: the keys a match reads — the city's id entry, then each spelling. */
  private keysOf(city: CityMatch): string[] {
    return [`id:${city.cityId}`, ...city.spellings.map((s) => s.toLowerCase())];
  }
  private sum(map: Map<string, number>, city: CityMatch): number {
    return this.keysOf(city).reduce((n, key) => n + (map.get(key) ?? 0), 0);
  }

  /* ── states and districts ─────────────────────────────────────── */

  async listStates(): Promise<GeoStateRow[]> {
    return [...this.states].sort((a, b) => a.name.localeCompare(b.name));
  }
  async findStateByCode(code: string): Promise<GeoStateRow | null> {
    return this.states.find((s) => s.code === code) ?? null;
  }
  async createStates(rows: NewGeoState[]): Promise<number> {
    this.writes += rows.length > 0 ? 1 : 0;
    let n = 0;
    for (const row of rows) {
      if (this.states.some((s) => s.code === row.code)) continue;
      this.states.push({ id: this.id('st'), ...row });
      n += 1;
    }
    return n;
  }
  async updateState(id: string, patch: Partial<NewGeoState>): Promise<void> {
    this.writes += 1;
    Object.assign(this.states.find((s) => s.id === id)!, patch);
  }
  async listDistricts(stateId?: string): Promise<GeoDistrictRow[]> {
    return this.districts.filter((d) => !stateId || d.stateId === stateId);
  }
  async findDistrict(id: string): Promise<GeoDistrictRow | null> {
    return this.districts.find((d) => d.id === id) ?? null;
  }
  async createDistricts(rows: NewGeoDistrict[]): Promise<number> {
    this.writes += rows.length > 0 ? 1 : 0;
    let n = 0;
    for (const row of rows) {
      if (this.districts.some((d) => d.stateId === row.stateId && d.code === row.code)) continue;
      this.districts.push({ id: this.id('di'), ...row });
      n += 1;
    }
    return n;
  }
  async updateDistrict(id: string, patch: Partial<NewGeoDistrict>): Promise<void> {
    this.writes += 1;
    Object.assign(this.districts.find((d) => d.id === id)!, patch);
  }

  /* ── cities ───────────────────────────────────────────────────── */

  async listCityKeys(): Promise<CityKey[]> {
    return this.cities.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      state: c.state,
      aliases: [...c.aliases],
      stateId: c.stateId,
      districtId: c.districtId,
      latitude: c.latitude,
      longitude: c.longitude,
      population: c.population,
      kind: c.kind,
      geonameId: c.geonameId,
      source: c.source,
    }));
  }
  async createCities(rows: NewGeoCity[]): Promise<number> {
    this.writes += rows.length > 0 ? 1 : 0;
    let n = 0;
    for (const row of rows) {
      if (this.cities.some((c) => c.slug === row.slug || (row.geonameId !== null && c.geonameId === row.geonameId))) continue;
      this.cities.push(this.materialise({ id: this.id('city'), ...row, launchedAt: null, pausedAt: null, withdrawnAt: null, rolloutNote: null }));
      n += 1;
    }
    return n;
  }
  private materialise(row: Omit<GeoCityRow, 'geoState' | 'geoDistrict'>): GeoCityRow {
    const state = this.states.find((s) => s.id === row.stateId);
    const district = this.districts.find((d) => d.id === row.districtId);
    return { ...row, switches: { ...row.switches }, geoState: state ? { code: state.code, name: state.name } : null, geoDistrict: district ? { code: district.code, name: district.name } : null };
  }
  async updateCity(id: string, patch: GeoCityPatch): Promise<GeoCityRow> {
    this.writes += 1;
    const index = this.cities.findIndex((c) => c.id === id);
    if (index < 0) throw new Error(`no city ${id}`);
    const current = this.cities[index]!;
    const { switches, ...rest } = patch;
    const next = this.materialise({ ...current, ...rest, switches: { ...current.switches, ...(switches ?? {}) } });
    this.cities[index] = next;
    return next;
  }
  async updateCities(updates: { id: string; patch: GeoCityPatch }[]): Promise<number> {
    if (updates.length === 0) return 0;
    for (const { id, patch } of updates) await this.updateCity(id, patch);
    this.writes -= updates.length - 1; // one transaction
    return updates.length;
  }
  async findCityBySlug(slug: string): Promise<GeoCityRow | null> {
    return this.cities.find((c) => c.slug === slug) ?? null;
  }
  async findCitiesBySlugs(slugs: string[]): Promise<GeoCityRow[]> {
    return this.cities.filter((c) => slugs.includes(c.slug));
  }
  async findCitiesIn(scope: { stateId?: string; districtId?: string }): Promise<GeoCityRow[]> {
    return this.cities.filter((c) => (!scope.stateId || c.stateId === scope.stateId) && (!scope.districtId || c.districtId === scope.districtId));
  }
  private matches(c: GeoCityRow, filter: CityListFilter, withStage: boolean): boolean {
    if (filter.stateId && c.stateId !== filter.stateId) return false;
    if (filter.districtId && c.districtId !== filter.districtId) return false;
    if (withStage && filter.stage?.length && !filter.stage.includes(c.stage)) return false;
    if (filter.kind?.length && (!c.kind || !filter.kind.includes(c.kind))) return false;
    if (filter.minPopulation !== undefined && (c.population ?? 0) < filter.minPopulation) return false;
    if (filter.q) {
      const q = filter.q.toLowerCase();
      if (!c.name.toLowerCase().includes(q) && !c.aliases.includes(q) && !c.slug.startsWith(q)) return false;
    }
    return true;
  }
  async listCities(filter: CityListFilter): Promise<{ items: GeoCityRow[]; total: number; counts: StageCounts }> {
    const all = this.cities.filter((c) => this.matches(c, filter, true));
    all.sort((a, b) => (filter.sort === 'name' ? a.name.localeCompare(b.name) : (b.population ?? -1) - (a.population ?? -1) || a.name.localeCompare(b.name)));
    const counts = this.countStages(this.cities.filter((c) => this.matches(c, filter, false)));
    const start = (filter.page - 1) * filter.pageSize;
    return { items: all.slice(start, start + filter.pageSize), total: all.length, counts };
  }
  private countStages(rows: GeoCityRow[]): StageCounts {
    const counts = {} as StageCounts;
    for (const stage of CITY_STAGES) counts[stage] = 0;
    for (const row of rows) counts[row.stage] += 1;
    return counts;
  }
  async stageCounts(): Promise<StageCounts> {
    return this.countStages(this.cities);
  }
  async stageCountsByState() {
    const out = new Map<string, number>();
    for (const c of this.cities) if (c.stateId) out.set(`${c.stateId}|${c.stage}`, (out.get(`${c.stateId}|${c.stage}`) ?? 0) + 1);
    return [...out].map(([key, count]) => {
      const [stateId, stage] = key.split('|') as [string, CityStageValue];
      return { stateId, stage, count };
    });
  }
  async stageCountsByDistrict(stateId: string) {
    const out = new Map<string, number>();
    for (const c of this.cities) if (c.stateId === stateId && c.districtId) out.set(`${c.districtId}|${c.stage}`, (out.get(`${c.districtId}|${c.stage}`) ?? 0) + 1);
    return [...out].map(([key, count]) => {
      const [districtId, stage] = key.split('|') as [string, CityStageValue];
      return { districtId, stage, count };
    });
  }
  async mapPoints(bounds: MapBounds | null, stages: readonly CityStageValue[] | null): Promise<MapPoint[]> {
    return this.cities
      .filter((c) => c.latitude !== null && c.longitude !== null)
      .filter((c) => !bounds || (c.latitude! >= bounds.minLat && c.latitude! <= bounds.maxLat && c.longitude! >= bounds.minLng && c.longitude! <= bounds.maxLng))
      .filter((c) => !stages?.length || stages.includes(c.stage))
      .map(({ id, slug, name, stage, latitude, longitude, population, kind }) => ({ id, slug, name, stage, latitude, longitude, population, kind }));
  }
  async pickerCities(input: { stages: readonly CityStageValue[]; plannedCapitals: boolean; q?: string | undefined; limit: number }): Promise<GeoCityRow[]> {
    return this.cities
      .filter((c) => input.stages.includes(c.stage) || (input.plannedCapitals && c.stage === 'PLANNED' && (c.kind === 'NATIONAL_CAPITAL' || c.kind === 'STATE_CAPITAL')))
      .filter((c) => !input.q || c.name.toLowerCase().startsWith(input.q.toLowerCase()) || c.aliases.includes(input.q.toLowerCase()))
      .sort((a, b) => (b.population ?? -1) - (a.population ?? -1))
      .slice(0, input.limit);
  }

  /* ── events ───────────────────────────────────────────────────── */

  async createRolloutEvents(events: NewRolloutEvent[]): Promise<number> {
    for (const event of events) this.events.push({ ...event, id: this.id('ev'), at: event.at ?? new Date() });
    return events.length;
  }
  async listRolloutEvents(cityId: string, limit: number): Promise<RolloutEventRow[]> {
    return this.events.filter((e) => e.cityId === cityId).reverse().slice(0, limit);
  }
  async withdrawnCities() {
    return this.cities
      .filter((c) => c.stage === 'WITHDRAWN')
      .map((city) => {
        const marks = this.events.filter((e) => e.cityId === city.id && e.note === WIND_DOWN_MARK);
        return { city, woundDownAt: marks.length ? marks[marks.length - 1]!.at : null };
      });
  }

  /* ── aggregates ───────────────────────────────────────────────── */

  async cityCounts(city: CityMatch): Promise<CityCounts> {
    const p = this.parties;
    return {
      publishers: this.sum(p.publishers, city),
      listingsLive: (await this.activeListings(city)).length,
      listingsTotal: this.sum(p.listingsTotal, city),
      advertisers: this.sum(p.advertisers, city),
      agents: (await this.agentUserIds(city)).length,
      printPartners: this.sum(p.printPartners, city),
      openLeads: this.sum(p.openLeads, city),
    };
  }
  async liveListingsByCity(cities: CityMatch[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const city of cities) {
      const n = (await this.activeListings(city)).length;
      if (n) out.set(city.cityId, n);
    }
    return out;
  }
  async rateCardInForce(cityId: string) {
    const card = this.rateCards.find((c) => c.cityId === cityId) ?? this.rateCards.find((c) => c.cityId === null);
    return card ? { cardId: 'card', name: card.name, national: card.cityId === null } : null;
  }
  async activeAgentsBySide(city: CityMatch) {
    const agents = this.keysOf(city).flatMap((key) => this.parties.agents.get(key) ?? []);
    return { publisher: agents.filter((a) => a.side === 'publisher').length, advertiser: agents.filter((a) => a.side === 'advertiser').length };
  }
  async activePrintPartners(city: CityMatch): Promise<number> {
    return this.sum(this.parties.printPartners, city);
  }
  async vocabularyPresent(): Promise<boolean> {
    return this.vocabulary;
  }
  async activeListings(city: CityMatch): Promise<LiveListingRef[]> {
    const seen = new Map<string, LiveListingRef>();
    for (const key of this.keysOf(city)) for (const row of this.parties.listingsLive.get(key) ?? []) seen.set(row.id, row);
    return [...seen.values()];
  }
  async listingPoints(city: CityMatch): Promise<ListingPoint[]> {
    const placed = new Map<string, ListingPoint>();
    for (const key of this.keysOf(city)) for (const row of this.parties.listingPoints.get(key) ?? []) placed.set(row.id, row);
    return (await this.activeListings(city)).map((row) => placed.get(row.id) ?? { id: row.id, latitude: null, longitude: null });
  }
  async agentUserIds(city: CityMatch): Promise<string[]> {
    return [...new Set(this.keysOf(city).flatMap((key) => (this.parties.agents.get(key) ?? []).map((a) => a.userId)))];
  }
}
