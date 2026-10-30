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
# The organisation section reads by default. The create/update/delete walk is
# opt-in, because an organisation row cannot be removed afterwards - there is
# no DELETE endpoint for one, by design:
#
#   ORG_DEMO=1 ./scripts/api-flow.sh
#
# Both need a login whose GROUP holds View on the Organizations and Locations
# modules. A 403 is reported and skipped, not fatal.
#
# The forgot-password flow runs last and is opt-in, because it really does
# change a password. Give it an employee whose work email and date of birth
# are both in dbo.tblEmployeeDetails:
#
#   FORGOT_EMAIL=anmol.ghai@rstartec.com FORGOT_DOB=1995-06-12 ./scripts/api-flow.sh
#
# Employee writes are behind a switch too - they create a real employee,
# exit them and delete them again:
#
#   EMP_DEMO=1 PASSWORD=... ./scripts/api-flow.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:5000/api/v1}"
# The only account that holds anything out of the box is the one `npm run
# db:create:admin` puts in the Administrator group. Anyone else can sign in and
# will then be refused by every guarded endpoint, which looks like a bug and is
# not one - they are in no group.
EMAIL="${EMAIL:-rajat.kushwaha@rstartec.com}"
# No default: a wrong one produces a 401 at step 2 and a confusing 403 trail
# after it, so fail loudly here instead.
PASSWORD="${PASSWORD:-}"
if [ -z "$PASSWORD" ]; then
  echo "PASSWORD is not set. Run: PASSWORD='...' ./scripts/api-flow.sh" >&2
  exit 1
fi

# Blank skips the forgot-password section entirely.
FORGOT_EMAIL="${FORGOT_EMAIL:-}"
FORGOT_DOB="${FORGOT_DOB:-}"
NEW_PASSWORD="${NEW_PASSWORD:-NewPass@123}"

# Blank keeps the organisation section read-only.
ORG_DEMO="${ORG_DEMO:-}"

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

# The rotated pair is adopted, not discarded: the rest of the run - logout
# included - should exercise the tokens a real client would now be holding.
# Both stay in the SAME session as the pair login issued, which is what lets
# step 20 end all of them at once.
step "7. refresh  ->  POST $BASE_URL/auth/refresh"
REFRESHED=$(curl -sS -X POST "$BASE_URL/auth/refresh" \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}")
echo "$REFRESHED" | json "j.message"

NEW_ACCESS=$(echo "$REFRESHED" | json "j.data && j.data.accessToken")
if [ -n "$NEW_ACCESS" ]; then
  ACCESS_TOKEN="$NEW_ACCESS"
  REFRESH_TOKEN=$(echo "$REFRESHED" | json "j.data && j.data.refreshToken")
  echo "Rotated. Using the refreshed pair from here on."
fi

# --- organisation ----------------------------------------------------------
# Needs organization.view, which only Super Admin and HR Admin hold today. A
# 403 is a real answer here - it means the login is not an admin - so it is
# reported and the section moves on rather than killing the run.

step "8. organizations  ->  GET $BASE_URL/organizations"
ORGS=$(curl -sS "$BASE_URL/organizations" -H "Authorization: Bearer $ACCESS_TOKEN")
echo "$ORGS" | json "j.message"
ORG_COUNT=$(echo "$ORGS" | json "j.meta && j.meta.total")
# `if`, not `[ -n ... ] && echo`: under `set -e` a false AND-list is a failing
# command and would abort the run - on exactly the 403 this is here to report.
if [ -n "$ORG_COUNT" ]; then
  echo "organizations on file: $ORG_COUNT"
fi

# details.requiredAccess names the module and the action, so a help-desk ticket
# can quote the exact checkbox instead of guessing which group is missing what.
ORG_DENIED=$(echo "$ORGS" | json "j.details && j.details.requiredAccess && j.details.requiredAccess.module + ':' + j.details.requiredAccess.action")
if [ -n "$ORG_DENIED" ]; then
  echo "missing right: $ORG_DENIED - tick it for this user's group on the group screen"
fi

