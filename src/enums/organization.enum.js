/**
 * Suggested values for the organisation's free-text columns.
 *
 * Unlike EMPLOYMENT_TYPE these are mirrored by no CHECK constraint: the
 * industry list on a settings dropdown changes often and a schema change is
 * the wrong cost for that. A value outside this list is stored as given.
 *
 * The API serves this list so the client dropdown and the server agree on the
 * spelling without the frontend hard-coding its own copy.
 */

/** What the organisation does. dbo.tblOrganization.OrganizationType. */
export const ORGANIZATION_TYPE = Object.freeze({
  INFORMATION_TECHNOLOGY: 'Information Technology',
  CONSULTING: 'Consulting',
  MANUFACTURING: 'Manufacturing',
  HEALTHCARE: 'Healthcare',
  EDUCATION: 'Education',
  FINANCE: 'Finance',
  RETAIL: 'Retail',
  LOGISTICS: 'Logistics',
  NON_PROFIT: 'Non-profit',
  OTHER: 'Other',
});

/** The same list as an array, in dropdown order. */
export const ORGANIZATION_TYPES = Object.freeze(Object.values(ORGANIZATION_TYPE));
