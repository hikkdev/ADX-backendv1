import type { ScheduleEntry } from '../../shared/database';

export type NewEntry = {
  date: Date;
  startTime: string;
  endTime: string | null;
  title: string;
  notes: string | null;
  assigneeUserId: string;
  department: string | null;
  createdByUserId: string;
};

export type EntryPatch = Partial<{
  date: Date;
  startTime: string;
  endTime: string | null;
  title: string;
  notes: string | null;
  assigneeUserId: string;
  department: string | null;
  status: 'PENDING' | 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED';
}>;

export interface ScheduleRepository {
  /** `[from, to]` inclusive, both UTC-midnight dates; narrowed to one person when given. In date, then start order. */
  findInRange(from: Date, to: Date, assigneeUserId?: string): Promise<ScheduleEntry[]>;
  findById(id: string): Promise<ScheduleEntry | null>;
  create(data: NewEntry): Promise<ScheduleEntry>;
  update(id: string, data: EntryPatch): Promise<ScheduleEntry>;
  remove(id: string): Promise<ScheduleEntry>;
}
