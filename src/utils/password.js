/**
 * Password hashing.
 *
 * @node-rs/bcrypt is a native binding, and the reason it is here is not raw
 * speed - one comparison costs about the same as the pure-JS bcryptjs it
 * replaced. It is that the work runs on libuv's thread pool instead of the
 * event loop, so comparisons happen in parallel across cores rather than
 * queueing behind one another.
 *
 * That only matters in bursts, which is exactly when it matters: measured on a
 * dev machine, 60 simultaneous logins took ~36s of serialised bcryptjs and
 * ~4.4s here. A 10 AM login rush is the normal case for an HRMS, not an edge
 * one.
 *
 * The hash format is unchanged - the same $2b$ string bcryptjs produced, and
 * hashes written by it still verify. Nothing in the database needed migrating.
 */
import { hash, verify } from '@node-rs/bcrypt';
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
  return hash(plainText, { cost: env.BCRYPT_SALT_ROUNDS });
}

/** @returns {Promise<boolean>} */
export function verifyPassword(plainText, storedHash) {
  return verify(plainText, storedHash);
}

/** Spends the cost of a real comparison without having a hash to compare to. */
export async function fakeVerifyPassword(plainText) {
  await verify(plainText, DUMMY_HASH);
  return false;
}
