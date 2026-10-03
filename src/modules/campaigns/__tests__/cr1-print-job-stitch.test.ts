import { describe, expect, it } from 'vitest';
import { orderIdsOf, stitchPrintJobs, type PrintJobForRow } from '../prisma-campaigns.repository';

/**
 * CR-1: the print job on a creative row's order.
 *
 * `PrintJob.orderId` is a plain unique column with no Prisma relation to
 * `Order`, so the job cannot be selected through the order — the first
 * version tried and reached the console as a 500 that no mocked test could
 * see. The jobs are fetched by order id and stitched on afterwards, and the
 * stitch is pure so it is tested here without a database.
 */

const job = (orderId: string, over: Partial<PrintJobForRow> = {}): PrintJobForRow => ({
  id: `job_${orderId}`,
  orderId,
  status: 'PRINTING',
  printPartner: { id: 'pp_1', name: 'Sharma Printers' },
  ...over,
});

const row = (spot: { order: { id: string; status: string } | null } | null, id = 'crt') => ({ id, spot: spot ? { id: `spot_${id}`, ...spot } : null });

describe('which orders a page sits on', () => {
  it('collects each order once and skips unbooked and spotless rows', () => {
    const rows = [
      row({ order: { id: 'ord_1', status: 'PENDING_PRINT' } }, 'a'),
      row({ order: { id: 'ord_1', status: 'PENDING_PRINT' } }, 'b'),
      row({ order: null }, 'c'),
      row(null, 'd'),
      row({ order: { id: 'ord_2', status: 'PENDING_PRINT' } }, 'e'),
    ];
    expect(orderIdsOf(rows)).toEqual(['ord_1', 'ord_2']);
  });
});

describe('stitching the job onto the row', () => {
  it('puts the job on the order it belongs to, without its orderId', () => {
    const [stitched] = stitchPrintJobs([row({ order: { id: 'ord_1', status: 'PENDING_PRINT' } })], [job('ord_1')]);
    expect(stitched?.spot?.order?.printJob).toEqual({ id: 'job_ord_1', status: 'PRINTING', printPartner: { id: 'pp_1', name: 'Sharma Printers' } });
  });

  it('answers null for an order with no job yet', () => {
    const [stitched] = stitchPrintJobs([row({ order: { id: 'ord_1', status: 'PENDING_PRINT' } })], []);
    expect(stitched?.spot?.order?.printJob).toBeNull();
  });

  it('leaves an unbooked spot and a spotless row alone', () => {
    const [unbooked, spotless] = stitchPrintJobs([row({ order: null }, 'a'), row(null, 'b')], [job('ord_1')]);
    expect(unbooked?.spot?.order).toBeNull();
    expect(spotless?.spot).toBeNull();
  });

  it('ignores a job on an order no row sits on', () => {
    const [stitched] = stitchPrintJobs([row({ order: { id: 'ord_1', status: 'PENDING_PRINT' } })], [job('ord_9')]);
    expect(stitched?.spot?.order?.printJob).toBeNull();
  });

  it('keeps every other field of the row and the order', () => {
    const [stitched] = stitchPrintJobs([row({ order: { id: 'ord_1', status: 'SLOT_CONFIRMED' } }, 'keep')], [job('ord_1')]);
    expect(stitched?.id).toBe('keep');
    expect(stitched?.spot?.id).toBe('spot_keep');
    expect(stitched?.spot?.order?.status).toBe('SLOT_CONFIRMED');
  });

  it('matches two rows on the same order to the same job', () => {
    const rows = [row({ order: { id: 'ord_1', status: 'PENDING_PRINT' } }, 'a'), row({ order: { id: 'ord_1', status: 'PENDING_PRINT' } }, 'b')];
    const stitched = stitchPrintJobs(rows, [job('ord_1')]);
    expect(stitched.map((item) => item.spot?.order?.printJob?.id)).toEqual(['job_ord_1', 'job_ord_1']);
  });
});
