/**
 * Section overviews — package O-B: one overview read per user section
 * (publishers, advertisers, agents, print partners, employees, users).
 *
 * Only the router leaves. A read-only reporting module in the mould of
 * `admin-overview`: it counts and sums across the tables the party modules
 * own, writes nothing, and its repository port is aggregates only so that
 * stays true. What another module already answers (the funnels, the
 * leaderboard, the employees' overview and workload) it carries through that
 * module's export.
 */
export { sectionOverviewsRouter } from './section-overviews.routes';
export type {
  SectionOverview,
  PublishersOverview,
  AdvertisersOverview,
  AgentsOverview,
  PrintPartnersOverview,
  EmployeesOverviewSection,
  UsersOverview,
  Figure,
  MoneyFigure,
  Series,
  MoneySeries,
} from './section-overviews.service';
export { SECTIONS } from './section-overviews.service';
export type { Section } from './section-overviews.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
