import { z } from 'zod';

export const loginSchema = z.object({
  email: z.email().max(190).trim().toLowerCase(),
  // No complexity rules on login - only on password *creation*. Rejecting a "weak" password
  // at login would tell an attacker which guesses were worth making.
  password: z.string().min(1, 'Password is required').max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
