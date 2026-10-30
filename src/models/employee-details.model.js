/**
 * dbo.tblEmployeeDetails - the HR record for a person.
 *
 * Mirrors db/migrations/001_employee_details.sql plus the columns added in
 * 007_employee_details_hr_fields.sql, which brought the table up to the set
 * HR keeps in Zoho People. THE employee table: every role, permission and
 * audit column in this schema keys on employeeDetailId. Credentials live in
 * dbo.EmployeeLogin, which points here - not the reverse, so there is no
 * nullable link column on this side any more.
 *
 * Soft delete: every read path must filter `WHERE DeletedAt IS NULL`. Nothing
 * in this table is ever DELETEd.
 *
 * Everything 007 added is nullable. A row that already existed has no value
 * for any of it, and a made-up default would record a guess as a fact.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

export const EmployeeDetails = defineModel({
  table: 'dbo.tblEmployeeDetails',
  columns: {
    employeeDetailId: { column: 'EmployeeDetailId', type: sql.BigInt, identity: true },

    /*
      A second auto-incrementing number, fed by dbo.seqEmployeeSerialNo rather
      than IDENTITY - SQL Server allows only one identity column per table and
      employeeDetailId is it. A DEFAULT of NEXT VALUE FOR behaves the same way
      from here: omit the column on INSERT and a number appears.

      `identity: true` says the same thing to db:verify and to any writer - the
      database fills this in, the application never does.
    */
    employeeSerialNo: { column: 'EmployeeSerialNo', type: sql.Int, identity: true },

    // Human-facing code, e.g. EMP001 or RSTR157. Unique among live rows.
    employeeCode: { column: 'EmployeeCode', type: sql.NVarChar(50) },

    // Where this row came from in Zoho People. An import matches on these;
    // nothing in the application reads them.
    zohoUserId: { column: 'ZohoUserId', type: sql.NVarChar(50), nullable: true },
    zohoRecordId: { column: 'ZohoRecordId', type: sql.NVarChar(50), nullable: true },
    internalEmployeeId: { column: 'InternalEmployeeId', type: sql.NVarChar(50), nullable: true },

    firstName: { column: 'FirstName', type: sql.NVarChar(100) },
    middleName: { column: 'MiddleName', type: sql.NVarChar(100), nullable: true },
    lastName: { column: 'LastName', type: sql.NVarChar(100) },
    nickName: { column: 'NickName', type: sql.NVarChar(150), nullable: true },

    workEmail: { column: 'WorkEmail', type: sql.NVarChar(255) },
    personalEmail: { column: 'PersonalEmail', type: sql.NVarChar(255), nullable: true },

    // The PERSONAL mobile. The work line is workPhone - a different number,
    // and often a shared one.
    phone: { column: 'Phone', type: sql.NVarChar(20), nullable: true },
    workPhone: { column: 'WorkPhone', type: sql.NVarChar(20), nullable: true },
    workPhoneExtension: { column: 'WorkPhoneExtension', type: sql.NVarChar(20), nullable: true },

    emergencyContactNumber: {
      column: 'EmergencyContactNumber',
      type: sql.NVarChar(20),
      nullable: true,
    },
    emergencyContactRelation: {
      column: 'EmergencyContactRelation',
      type: sql.NVarChar(50),
      nullable: true,
    },

    dateOfBirth: { column: 'DateOfBirth', type: sql.Date, nullable: true },
    gender: { column: 'Gender', type: sql.NVarChar(30), nullable: true },
    maritalStatus: { column: 'MaritalStatus', type: sql.NVarChar(30), nullable: true },

    /*
      The present address written out in full, and the same address broken
      out. Both are kept rather than one derived from the other: the export
      carries both and they do not always agree, so collapsing them would mean
      choosing which version to lose.
    */
    address: { column: 'Address', type: sql.NVarChar(sql.MAX), nullable: true },
    presentAddressLine1: { column: 'PresentAddressLine1', type: sql.NVarChar(255), nullable: true },
    presentAddressLine2: { column: 'PresentAddressLine2', type: sql.NVarChar(255), nullable: true },
    presentCity: { column: 'PresentCity', type: sql.NVarChar(100), nullable: true },
    presentState: { column: 'PresentState', type: sql.NVarChar(100), nullable: true },
    presentCountry: { column: 'PresentCountry', type: sql.NVarChar(100), nullable: true },
    presentPostalCode: { column: 'PresentPostalCode', type: sql.NVarChar(20), nullable: true },

    permanentAddress: { column: 'PermanentAddress', type: sql.NVarChar(sql.MAX), nullable: true },
    permanentAddressLine1: {
      column: 'PermanentAddressLine1',
      type: sql.NVarChar(255),
      nullable: true,
    },
    permanentAddressLine2: {
      column: 'PermanentAddressLine2',
      type: sql.NVarChar(255),
      nullable: true,
    },
    permanentCity: { column: 'PermanentCity', type: sql.NVarChar(100), nullable: true },
    permanentState: { column: 'PermanentState', type: sql.NVarChar(100), nullable: true },
    permanentCountry: { column: 'PermanentCountry', type: sql.NVarChar(100), nullable: true },
    permanentPostalCode: { column: 'PermanentPostalCode', type: sql.NVarChar(20), nullable: true },

    // The most sensitive values in the table: not indexed, and deliberately
    // absent from EMPLOYEE_DETAILS_PUBLIC_PROPS below.
    panNumber: { column: 'PanNumber', type: sql.NVarChar(20), nullable: true },
    aadharNumber: { column: 'AadharNumber', type: sql.NVarChar(20), nullable: true },

    // No FOREIGN KEY yet - the referenced tables do not exist. See the
    // migration header.
    departmentId: { column: 'DepartmentId', type: sql.BigInt, nullable: true },
    designationId: { column: 'DesignationId', type: sql.BigInt, nullable: true },
    workLocationId: { column: 'WorkLocationId', type: sql.BigInt, nullable: true },
    workLocation: { column: 'WorkLocation', type: sql.NVarChar(150), nullable: true },

    // Stored as written as well as by id, for the same reason workLocation is:
    // the id tables do not exist yet and a profile still has to read correctly.
    designation: { column: 'Designation', type: sql.NVarChar(150), nullable: true },
    department: { column: 'Department', type: sql.NVarChar(150), nullable: true },
    jobRole: { column: 'JobRole', type: sql.NVarChar(150), nullable: true },
    employeeBand: { column: 'EmployeeBand', type: sql.NVarChar(50), nullable: true },
    // Employee / Contractor / Vendor - what the person IS to the company.
    // employmentType is how they are engaged, which is a different question.
    userType: { column: 'UserType', type: sql.NVarChar(50), nullable: true },
    sourceOfHire: { column: 'SourceOfHire', type: sql.NVarChar(100), nullable: true },
    seatingLocation: { column: 'SeatingLocation', type: sql.NVarChar(150), nullable: true },

    /*
      The primary reporting line, and the ONLY one the TEAM scope follows -
      see src/helpers/access-scope.helper.js. The other two are recorded but
      grant nothing: widening TEAM to three manager columns changes who can
      see whose data, and that is an access-control decision rather than a
      side effect of an HR import.
    */
    managerId: { column: 'ManagerId', type: sql.BigInt, nullable: true },
    secondaryManagerId: { column: 'SecondaryManagerId', type: sql.BigInt, nullable: true },
    additionalManagerId: { column: 'AdditionalManagerId', type: sql.BigInt, nullable: true },

    // Values from EMPLOYMENT_TYPE / EMPLOYMENT_STATUS in src/enums. Both
    // lists were widened in 007 to accept the Zoho export's vocabulary.
    employmentType: { column: 'EmploymentType', type: sql.NVarChar(30) },
    employmentStatus: { column: 'EmploymentStatus', type: sql.NVarChar(30) },

    dateOfJoining: { column: 'DateOfJoining', type: sql.Date },
    probationEndDate: { column: 'ProbationEndDate', type: sql.Date, nullable: true },
    dateOfLeaving: { column: 'DateOfLeaving', type: sql.Date, nullable: true },
    dateOfRehire: { column: 'DateOfRehire', type: sql.Date, nullable: true },
    contractorEndDate: { column: 'ContractorEndDate', type: sql.Date, nullable: true },

    // Text, because the export writes a band ("0 to 50") rather than a number.
    totalExperience: { column: 'TotalExperience', type: sql.NVarChar(50), nullable: true },
    // Years at this company, and this one does arrive as a figure.
    currentExperience: { column: 'CurrentExperience', type: sql.Decimal(5, 2), nullable: true },

    // Free text: these lists belong to whoever runs the process and change
    // without a release, so a CHECK would be a release blocker for an HR edit.
    onboardingStatus: { column: 'OnboardingStatus', type: sql.NVarChar(50), nullable: true },
    approvalStatus: { column: 'ApprovalStatus', type: sql.NVarChar(50), nullable: true },
    // "BGV" in the sheet.
    backgroundVerificationStatus: {
      column: 'BackgroundVerificationStatus',
      type: sql.NVarChar(50),
      nullable: true,
    },

    workFromOffice: { column: 'WorkFromOffice', type: sql.Bit, nullable: true },
    // "B/NB" in the export: Billable / Non-Billable.
    billableStatus: { column: 'BillableStatus', type: sql.NVarChar(20), nullable: true },
    projectName: { column: 'ProjectName', type: sql.NVarChar(200), nullable: true },
    taxRegime: { column: 'TaxRegime', type: sql.NVarChar(20), nullable: true },
    systemConfiguration: { column: 'SystemConfiguration', type: sql.NVarChar(500), nullable: true },
    additionalAccessories: {
      column: 'AdditionalAccessories',
      type: sql.NVarChar(500),
      nullable: true,
    },

    aboutMe: { column: 'AboutMe', type: sql.NVarChar(sql.MAX), nullable: true },
    // "Ask me about / Expertise" in the sheet.
    expertise: { column: 'Expertise', type: sql.NVarChar(sql.MAX), nullable: true },
    tags: { column: 'Tags', type: sql.NVarChar(500), nullable: true },

    profilePhotoUrl: { column: 'ProfilePhotoUrl', type: sql.NVarChar(2048), nullable: true },

    // Distinct from employmentStatus: that is where the person stands with the
    // company, this is whether the record is in play at all.
    isActive: { column: 'IsActive', type: sql.Bit },

    // The one thing that decides what this person may do in the application.
    // NULL means no group, which means no access to anything - the correct
    // default for a new joiner. See src/enums/module.enum.js.
    groupId: { column: 'GroupId', type: sql.Int, nullable: true },

    // EmployeeDetailIds, self-referencing.
    createdBy: { column: 'CreatedBy', type: sql.BigInt, nullable: true },
    modifiedBy: { column: 'ModifiedBy', type: sql.BigInt, nullable: true },

    createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
    modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
    // NULL means live.
    deletedAt: { column: 'DeletedAt', type: sql.DateTime2, nullable: true },
  },
});

