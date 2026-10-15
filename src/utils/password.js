/**
 * Password hashing. bcryptjs is the pure-JavaScript bcrypt implementation, so
 * there is no native module to compile on a dev machine or CI image.
 */
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

/**
 * A valid bcrypt hash of a value nobody knows.
 *
 * Used to burn the same CPU time when an email does not exist as when it does.
 * Without it, a missing account answers measurably faster than a wrong
 * password, which lets an attacker enumerate valid addresses with a stopwatch.
 */
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.7fQKBoVOEVOuAcA6xB0OaOqWmgDiLLy';

/** @returns {Promise<string>} a 60-character bcrypt hash */
export function hashPassword(plainText) {
  return bcrypt.hash(plainText, env.BCRYPT_SALT_ROUNDS);
}

/** @returns {Promise<boolean>} */
export function verifyPassword(plainText, hash) {
  return bcrypt.compare(plainText, hash);
}

/** Spends the cost of a real comparison without having a hash to compare to. */
export async function fakeVerifyPassword(plainText) {
  await bcrypt.compare(plainText, DUMMY_HASH);
  return false;
}