step "9. organization types  ->  GET $BASE_URL/organizations/types"
# Falls back to the message, so a denial reads as a denial rather than "null".
curl -sS "$BASE_URL/organizations/types" -H "Authorization: Bearer $ACCESS_TOKEN" \
  | json "j.data ? j.data.join(', ') : j.message"

if [ -n "$ORG_DEMO" ]; then
  # Unique per run: OrganizationName is unique among live rows, and nothing
  # here can delete the one a previous run left behind.
  ORG_NAME="curl flow $(date +%s)"

  step "10. create organization  ->  POST $BASE_URL/organizations"
  CREATED=$(curl -sS -X POST "$BASE_URL/organizations" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"organizationName\":\"$ORG_NAME\",\"website\":\"https://rstartec.com/\",\"organizationType\":\"Information Technology\",\"contactPerson\":\"Shakun Arora\",\"contactNumber\":\"9999299385\",\"contactEmail\":\"shakun.arora@rstartec.com\",\"addressLine1\":\"770 Pasquinelli Drive\",\"addressLine2\":\"Unit 424\",\"city\":\"Westmont\",\"state\":\"Illinois\",\"country\":\"United States\",\"postalCode\":\"60559\"}")
  echo "$CREATED" | json "j.message"

  ORG_ID=$(echo "$CREATED" | json "j.data && j.data.organizationId")
  if [ -z "$ORG_ID" ]; then
    echo "Could not create an organization: $CREATED" >&2
    exit 1
  fi
  echo "organizationId: $ORG_ID"

  step "11. get organization  ->  GET $BASE_URL/organizations/$ORG_ID"
  curl -sS "$BASE_URL/organizations/$ORG_ID" -H "Authorization: Bearer $ACCESS_TOKEN" | json "j.data && j.data.organizationName"

  # PUT is a full replace: every field the body leaves out is set to NULL.
  # That is why the whole form is resent here and only contactPerson differs.
  step "12. update organization  ->  PUT $BASE_URL/organizations/$ORG_ID"
  curl -sS -X PUT "$BASE_URL/organizations/$ORG_ID" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"organizationName\":\"$ORG_NAME\",\"website\":\"https://rstartec.com/\",\"organizationType\":\"Information Technology\",\"contactPerson\":\"Shakun A.\",\"contactNumber\":\"9999299385\",\"contactEmail\":\"shakun.arora@rstartec.com\",\"addressLine1\":\"770 Pasquinelli Drive\",\"addressLine2\":\"Unit 424\",\"city\":\"Westmont\",\"state\":\"Illinois\",\"country\":\"United States\",\"postalCode\":\"60559\"}" \
    | json "j.data && j.data.contactPerson"

  step "13. create location  ->  POST $BASE_URL/organizations/$ORG_ID/locations"
  LOCATION=$(curl -sS -X POST "$BASE_URL/organizations/$ORG_ID/locations" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"locationName":"India","locationCode":"IN","email":"india.office@rstartec.com","addressLine1":"CM2/1801 Plot No. GH-01/A","addressLine2":"Sector-74","city":"Noida","state":"Uttar Pradesh","country":"INDIA","timeZone":"Asia/Kolkata","description":"Delivery centre"}')
  echo "$LOCATION" | json "j.message"

  LOCATION_ID=$(echo "$LOCATION" | json "j.data && j.data.locationId")
  if [ -z "$LOCATION_ID" ]; then
    echo "Could not create a location: $LOCATION" >&2
    exit 1
  fi
  echo "locationId: $LOCATION_ID"

  step "14. duplicate location name  ->  POST (expected to fail)"
  curl -sS -X POST "$BASE_URL/organizations/$ORG_ID/locations" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"locationName":"India"}' \
    | json "j.statusCode + ' ' + j.message"

  step "15. list locations  ->  GET $BASE_URL/organizations/$ORG_ID/locations"
  # associatedUsers is the grid's "Associated users" column: live employees
  # whose WorkLocationId is this location.
  curl -sS "$BASE_URL/organizations/$ORG_ID/locations" -H "Authorization: Bearer $ACCESS_TOKEN" \
    | json "j.data && j.data.map(l => l.locationName + ' (' + l.associatedUsers + ' users)').join(', ')"

  step "16. update location  ->  PUT $BASE_URL/organizations/$ORG_ID/locations/$LOCATION_ID"
  curl -sS -X PUT "$BASE_URL/organizations/$ORG_ID/locations/$LOCATION_ID" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"locationName":"India (Noida)","locationCode":"IN","city":"Noida","state":"Uttar Pradesh","country":"INDIA","timeZone":"Asia/Kolkata"}' \
    | json "j.data && j.data.locationName"

  # Soft delete. Answers 409 while any employee is still assigned to it.
  step "17. delete location  ->  DELETE $BASE_URL/organizations/$ORG_ID/locations/$LOCATION_ID"
  curl -sS -X DELETE "$BASE_URL/organizations/$ORG_ID/locations/$LOCATION_ID" \
    -H "Authorization: Bearer $ACCESS_TOKEN" | json "j.statusCode + ' ' + j.message"

  printf '\033[33mOrganization %s ("%s") stays behind - there is no delete endpoint for one.\033[0m\n' "$ORG_ID" "$ORG_NAME"
