/**
 * The accepted values for the constrained employee columns.
 *
 * EMPLOYMENT_TYPE and EMPLOYMENT_STATUS are each mirrored by a CHECK
 * constraint - written in db/migrations/001_employee_details.sql and widened
 * in 007_employee_details_hr_fields.sql. Adding a value means editing both,
 * deliberately, so a new employment type is a decision rather than a typo
 * that silently lands in the table.
 *
 * Everything below those two is a SUGGESTION list: the column is free text
 * and carries no CHECK, so a value outside the list is stored as given rather
 * than rejected. They exist so a form has something to populate a dropdown
 * from and so the spelling stays consistent, not to enforce anything.
 */

/**
 * How somebody is engaged. CK_tblEmployeeDetails_EmploymentType.
 *
 * Two vocabularies live here. The first five are this schema's own; PERMANENT
 * and TEMPORARY come from the Zoho People export, which writes "Permanent"
 * where we would write "FullTime". Both are accepted because rows already use
 * the first set and the import produces the second. That is a duplication
 * worth closing one day - by migrating the data, not by narrowing the CHECK
 * underneath it.
 */
export const EMPLOYMENT_TYPE = Object.freeze({
  FULL_TIME: 'FullTime',
  PART_TIME: 'PartTime',
  CONTRACT: 'Contract',
  INTERN: 'Intern',
  CONSULTANT: 'Consultant',

  // Zoho People vocabulary.
  PERMANENT: 'Permanent',
  TEMPORARY: 'Temporary',
});

/**
 * Where somebody stands with the company. CK_tblEmployeeDetails_EmploymentStatus.
 *
 * Same split as above: the first five are ours, the last three are Zoho's.
 * Note that INACTIVE and EXITED overlap, as do RESIGNED and NOTICE_PERIOD.
 */
export const EMPLOYMENT_STATUS = Object.freeze({
  ACTIVE: 'Active',
  ON_LEAVE: 'OnLeave',
  NOTICE_PERIOD: 'NoticePeriod',
  EXITED: 'Exited',
  SUSPENDED: 'Suspended',

  // Zoho People vocabulary.
  INACTIVE: 'Inactive',
  RESIGNED: 'Resigned',
  TERMINATED: 'Terminated',
});

/** Suggested values only - the column is free text. */
export const GENDER = Object.freeze({
  MALE: 'Male',
  FEMALE: 'Female',
  OTHER: 'Other',
  PREFER_NOT_TO_SAY: 'PreferNotToSay',
});

/** Suggested values only. */
export const MARITAL_STATUS = Object.freeze({
  SINGLE: 'Single',
  MARRIED: 'Married',
  DIVORCED: 'Divorced',
  WIDOWED: 'Widowed',
  PREFER_NOT_TO_SAY: 'PreferNotToSay',
});

/**
 * What the person IS to the company, which is not the same question as how
 * they are engaged - that is EMPLOYMENT_TYPE. A contractor can be permanent.
 * Suggested values only.
 */
export const USER_TYPE = Object.freeze({
  EMPLOYEE: 'Employee',
  CONTRACTOR: 'Contractor',
  VENDOR: 'Vendor',
  INTERN: 'Intern',
});

/** "B/NB" in the Zoho export. Suggested values only. */
export const BILLABLE_STATUS = Object.freeze({
  BILLABLE: 'Billable',
  NON_BILLABLE: 'Non-Billable',
});

/** Indian payroll. Suggested values only. */
export const TAX_REGIME = Object.freeze({
  NEW: 'New',
  OLD: 'Old',
});

/** Where a new joiner is in onboarding. Suggested values only. */
export const ONBOARDING_STATUS = Object.freeze({
  NOT_TRIGGERED: 'Not Triggered',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
});

/** Background verification. "BGV" in the export. Suggested values only. */
export const BGV_STATUS = Object.freeze({
  NOT_INITIATED: 'Not Initiated',
  IN_PROGRESS: 'In Progress',
  CLEARED: 'Cleared',
  FAILED: 'Failed',
});

/** Whether the employee record itself has been signed off. Suggested only. */
export const APPROVAL_STATUS = Object.freeze({
  NOT_SUBMITTED: 'Not Submitted',
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
});
