/**
 * Organisation routes: path (from the enum) -> guard -> controller method.
 *
 * ACCESS: each endpoint names the MODULE it belongs to and the ACTION it
 * performs - nothing more. WHICH GROUPS hold that action is data, not code:
 * it is set on the Add/Edit Group screen and changed without a deploy.
 *
 * Nothing in this file names a group, and nothing should. A
 * `if (group === 'HR Admin')` here would turn "let Finance see locations"
 * into a code change, and would be invisible to the rights matrix that the
 * administrator believes is the whole truth.
 */
import { Router } from 'express';
import { ROUTES } from '../enums/index.js';
import { MODULE, ACTION } from '../enums/module.enum.js';
import * as organizationController from '../controllers/organization.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { requireAccess } from '../middlewares/permission.middleware.js';

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
  requireAccess(MODULE.ORGANIZATIONS, ACTION.VIEW),
  organizationController.list,
);

// Declared BEFORE /:organizationId, or Express matches "types" as an id and
// the request dies in the validator with "must be a whole number".
router.get(
  ROUTES.ORGANIZATIONS.TYPES,
  requireAccess(MODULE.ORGANIZATIONS, ACTION.VIEW),
  organizationController.types,
);

router.post(
  ROUTES.ORGANIZATIONS.CREATE,
  requireAccess(MODULE.ORGANIZATIONS, ACTION.ADD),
  organizationController.create,
);

router.get(
  ROUTES.ORGANIZATIONS.DETAIL,
  requireAccess(MODULE.ORGANIZATIONS, ACTION.VIEW),
  organizationController.detail,
);

router.put(
  ROUTES.ORGANIZATIONS.UPDATE,
  requireAccess(MODULE.ORGANIZATIONS, ACTION.EDIT),
  organizationController.update,
);

/* Locations --------------------------------------------------------------- */

router.get(
  ROUTES.ORGANIZATIONS.LOCATION_LIST,
  requireAccess(MODULE.LOCATIONS, ACTION.VIEW),
  organizationController.listLocations,
);

router.post(
  ROUTES.ORGANIZATIONS.LOCATION_CREATE,
  requireAccess(MODULE.LOCATIONS, ACTION.ADD),
  organizationController.createLocation,
);

router.get(
  ROUTES.ORGANIZATIONS.LOCATION_DETAIL,
  requireAccess(MODULE.LOCATIONS, ACTION.VIEW),
  organizationController.locationDetail,
);

router.put(
  ROUTES.ORGANIZATIONS.LOCATION_UPDATE,
  requireAccess(MODULE.LOCATIONS, ACTION.EDIT),
  organizationController.updateLocation,
);

router.delete(
  ROUTES.ORGANIZATIONS.LOCATION_DELETE,
  requireAccess(MODULE.LOCATIONS, ACTION.DELETE),
  organizationController.deleteLocation,
);

export default router;
