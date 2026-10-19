/**
 * Auth routes: path (from the enum) -> controller method.
 */
import { Router } from 'express';
import { ROUTES } from '../enums/index.js';
import * as authController from '../controllers/auth.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';

const router = Router();

router.post(ROUTES.AUTH.LOGIN, authController.login);
router.post(ROUTES.AUTH.VERIFY_OTP, authController.verifyOtp);
router.post(ROUTES.AUTH.RESEND_OTP, authController.resendOtp);
router.post(ROUTES.AUTH.FORGOT_PASSWORD, authController.forgotPassword);
router.post(ROUTES.AUTH.RESET_PASSWORD, authController.resetPassword);
router.post(ROUTES.AUTH.REFRESH, authController.refresh);

// Everything below needs a valid access token.
router.get(ROUTES.AUTH.ME, authenticate, authController.me);

export default router;
