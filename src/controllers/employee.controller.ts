import type { Request, Response } from 'express';
import { HttpStatus } from '../enums.js';
import { sendSuccess } from '../utils/api-response.js';
import { ApiError } from '../utils/api-error.js';
import * as employeeService from '../services/employee.service.js';
import type {
  CreateEmployeeInput,
  ListEmployeesQuery,
  UpdateEmployeeInput,
} from '../validations/employee.validation.js';

export async function list(req: Request, res: Response): Promise<void> {
  const { items, meta } = await employeeService.listEmployees(
    req.query as unknown as ListEmployeesQuery,
  );
  sendSuccess(res, items, HttpStatus.OK, meta);
}

export async function getById(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await employeeService.getEmployeeById(requireParam(req, 'id')));
}

export async function create(req: Request, res: Response): Promise<void> {
  const employee = await employeeService.createEmployee(
    req.body as CreateEmployeeInput,
    actor(req),
  );
  sendSuccess(res, employee, HttpStatus.CREATED);
}

export async function update(req: Request, res: Response): Promise<void> {
  const employee = await employeeService.updateEmployee(
    requireParam(req, 'id'),
    req.body as UpdateEmployeeInput,
    actor(req),
  );
  sendSuccess(res, employee);
}

export async function remove(req: Request, res: Response): Promise<void> {
  await employeeService.deleteEmployee(requireParam(req, 'id'), actor(req));
  res.status(HttpStatus.NO_CONTENT).send();
}

/** `authenticate` runs before every route here, so a missing user is a wiring bug. */
function actor(req: Request): employeeService.ActorContext {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  return { actorId: req.user.id, ipAddress: req.ip };
}

function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw ApiError.badRequest(`Missing route parameter: ${name}`);
  }
  return value;
}
