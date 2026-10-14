import { z } from 'zod';
import { EmploymentStatus } from '../enums.js';

export const employeeIdParamsSchema = z.object({
  id: z.uuid('Employee id must be a UUID'),
});

export const createEmployeeSchema = z.object({
  employeeCode: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Z0-9][A-Z0-9-]*$/, 'Employee code must be uppercase letters, digits or hyphens'),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  workEmail: z.email().max(190).trim().toLowerCase(),
  phone: z
    .string()
    .trim()
    .max(20)
    .regex(/^\+?[\d\s-]+$/, 'Phone may contain digits, spaces, hyphens and a leading +')
    .optional(),
  department: z.string().trim().min(1).max(80),
  designation: z.string().trim().min(1).max(80),
  dateOfJoining: z.coerce.date(),
  employmentStatus: z.enum(EmploymentStatus).default(EmploymentStatus.PROBATION),
  managerId: z.uuid().optional(),
  userId: z.uuid().optional(),
});

export const updateEmployeeSchema = createEmployeeSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

export const listEmployeesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Capped so a client cannot ask for the entire table in one request.
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  department: z.string().trim().max(80).optional(),
  employmentStatus: z.enum(EmploymentStatus).optional(),
  sortBy: z.enum(['createdAt', 'employeeCode', 'firstName', 'dateOfJoining']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuerySchema>;
