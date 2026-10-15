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
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:5000/api/v1}"
EMAIL="${EMAIL:-admin@rstartec.com}"
PASSWORD="${PASSWORD:-admin}"

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=$1;console.log(v===undefined?'':v)}catch{console.log('')}})"; }
step() { printf '\n\033[36m== %s\033[0m\n' "$1"; }

step "1. login  ->  POST $BASE_URL/auth/login"
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

step "2. verify-otp  ->  POST $BASE_URL/auth/verify-otp"
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

step "3. me  ->  GET $BASE_URL/auth/me  (token used automatically)"
curl -sS "$BASE_URL/auth/me" -H "Authorization: Bearer $ACCESS_TOKEN"
echo

step "4. refresh  ->  POST $BASE_URL/auth/refresh"
curl -sS -X POST "$BASE_URL/auth/refresh" \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}" | json "j.message"

printf '\n\033[32mFlow complete.\033[0m Export the token for ad-hoc calls:\n'
printf '  export TOKEN=%s\n' "$ACCESS_TOKEN"
printf '  curl %s/auth/me -H "Authorization: Bearer $TOKEN"\n' "$BASE_URL"