/**
 * Columns safe to hand back to a client.
 *
 * Audit columns are not among them, and neither are panNumber and
 * aadharNumber: a government identifier should leave this table only through
 * an endpoint written on purpose for it, never by being swept up in a default
 * select list. Adding one here would put it in every employee listing.
 */
export const EMPLOYEE_DETAILS_PUBLIC_PROPS = Object.freeze([
  'employeeDetailId',
  'employeeSerialNo',
  'employeeCode',
  'internalEmployeeId',
  'firstName',
  'middleName',
  'lastName',
  'nickName',
  'workEmail',
  'personalEmail',
  'phone',
  'workPhone',
  'workPhoneExtension',
  'emergencyContactNumber',
  'emergencyContactRelation',
  'dateOfBirth',
  'gender',
  'maritalStatus',
  'address',
  'presentAddressLine1',
  'presentAddressLine2',
  'presentCity',
  'presentState',
  'presentCountry',
  'presentPostalCode',
  'permanentAddress',
  'permanentAddressLine1',
  'permanentAddressLine2',
  'permanentCity',
  'permanentState',
  'permanentCountry',
  'permanentPostalCode',
  'departmentId',
  'designationId',
  'workLocationId',
  'workLocation',
  'designation',
  'department',
  'jobRole',
  'employeeBand',
  'userType',
  'sourceOfHire',
  'seatingLocation',
  'managerId',
  'secondaryManagerId',
  'additionalManagerId',
  'employmentType',
  'employmentStatus',
  'dateOfJoining',
  'probationEndDate',
  'dateOfLeaving',
  'dateOfRehire',
  'contractorEndDate',
  'totalExperience',
  'currentExperience',
  'onboardingStatus',
  'approvalStatus',
  'backgroundVerificationStatus',
  'workFromOffice',
  'billableStatus',
  'projectName',
  'taxRegime',
  'systemConfiguration',
  'additionalAccessories',
  'aboutMe',
  'expertise',
  'tags',
  'profilePhotoUrl',
  'isActive',
  'groupId',
]);
