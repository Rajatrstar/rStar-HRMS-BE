/**
 * Employee controller: validate input, call the service, shape the reply.
 * No SQL and no business rules live here.
 *
 * Every maxLength below is the column width from
 * db/migrations/001_employee_details.sql and 007_employee_details_hr_fields.sql.
 * A value SQL Server would truncate is rejected with a 400 naming the field
 * instead, because a silently shortened Aadhar number is worse than a failed
 * save.
 */
import * as employeeService from '../services/employee.service.js';
import { EXIT_STATUSES } from '../services/employee.service.js';
import { sendSuccess } from '../helpers/response.helper.js';
import { validateBody, validateParams } from '../helpers/validation.helper.js';
import {
  HTTP_STATUS,
  MESSAGES,
  EMPLOYMENT_TYPE,
  EMPLOYMENT_STATUS,
  USER_TYPE,
  BILLABLE_STATUS,
  TAX_REGIME,
} from '../enums/index.js';

const values = (enumObject) => Object.freeze(Object.values(enumObject));

/** The id in the path. Four handlers need the same check. */
const EMPLOYEE_PARAM = { employeeDetailId: { required: true, integer: true } };

/**
 * Create and update share one rule set, because they write the same columns -
 * see WRITABLE_PROPS in the service. Keeping one object here is what stops a
 * field being validated on create and waved through on update.
 *
 * Required: the four an employee record is meaningless without, plus the two
 * the database declares NOT NULL. Everything else is optional, because HR
 * fills a profile in over weeks and a form that refuses to save until every
 * box is full gets worked around with placeholder data.
 */
const EMPLOYEE_RULES = {
  employeeCode: { required: true, maxLength: 50 },
  firstName: { required: true, maxLength: 100 },
  middleName: { maxLength: 100 },
  lastName: { required: true, maxLength: 100 },
  nickName: { maxLength: 150 },

  workEmail: { required: true, email: true, lowercase: true, maxLength: 255 },
  personalEmail: { email: true, lowercase: true, maxLength: 255 },

  // Not `digits: true`: a real number carries "+", spaces and brackets, and
  // rejecting "+91 98765 43210" would be a bug rather than a check.
  phone: { maxLength: 20 },
  workPhone: { maxLength: 20 },
  workPhoneExtension: { maxLength: 20 },
  emergencyContactNumber: { maxLength: 20 },
  emergencyContactRelation: { maxLength: 50 },

  dateOfBirth: { date: true },
  // Free text by design - the columns carry no CHECK, so these cap the
  // length and not the content. GENDER and MARITAL_STATUS in
  // src/enums/employee.enum.js are the dropdown's suggestions.
  gender: { maxLength: 30 },
  maritalStatus: { maxLength: 30 },

  address: { maxLength: 4000 },
  presentAddressLine1: { maxLength: 255 },
  presentAddressLine2: { maxLength: 255 },
  presentCity: { maxLength: 100 },
  presentState: { maxLength: 100 },
  presentCountry: { maxLength: 100 },
  presentPostalCode: { maxLength: 20 },

  permanentAddress: { maxLength: 4000 },
  permanentAddressLine1: { maxLength: 255 },
  permanentAddressLine2: { maxLength: 255 },
  permanentCity: { maxLength: 100 },
  permanentState: { maxLength: 100 },
  permanentCountry: { maxLength: 100 },
  permanentPostalCode: { maxLength: 20 },

  panNumber: { maxLength: 20 },
  aadharNumber: { maxLength: 20 },

  departmentId: { integer: true },
  designationId: { integer: true },
  workLocationId: { integer: true },
  workLocation: { maxLength: 150 },
  designation: { maxLength: 150 },
  department: { maxLength: 150 },
  jobRole: { maxLength: 150 },
  employeeBand: { maxLength: 50 },
  userType: { oneOf: values(USER_TYPE), maxLength: 50 },
  sourceOfHire: { maxLength: 100 },
  seatingLocation: { maxLength: 150 },

  managerId: { integer: true },
  secondaryManagerId: { integer: true },
  additionalManagerId: { integer: true },

  /*
    Both lists are enforced by a CHECK constraint as well. Validating here
    too is not duplication for its own sake: the database answers with a
    constraint name and a 500, this answers with the field and the accepted
    values and a 400.
  */
  employmentType: { required: true, oneOf: values(EMPLOYMENT_TYPE), maxLength: 30 },
  employmentStatus: { oneOf: values(EMPLOYMENT_STATUS), maxLength: 30 },

  dateOfJoining: { required: true, date: true },
  probationEndDate: { date: true },
  contractorEndDate: { date: true },
  // dateOfLeaving is absent on purpose - only the deactivate endpoint sets it.

  totalExperience: { maxLength: 50 },
  // DECIMAL(5, 2): three digits before the point, two after.
  currentExperience: { decimal: true, min: 0, max: 999.99 },

  onboardingStatus: { maxLength: 50 },
  approvalStatus: { maxLength: 50 },
  backgroundVerificationStatus: { maxLength: 50 },

  workFromOffice: { boolean: true },
  billableStatus: { oneOf: values(BILLABLE_STATUS), maxLength: 20 },
  projectName: { maxLength: 200 },
  taxRegime: { oneOf: values(TAX_REGIME), maxLength: 20 },
  systemConfiguration: { maxLength: 500 },
  additionalAccessories: { maxLength: 500 },

  aboutMe: { maxLength: 4000 },
  expertise: { maxLength: 4000 },
  tags: { maxLength: 500 },

  profilePhotoUrl: { url: true, maxLength: 2048 },
};

