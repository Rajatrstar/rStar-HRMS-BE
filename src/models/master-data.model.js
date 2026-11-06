/**
 * The five master-data tables: dbo.tblParentDepartment, dbo.tblDepartment,
 * dbo.tblDesignation, dbo.tblLeaveType and dbo.tblCategory.
 *
 * Mirrors db/migrations/009_master_data.sql. One file because they are one
 * feature and one shape: Name, Description, IsActive and the audit columns,
 * with nothing table-specific except tblDepartment's ParentDepartmentId.
 *
 * `masterColumns()` is a FUNCTION rather than a shared frozen object so the
 * five tables cannot accidentally share one mutable column descriptor - the
 * same reasoning as addressColumns() in organization.model.js.
 *
 * Soft delete: every read path must filter `WHERE DeletedAt IS NULL`. Nothing
 * here is ever DELETEd - tblEmployeeDetails.DepartmentId and .DesignationId
 * carry real foreign keys into two of these tables.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

/** Audit and soft-delete columns, identical on all five tables. */
const auditColumns = () => ({
  createdBy: { column: 'CreatedBy', type: sql.BigInt, nullable: true },
  modifiedBy: { column: 'ModifiedBy', type: sql.BigInt, nullable: true },
  createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
  modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  // NULL means live.
  deletedAt: { column: 'DeletedAt', type: sql.DateTime2, nullable: true },
});

/** The three columns every master list has, plus the audit block. */
const masterColumns = () => ({
  name: { column: 'Name', type: sql.NVarChar(150) },
  description: { column: 'Description', type: sql.NVarChar(500), nullable: true },
  isActive: { column: 'IsActive', type: sql.Bit },
  ...auditColumns(),
});

