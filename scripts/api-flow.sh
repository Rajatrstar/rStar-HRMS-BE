#!/usr/bin/env bash
#
# The whole login flow in curl, with the bearer token captured automatically.
# The Postman collection does exactly this; use whichever you prefer.
#
#   ./scripts/api-flow.sh
#   BASE_URL=https://hrms-staging.rstartec.com/api/v1 ./scripts/api-flow.sh
#   EMAIL=someone@rstartec.com PASSWORD=secret ./scripts/api-flow.sh
#
# Requires OTP_IN_RESPONSE=true on the server (development only). Without it,
# set OTP=123456 yourself from the server log:
#
#   OTP=512774 ./scripts/api-flow.sh
#
# The forgot-password flow runs last and is opt-in, because it really does
# change a password. Give it an employee whose work email and date of birth
# are both in dbo.tblEmployeeDetails:
#
#   FORGOT_EMAIL=anmol.ghai@rstartec.com FORGOT_DOB=1995-06-12 ./scripts/api-flow.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:5000/api/v1}"
EMAIL="${EMAIL:-admin@rstartec.com}"
PASSWORD="${PASSWORD:-admin}"

# Blank skips the forgot-password section entirely.
FORGOT_EMAIL="${FORGOT_EMAIL:-}"
FORGOT_DOB="${FORGOT_DOB:-}"
NEW_PASSWORD="${NEW_PASSWORD:-NewPass@123}"

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=$1;console.log(v===undefined?'':v)}catch{console.log('')}})"; }
step() { printf '\n\033[36m== %s\033[0m\n' "$1"; }

step "1. health  ->  GET $BASE_URL/health"
curl -sS "$BASE_URL/health" | json "j.message"

step "2. health/ready  ->  GET $BASE_URL/health/ready"
# 503 here is a real answer, not a transport failure, so the pipeline must not
# abort on it - hence the explicit || true under `set -e`.
READY=$(curl -sS "$BASE_URL/health/ready" || true)
echo "$READY" | json "j.message"

step "3. login  ->  POST $BASE_URL/auth/login"
LOGIN=$(curl -sS -X POST "$BASE_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
echo "$LOGIN" | json "j.message"

OTP="${OTP:-$(echo "$LOGIN" | json "j.data && j.data.otp")}"
if [ -z "$OTP" ]; then
  echo "No OTP in the response. Either set OTP_IN_RESPONSE=true on the server," >&2
  echo "or read the code from the server log and re-run with OTP=<code>." >&2
  exit 1
fi
echo "OTP captured automatically: $OTP"

step "4. resend-otp  ->  POST $BASE_URL/auth/resend-otp"
RESENT=$(curl -sS -X POST "$BASE_URL/auth/resend-otp" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\"}")
echo "$RESENT" | json "j.message"

# The resent code replaces the one login issued, so the previous one is dead.
# Only adopt it when the server actually hands it back; otherwise a code passed
# in via OTP= is all there is - and it is now stale.
RESENT_OTP=$(echo "$RESENT" | json "j.data && j.data.otp")
if [ -n "$RESENT_OTP" ]; then
  OTP="$RESENT_OTP"
  echo "OTP replaced with: $OTP"
else
  echo "No OTP in the resend response - the previous code is now stale." >&2
fi

step "5. verify-otp  ->  POST $BASE_URL/auth/verify-otp"
TOKENS=$(curl -sS -X POST "$BASE_URL/auth/verify-otp" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"otp\":\"$OTP\"}")
ACCESS_TOKEN=$(echo "$TOKENS" | json "j.data && j.data.accessToken")
REFRESH_TOKEN=$(echo "$TOKENS" | json "j.data && j.data.refreshToken")

if [ -z "$ACCESS_TOKEN" ]; then
  echo "Login failed: $TOKENS" >&2
  exit 1
fi
echo "access token  : ${ACCESS_TOKEN:0:40}..."
echo "refresh token : ${REFRESH_TOKEN:0:40}..."

step "6. me  ->  GET $BASE_URL/auth/me  (token used automatically)"
curl -sS "$BASE_URL/auth/me" -H "Authorization: Bearer $ACCESS_TOKEN"
echo

step "7. refresh  ->  POST $BASE_URL/auth/refresh"
curl -sS -X POST "$BASE_URL/auth/refresh" \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}" | json "j.message"

# --- forgot password -------------------------------------------------------
# Opt-in: this writes a new password hash, so it stays off unless an employee
# is named explicitly.
if [ -n "$FORGOT_EMAIL" ] && [ -n "$FORGOT_DOB" ]; then
  step "8. forgot-password  ->  POST $BASE_URL/auth/forgot-password"
  FORGOT=$(curl -sS -X POST "$BASE_URL/auth/forgot-password" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$FORGOT_EMAIL\",\"dateOfBirth\":\"$FORGOT_DOB\"}")
  echo "$FORGOT" | json "j.message"

  RESET_OTP="${RESET_OTP:-$(echo "$FORGOT" | json "j.data && j.data.otp")}"
  if [ -z "$RESET_OTP" ]; then
    echo "No reset OTP in the response. Set OTP_IN_RESPONSE=true on the server," >&2
    echo "or read the code from the log and re-run with RESET_OTP=<code>." >&2
    exit 1
  fi
  echo "Reset OTP captured: $RESET_OTP"

  step "9. reset-password  ->  POST $BASE_URL/auth/reset-password"
  RESET=$(curl -sS -X POST "$BASE_URL/auth/reset-password" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$FORGOT_EMAIL\",\"otp\":\"$RESET_OTP\",\"newPassword\":\"$NEW_PASSWORD\"}")
  echo "$RESET" | json "j.message"

  if [ "$(echo "$RESET" | json "j.success")" != "true" ]; then
    echo "Password reset failed: $RESET" >&2
    exit 1
  fi
  printf '\033[33mPassword for %s is now: %s\033[0m\n' "$FORGOT_EMAIL" "$NEW_PASSWORD"
else
  step "8-9. forgot-password / reset-password  ->  skipped"
  echo "Set FORGOT_EMAIL and FORGOT_DOB to exercise the reset flow."
fi

printf '\n\033[32mFlow complete.\033[0m Export the token for ad-hoc calls:\n'
printf '  export TOKEN=%s\n' "$ACCESS_TOKEN"
printf '  curl %s/auth/me -H "Authorization: Bearer $TOKEN"\n' "$BASE_URL"
