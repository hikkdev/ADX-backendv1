import type { SafetyAlert } from '../../shared/database';
import type { NewAlert, SafetyAlertRow, SafetyPatch } from './safety.types';

export interface SafetyRepository {
  create(data: NewAlert): Promise<SafetyAlert>;
  findById(alertId: string): Promise<SafetyAlert | null>;
  findManyForUser(userId: string): Promise<SafetyAlertRow[]>;
  findQueue(filter: { status?: 'OPEN' | 'ACKNOWLEDGED' | 'CLOSED'; limit: number; offset: number }): Promise<SafetyAlertRow[]>;
  /** T-B: answers the queue's row — the alert with `raisedBy` and its `order` — so the desk's write carries what its list carries. */
  update(alertId: string, patch: SafetyPatch): Promise<SafetyAlertRow>;
  /** Enough of the order to name it and to know it exists. */
  findOrderForActor(orderId: string): Promise<{ id: string; status: string; agentId: string | null } | null>;
  /** Takes the agent off the job and puts it back in the dispatcher's hands. */
  releaseOrderFromAgent(orderId: string): Promise<void>;
}
