import { logger } from '../../shared/logging';
import { notify } from '../notifications';

/**
 * The six things a task tells its people — Lot AA. Every call goes through
 * the dispatcher under NotificationType WORK: the in-app row here, the push
 * (and whatever else ops' template names) from the seeded copy. Every row
 * carries `relatedType: 'WORK'` beside the task id (AB-B) — the phones
 * resolve a row through relatedType first, so a tap opens the task. A notice
 * that cannot be sent is logged, never thrown: the task moved, and the
 * notification is the record of it, not a condition of it.
 */

const TAG = 'work';

type TaskRef = { id: string; displayId: string | null; title: string; deadline: Date | null };

const label = (task: TaskRef) => `${task.displayId ?? task.id} · ${task.title}`;
const due = (task: TaskRef) => (task.deadline ? task.deadline.toISOString().slice(0, 10) : 'no deadline');

async function guarded(what: string, send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
  } catch (err) {
    logger.warn('Work notice not sent', { tag: TAG, what, reason: err instanceof Error ? err.message : String(err) });
  }
}

export async function notifyAssigned(task: TaskRef, userId: string, byName: string | null): Promise<void> {
  await guarded('assigned', () =>
    notify(
      'WORK_ASSIGNED',
      userId,
      { task: label(task), due: due(task), by: byName ?? 'the desk' },
      { type: 'WORK', inApp: { type: 'WORK', title: 'A task was assigned to you', subtitle: label(task), message: `Due ${due(task)}.`, relatedType: 'WORK', relatedId: task.id } },
    ),
  );
}

export async function notifyReviewRequested(task: TaskRef, userId: string): Promise<void> {
  await guarded('review requested', () =>
    notify(
      'WORK_REVIEW_REQUESTED',
      userId,
      { task: label(task) },
      { type: 'WORK', inApp: { type: 'WORK', title: 'A task awaits your review', subtitle: label(task), message: 'Approve it, or send it back with a note.', relatedType: 'WORK', relatedId: task.id } },
    ),
  );
}

export async function notifyRejected(task: TaskRef, userId: string, note: string | null): Promise<void> {
  await guarded('rejected', () =>
    notify(
      'WORK_REJECTED',
      userId,
      { task: label(task), note: note ?? '' },
      { type: 'WORK', inApp: { type: 'WORK', title: 'A task was sent back', subtitle: label(task), message: note ?? 'The reviewer sent it back to in progress.', relatedType: 'WORK', relatedId: task.id } },
    ),
  );
}

export async function notifyDueTomorrow(task: TaskRef, userId: string): Promise<void> {
  await guarded('due tomorrow', () =>
    notify(
      'WORK_DUE',
      userId,
      { task: label(task), due: due(task) },
      { type: 'WORK', inApp: { type: 'WORK', title: 'A task is due tomorrow', subtitle: label(task), message: `Due ${due(task)}.`, relatedType: 'WORK', relatedId: task.id } },
    ),
  );
}

export async function notifyOverdue(task: TaskRef, userId: string): Promise<void> {
  await guarded('overdue', () =>
    notify(
      'WORK_OVERDUE',
      userId,
      { task: label(task), due: due(task) },
      { type: 'WORK', inApp: { type: 'WORK', title: 'A task is overdue', subtitle: label(task), message: `It was due ${due(task)}.`, relatedType: 'WORK', relatedId: task.id } },
    ),
  );
}

export async function notifyComment(task: TaskRef, userId: string, authorName: string | null, preview: string): Promise<void> {
  await guarded('comment', () =>
    notify(
      'WORK_COMMENT',
      userId,
      { task: label(task), author: authorName ?? 'Someone', preview },
      { type: 'WORK', inApp: { type: 'WORK', title: `${authorName ?? 'Someone'} commented`, subtitle: label(task), message: preview, relatedType: 'WORK', relatedId: task.id } },
    ),
  );
}
