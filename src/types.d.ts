import type { Role } from './enums.js';

/**
 * Fields the middleware chain attaches to the request.
 * `user` is set by `authenticate`, `id` by `requestContext`.
 */
declare global {
  namespace Express {
    interface AuthenticatedUser {
      id: string;
      role: Role;
    }

    interface Request {
      id: string;
      user?: AuthenticatedUser;
    }
  }
}

export {};
