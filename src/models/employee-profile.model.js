/**
 * The repeating sections of an employee profile, and their uploaded documents.
 *
 * Mirrors db/migrations/011_employee_profile_sections.sql. Every table here
 * hangs off tblEmployeeDetails by EmployeeDetailId and is soft-deleted: every
 * read path must filter `WHERE DeletedAt IS NULL`.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

/** The five audit columns every table here carries. */
const AUDIT_COLUMNS = {
  createdBy: { column: 'CreatedBy', type: sql.BigInt, nullable: true },
  modifiedBy: { column: 'ModifiedBy', type: sql.BigInt, nullable: true },
  createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
  modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  deletedAt: { column: 'DeletedAt', type: sql.DateTime2, nullable: true },
};

/** dbo.tblEmployeeWorkExperience - previous employers, one row per job. */
export const EmployeeWorkExperience = defineModel({
  table: 'dbo.tblEmployeeWorkExperience',
  columns: {
    employeeWorkExperienceId: {
      column: 'EmployeeWorkExperienceId',
      type: sql.BigInt,
      identity: true,
    },
    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },
    companyName: { column: 'CompanyName', type: sql.NVarChar(200) },
    jobTitle: { column: 'JobTitle', type: sql.NVarChar(150) },
    fromDate: { column: 'FromDate', type: sql.Date },
    toDate: { column: 'ToDate', type: sql.Date, nullable: true },
    jobDescription: { column: 'JobDescription', type: sql.NVarChar(4000), nullable: true },
    isRelevant: { column: 'IsRelevant', type: sql.Bit, nullable: true },
    ...AUDIT_COLUMNS,
  },
});

/** dbo.tblEmployeeEducation - qualifications, one row per degree or course. */
export const EmployeeEducation = defineModel({
  table: 'dbo.tblEmployeeEducation',
  columns: {
    employeeEducationId: { column: 'EmployeeEducationId', type: sql.BigInt, identity: true },
    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },
    instituteName: { column: 'InstituteName', type: sql.NVarChar(250) },
    qualificationId: { column: 'QualificationId', type: sql.BigInt, nullable: true },
    specializationId: { column: 'SpecializationId', type: sql.BigInt, nullable: true },
    degree: { column: 'Degree', type: sql.NVarChar(150), nullable: true },
    dateOfCompletion: { column: 'DateOfCompletion', type: sql.Date, nullable: true },
    grade: { column: 'Grade', type: sql.NVarChar(50), nullable: true },
    ...AUDIT_COLUMNS,
  },
});

/** dbo.tblEmployeeDependent - family members the employee declares. */
export const EmployeeDependent = defineModel({
  table: 'dbo.tblEmployeeDependent',
  columns: {
    employeeDependentId: { column: 'EmployeeDependentId', type: sql.BigInt, identity: true },
    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },
    name: { column: 'Name', type: sql.NVarChar(150) },
    relationshipId: { column: 'RelationshipId', type: sql.BigInt },
    dateOfBirth: { column: 'DateOfBirth', type: sql.Date, nullable: true },
    gender: { column: 'Gender', type: sql.NVarChar(30), nullable: true },
    contactNumber: { column: 'ContactNumber', type: sql.NVarChar(20), nullable: true },
    ...AUDIT_COLUMNS,
  },
});

/**
 * dbo.tblEmployeeDocument - an uploaded file. The bytes are on disk under
 * UPLOAD_DIR; fileUrl is the path the API serves them from.
 */
export const EmployeeDocument = defineModel({
  table: 'dbo.tblEmployeeDocument',
  columns: {
    employeeDocumentId: { column: 'EmployeeDocumentId', type: sql.BigInt, identity: true },
    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt },
    documentType: { column: 'DocumentType', type: sql.NVarChar(30) },
    fileUrl: { column: 'FileUrl', type: sql.NVarChar(500) },
    originalFileName: { column: 'OriginalFileName', type: sql.NVarChar(255), nullable: true },
    mimeType: { column: 'MimeType', type: sql.NVarChar(100) },
    fileSizeBytes: { column: 'FileSizeBytes', type: sql.Int },
    ...AUDIT_COLUMNS,
  },
});

/** What a client sees of a document. Audit columns stay inside, as elsewhere. */
export const EMPLOYEE_DOCUMENT_PUBLIC_PROPS = Object.freeze([
  'employeeDocumentId',
  'employeeDetailId',
  'documentType',
  'fileUrl',
  'originalFileName',
  'mimeType',
  'fileSizeBytes',
  'createdAt',
  'modifiedAt',
]);
