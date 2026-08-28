import type { AgentProfile } from '../../shared/database';

export type AgentFilter = {
  city?: string;
  tier?: string;
  search?: string;
};

export interface AgentsRepository {
  findPage(
    filter: AgentFilter,
    limit: number,
    offset: number,
  ): Promise<{ items: AgentProfile[]; total: number }>;
  findById(id: string): Promise<AgentProfile | null>;
  findByUserId(userId: string): Promise<AgentProfile | null>;
  /** Agent plus the user id to notify. */
  findWithUser(agentId: string): Promise<{ id: string; userId: string } | null>;
  /** First active agent-publisher not in the exclusion list. */
  findAssignable(excludeIds: string[]): Promise<{ id: string } | null>;
}
