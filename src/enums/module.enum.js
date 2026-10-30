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
]);

/** moduleId -> catalog entry. Built once; the catalog never changes at runtime. */
export const MODULE_BY_ID = Object.freeze(
  new Map(MODULE_CATALOG.map((module) => [module.moduleId, module])),
);

/** Readable name for a module id, for log lines and error details. */
export function moduleName(moduleId) {
  return MODULE_BY_ID.get(moduleId)?.moduleCode ?? `module ${moduleId}`;
}
