import type { RoleConfig } from '../../shared/database';
import type { CreateRoleConfigInput, UpdateRoleConfigInput } from './access-control.schema';

export interface RoleConfigRepository {
  findAll(): Promise<RoleConfig[]>;
  findById(id: string): Promise<RoleConfig | null>;
  findByName(name: string): Promise<RoleConfig | null>;
  create(data: CreateRoleConfigInput): Promise<RoleConfig>;
  update(id: string, data: UpdateRoleConfigInput): Promise<RoleConfig>;
  remove(id: string): Promise<unknown>;
}
