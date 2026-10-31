/**
 * Master-data routes: five lookup lists, all wired from the same loop.
 *
 *   /api/v1/organizations/parent-departments
 *   /api/v1/organizations/departments
 *   /api/v1/organizations/designations
 *   /api/v1/organizations/leave-types
 *   /api/v1/organizations/categories
 *
 * THEY ARE REGISTERED ONTO THE ORGANISATION ROUTER rather than mounted as a
 * group of their own, which is why this file exports a function instead of a
 * router. Two reasons, and both are about where a lookup list belongs:
 *
 *   - It is organisation setup. A department and a designation are the same
 *     kind of thing as a location - company master data the employee screens
 *     choose from - so they answer under the same group.
 *   - A separate router mounted at the same path would have to be ordered
 *     ahead of the organisation one to avoid `/:organizationId` swallowing
 *     `/departments`, and would run `authenticate` twice for every
 *     organisation request. Registering onto the one router makes that
 *     ordering explicit, in one file, where the next person will see it.
 *
 * They sit beside /organizations and not under /organizations/:organizationId
 * because a department belongs to the company, not to one organisation row -
 * unlike a location, which only means anything as part of one.
 *
 * ACCESS: each endpoint names the MODULE it belongs to and the ACTION it
 * performs - nothing more. The module comes from the registry entry, so the
 * five lists are genuinely separate rights: a group can be allowed to edit
 * designations without being handed departments. Today only the system groups
 * and HR Admin hold any of them - see scripts/grant-master-data-access.js.
 *
 * The loop does not weaken the boot-time route audit in src/index.js: every
 * route still gets a real requireAccess guard carrying a real module id and
 * action, and a registry entry with a missing moduleId fails at wiring time
 * rather than serving an unguarded endpoint.
 *
 * Nothing in this file names a group, and nothing should - which groups hold
 * which action is data, set on the group screen and changed without a deploy.
 */
import { ROUTES, MASTER_DATA_RESOURCES } from '../enums/index.js';
import { ACTION } from '../enums/module.enum.js';
import { buildMasterDataController } from '../controllers/master-data.controller.js';
import { requireAccess } from '../middlewares/permission.middleware.js';

/**
 * Adds the five lookup lists to a router.
 *
 * The caller owns `authenticate` - this registers guarded routes onto a
 * router that is already behind it.
 *
 * @param {import('express').Router} router the organisations router
 */
export function registerMasterDataRoutes(router) {
  for (const resource of MASTER_DATA_RESOURCES) {
    const controller = buildMasterDataController(resource);

    const collection = `${resource.path}${ROUTES.ORGANIZATIONS.MASTER_DATA.COLLECTION}`;
    const item = `${resource.path}${ROUTES.ORGANIZATIONS.MASTER_DATA.ITEM}`;

    router.get(collection, requireAccess(resource.moduleId, ACTION.VIEW), controller.list);
    router.post(collection, requireAccess(resource.moduleId, ACTION.ADD), controller.create);

    router.get(item, requireAccess(resource.moduleId, ACTION.VIEW), controller.detail);
    router.put(item, requireAccess(resource.moduleId, ACTION.EDIT), controller.update);
    router.delete(item, requireAccess(resource.moduleId, ACTION.DELETE), controller.remove);
  }
}
