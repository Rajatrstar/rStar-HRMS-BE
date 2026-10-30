/**
 * Auth routes: path (from the enum) -> controller method.
 */
import { Router } from 'express';
import { ROUTES } from '../enums/index.js';
import * as authController from '../controllers/auth.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import {
  authLimiter,
  credentialLimiter,
  otpSendLimiter,
} from '../middlewares/rate-limit.middleware.js';

const router = Router();

// Every auth endpoint carries the per-IP limit; the ones that check a
// credential or send mail carry a per-account one on top. Order matters: the
// cheap IP check runs first, so a flood never reaches the account bookkeeping.
router.use(authLimiter);

// login and forgot-password both check a secret AND send an OTP on success,
// so they carry both per-account limiters: failed guesses are capped by one,
// the mail that a success generates by the other.
router.post(ROUTES.AUTH.LOGIN, credentialLimiter, otpSendLimiter, authController.login);
router.post(ROUTES.AUTH.VERIFY_OTP, credentialLimiter, authController.verifyOtp);
router.post(ROUTES.AUTH.RESEND_OTP, otpSendLimiter, authController.resendOtp);
router.post(
  ROUTES.AUTH.FORGOT_PASSWORD,
  credentialLimiter,
  otpSendLimiter,
  authController.forgotPassword,
);
router.post(ROUTES.AUTH.RESET_PASSWORD, credentialLimiter, authController.resetPassword);
// No per-account tier: a refresh token carries no email to key on, and the
// token's own signature check is the gate.
router.post(ROUTES.AUTH.REFRESH, authController.refresh);

// Everything below needs a valid access token.
router.get(ROUTES.AUTH.ME, authenticate, authController.me);
// Authenticated on purpose. Logout revokes the session the token names, so
// there has to BE a valid token to name one - an unauthenticated logout could
// only take a session id from the body, and that is an invitation to end
// somebody else's.
router.post(ROUTES.AUTH.LOGOUT, authenticate, authController.logout);

export default router;
