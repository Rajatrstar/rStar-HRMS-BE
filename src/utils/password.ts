import argon2 from 'argon2';

/**
 * Password hashing, isolated behind two functions so the algorithm can be changed without
 * touching a single call site.
 *
 * argon2id with these parameters is the OWASP-recommended baseline (19 MiB, 2 passes).
 */
const HASH_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // A malformed stored hash must read as "wrong password", not as a 500.
    return false;
  }
}
