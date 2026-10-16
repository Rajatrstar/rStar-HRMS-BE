/**
 * Every email the application can send.
 *
 * The value is the file stem under `src/templates/`, so `OTP_LOGIN` resolves to
 * `src/templates/otp-login.html` (plus an optional `otp-login.txt` for the
 * plain-text part). Callers only ever name the constant - nothing in the
 * application passes a filename around.
 *
 * Adding an email is two steps: add the entry here, drop the .html file next to
 * its siblings. `assertTemplatesExist()` in ../utils/template.js checks the two
 * stay in step at boot.
 */
export const EMAIL_TEMPLATE = Object.freeze({
  OTP_LOGIN: 'otp-login',
  PASSWORD_RESET: 'password-reset',
});
