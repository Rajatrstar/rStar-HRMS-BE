import type { Request, Response } from 'express';
import { HttpStatus } from '../enums.js';
import { sendSuccess } from '../utils/api-response.js';
import { ApiError } from '../utils/api-error.js';
import * as authService from '../services/auth.service.js';
import type { LoginInput, RefreshInput } from '../validations/auth.validation.js';

/** Controllers translate HTTP to service calls and back. No business logic lives here. */

export async function login(req: Request, res: Response): Promise<void> {
  const tokens = await authService.login(req.body as LoginInput, fingerprint(req));
  sendSuccess(res, tokens);
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as RefreshInput;
  const tokens = await authService.rotateTokenPair(refreshToken, fingerprint(req));
  sendSuccess(res, tokens);
}

export async function logout(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as RefreshInput;
  await authService.logout(refreshToken, req.user?.id);
  res.status(HttpStatus.NO_CONTENT).send();
}

export async function me(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  sendSuccess(res, await authService.getProfile(req.user.id));
}

function fingerprint(req: Request): { userAgent?: string; ipAddress?: string } {
  return { userAgent: req.get('user-agent'), ipAddress: req.ip };
}
