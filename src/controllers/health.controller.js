/**
 * Health controller.
 *
 * A controller is the only layer that knows about req/res. It reads input,
 * calls a service, and shapes the reply through the response helper — no SQL,
 * no business rules.
 */
import * as healthService from '../services/health.service.js';
import { sendSuccess, sendError } from '../helpers/response.helper.js';
import { HTTP_STATUS, MESSAGES } from '../enums/index.js';

export function liveness(req, res) {
  const data = healthService.getLiveness();

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.SERVICE_HEALTHY,
    data,
  });
}

export async function readiness(req, res) {
  const data = await healthService.getReadiness();

  // 503 while a dependency is down, so a load balancer pulls this instance out
  // of rotation instead of sending it traffic it cannot serve. It goes through
  // sendError so the degraded reply is shaped like every other failure - which
  // dependency is down lands in `details`.
  if (!data.ready) {
    return sendError(res, {
      statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
      message: MESSAGES.SERVICE_DEGRADED,
      details: data,
    });
  }

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.OK,
    message: MESSAGES.SERVICE_READY,
    data,
  });
}
