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
}
