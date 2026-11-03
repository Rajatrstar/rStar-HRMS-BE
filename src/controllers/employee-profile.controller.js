/**
 * Employee profile sections (work experience, education, dependents) and
 * uploaded documents: validate input, call the service, shape the reply.
 *
 * Every maxLength below is the column width from
 * db/migrations/011_employee_profile_sections.sql, for the same reason the
 * employee controller gives: a 400 naming the field beats silent truncation.
 */
import * as sectionService from '../services/employee-section.service.js';
import * as documentService from '../services/employee-document.service.js';
import { sendSuccess } from '../helpers/response.helper.js';
import { validateBody, validateParams } from '../helpers/validation.helper.js';
import { ApiError } from '../utils/api-error.js';
import {
  HTTP_STATUS,
  MESSAGES,
  ERROR_CODE,
  EMPLOYEE_SECTION,
  EMPLOYEE_DOCUMENT_TYPE,
} from '../enums/index.js';

const EMPLOYEE_PARAM = { employeeDetailId: { required: true, integer: true } };

/** A section save is one form, not a bulk import. */
const MAX_ROWS_PER_SAVE = 50;

/**
 * Per-section row rules and replies.
 *
 * Each row may carry its own id (the `idProp` rule): present means "this row,
 * changed", absent means "a new row". `check` is for rules across two fields
 * of the same row, which the declarative validator cannot express.
 */
const SECTION_RULES = Object.freeze({
  [EMPLOYEE_SECTION.WORK_EXPERIENCE]: {
    rules: {
      employeeWorkExperienceId: { integer: true },
      companyName: { required: true, maxLength: 200 },
      jobTitle: { required: true, maxLength: 150 },
      fromDate: { required: true, date: true },
      toDate: { date: true },
      jobDescription: { maxLength: 4000 },
      isRelevant: { boolean: true },
    },
    // Mirrors CK_tblEmployeeWorkExperience_Dates. YYYY-MM-DD compares as text.
    check: (row) =>
      row.toDate && row.toDate < row.fromDate
        ? { toDate: 'To date cannot be before from date' }
        : null,
    fetched: MESSAGES.WORK_EXPERIENCE_FETCHED,
    saved: MESSAGES.WORK_EXPERIENCE_SAVED,
  },
  [EMPLOYEE_SECTION.EDUCATION]: {
    rules: {
      employeeEducationId: { integer: true },
      instituteName: { required: true, maxLength: 250 },
      qualificationId: { integer: true },
      specializationId: { integer: true },
      degree: { maxLength: 150 },
      dateOfCompletion: { date: true },
      grade: { maxLength: 50 },
    },
    fetched: MESSAGES.EDUCATION_FETCHED,
    saved: MESSAGES.EDUCATION_SAVED,
  },
  [EMPLOYEE_SECTION.DEPENDENTS]: {
    rules: {
      employeeDependentId: { integer: true },
      name: { required: true, maxLength: 150 },
      relationshipId: { required: true, integer: true },
      dateOfBirth: { date: true },
      gender: { maxLength: 30 },
      contactNumber: { maxLength: 20 },
    },
    fetched: MESSAGES.DEPENDENTS_FETCHED,
    saved: MESSAGES.DEPENDENTS_SAVED,
  },
});

/**
 * Validates `{ items: [...] }` row by row, and reports every bad field of
 * every row at once, keyed `items[2].fromDate` - the same "all errors in one
 * reply" contract as a single form, with the row index the table needs to
 * put each message next to the right cell.
 */
function validateRows(body, { rules, check }) {
  const items = body?.items;

  if (!Array.isArray(items)) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, {
      items: 'Items must be a list of rows (send an empty list to clear the section)',
    });
  }
  if (items.length > MAX_ROWS_PER_SAVE) {
    throw ApiError.badRequest(MESSAGES.SECTION_TOO_MANY_ROWS, {
      code: ERROR_CODE.VALIDATION_FAILED,
      maxRows: MAX_ROWS_PER_SAVE,
    });
  }

  const errors = {};
  const rows = items.map((item, index) => {
    try {
      const row = validateBody(item, rules);
      for (const [field, message] of Object.entries(check?.(row) ?? {})) {
        errors[`items[${index}].${field}`] = message;
      }
      return row;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      for (const [field, message] of Object.entries(error.details ?? {})) {
        errors[`items[${index}].${field}`] = message;
      }
      return null;
    }
  });

  if (Object.keys(errors).length > 0) {
    throw ApiError.badRequest(MESSAGES.VALIDATION_FAILED, errors);
  }
  return rows;
}

/** GET /api/v1/employees/:employeeDetailId/<section> */
export function listSection(sectionKey) {
  const { fetched } = SECTION_RULES[sectionKey];

  return async (req, res) => {
    const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
    const data = await sectionService.listSection(sectionKey, employeeDetailId);
    return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: fetched, data });
  };
}

/** PUT /api/v1/employees/:employeeDetailId/<section> */
export function saveSection(sectionKey) {
  const config = SECTION_RULES[sectionKey];

  return async (req, res) => {
    const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
    const rows = validateRows(req.body, config);

    const data = await sectionService.saveSection(
      sectionKey,
      req.access.employeeDetailId,
      employeeDetailId,
      rows,
    );

    return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: config.saved, data });
  };
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                  */
/* -------------------------------------------------------------------------- */

const DOCUMENT_TYPES = Object.freeze(Object.values(EMPLOYEE_DOCUMENT_TYPE));

/** :documentType is case-insensitive in the URL - /documents/pan works. */
function documentParams(params) {
  return validateParams(
    {
      ...params,
      documentType:
        typeof params.documentType === 'string' ? params.documentType.toUpperCase() : undefined,
    },
    { ...EMPLOYEE_PARAM, documentType: { required: true, oneOf: DOCUMENT_TYPES } },
  );
}

/** GET /api/v1/employees/:employeeDetailId/documents */
export async function listDocuments(req, res) {
  const { employeeDetailId } = validateParams(req.params, EMPLOYEE_PARAM);
  const data = await documentService.listDocuments(employeeDetailId);
  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.DOCUMENTS_FETCHED, data });
}

/** PUT /api/v1/employees/:employeeDetailId/documents/:documentType (multipart, field "file") */
export async function uploadDocument(req, res) {
  const { employeeDetailId, documentType } = documentParams(req.params);

  const data = await documentService.uploadDocument(
    req.access.employeeDetailId,
    employeeDetailId,
    documentType,
    req.file,
  );

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.DOCUMENT_UPLOADED, data });
}

/** DELETE /api/v1/employees/:employeeDetailId/documents/:documentType */
export async function deleteDocument(req, res) {
  const { employeeDetailId, documentType } = documentParams(req.params);

  const data = await documentService.deleteDocument(
    req.access.employeeDetailId,
    employeeDetailId,
    documentType,
  );

  return sendSuccess(res, { statusCode: HTTP_STATUS.OK, message: MESSAGES.DOCUMENT_DELETED, data });
}
