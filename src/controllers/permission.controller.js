/**
 * Permission catalog controller. Read-only, by design - see
 * src/services/permission.service.js for why there is no create.
 */
import * as permissionService from '../services/permission.service.js';
import { sendSuccess } from '../helpers/response.helper.js';
import { HTTP_STATUS, MESSAGES } from '../enums/index.js';

/** GET /api/v1/permissions/catalog */
export async function catalog(req, res) {
  const data = await permissionService.getCatalog();

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.CATALOG_FETCHED,
    data,
  });
}