else
  step "10-17. organization create / update / locations  ->  skipped"
  echo "Set ORG_DEMO=1 to exercise them. It leaves one organization row behind."
fi

# --- forgot password -------------------------------------------------------
# Opt-in: this writes a new password hash, so it stays off unless an employee
# is named explicitly.
if [ -n "$FORGOT_EMAIL" ] && [ -n "$FORGOT_DOB" ]; then
  step "18. forgot-password  ->  POST $BASE_URL/auth/forgot-password"
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

  step "19. reset-password  ->  POST $BASE_URL/auth/reset-password"
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
  step "18-19. forgot-password / reset-password  ->  skipped"
  echo "Set FORGOT_EMAIL and FORGOT_DOB to exercise the reset flow."
fi

# --- employees -------------------------------------------------------------
# Needs employees.create / view / update / deactivate / delete. Like the
# organisation section, a 403 here is a real answer - it means this login is
# not an HR admin - so it is reported and the run continues.
#
# Set EMP_DEMO=1 to run it: it creates a real employee, exits them and deletes
# them again. Everything it makes, it removes.

step "20. employees  ->  GET $BASE_URL/employees?pageSize=5"
EMPLOYEES=$(curl -sS "$BASE_URL/employees?pageSize=5" -H "Authorization: Bearer $ACCESS_TOKEN")
echo "$EMPLOYEES" | json "j.message"
EMP_TOTAL=$(echo "$EMPLOYEES" | json "j.meta && j.meta.total")
if [ -n "$EMP_TOTAL" ]; then
  echo "total employees visible to this login: $EMP_TOTAL"
else
  echo "$EMPLOYEES" | json "j.details && j.details.requiredAccess && 'missing right: ' + j.details.requiredAccess.module + ':' + j.details.requiredAccess.action"
fi

