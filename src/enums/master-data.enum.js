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

  /* The employee-form dropdown lists - db/migrations/010. */
  GENDERS: 'genders',
  MARITAL_STATUSES: 'maritalStatuses',
  RELATIONSHIPS: 'relationships',
  SKILLS: 'skills',
  EMPLOYMENT_TYPES: 'employmentTypes',
  JOB_ROLES: 'jobRoles',
  EMPLOYEE_BANDS: 'employeeBands',
  WORK_LOCATION_COUNTRIES: 'workLocationCountries',
  WORK_MODES: 'workModes',
  BILLABILITY_TYPES: 'billabilityTypes',
  PROJECT_CLIENTS: 'projectClients',
  COST_CENTERS: 'costCenters',
  SOURCES_OF_HIRE: 'sourcesOfHire',
  ONBOARDING_STATUSES: 'onboardingStatuses',
  BACKGROUND_VERIFICATION_STATUSES: 'backgroundVerificationStatuses',
  TAX_REGIMES: 'taxRegimes',
  GOVERNMENT_ID_TYPES: 'governmentIdTypes',
  DOCUMENT_TYPES: 'documentTypes',
  DOCUMENT_VERIFICATION_STATUSES: 'documentVerificationStatuses',
  ASSET_TYPES: 'assetTypes',
  ASSET_MODELS: 'assetModels',
  QUALIFICATIONS: 'qualifications',
  SPECIALIZATIONS: 'specializations',
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

  /* ---------------------------------------------------------------------
     The employee-form dropdown lists. No `inUse` on any of them: the
     employee columns behind these fields are still text (see
     db/migrations/010), so nothing points at these rows by id yet and a
     delete has nothing to refuse for.
     --------------------------------------------------------------------- */

  Object.freeze({
    key: MASTER_DATA.GENDERS,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.GENDERS,
    moduleId: MODULE.GENDERS,
    idProp: 'genderId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.GENDERS_FETCHED,
      fetched: MESSAGES.GENDER_FETCHED,
      created: MESSAGES.GENDER_CREATED,
      updated: MESSAGES.GENDER_UPDATED,
      deleted: MESSAGES.GENDER_DELETED,
      notFound: MESSAGES.GENDER_NOT_FOUND,
      nameExists: MESSAGES.GENDER_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.MARITAL_STATUSES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.MARITAL_STATUSES,
    moduleId: MODULE.MARITAL_STATUSES,
    idProp: 'maritalStatusId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.MARITAL_STATUSES_FETCHED,
      fetched: MESSAGES.MARITAL_STATUS_FETCHED,
      created: MESSAGES.MARITAL_STATUS_CREATED,
      updated: MESSAGES.MARITAL_STATUS_UPDATED,
      deleted: MESSAGES.MARITAL_STATUS_DELETED,
      notFound: MESSAGES.MARITAL_STATUS_NOT_FOUND,
      nameExists: MESSAGES.MARITAL_STATUS_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.RELATIONSHIPS,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.RELATIONSHIPS,
    moduleId: MODULE.RELATIONSHIPS,
    idProp: 'relationshipId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.RELATIONSHIPS_FETCHED,
      fetched: MESSAGES.RELATIONSHIP_FETCHED,
      created: MESSAGES.RELATIONSHIP_CREATED,
      updated: MESSAGES.RELATIONSHIP_UPDATED,
      deleted: MESSAGES.RELATIONSHIP_DELETED,
      notFound: MESSAGES.RELATIONSHIP_NOT_FOUND,
      nameExists: MESSAGES.RELATIONSHIP_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.SKILLS,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.SKILLS,
    moduleId: MODULE.SKILLS,
    idProp: 'skillId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.SKILLS_FETCHED,
      fetched: MESSAGES.SKILL_FETCHED,
      created: MESSAGES.SKILL_CREATED,
      updated: MESSAGES.SKILL_UPDATED,
      deleted: MESSAGES.SKILL_DELETED,
      notFound: MESSAGES.SKILL_NOT_FOUND,
      nameExists: MESSAGES.SKILL_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.EMPLOYMENT_TYPES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.EMPLOYMENT_TYPES,
    moduleId: MODULE.EMPLOYMENT_TYPES,
    idProp: 'employmentTypeId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.EMPLOYMENT_TYPES_FETCHED,
      fetched: MESSAGES.EMPLOYMENT_TYPE_FETCHED,
      created: MESSAGES.EMPLOYMENT_TYPE_CREATED,
      updated: MESSAGES.EMPLOYMENT_TYPE_UPDATED,
      deleted: MESSAGES.EMPLOYMENT_TYPE_DELETED,
      notFound: MESSAGES.EMPLOYMENT_TYPE_NOT_FOUND,
      nameExists: MESSAGES.EMPLOYMENT_TYPE_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.JOB_ROLES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.JOB_ROLES,
    moduleId: MODULE.JOB_ROLES,
    idProp: 'jobRoleId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.JOB_ROLES_FETCHED,
      fetched: MESSAGES.JOB_ROLE_FETCHED,
      created: MESSAGES.JOB_ROLE_CREATED,
      updated: MESSAGES.JOB_ROLE_UPDATED,
      deleted: MESSAGES.JOB_ROLE_DELETED,
      notFound: MESSAGES.JOB_ROLE_NOT_FOUND,
      nameExists: MESSAGES.JOB_ROLE_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.EMPLOYEE_BANDS,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.EMPLOYEE_BANDS,
    moduleId: MODULE.EMPLOYEE_BANDS,
    idProp: 'employeeBandId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.EMPLOYEE_BANDS_FETCHED,
      fetched: MESSAGES.EMPLOYEE_BAND_FETCHED,
      created: MESSAGES.EMPLOYEE_BAND_CREATED,
      updated: MESSAGES.EMPLOYEE_BAND_UPDATED,
      deleted: MESSAGES.EMPLOYEE_BAND_DELETED,
      notFound: MESSAGES.EMPLOYEE_BAND_NOT_FOUND,
      nameExists: MESSAGES.EMPLOYEE_BAND_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.WORK_LOCATION_COUNTRIES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.WORK_LOCATION_COUNTRIES,
    moduleId: MODULE.WORK_LOCATION_COUNTRIES,
    idProp: 'workLocationCountryId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.WORK_LOCATION_COUNTRIES_FETCHED,
      fetched: MESSAGES.WORK_LOCATION_COUNTRY_FETCHED,
      created: MESSAGES.WORK_LOCATION_COUNTRY_CREATED,
      updated: MESSAGES.WORK_LOCATION_COUNTRY_UPDATED,
      deleted: MESSAGES.WORK_LOCATION_COUNTRY_DELETED,
      notFound: MESSAGES.WORK_LOCATION_COUNTRY_NOT_FOUND,
      nameExists: MESSAGES.WORK_LOCATION_COUNTRY_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.WORK_MODES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.WORK_MODES,
    moduleId: MODULE.WORK_MODES,
    idProp: 'workModeId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.WORK_MODES_FETCHED,
      fetched: MESSAGES.WORK_MODE_FETCHED,
      created: MESSAGES.WORK_MODE_CREATED,
      updated: MESSAGES.WORK_MODE_UPDATED,
      deleted: MESSAGES.WORK_MODE_DELETED,
      notFound: MESSAGES.WORK_MODE_NOT_FOUND,
      nameExists: MESSAGES.WORK_MODE_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.BILLABILITY_TYPES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.BILLABILITY_TYPES,
    moduleId: MODULE.BILLABILITY_TYPES,
    idProp: 'billabilityTypeId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.BILLABILITY_TYPES_FETCHED,
      fetched: MESSAGES.BILLABILITY_TYPE_FETCHED,
      created: MESSAGES.BILLABILITY_TYPE_CREATED,
      updated: MESSAGES.BILLABILITY_TYPE_UPDATED,
      deleted: MESSAGES.BILLABILITY_TYPE_DELETED,
      notFound: MESSAGES.BILLABILITY_TYPE_NOT_FOUND,
      nameExists: MESSAGES.BILLABILITY_TYPE_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.PROJECT_CLIENTS,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.PROJECT_CLIENTS,
    moduleId: MODULE.PROJECT_CLIENTS,
    idProp: 'projectClientId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.PROJECT_CLIENTS_FETCHED,
      fetched: MESSAGES.PROJECT_CLIENT_FETCHED,
      created: MESSAGES.PROJECT_CLIENT_CREATED,
      updated: MESSAGES.PROJECT_CLIENT_UPDATED,
      deleted: MESSAGES.PROJECT_CLIENT_DELETED,
      notFound: MESSAGES.PROJECT_CLIENT_NOT_FOUND,
      nameExists: MESSAGES.PROJECT_CLIENT_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.COST_CENTERS,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.COST_CENTERS,
    moduleId: MODULE.COST_CENTERS,
    idProp: 'costCenterId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.COST_CENTERS_FETCHED,
      fetched: MESSAGES.COST_CENTER_FETCHED,
      created: MESSAGES.COST_CENTER_CREATED,
      updated: MESSAGES.COST_CENTER_UPDATED,
      deleted: MESSAGES.COST_CENTER_DELETED,
      notFound: MESSAGES.COST_CENTER_NOT_FOUND,
      nameExists: MESSAGES.COST_CENTER_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.SOURCES_OF_HIRE,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.SOURCES_OF_HIRE,
    moduleId: MODULE.SOURCES_OF_HIRE,
    idProp: 'sourceOfHireId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.SOURCES_OF_HIRE_FETCHED,
      fetched: MESSAGES.SOURCE_OF_HIRE_FETCHED,
      created: MESSAGES.SOURCE_OF_HIRE_CREATED,
      updated: MESSAGES.SOURCE_OF_HIRE_UPDATED,
      deleted: MESSAGES.SOURCE_OF_HIRE_DELETED,
      notFound: MESSAGES.SOURCE_OF_HIRE_NOT_FOUND,
      nameExists: MESSAGES.SOURCE_OF_HIRE_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.ONBOARDING_STATUSES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.ONBOARDING_STATUSES,
    moduleId: MODULE.ONBOARDING_STATUSES,
    idProp: 'onboardingStatusId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.ONBOARDING_STATUSES_FETCHED,
      fetched: MESSAGES.ONBOARDING_STATUS_FETCHED,
      created: MESSAGES.ONBOARDING_STATUS_CREATED,
      updated: MESSAGES.ONBOARDING_STATUS_UPDATED,
      deleted: MESSAGES.ONBOARDING_STATUS_DELETED,
      notFound: MESSAGES.ONBOARDING_STATUS_NOT_FOUND,
      nameExists: MESSAGES.ONBOARDING_STATUS_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.BACKGROUND_VERIFICATION_STATUSES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.BACKGROUND_VERIFICATION_STATUSES,
    moduleId: MODULE.BACKGROUND_VERIFICATION_STATUSES,
    idProp: 'backgroundVerificationStatusId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.BACKGROUND_VERIFICATION_STATUSES_FETCHED,
      fetched: MESSAGES.BACKGROUND_VERIFICATION_STATUS_FETCHED,
      created: MESSAGES.BACKGROUND_VERIFICATION_STATUS_CREATED,
      updated: MESSAGES.BACKGROUND_VERIFICATION_STATUS_UPDATED,
      deleted: MESSAGES.BACKGROUND_VERIFICATION_STATUS_DELETED,
      notFound: MESSAGES.BACKGROUND_VERIFICATION_STATUS_NOT_FOUND,
      nameExists: MESSAGES.BACKGROUND_VERIFICATION_STATUS_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.TAX_REGIMES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.TAX_REGIMES,
    moduleId: MODULE.TAX_REGIMES,
    idProp: 'taxRegimeId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.TAX_REGIMES_FETCHED,
      fetched: MESSAGES.TAX_REGIME_FETCHED,
      created: MESSAGES.TAX_REGIME_CREATED,
      updated: MESSAGES.TAX_REGIME_UPDATED,
      deleted: MESSAGES.TAX_REGIME_DELETED,
      notFound: MESSAGES.TAX_REGIME_NOT_FOUND,
      nameExists: MESSAGES.TAX_REGIME_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.GOVERNMENT_ID_TYPES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.GOVERNMENT_ID_TYPES,
    moduleId: MODULE.GOVERNMENT_ID_TYPES,
    idProp: 'governmentIdTypeId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.GOVERNMENT_ID_TYPES_FETCHED,
      fetched: MESSAGES.GOVERNMENT_ID_TYPE_FETCHED,
      created: MESSAGES.GOVERNMENT_ID_TYPE_CREATED,
      updated: MESSAGES.GOVERNMENT_ID_TYPE_UPDATED,
      deleted: MESSAGES.GOVERNMENT_ID_TYPE_DELETED,
      notFound: MESSAGES.GOVERNMENT_ID_TYPE_NOT_FOUND,
      nameExists: MESSAGES.GOVERNMENT_ID_TYPE_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.DOCUMENT_TYPES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.DOCUMENT_TYPES,
    moduleId: MODULE.DOCUMENT_TYPES,
    idProp: 'documentTypeId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.DOCUMENT_TYPES_FETCHED,
      fetched: MESSAGES.DOCUMENT_TYPE_FETCHED,
      created: MESSAGES.DOCUMENT_TYPE_CREATED,
      updated: MESSAGES.DOCUMENT_TYPE_UPDATED,
      deleted: MESSAGES.DOCUMENT_TYPE_DELETED,
      notFound: MESSAGES.DOCUMENT_TYPE_NOT_FOUND,
      nameExists: MESSAGES.DOCUMENT_TYPE_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.DOCUMENT_VERIFICATION_STATUSES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.DOCUMENT_VERIFICATION_STATUSES,
    moduleId: MODULE.DOCUMENT_VERIFICATION_STATUSES,
    idProp: 'documentVerificationStatusId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.DOCUMENT_VERIFICATION_STATUSES_FETCHED,
      fetched: MESSAGES.DOCUMENT_VERIFICATION_STATUS_FETCHED,
      created: MESSAGES.DOCUMENT_VERIFICATION_STATUS_CREATED,
      updated: MESSAGES.DOCUMENT_VERIFICATION_STATUS_UPDATED,
      deleted: MESSAGES.DOCUMENT_VERIFICATION_STATUS_DELETED,
      notFound: MESSAGES.DOCUMENT_VERIFICATION_STATUS_NOT_FOUND,
      nameExists: MESSAGES.DOCUMENT_VERIFICATION_STATUS_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.ASSET_TYPES,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.ASSET_TYPES,
    moduleId: MODULE.ASSET_TYPES,
    idProp: 'assetTypeId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.ASSET_TYPES_FETCHED,
      fetched: MESSAGES.ASSET_TYPE_FETCHED,
      created: MESSAGES.ASSET_TYPE_CREATED,
      updated: MESSAGES.ASSET_TYPE_UPDATED,
      deleted: MESSAGES.ASSET_TYPE_DELETED,
      notFound: MESSAGES.ASSET_TYPE_NOT_FOUND,
      nameExists: MESSAGES.ASSET_TYPE_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.ASSET_MODELS,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.ASSET_MODELS,
    moduleId: MODULE.ASSET_MODELS,
    idProp: 'assetModelId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.ASSET_MODELS_FETCHED,
      fetched: MESSAGES.ASSET_MODEL_FETCHED,
      created: MESSAGES.ASSET_MODEL_CREATED,
      updated: MESSAGES.ASSET_MODEL_UPDATED,
      deleted: MESSAGES.ASSET_MODEL_DELETED,
      notFound: MESSAGES.ASSET_MODEL_NOT_FOUND,
      nameExists: MESSAGES.ASSET_MODEL_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.QUALIFICATIONS,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.QUALIFICATIONS,
    moduleId: MODULE.QUALIFICATIONS,
    idProp: 'qualificationId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.QUALIFICATIONS_FETCHED,
      fetched: MESSAGES.QUALIFICATION_FETCHED,
      created: MESSAGES.QUALIFICATION_CREATED,
      updated: MESSAGES.QUALIFICATION_UPDATED,
      deleted: MESSAGES.QUALIFICATION_DELETED,
      notFound: MESSAGES.QUALIFICATION_NOT_FOUND,
      nameExists: MESSAGES.QUALIFICATION_NAME_EXISTS,
    }),
  }),

  Object.freeze({
    key: MASTER_DATA.SPECIALIZATIONS,
    path: ROUTES.ORGANIZATIONS.MASTER_DATA.RESOURCE.SPECIALIZATIONS,
    moduleId: MODULE.SPECIALIZATIONS,
    idProp: 'specializationId',
    hasParentDepartment: false,
    messages: Object.freeze({
      listed: MESSAGES.SPECIALIZATIONS_FETCHED,
      fetched: MESSAGES.SPECIALIZATION_FETCHED,
      created: MESSAGES.SPECIALIZATION_CREATED,
      updated: MESSAGES.SPECIALIZATION_UPDATED,
      deleted: MESSAGES.SPECIALIZATION_DELETED,
      notFound: MESSAGES.SPECIALIZATION_NOT_FOUND,
      nameExists: MESSAGES.SPECIALIZATION_NAME_EXISTS,
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