/** dbo.tblParentDepartment - the top of the department tree. */
export const ParentDepartment = defineModel({
  table: 'dbo.tblParentDepartment',
  columns: {
    parentDepartmentId: { column: 'ParentDepartmentId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblDepartment. NULL ParentDepartmentId is a department with no parent. */
export const Department = defineModel({
  table: 'dbo.tblDepartment',
  columns: {
    departmentId: { column: 'DepartmentId', type: sql.BigInt, identity: true },
    parentDepartmentId: { column: 'ParentDepartmentId', type: sql.BigInt, nullable: true },
    ...masterColumns(),
  },
});

/** dbo.tblDesignation - job titles. */
export const Designation = defineModel({
  table: 'dbo.tblDesignation',
  columns: {
    designationId: { column: 'DesignationId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblLeaveType - IsActive carries the export's "enabled" flag. */
export const LeaveType = defineModel({
  table: 'dbo.tblLeaveType',
  columns: {
    leaveTypeId: { column: 'LeaveTypeId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblCategory - help-desk and announcement categories. */
export const Category = defineModel({
  table: 'dbo.tblCategory',
  columns: {
    categoryId: { column: 'CategoryId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});


/* --------------------------------------------------------------------------
   The employee-form dropdown lists, from db/migrations/010.

   Same three columns and the same audit block as the five above - the whole
   point of masterColumns(). Nothing here carries a parent or any other
   table-specific column, which is why each one is four lines.
   -------------------------------------------------------------------------- */

/** dbo.tblGender - gender options on the personal details form. */
export const Gender = defineModel({
  table: 'dbo.tblGender',
  columns: {
    genderId: { column: 'GenderId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblMaritalStatus - marital status options on the personal details form. */
export const MaritalStatus = defineModel({
  table: 'dbo.tblMaritalStatus',
  columns: {
    maritalStatusId: { column: 'MaritalStatusId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblRelationship - how an emergency contact or a dependent is related to the employee. */
export const Relationship = defineModel({
  table: 'dbo.tblRelationship',
  columns: {
    relationshipId: { column: 'RelationshipId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblSkill - skills and areas of expertise an employee can be tagged with. */
export const Skill = defineModel({
  table: 'dbo.tblSkill',
  columns: {
    skillId: { column: 'SkillId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblEmploymentType - the terms an employee is engaged on. */
export const EmploymentType = defineModel({
  table: 'dbo.tblEmploymentType',
  columns: {
    employmentTypeId: { column: 'EmploymentTypeId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblJobRole - the kind of role an employee holds, independent of their job title. */
export const JobRole = defineModel({
  table: 'dbo.tblJobRole',
  columns: {
    jobRoleId: { column: 'JobRoleId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblEmployeeBand - internal grade bands. */
export const EmployeeBand = defineModel({
  table: 'dbo.tblEmployeeBand',
  columns: {
    employeeBandId: { column: 'EmployeeBandId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblWorkLocationCountry - the countries the company employs people in. */
export const WorkLocationCountry = defineModel({
  table: 'dbo.tblWorkLocationCountry',
  columns: {
    workLocationCountryId: { column: 'WorkLocationCountryId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblWorkMode - where an employee works from. */
export const WorkMode = defineModel({
  table: 'dbo.tblWorkMode',
  columns: {
    workModeId: { column: 'WorkModeId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblBillabilityType - whether an employee's time is billed to a client. */
export const BillabilityType = defineModel({
  table: 'dbo.tblBillabilityType',
  columns: {
    billabilityTypeId: { column: 'BillabilityTypeId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblProjectClient - the project or client an employee is assigned to. */
export const ProjectClient = defineModel({
  table: 'dbo.tblProjectClient',
  columns: {
    projectClientId: { column: 'ProjectClientId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblCostCenter - the cost center an employee's salary is booked against. */
export const CostCenter = defineModel({
  table: 'dbo.tblCostCenter',
  columns: {
    costCenterId: { column: 'CostCenterId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblSourceOfHire - how a hire reached the company. */
export const SourceOfHire = defineModel({
  table: 'dbo.tblSourceOfHire',
  columns: {
    sourceOfHireId: { column: 'SourceOfHireId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblOnboardingStatus - where a new joiner has got to in onboarding. */
export const OnboardingStatus = defineModel({
  table: 'dbo.tblOnboardingStatus',
  columns: {
    onboardingStatusId: { column: 'OnboardingStatusId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblBackgroundVerificationStatus - where a background check has got to. */
export const BackgroundVerificationStatus = defineModel({
  table: 'dbo.tblBackgroundVerificationStatus',
  columns: {
    backgroundVerificationStatusId: { column: 'BackgroundVerificationStatusId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblTaxRegime - the tax regime an employee has elected. */
export const TaxRegime = defineModel({
  table: 'dbo.tblTaxRegime',
  columns: {
    taxRegimeId: { column: 'TaxRegimeId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblGovernmentIdType - the kinds of government identity document on file. */
export const GovernmentIdType = defineModel({
  table: 'dbo.tblGovernmentIdType',
  columns: {
    governmentIdTypeId: { column: 'GovernmentIdTypeId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblDocumentType - the kinds of document an employee record can hold. */
export const DocumentType = defineModel({
  table: 'dbo.tblDocumentType',
  columns: {
    documentTypeId: { column: 'DocumentTypeId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblDocumentVerificationStatus - where the check on an uploaded document has got to. */
export const DocumentVerificationStatus = defineModel({
  table: 'dbo.tblDocumentVerificationStatus',
  columns: {
    documentVerificationStatusId: { column: 'DocumentVerificationStatusId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblAssetType - the kinds of company asset issued to employees, and the accessories list. */
export const AssetType = defineModel({
  table: 'dbo.tblAssetType',
  columns: {
    assetTypeId: { column: 'AssetTypeId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblAssetModel - specific device models that can be issued. */
export const AssetModel = defineModel({
  table: 'dbo.tblAssetModel',
  columns: {
    assetModelId: { column: 'AssetModelId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblQualification - education levels on the qualification form. */
export const Qualification = defineModel({
  table: 'dbo.tblQualification',
  columns: {
    qualificationId: { column: 'QualificationId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/** dbo.tblSpecialization - fields of study on the qualification form. */
export const Specialization = defineModel({
  table: 'dbo.tblSpecialization',
  columns: {
    specializationId: { column: 'SpecializationId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/**
 * dbo.tblRegularizationType - why an attendance correction was raised.
 *
 * From db/migrations/016, not 009, and it belongs here anyway: it is the
 * same three columns served by the same loop. Its two neighbours in that
 * migration, tblAttendanceStatus and tblHolidayType, look like master data
 * and are NOT - the code branches on them, so they carry fixed ids and live
 * in attendance.model.js and holiday.model.js.
 */
export const RegularizationType = defineModel({
  table: 'dbo.tblRegularizationType',
  columns: {
    regularizationTypeId: { column: 'RegularizationTypeId', type: sql.BigInt, identity: true },
    ...masterColumns(),
  },
});

/**
 * What a master row hands back to a client, after its own id.
 *
 * The audit columns are deliberately absent, exactly as they are for an
 * organisation. `modifiedAt` is carried so a client can detect a stale edit.
 */
export const MASTER_DATA_PUBLIC_PROPS = Object.freeze([
  'name',
  'description',
  'isActive',
  'modifiedAt',
]);
