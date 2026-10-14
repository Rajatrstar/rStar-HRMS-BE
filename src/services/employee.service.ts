import { prisma } from '../config/db.js';
import type { Employee, Prisma } from '../generated/prisma/client.js';
import { AuditAction } from '../enums.js';
import { ApiError } from '../utils/api-error.js';
import { buildPaginationMeta, toPrismaPagination } from '../utils/api-response.js';
import type { PaginationMeta } from '../utils/api-response.js';
import { recordAudit } from './audit.service.js';
import type {
  CreateEmployeeInput,
  ListEmployeesQuery,
  UpdateEmployeeInput,
} from '../validations/employee.validation.js';

export interface ActorContext {
  actorId: string;
  ipAddress?: string | undefined;
}

export interface PaginatedEmployees {
  items: Employee[];
  meta: PaginationMeta;
}

/** Soft-deleted rows are invisible to every read path. */
const notDeleted = { deletedAt: null } satisfies Prisma.EmployeeWhereInput;

export async function listEmployees(query: ListEmployeesQuery): Promise<PaginatedEmployees> {
  const where: Prisma.EmployeeWhereInput = {
    ...notDeleted,
    ...(query.department ? { department: query.department } : {}),
    ...(query.employmentStatus ? { employmentStatus: query.employmentStatus } : {}),
    // SQL Server collations are case-insensitive by default, so `contains` needs no
    // `mode: 'insensitive'` - which the SQL Server connector does not support anyway.
    ...(query.search
      ? {
          OR: [
            { firstName: { contains: query.search } },
            { lastName: { contains: query.search } },
            { workEmail: { contains: query.search } },
            { employeeCode: { contains: query.search } },
          ],
        }
      : {}),
  };

  const { skip, take } = toPrismaPagination(query);

  const [items, total] = await prisma.$transaction([
    prisma.employee.findMany({
      where,
      skip,
      take,
      orderBy: { [query.sortBy]: query.sortOrder },
    }),
    prisma.employee.count({ where }),
  ]);

  return { items, meta: buildPaginationMeta(query, total) };
}

export async function getEmployeeById(id: string): Promise<Employee> {
  const employee = await prisma.employee.findFirst({ where: { id, ...notDeleted } });

  if (!employee) {
    throw ApiError.notFound('Employee not found');
  }

  return employee;
}

export async function createEmployee(
  input: CreateEmployeeInput,
  actor: ActorContext,
): Promise<Employee> {
  if (input.managerId) {
    await assertManagerExists(input.managerId);
  }

  // Unique violations on employeeCode / workEmail / userId surface as P2002 and are mapped
  // to a 409 by the error handler, so there is no pre-check race to lose here.
  const employee = await prisma.employee.create({ data: input });

  await recordAudit({
    action: AuditAction.EMPLOYEE_CREATED,
    entity: 'Employee',
    entityId: employee.id,
    actorId: actor.actorId,
    ipAddress: actor.ipAddress,
    metadata: { employeeCode: employee.employeeCode },
  });

  return employee;
}

export async function updateEmployee(
  id: string,
  input: UpdateEmployeeInput,
  actor: ActorContext,
): Promise<Employee> {
  await getEmployeeById(id);

  if (input.managerId) {
    if (input.managerId === id) {
      throw ApiError.badRequest('An employee cannot be their own manager');
    }
    await assertManagerExists(input.managerId);
  }

  const employee = await prisma.employee.update({ where: { id }, data: input });

  await recordAudit({
    action: AuditAction.EMPLOYEE_UPDATED,
    entity: 'Employee',
    entityId: id,
    actorId: actor.actorId,
    ipAddress: actor.ipAddress,
    metadata: { fields: Object.keys(input) },
  });

  return employee;
}

/**
 * Soft delete. HR records are evidence in disputes and payroll audits, so rows are
 * retained; direct reports are detached so the org chart does not point at a dead node.
 */
export async function deleteEmployee(id: string, actor: ActorContext): Promise<void> {
  await getEmployeeById(id);

  await prisma.$transaction([
    prisma.employee.updateMany({ where: { managerId: id }, data: { managerId: null } }),
    prisma.employee.update({ where: { id }, data: { deletedAt: new Date() } }),
  ]);

  await recordAudit({
    action: AuditAction.EMPLOYEE_DELETED,
    entity: 'Employee',
    entityId: id,
    actorId: actor.actorId,
    ipAddress: actor.ipAddress,
  });
}

async function assertManagerExists(managerId: string): Promise<void> {
  const manager = await prisma.employee.findFirst({
    where: { id: managerId, ...notDeleted },
    select: { id: true },
  });

  if (!manager) {
    throw ApiError.badRequest('Manager not found');
  }
}
