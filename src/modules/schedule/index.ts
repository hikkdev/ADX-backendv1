/**
 * Schedule — Lot E (Q72/Q99): the staff diary ADX owns, with the field
 * overlay read from `visits`. Nothing imports this module but bootstrap; it
 * sits at the bottom of the graph, reading `hr` for holidays and the people
 * registry and `visits` for an agent's work in the window.
 */
export { scheduleRouter } from './schedule.routes';
export type { EntryView, EntryWithAssignee, ScheduleWindow, ScheduleLogRow } from './schedule.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
