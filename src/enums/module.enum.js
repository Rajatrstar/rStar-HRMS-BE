/**
 * The module catalog - the single list of things a group can hold rights on.
 *
 * This file is the contract. dbo.tblModule is seeded from MODULE_CATALOG by
 * `npm run db:seed:modules`, the API guards name MODULE.*, and the frontend
 * menu is built from what this describes. Three consumers, one definition.
 *
 * IDS ARE FIXED AND PERMANENT. They are stored in dbo.tblAccessRight, so
 * renumbering one silently moves every group's rights onto a different
 * screen. Add new modules with new numbers; never reuse a retired one. The
 * gaps between numbers are deliberate - they leave room for a screen to be
 * added next to its siblings without renumbering anything.
 *
 * The same reasoning as clsEnum.Module in the EHMS portal, where the ids have
 * survived ten years of screens coming and going.
 */

/** Every module, by name. Guards and services use these, never a number. */
export const MODULE = Object.freeze({
  DASHBOARD: 1,

  EMPLOYEE_MANAGEMENT: 10,
  EMPLOYEES: 11,

  ORGANIZATION_SETUP: 20,
  ORGANIZATIONS: 21,
  LOCATIONS: 22,

  ADMINISTRATION: 30,
  GROUPS: 31,
  USER_ACCESS: 32,
  ERROR_LOGS: 33,

  MASTER_DATA: 40,
  PARENT_DEPARTMENTS: 41,
  DEPARTMENTS: 42,
  DESIGNATIONS: 43,
  LEAVE_TYPES: 44,
  CATEGORIES: 45,

  /* The employee-form dropdown lists - db/migrations/010. */
  GENDERS: 46,
  MARITAL_STATUSES: 47,
  RELATIONSHIPS: 48,
  SKILLS: 49,
  EMPLOYMENT_TYPES: 50,
  JOB_ROLES: 51,
  EMPLOYEE_BANDS: 52,
  WORK_LOCATION_COUNTRIES: 53,
  WORK_MODES: 54,
  BILLABILITY_TYPES: 55,
  PROJECT_CLIENTS: 56,
  COST_CENTERS: 57,
  SOURCES_OF_HIRE: 58,
  ONBOARDING_STATUSES: 59,
  BACKGROUND_VERIFICATION_STATUSES: 60,
  TAX_REGIMES: 61,
  GOVERNMENT_ID_TYPES: 62,
  DOCUMENT_TYPES: 63,
  DOCUMENT_VERIFICATION_STATUSES: 64,
  ASSET_TYPES: 65,
  ASSET_MODELS: 66,
  QUALIFICATIONS: 67,
  SPECIALIZATIONS: 68,
});

/**
 * The six rights, matching the six checkboxes on the group screen.
 *
 * View/Add/Edit/Delete are the obvious four. Print and Mail are separate
 * because "may read this on screen" and "may walk out with a PDF of it" or
 * "may email it outside the company" are genuinely different decisions for
 * employee data - which is exactly why the .NET portal keeps them apart too.
 */
export const ACTION = Object.freeze({
  VIEW: 'view',
  ADD: 'add',
  EDIT: 'edit',
  DELETE: 'delete',
  PRINT: 'print',
  MAIL: 'mail',
});

/** Every action, for iterating a rights matrix. Order is the screen's order. */
export const ACTIONS = Object.freeze([
  ACTION.VIEW,
  ACTION.ADD,
  ACTION.EDIT,
  ACTION.DELETE,
  ACTION.PRINT,
  ACTION.MAIL,
]);

/** action -> the tblAccessRight column that carries it. */
export const ACTION_COLUMN = Object.freeze({
  [ACTION.VIEW]: 'CanView',
  [ACTION.ADD]: 'CanAdd',
  [ACTION.EDIT]: 'CanEdit',
  [ACTION.DELETE]: 'CanDelete',
  [ACTION.PRINT]: 'CanPrint',
  [ACTION.MAIL]: 'CanMail',
});

/** action -> the key the API returns it under. Mirrors the column names. */
export const ACTION_PROP = Object.freeze({
  [ACTION.VIEW]: 'canView',
  [ACTION.ADD]: 'canAdd',
  [ACTION.EDIT]: 'canEdit',
  [ACTION.DELETE]: 'canDelete',
  [ACTION.PRINT]: 'canPrint',
  [ACTION.MAIL]: 'canMail',
});