if [ -n "$EMP_DEMO" ]; then
  EMP_STAMP=$(date +%s)
  EMP_CODE="FLOW$EMP_STAMP"

  step "21. create employee  ->  POST $BASE_URL/employees"
  CREATED_EMP=$(curl -sS -X POST "$BASE_URL/employees" \
    -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"employeeCode\":\"$EMP_CODE\",\"firstName\":\"Flow\",\"lastName\":\"Probe\",
         \"workEmail\":\"flow.$EMP_STAMP@rstartec.com\",\"employmentType\":\"Permanent\",
         \"dateOfJoining\":\"2024-04-01\",\"designation\":\"Engineer\",\"workFromOffice\":true}")
  echo "$CREATED_EMP" | json "j.message"

  EMP_ID=$(echo "$CREATED_EMP" | json "j.data && j.data.employeeDetailId")
  if [ -z "$EMP_ID" ]; then
    echo "Could not create an employee: $CREATED_EMP" >&2
  else
    echo "employeeDetailId: $EMP_ID  (serial $(echo "$CREATED_EMP" | json "j.data.employeeSerialNo"))"

    step "22. get employee  ->  GET $BASE_URL/employees/$EMP_ID"
    curl -sS "$BASE_URL/employees/$EMP_ID" -H "Authorization: Bearer $ACCESS_TOKEN" \
      | json "j.data && (j.data.firstName + ' ' + j.data.lastName)"

    step "23. update employee  ->  PUT $BASE_URL/employees/$EMP_ID"
    curl -sS -X PUT "$BASE_URL/employees/$EMP_ID" \
      -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
      -d "{\"employeeCode\":\"$EMP_CODE\",\"firstName\":\"Flow\",\"lastName\":\"Probe-Renamed\",
           \"workEmail\":\"flow.$EMP_STAMP@rstartec.com\",\"employmentType\":\"Permanent\",
           \"dateOfJoining\":\"2024-04-01\",\"designation\":\"Senior Engineer\"}" \
      | json "j.data && j.data.designation"

    # The whole point of a separate endpoint: an exit without a date and a
    # status is refused, rather than saved with IsActive = 0 and no story.
    step "24. deactivate with no exit details  ->  PATCH (expected 400)"
    curl -sS -X PATCH "$BASE_URL/employees/$EMP_ID/deactivate" \
      -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' -d '{}' \
      | json "j.details && Object.keys(j.details).join(' and ') + ' are required'"

    step "25. deactivate employee  ->  PATCH $BASE_URL/employees/$EMP_ID/deactivate"
    curl -sS -X PATCH "$BASE_URL/employees/$EMP_ID/deactivate" \
      -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
      -d '{"dateOfLeaving":"2026-03-31","employmentStatus":"Resigned"}' \
      | json "j.data && ('isActive=' + j.data.isActive + ' status=' + j.data.employmentStatus)"

    step "26. delete employee  ->  DELETE $BASE_URL/employees/$EMP_ID"
    curl -sS -X DELETE "$BASE_URL/employees/$EMP_ID" -H "Authorization: Bearer $ACCESS_TOKEN" \
      | json "j.message"
  fi
else
  step "21-26. employee create / update / deactivate / delete  ->  skipped"
  echo "Set EMP_DEMO=1 to exercise them. They create a real employee and remove it again."
fi

# --- logout ----------------------------------------------------------------
# Last, because it ends the session every step above was using.
#
# The two checks after it are the point of the endpoint. A logout that only
# deleted the client's copy of the token would still pass step 27 and fail
# both of these: the access token would keep opening guarded routes until it
# expired, and the refresh token would keep minting replacements for days.

step "27. logout  ->  POST $BASE_URL/auth/logout"
curl -sS -X POST "$BASE_URL/auth/logout" -H "Authorization: Bearer $ACCESS_TOKEN" | json "j.message"

step "28. access token after logout  ->  GET $BASE_URL/auth/me  (expect 401)"
ME_AFTER=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/auth/me" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
if [ "$ME_AFTER" = "401" ]; then
  printf '\033[32mHTTP %s - access token rejected, as it should be.\033[0m\n' "$ME_AFTER"
else
  printf '\033[31mHTTP %s - the access token still works after logout.\033[0m\n' "$ME_AFTER" >&2
  exit 1
fi

step "29. refresh token after logout  ->  POST $BASE_URL/auth/refresh  (expect 401)"
REFRESH_AFTER=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/auth/refresh" \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}")
if [ "$REFRESH_AFTER" = "401" ]; then
  printf '\033[32mHTTP %s - refresh token rejected too. Both halves are dead.\033[0m\n' "$REFRESH_AFTER"
else
  printf '\033[31mHTTP %s - the refresh token survived logout and can mint a new access token.\033[0m\n' "$REFRESH_AFTER" >&2
  exit 1
fi

printf '\n\033[32mFlow complete.\033[0m Step 27 logged the session out, so the token\n'
printf 'it used is dead. Sign in again for ad-hoc calls:\n'
printf "  PASSWORD='...' ./scripts/api-flow.sh\n"
