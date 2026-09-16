/**
 * The two questions employee KYC asks of `employees` — Lot D.
 *
 * Asked through a port rather than an import because `employees` reaches
 * `users`, `users` reaches `publishers` for the manifest, and `publishers`
 * reaches this module for the desk: importing `employees` here would close
 * that ring. Filled in `bootstrap/register-modules.ts`; unregistered, every
 * lookup answers "not found", which is honest and never a 500.
 */
export interface EmployeeLookupPort {
  findByUserId(userId: string): Promise<{ id: string } | null>;
  exists(employeeId: string): Promise<boolean>;
}

let port: EmployeeLookupPort | null = null;

export function registerEmployeeLookupPort(implementation: EmployeeLookupPort): void {
  port = implementation;
}

export async function findEmployeeForUser(userId: string): Promise<{ id: string } | null> {
  return port ? port.findByUserId(userId) : null;
}

export async function employeeExists(employeeId: string): Promise<boolean> {
  return port ? port.exists(employeeId) : false;
}