/**
 * What exiting somebody requires.
 *
 * Two mandatory fields, and the service explains in full why each one is. In
 * short: IsActive = 0 records THAT they left, dateOfLeaving records when, and
 * employmentStatus records how - and payroll, leave encashment and every
 * headcount-as-at report need all three.
 *
 * employmentStatus is restricted to EXIT_STATUSES rather than the full list,
 * so "deactivate with status Active" cannot be submitted at all.
 */
const DEACTIVATE_RULES = {
  dateOfLeaving: { required: true, date: true },
  employmentStatus: { required: true, oneOf: EXIT_STATUSES, maxLength: 30 },
  contractorEndDate: { date: true },
};

/** Query-string filters for the list. */
const LIST_RULES = {
  page: { integer: true, min: 1 },
  pageSize: { integer: true, min: 1 },
  search: { maxLength: 100 },
  employmentStatus: { oneOf: values(EMPLOYMENT_STATUS), maxLength: 30 },
  isActive: { boolean: true },
  departmentId: { integer: true },
  managerId: { integer: true },
};

// A page nobody asked to size. 200 is the ceiling because the row is wide -
// seventy columns times a thousand rows is a response no grid wants either.
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

/** GET /api/v1/employees */
export async function list(req, res) {
  const filters = validateParams(req.query, LIST_RULES);

  const { employees, meta } = await employeeService.listEmployees(req.access, {
    ...filters,
    page: filters.page ?? 1,
    pageSize: Math.min(filters.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  });

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.EMPLOYEES_FETCHED,
    data: employees,
    meta,
  });
}

/** GET /api/v1/employees/:employeeDetailId */
export async function detail(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);

  const data = await employeeService.getEmployee(req.access, employeeDetailId);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.EMPLOYEE_FETCHED,
    data,
  });
}

/** POST /api/v1/employees */
export async function create(req, res) {
  const input = validateBody(req.body, EMPLOYEE_RULES);

  const data = await employeeService.createEmployee(req.access.employeeDetailId, input);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: MESSAGES.EMPLOYEE_CREATED,
    data,
  });
}

/** PUT /api/v1/employees/:employeeDetailId */
export async function update(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
  const input = validateBody(req.body, EMPLOYEE_RULES);

  const data = await employeeService.updateEmployee(
    req.access,
    req.access.employeeDetailId,
    employeeDetailId,
    input,
  );

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.EMPLOYEE_UPDATED,
    data,
  });
}

/** PATCH /api/v1/employees/:employeeDetailId/deactivate */
export async function deactivate(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
  const input = validateBody(req.body, DEACTIVATE_RULES);

  const data = await employeeService.deactivateEmployee(
    req.access,
    req.access.employeeDetailId,
    employeeDetailId,
    input,
  );

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.EMPLOYEE_DEACTIVATED,
    data,
  });
}

/** DELETE /api/v1/employees/:employeeDetailId */
export async function remove(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);

  const data = await employeeService.deleteEmployee(
    req.access,
    req.access.employeeDetailId,
    employeeDetailId,
  );

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.EMPLOYEE_DELETED,
    data,
  });
}
