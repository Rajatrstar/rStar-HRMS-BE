/**
 * dbo.tblOrganization and dbo.tblOrganizationLocation.
 *
 * Mirrors db/migrations/005_organization.sql. One file because they are one
 * feature: nothing reads a location without knowing its organisation.
 *
 * Soft delete: every read path must filter `WHERE DeletedAt IS NULL`. Nothing
 * in either table is ever DELETEd - tblEmployeeDetails.WorkLocationId points
 * at a location, and a real FOREIGN KEY now enforces it.
 */
import { sql } from '../config/db.js';
import { defineModel } from './define-model.js';

/** Audit and soft-delete columns, identical on both tables. */
const auditColumns = () => ({
  createdBy: { column: 'CreatedBy', type: sql.Int, nullable: true },
  modifiedBy: { column: 'ModifiedBy', type: sql.Int, nullable: true },
  createdAt: { column: 'CreatedAt', type: sql.DateTime2 },
  modifiedAt: { column: 'ModifiedAt', type: sql.DateTime2 },
  // NULL means live.
  deletedAt: { column: 'DeletedAt', type: sql.DateTime2, nullable: true },
});

/**
 * Postal address, identical on both tables.
 *
 * Shared as a function rather than a frozen object so the two tables cannot
 * accidentally share one mutable column descriptor.
 */
const addressColumns = () => ({
  addressLine1: { column: 'AddressLine1', type: sql.NVarChar(255), nullable: true },
  addressLine2: { column: 'AddressLine2', type: sql.NVarChar(255), nullable: true },
  city: { column: 'City', type: sql.NVarChar(100), nullable: true },
  state: { column: 'State', type: sql.NVarChar(100), nullable: true },
  country: { column: 'Country', type: sql.NVarChar(100), nullable: true },
  postalCode: { column: 'PostalCode', type: sql.NVarChar(20), nullable: true },
});

/** dbo.tblOrganization - the "Basic details" screen. */
export const Organization = defineModel({
  table: 'dbo.tblOrganization',
  columns: {
    organizationId: { column: 'OrganizationId', type: sql.BigInt, identity: true },

    organizationName: { column: 'OrganizationName', type: sql.NVarChar(200) },
    logoUrl: { column: 'LogoUrl', type: sql.NVarChar(2048), nullable: true },
    website: { column: 'Website', type: sql.NVarChar(2048), nullable: true },
    // Values from ORGANIZATION_TYPE in src/enums/organization.enum.js, but the
    // column carries no CHECK - anything else is stored as given.
    organizationType: { column: 'OrganizationType', type: sql.NVarChar(100), nullable: true },

    contactPerson: { column: 'ContactPerson', type: sql.NVarChar(150), nullable: true },
    contactNumber: { column: 'ContactNumber', type: sql.NVarChar(20), nullable: true },
    contactEmail: { column: 'ContactEmail', type: sql.NVarChar(255) },

    ...addressColumns(),

    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
  },
});

/** dbo.tblOrganizationLocation - the master list of sites. */
export const OrganizationLocation = defineModel({
  table: 'dbo.tblOrganizationLocation',
  columns: {
    locationId: { column: 'LocationId', type: sql.BigInt, identity: true },
    organizationId: { column: 'OrganizationId', type: sql.BigInt },

    locationName: { column: 'LocationName', type: sql.NVarChar(150) },
    // Optional. Unique per organisation among live rows when set.
    locationCode: { column: 'LocationCode', type: sql.NVarChar(50), nullable: true },

    email: { column: 'Email', type: sql.NVarChar(255), nullable: true },

    ...addressColumns(),

    // An IANA zone name - "Asia/Kolkata", not "+05:30".
    timeZone: { column: 'TimeZone', type: sql.NVarChar(100), nullable: true },
    description: { column: 'Description', type: sql.NVarChar(500), nullable: true },

    isActive: { column: 'IsActive', type: sql.Bit },

    ...auditColumns(),
  },
});

/** Organisation columns safe to hand back to a client. Audit columns are not. */
export const ORGANIZATION_PUBLIC_PROPS = Object.freeze([
  'organizationId',
  'organizationName',
  'logoUrl',
  'website',
  'organizationType',
  'contactPerson',
  'contactNumber',
  'contactEmail',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'country',
  'postalCode',
  'isActive',
  // Carried so a client can detect a stale edit. The write path does not use
  // it for optimistic concurrency yet; MODIFIED_ELSEWHERE is where that lands.
  'modifiedAt',
]);

/** Location columns safe to hand back to a client. */
export const ORGANIZATION_LOCATION_PUBLIC_PROPS = Object.freeze([
  'locationId',
  'organizationId',
  'locationName',
  'locationCode',
  'email',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'country',
  'postalCode',
  'timeZone',
  'description',
  'isActive',
  'modifiedAt',
]);
