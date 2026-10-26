/**
 * Organisation routes: path (from the enum) -> guard -> controller method.
 *
 * ACCESS, stated once: today only Super Admin and HR Admin hold any of these
 * permissions - see ROLE_PERMISSION_DEFAULTS in src/enums/role.enum.js.
 *
 * That is a GRANT, not a role check. Nothing in this file names a role, and
 * nothing should: widening access to a Finance lead later is then a row in
 * tblRolePermission or a group grant through the admin API, with no deploy. A
 * `if (role === 'HR_ADMIN')` here would make the same change a code change,
 * and would be invisible to the permission matrix screen.
 */
import { Router } from 'express';
import { ROUTES, PERMISSION } from '../enums/index.js';
import * as organizationController from '../controllers/organization.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { requirePermission } from '../middlewares/permission.middleware.js';

const router = Router();

// Every endpoint below needs a valid access token. Mounted once rather than
// repeated per route, so a new endpoint cannot be added unauthenticated by
// forgetting an argument.
router.use(authenticate);

/* Organisation -------------------------------------------------------------
   No DELETE. Removing the organisation this HRMS belongs to is a decommission,
   not an operation an endpoint should offer. */

router.get(
  ROUTES.ORGANIZATIONS.LIST,
  requirePermission(PERMISSION.ORGANIZATION_VIEW),
  organizationController.list,
);

// Declared BEFORE /:organizationId, or Express matches "types" as an id and
// the request dies in the validator with "must be a whole number".
router.get(
  ROUTES.ORGANIZATIONS.TYPES,
  requirePermission(PERMISSION.ORGANIZATION_VIEW),
  organizationController.types,
);

router.post(
  ROUTES.ORGANIZATIONS.CREATE,
  requirePermission(PERMISSION.ORGANIZATION_CREATE),
  organizationController.create,
);

router.get(
  ROUTES.ORGANIZATIONS.DETAIL,
  requirePermission(PERMISSION.ORGANIZATION_VIEW),
  organizationController.detail,
);

router.put(
  ROUTES.ORGANIZATIONS.UPDATE,
  requirePermission(PERMISSION.ORGANIZATION_UPDATE),
  organizationController.update,
);

/* Locations --------------------------------------------------------------- */

router.get(
  ROUTES.ORGANIZATIONS.LOCATION_LIST,
  requirePermission(PERMISSION.ORGANIZATION_LOCATION_VIEW),
  organizationController.listLocations,
);

router.post(
  ROUTES.ORGANIZATIONS.LOCATION_CREATE,
  requirePermission(PERMISSION.ORGANIZATION_LOCATION_CREATE),
  organizationController.createLocation,
);

router.get(
  ROUTES.ORGANIZATIONS.LOCATION_DETAIL,
  requirePermission(PERMISSION.ORGANIZATION_LOCATION_VIEW),
  organizationController.locationDetail,
);

router.put(
  ROUTES.ORGANIZATIONS.LOCATION_UPDATE,
  requirePermission(PERMISSION.ORGANIZATION_LOCATION_UPDATE),
  organizationController.updateLocation,
);

router.delete(
  ROUTES.ORGANIZATIONS.LOCATION_DELETE,
  requirePermission(PERMISSION.ORGANIZATION_LOCATION_DELETE),
  organizationController.deleteLocation,
);

export default router;
