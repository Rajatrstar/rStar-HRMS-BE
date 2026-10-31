/**
 * The master-data registry: the one list that says which lookup tables exist
 * and what each one is called at every layer.
 *
 * Five tables with one shape (Name, Description, IsActive) are served by one
 * service, one controller and one route loop. This file is what makes that
 * possible without any of them hard-coding a resource: a new lookup list is a
 * migration, a model, a MODULE id, a block of MESSAGES and one entry here.
 *
 * WHAT IS DELIBERATELY NOT HERE: the models and the SQL. An enum that
 * imported src/models would make the enum layer depend on the database
 * connection, so the key -> model map lives in
 * src/services/master-data.service.js, which is the only file that needs it.
 *
 * `idProp` is the JSON property the row's own id comes back as. It is NOT the
 * path parameter - every resource takes `:id` in the URL (see
 * ROUTES.ORGANIZATIONS.MASTER_DATA).
 */
import { MODULE } from './module.enum.js';
import { ROUTES } from './api-routes.enum.js';
import { MESSAGES } from './messages.enum.js';

/** The five resources, by key. A key is what every layer passes around. */
export const MASTER_DATA = Object.freeze({
  PARENT_DEPARTMENTS: 'parentDepartments',
  DEPARTMENTS: 'departments',
  DESIGNATIONS: 'designations',
  LEAVE_TYPES: 'leaveTypes',
  CATEGORIES: 'categories',
});

/**
 * One entry per resource, in menu order.
 *
 * `path` is relative to the organisations group: the five lists are wired
 * onto that router, so /departments here is /api/v1/organizations/departments.
 *
 * `messages.inUse` is absent where nothing can point at the row yet - a leave
 * type and a category have no dependants until the leave and help-desk
 * modules land, so their delete has nothing to refuse for.
 */
export const MASTER_DATA_RESOURCES = Object.freeze([
  Object.freeze({
    key: MASTER_DATA.PARENT_DEPARTMENTS,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.PARENT_DEPARTMENTS,
    moduleId: MODULE.PARENT_DEPARTMENTS,
    idProp: 'parentDepartmentId',
    // Only a department carries a parent; the other four are flat lists.
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.PARENT_DEPARTMENTS_FETCHED,
      fetched: MESSAGES.PARENT_DEPARTMENT_FETCHED,
      created: MESSAGES.PARENT_DEPARTMENT_CREATED,
      updated: MESSAGES.PARENT_DEPARTMENT_UPDATED,
      deleted: MESSAGES.PARENT_DEPARTMENT_DELETED,
      notFound: MESSAGES.PARENT_DEPARTMENT_NOT_FOUND,
      nameExists: MESSAGES.PARENT_DEPARTMENT_NAME_EXISTS,
      inUse: MESSAGES.PARENT_DEPARTMENT_IN_USE,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.DEPARTMENTS,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.DEPARTMENTS,
    moduleId: MODULE.DEPARTMENTS,
    idProp: 'departmentId',
    hasParentDepartment: true,
    messages: Object.freeze({
      listed: MESSAGES.DEPARTMENTS_FETCHED,
      fetched: MESSAGES.DEPARTMENT_FETCHED,
      created: MESSAGES.DEPARTMENT_CREATED,
      updated: MESSAGES.DEPARTMENT_UPDATED,
      deleted: MESSAGES.DEPARTMENT_DELETED,
      notFound: MESSAGES.DEPARTMENT_NOT_FOUND,
      nameExists: MESSAGES.DEPARTMENT_NAME_EXISTS,
      inUse: MESSAGES.DEPARTMENT_IN_USE,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.DESIGNATIONS,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.DESIGNATIONS,
    moduleId: MODULE.DESIGNATIONS,
    idProp: 'designationId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.DESIGNATIONS_FETCHED,
      fetched: MESSAGES.DESIGNATION_FETCHED,
      created: MESSAGES.DESIGNATION_CREATED,
      updated: MESSAGES.DESIGNATION_UPDATED,
      deleted: MESSAGES.DESIGNATION_DELETED,
      notFound: MESSAGES.DESIGNATION_NOT_FOUND,
      nameExists: MESSAGES.DESIGNATION_NAME_EXISTS,
      inUse: MESSAGES.DESIGNATION_IN_USE,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.LEAVE_TYPES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.LEAVE_TYPES,
    moduleId: MODULE.LEAVE_TYPES,
    idProp: 'leaveTypeId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.LEAVE_TYPES_FETCHED,
      fetched: MESSAGES.LEAVE_TYPE_FETCHED,
      created: MESSAGES.LEAVE_TYPE_CREATED,
      updated: MESSAGES.LEAVE_TYPE_UPDATED,
      deleted: MESSAGES.LEAVE_TYPE_DELETED,
      notFound: MESSAGES.LEAVE_TYPE_NOT_FOUND,
      nameExists: MESSAGES.LEAVE_TYPE_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.CATEGORIES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.CATEGORIES,
    moduleId: MODULE.CATEGORIES,
    idProp: 'categoryId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.CATEGORIES_FETCHED,
      fetched: MESSAGES.CATEGORY_FETCHED,
      created: MESSAGES.CATEGORY_CREATED,
      updated: MESSAGES.CATEGORY_UPDATED,
      deleted: MESSAGES.CATEGORY_DELETED,
      notFound: MESSAGES.CATEGORY_NOT_FOUND,
      nameExists: MESSAGES.CATEGORY_NAME_EXISTS,
    }),
  }),
]);

/** key -> entry, for the layers that are handed a key rather than an entry. */
export const MASTER_DATA_RESOURCE_BY_KEY = Object.freeze(
  new Map(MASTER_DATA_RESOURCES.map((resource) => [resource.key, resource])),
);

/**
 * Column widths, mirroring db/migrations/009_master_data.sql. The controller
 * validates against these so a name SQL Server would truncate is rejected
 * with a 400 that names the field instead.
 */
export const MASTER_DATA_LIMITS = Object.freeze({
  NAME: 150,
  DESCRIPTION: 500,
});
