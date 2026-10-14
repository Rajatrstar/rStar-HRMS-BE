import { Router } from 'express';
import * as employeeController from '../controllers/employee.controller.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/request.middleware.js';
import { Role } from '../enums.js';
import {
  createEmployeeSchema,
  employeeIdParamsSchema,
  listEmployeesQuerySchema,
  updateEmployeeSchema,
} from '../validations/employee.validation.js';

const router = Router();

// Every employee route requires a valid session; individual routes narrow it further.
router.use(authenticate);

router.get('/', validate({ query: listEmployeesQuerySchema }), employeeController.list);

router.get('/:id', validate({ params: employeeIdParamsSchema }), employeeController.getById);

router.post(
  '/',
  authorize(Role.SUPER_ADMIN, Role.HR_ADMIN),
  validate({ body: createEmployeeSchema }),
  employeeController.create,
);

router.patch(
  '/:id',
  authorize(Role.SUPER_ADMIN, Role.HR_ADMIN),
  validate({ params: employeeIdParamsSchema, body: updateEmployeeSchema }),
  employeeController.update,
);

router.delete(
  '/:id',
  authorize(Role.SUPER_ADMIN),
  validate({ params: employeeIdParamsSchema }),
  employeeController.remove,
);

export default router;
