/**
 * The accepted values for the constrained employee columns.
 *
 * Each of these is mirrored by a CHECK constraint in
 * db/migrations/003_employee_details.sql. Adding a value means editing both -
 * deliberately, so a new employment type is a decision rather than a typo that
 * silently lands in the table.
 */

/** How somebody is engaged. CK_tblEmployeeDetails_EmploymentType. */
export const EMPLOYMENT_TYPE = Object.freeze({
  FULL_TIME: 'FullTime',
  PART_TIME: 'PartTime',
  CONTRACT: 'Contract',
  INTERN: 'Intern',
  CONSULTANT: 'Consultant',
});

/** Where somebody stands with the company. CK_tblEmployeeDetails_EmploymentStatus. */
export const EMPLOYMENT_STATUS = Object.freeze({
  ACTIVE: 'Active',
  ON_LEAVE: 'OnLeave',
  NOTICE_PERIOD: 'NoticePeriod',
  EXITED: 'Exited',
  SUSPENDED: 'Suspended',
});

/**
 * Suggested values only - the column is free text and carries no CHECK, so a
 * value outside this list is stored as given rather than rejected.
 */
export const GENDER = Object.freeze({
  MALE: 'Male',
  FEMALE: 'Female',
  OTHER: 'Other',
  PREFER_NOT_TO_SAY: 'PreferNotToSay',
});