/**
 * The catalog itself: what each module is, and where it sits in the menu.
 *
 * `routePath` is the FRONTEND route, not an API path. It is what lets a page
 * ask "what may I do here?" with the path it already knows
 * (GET /access/page?path=/employees) instead of having to hard-code a module
 * id in every screen.
 *
 * A row with no `routePath` is a heading: it groups children in the menu and
 * is not navigable itself. A heading still carries rights, and a child is
 * only reachable when its parent is visible too - see buildMenu().
 */
export const MODULE_CATALOG = Object.freeze([
  {
    moduleId: MODULE.DASHBOARD,
    moduleCode: 'DASHBOARD',
    moduleName: 'Dashboard',
    description: 'Landing page and summary tiles',
    parentModuleId: null,
    routePath: '/dashboard',
    icon: 'home',
    sortOrder: 10,
    showInMenu: true,
  },

  {
    moduleId: MODULE.EMPLOYEE_MANAGEMENT,
    moduleCode: 'EMPLOYEE_MANAGEMENT',
    moduleName: 'Employee Management',
    description: 'Everything about people',
    parentModuleId: null,
    routePath: null,
    icon: 'users',
    sortOrder: 20,
    showInMenu: true,
  },
  {
    moduleId: MODULE.EMPLOYEES,
    moduleCode: 'EMPLOYEES',
    moduleName: 'Employees',
    description: 'Employee records: onboarding, updates, exit and deletion',
    parentModuleId: MODULE.EMPLOYEE_MANAGEMENT,
    routePath: '/employees',
    icon: 'user',
    sortOrder: 10,
    showInMenu: true,
  },

  {
    moduleId: MODULE.ORGANIZATION_SETUP,
    moduleCode: 'ORGANIZATION_SETUP',
    moduleName: 'Organization Setup',
    description: 'Company and site master data',
    parentModuleId: null,
    routePath: null,
    icon: 'building',
    sortOrder: 30,
    showInMenu: true,
  },
  {
    moduleId: MODULE.ORGANIZATIONS,
    moduleCode: 'ORGANIZATIONS',
    moduleName: 'Organizations',
    description: 'Legal entities',
    parentModuleId: MODULE.ORGANIZATION_SETUP,
    routePath: '/organizations',
    icon: 'briefcase',
    sortOrder: 10,
    showInMenu: true,
  },
  {
    moduleId: MODULE.LOCATIONS,
    moduleCode: 'LOCATIONS',
    moduleName: 'Locations',
    description: 'Offices and sites belonging to an organization',
    parentModuleId: MODULE.ORGANIZATION_SETUP,
    routePath: '/locations',
    icon: 'map-pin',
    sortOrder: 20,
    showInMenu: true,
  },

  {
    moduleId: MODULE.ADMINISTRATION,
    moduleCode: 'ADMINISTRATION',
    moduleName: 'Administration',
    description: 'Who may do what',
    parentModuleId: null,
    routePath: null,
    icon: 'shield',
    sortOrder: 90,
    showInMenu: true,
  },
  {
    moduleId: MODULE.GROUPS,
    moduleCode: 'GROUPS',
    moduleName: 'User Groups',
    description: 'Create groups and set their rights on each module',
    parentModuleId: MODULE.ADMINISTRATION,
    routePath: '/administration/groups',
    icon: 'layers',
    sortOrder: 10,
    showInMenu: true,
  },
  {
    moduleId: MODULE.USER_ACCESS,
    moduleCode: 'USER_ACCESS',
    moduleName: 'User Access',
    description: 'Put employees into groups',
    parentModuleId: MODULE.ADMINISTRATION,
    routePath: '/administration/user-access',
    icon: 'key',
    sortOrder: 20,
    showInMenu: true,
  },
  {
    moduleId: MODULE.ERROR_LOGS,
    moduleCode: 'ERROR_LOGS',
    moduleName: 'Error Logs',
    description: 'Server and frontend failures: review, resolve, clear',
    parentModuleId: MODULE.ADMINISTRATION,
    routePath: '/administration/error-logs',
    icon: 'alert-triangle',
    sortOrder: 30,
    showInMenu: true,
  },

  {
    moduleId: MODULE.MASTER_DATA,
    moduleCode: 'MASTER_DATA',
    moduleName: 'Master Data',
    description: 'The lookup lists every other screen chooses from',
    parentModuleId: null,
    routePath: null,
    icon: 'list',
    sortOrder: 40,
    showInMenu: true,
  },
  {
    moduleId: MODULE.PARENT_DEPARTMENTS,
    moduleCode: 'PARENT_DEPARTMENTS',
    moduleName: 'Parent Departments',
    description: 'The top of the department tree',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/parent-departments',
    icon: 'git-branch',
    sortOrder: 10,
    showInMenu: true,
  },
  {
    moduleId: MODULE.DEPARTMENTS,
    moduleCode: 'DEPARTMENTS',
    moduleName: 'Departments',
    description: 'Departments, each optionally under a parent department',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/departments',
    icon: 'sitemap',
    sortOrder: 20,
    showInMenu: true,
  },
  {
    moduleId: MODULE.DESIGNATIONS,
    moduleCode: 'DESIGNATIONS',
    moduleName: 'Designations',
    description: 'Job titles an employee can hold',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/designations',
    icon: 'badge',
    sortOrder: 30,
    showInMenu: true,
  },
  {
    moduleId: MODULE.LEAVE_TYPES,
    moduleCode: 'LEAVE_TYPES',
    moduleName: 'Leave Types',
    description: 'The kinds of leave that can be applied for',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/leave-types',
    icon: 'calendar',
    sortOrder: 40,
    showInMenu: true,
  },
  {
    moduleId: MODULE.CATEGORIES,
    moduleCode: 'CATEGORIES',
    moduleName: 'Categories',
    description: 'Help-desk and announcement categories',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/categories',
    icon: 'tag',
    sortOrder: 50,
    showInMenu: true,
  },

  {
    moduleId: MODULE.GENDERS,
    moduleCode: 'GENDERS',
    moduleName: 'Genders',
    description: 'Gender options on the personal details form',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/genders',
    icon: 'user',
    sortOrder: 60,
    showInMenu: true,
  },
  {
    moduleId: MODULE.MARITAL_STATUSES,
    moduleCode: 'MARITAL_STATUSES',
    moduleName: 'Marital Statuses',
    description: 'Marital status options on the personal details form',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/marital-statuses',
    icon: 'heart',
    sortOrder: 70,
    showInMenu: true,
  },
  {
    moduleId: MODULE.RELATIONSHIPS,
    moduleCode: 'RELATIONSHIPS',
    moduleName: 'Relationships',
    description: 'How an emergency contact or a dependent is related to the employee',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/relationships',
    icon: 'users',
    sortOrder: 80,
    showInMenu: true,
  },
  {
    moduleId: MODULE.SKILLS,
    moduleCode: 'SKILLS',
    moduleName: 'Skills',
    description: 'Skills and areas of expertise an employee can be tagged with',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/skills',
    icon: 'award',
    sortOrder: 90,
    showInMenu: true,
  },
  {
    moduleId: MODULE.EMPLOYMENT_TYPES,
    moduleCode: 'EMPLOYMENT_TYPES',
    moduleName: 'Employment Types',
    description: 'The terms an employee is engaged on',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/employment-types',
    icon: 'file-text',
    sortOrder: 100,
    showInMenu: true,
  },
  {
    moduleId: MODULE.JOB_ROLES,
    moduleCode: 'JOB_ROLES',
    moduleName: 'Job Roles',
    description: 'The kind of role an employee holds, independent of their job title',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/job-roles',
    icon: 'user-check',
    sortOrder: 110,
    showInMenu: true,
  },
  {
    moduleId: MODULE.EMPLOYEE_BANDS,
    moduleCode: 'EMPLOYEE_BANDS',
    moduleName: 'Employee Bands',
    description: 'Internal grade bands',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/employee-bands',
    icon: 'bar-chart',
    sortOrder: 120,
    showInMenu: true,
  },
  {
    moduleId: MODULE.WORK_LOCATION_COUNTRIES,
    moduleCode: 'WORK_LOCATION_COUNTRIES',
    moduleName: 'Work Location Countries',
    description: 'The countries the company employs people in',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/work-location-countries',
    icon: 'globe',
    sortOrder: 130,
    showInMenu: true,
  },
  {
    moduleId: MODULE.WORK_MODES,
    moduleCode: 'WORK_MODES',
    moduleName: 'Work Modes',
    description: 'Where an employee works from',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/work-modes',
    icon: 'home',
    sortOrder: 140,
    showInMenu: true,
  },
  {
    moduleId: MODULE.BILLABILITY_TYPES,
    moduleCode: 'BILLABILITY_TYPES',
    moduleName: 'Billability Types',
    description: 'Whether an employee\'s time is billed to a client',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/billability-types',
    icon: 'dollar-sign',
    sortOrder: 150,
    showInMenu: true,
  },
  {
    moduleId: MODULE.PROJECT_CLIENTS,
    moduleCode: 'PROJECT_CLIENTS',
    moduleName: 'Projects / Clients',
    description: 'The project or client an employee is assigned to',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/project-clients',
    icon: 'folder',
    sortOrder: 160,
    showInMenu: true,
  },
  {
    moduleId: MODULE.COST_CENTERS,
    moduleCode: 'COST_CENTERS',
    moduleName: 'Cost Centers',
    description: 'The cost center an employee\'s salary is booked against',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/cost-centers',
    icon: 'credit-card',
    sortOrder: 170,
    showInMenu: true,
  },
  {
    moduleId: MODULE.SOURCES_OF_HIRE,
    moduleCode: 'SOURCES_OF_HIRE',
    moduleName: 'Sources of Hire',
    description: 'How a hire reached the company',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/sources-of-hire',
    icon: 'user-plus',
    sortOrder: 180,
    showInMenu: true,
  },
  {
    moduleId: MODULE.ONBOARDING_STATUSES,
    moduleCode: 'ONBOARDING_STATUSES',
    moduleName: 'Onboarding Statuses',
    description: 'Where a new joiner has got to in onboarding',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/onboarding-statuses',
    icon: 'clipboard',
    sortOrder: 190,
    showInMenu: true,
  },
  {
    moduleId: MODULE.BACKGROUND_VERIFICATION_STATUSES,
    moduleCode: 'BACKGROUND_VERIFICATION_STATUSES',
    moduleName: 'Background Verification Statuses',
    description: 'Where a background check has got to',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/background-verification-statuses',
    icon: 'shield-check',
    sortOrder: 200,
    showInMenu: true,
  },
  {
    moduleId: MODULE.TAX_REGIMES,
    moduleCode: 'TAX_REGIMES',
    moduleName: 'Tax Regimes',
    description: 'The tax regime an employee has elected',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/tax-regimes',
    icon: 'percent',
    sortOrder: 210,
    showInMenu: true,
  },
  {
    moduleId: MODULE.GOVERNMENT_ID_TYPES,
    moduleCode: 'GOVERNMENT_ID_TYPES',
    moduleName: 'Government ID Types',
    description: 'The kinds of government identity document on file',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/government-id-types',
    icon: 'id-card',
    sortOrder: 220,
    showInMenu: true,
  },
  {
    moduleId: MODULE.DOCUMENT_TYPES,
    moduleCode: 'DOCUMENT_TYPES',
    moduleName: 'Document Types',
    description: 'The kinds of document an employee record can hold',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/document-types',
    icon: 'file',
    sortOrder: 230,
    showInMenu: true,
  },
  {
    moduleId: MODULE.DOCUMENT_VERIFICATION_STATUSES,
    moduleCode: 'DOCUMENT_VERIFICATION_STATUSES',
    moduleName: 'Document Verification Statuses',
    description: 'Where the check on an uploaded document has got to',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/document-verification-statuses',
    icon: 'file-check',
    sortOrder: 240,
    showInMenu: true,
  },
  {
    moduleId: MODULE.ASSET_TYPES,
    moduleCode: 'ASSET_TYPES',
    moduleName: 'Asset Types',
    description: 'The kinds of company asset issued to employees, and the accessories list',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/asset-types',
    icon: 'package',
    sortOrder: 250,
    showInMenu: true,
  },
  {
    moduleId: MODULE.ASSET_MODELS,
    moduleCode: 'ASSET_MODELS',
    moduleName: 'Asset Models',
    description: 'Specific device models that can be issued',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/asset-models',
    icon: 'monitor',
    sortOrder: 260,
    showInMenu: true,
  },
  {
    moduleId: MODULE.QUALIFICATIONS,
    moduleCode: 'QUALIFICATIONS',
    moduleName: 'Qualifications',
    description: 'Education levels on the qualification form',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/qualifications',
    icon: 'book',
    sortOrder: 270,
    showInMenu: true,
  },
  {
    moduleId: MODULE.SPECIALIZATIONS,
    moduleCode: 'SPECIALIZATIONS',
    moduleName: 'Specializations',
    description: 'Fields of study on the qualification form',
    parentModuleId: MODULE.MASTER_DATA,
    routePath: '/master-data/specializations',
    icon: 'bookmark',
    sortOrder: 280,
    showInMenu: true,
  },
]);

/** moduleId -> catalog entry. Built once; the catalog never changes at runtime. */
export const MODULE_BY_ID = Object.freeze(
  new Map(MODULE_CATALOG.map((module) => [module.moduleId, module])),
);

/** Readable name for a module id, for log lines and error details. */
export function moduleName(moduleId) {
  return MODULE_BY_ID.get(moduleId)?.moduleCode ?? `module ${moduleId}`;
}
