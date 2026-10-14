import { Router } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { authRateLimiter, validate } from '../middlewares/request.middleware.js';
import { loginSchema, refreshSchema } from '../validations/auth.validation.js';

const router = Router();

// There is no public registration endpoint by design - HRMS accounts are provisioned by HR.
router.post('/login', authRateLimiter, validate({ body: loginSchema }), authController.login);
router.post('/refresh', authRateLimiter, validate({ body: refreshSchema }), authController.refresh);
router.post('/logout', validate({ body: refreshSchema }), authController.logout);
router.get('/me', authenticate, authController.me);

export default router;
