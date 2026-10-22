#!/bin/bash
# init-tidecloak.sh — Bootstrap TideCloak dev instance for MedPool
#
# Run via: npm run init
#
# What this does:
#   1. Starts TideCloak dev container (tideorg/tidecloak-dev:latest on port 8080)
#   2. Creates the 'medpool' realm and 'medpool-client' from scripts/realm.json.template
#      (including /studies/study-42 group, groups/vuid/tideuserkey mappers, DPoP & E2EE roles)
#   3. Licenses the realm with Tide ORKs (setUpTideRealm) + stamps iga.attestor=tide + enables IGA
#   4. Drains all baseline IGA change requests (ADOPT_ROLE, ADOPT_PROTOCOL_MAPPER, ADOPT_CLIENT, etc.)
#   5. Creates the MedPool admin, 3 Ethics Board admins, Researcher, and Patient accounts
#   6. Signs IdP & client settings against the VVK, exports data/tidecloak.json, and seals the
#      RelationshipAttestation:1 policy for /studies/study-42
#   7. Generates the admin Tide account-linking invite URL

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$PROJECT_DIR/package.json" ] && command -v jq &>/dev/null; then
  _PKG_NAME=$(jq -r '.name // empty' "$PROJECT_DIR/package.json" | sed 's|^@[^/]*/||' | tr -cs 'a-zA-Z0-9-' '-' | tr '[:upper:]' '[:lower:]' | sed 's/^-//;s/-$//')
fi
_APP_NAME="${_PKG_NAME:-medpool}"

TIDECLOAK_URL="${TIDECLOAK_URL:-http://localhost:8080}"
REALM_NAME="${REALM_NAME:-$_APP_NAME}"
CLIENT_NAME="${CLIENT_NAME:-${_APP_NAME}-client}"
CLIENT_APP_URL="${CLIENT_APP_URL:-http://localhost:3000}"
ADAPTER_OUTPUT="${ADAPTER_OUTPUT:-$PROJECT_DIR/data/tidecloak.json}"
TIDECLOAK_IMAGE="${TIDECLOAK_IMAGE:-tideorg/tidecloak-dev:latest}"

# Load .env if present (gitignored).
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # Strip CR if .env was edited on Windows
  eval "$(tr -d '\r' < "$PROJECT_DIR/.env" | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$')"
  set +a
fi

KC_BOOTSTRAP_ADMIN_USERNAME="${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}"

if [ -z "${KC_BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  cat >&2 <<'MSG'
ERROR: KC_BOOTSTRAP_ADMIN_PASSWORD is not set.

  This is the TideCloak master-admin password. It must come from the environment,
  not from this script:

    cp .env.example .env
    $EDITOR .env            # set KC_BOOTSTRAP_ADMIN_PASSWORD
    npm run init

  .env is gitignored.
MSG
  exit 1
fi

# --- Licence email + Terms & Conditions (AP-90) ---
TIDE_TERMS_URL="https://tide.org/legal"
LICENSE_EMAIL="${TIDE_LICENSE_EMAIL:-${ADMIN_EMAIL:-}}"

valid_license_email() {
  [[ "${1:-}" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || return 1
  case "${1##*@}" in
    example.com|example.org|example.net|yourorg.com|yourdomain.com|yourcompany.com|company.com|\
    domain.com|test.com|placeholder.com|email.com|*.example|*.test|*.invalid|*.local|localhost)
      return 1 ;;
  esac
  return 0
}

if [ -t 0 ] && [ -t 1 ]; then
  while ! valid_license_email "$LICENSE_EMAIL"; do
    [ -z "$LICENSE_EMAIL" ] || echo "'$LICENSE_EMAIL' is not a usable address (placeholders are rejected)."
    read -r -p "Enter an email to manage your Tide licence: " LICENSE_EMAIL
  done
  if [ "${TIDE_TERMS_ACCEPTED:-}" != "yes" ]; then
    echo ""
    echo "Please review the Tide Terms & Conditions: $TIDE_TERMS_URL"
    read -r -p "Do you agree to the Terms & Conditions? (yes/no): " _TERMS_ANSWER
    case "$_TERMS_ANSWER" in
      y|Y|yes|Yes|YES) TIDE_TERMS_ACCEPTED=yes ;;
      *) echo "Terms & Conditions not accepted. Nothing was created." >&2; exit 1 ;;
    esac
  fi
fi

if ! valid_license_email "$LICENSE_EMAIL" || [ "${TIDE_TERMS_ACCEPTED:-}" != "yes" ]; then
  cat >&2 <<MSG

STOP: the Tide realm was NOT set up. Nothing was created.

  Ask the deployment owner:
    1. "Which email address should manage your Tide licence?"
    2. "Tide's Terms & Conditions are at $TIDE_TERMS_URL — do you agree to them? (yes/no)"

  Then re-run with:
    TIDE_LICENSE_EMAIL=<their email> TIDE_TERMS_ACCEPTED=yes npm run init
MSG
  exit 2
fi

ADMIN_EMAIL="$LICENSE_EMAIL"
echo "==> Licence email: $LICENSE_EMAIL"
echo "==> Terms & Conditions ($TIDE_TERMS_URL): accepted by the operator"

get_token() {
  curl -s -X POST "$TIDECLOAK_URL/realms/master/protocol/openid-connect/token" \
    -d "client_id=admin-cli" -d "grant_type=password" \
    --data-urlencode "username=$KC_BOOTSTRAP_ADMIN_USERNAME" \
    --data-urlencode "password=$KC_BOOTSTRAP_ADMIN_PASSWORD" \
    | jq -r '.access_token'
}

approve_all_pending() {
  local TOKEN ids id ready pass round
  for round in 1 2 3 4 5 6; do
    TOKEN="$(get_token)"
    ids=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/iga/change-requests?status=PENDING" \
      -H "Authorization: Bearer $TOKEN" 2>/dev/null \
      | jq -r 'if type=="array" then (.[] | select(.actionType | IN("DISABLE_IGA","DELETE_REALM","OFFBOARD_REALM") | not) | .id) else empty end' 2>/dev/null || true)
    [ -z "$ids" ] && break

    for id in $ids; do
      TOKEN="$(get_token)"
      curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/iga/change-requests/$id/authorize" \
        -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' > /dev/null 2>&1 || true
    done

    for pass in 1 2 3 4; do
      TOKEN="$(get_token)"
      ready=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/iga/change-requests?status=PENDING" \
        -H "Authorization: Bearer $TOKEN" 2>/dev/null \
        | jq -r 'if type=="array" then (.[] | select(.actionType | IN("DISABLE_IGA","DELETE_REALM","OFFBOARD_REALM") | not) | select(.readyToCommit==true) | .id) else empty end' 2>/dev/null || true)
      [ -z "$ready" ] && break
      for id in $ready; do
        TOKEN="$(get_token)"
        curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/iga/change-requests/$id/commit" \
          -H "Authorization: Bearer $TOKEN" > /dev/null 2>&1 || true
      done
    done
  done
}

approve_and_commit() { approve_all_pending; }

# --- Step 0: Check prerequisites ---
for cmd in docker curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is required but not found."
    exit 1
  fi
done

# --- Step 1: Clean previous state ---
echo "==> Cleaning previous state..."
docker stop tidecloak 2>/dev/null || true
docker rm tidecloak 2>/dev/null || true
docker volume rm medpool-tidecloak-h2 2>/dev/null || true
mkdir -p "$PROJECT_DIR/data"
rm -f "$PROJECT_DIR/data/keycloakdb"* 2>/dev/null || true

# --- Step 2: Start container ---
echo "==> Starting TideCloak ($TIDECLOAK_IMAGE)..."
case "$TIDECLOAK_IMAGE" in
  *stg*) echo "ERROR: $TIDECLOAK_IMAGE is a staging image and is not supported."
         echo "       Use tideorg/tidecloak-dev:latest."
         exit 1 ;;
esac

MSYS_NO_PATHCONV=1 docker run --rm -u 0 \
  -v medpool-tidecloak-h2:/opt/keycloak/data/h2 \
  --entrypoint sh "$TIDECLOAK_IMAGE" -c "chown -R 1000:0 /opt/keycloak/data/h2 && chmod -R 775 /opt/keycloak/data/h2"

MSYS_NO_PATHCONV=1 docker run -d --name tidecloak \
  -v medpool-tidecloak-h2:/opt/keycloak/data/h2 \
  -p 8080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME="$KC_BOOTSTRAP_ADMIN_USERNAME" \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD="$KC_BOOTSTRAP_ADMIN_PASSWORD" \
  "$TIDECLOAK_IMAGE"

# --- Step 3: Wait for readiness ---
echo "==> Waiting for TideCloak to start on $TIDECLOAK_URL..."
for i in {1..36}; do
  curl -sf "$TIDECLOAK_URL" > /dev/null 2>&1 && break
  echo "  Attempt $i/36..."
  sleep 5
done

if ! curl -sf "$TIDECLOAK_URL" > /dev/null 2>&1; then
  echo "ERROR: TideCloak did not start within 180 seconds. Run: docker logs tidecloak"
  exit 1
fi
echo "  TideCloak is ready."

# --- Step 4: Create realm from template ---
echo "==> Creating realm '$REALM_NAME' from scripts/realm.json.template..."
REALM_TEMPLATE="$SCRIPT_DIR/realm.json.template"
if [ ! -f "$REALM_TEMPLATE" ]; then
  echo "ERROR: realm.json.template not found."
  exit 1
fi

TMP_REALM="$(mktemp)"
cp "$REALM_TEMPLATE" "$TMP_REALM"
sed -i "s|REALM_NAME|$REALM_NAME|g" "$TMP_REALM"
sed -i "s|CLIENT_NAME|$CLIENT_NAME|g" "$TMP_REALM"
sed -i "s|CLIENT_APP_URL|$CLIENT_APP_URL|g" "$TMP_REALM"

TOKEN="$(get_token)"
IMPORT_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$TIDECLOAK_URL/admin/realms" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @"$TMP_REALM")
rm -f "$TMP_REALM"

case "$IMPORT_CODE" in
  2??) echo "    Realm '$REALM_NAME' created (HTTP $IMPORT_CODE)." ;;
  *)   echo "ERROR: Realm import failed with HTTP $IMPORT_CODE" >&2; exit 1 ;;
esac

# Ensure /studies and /studies/study-42 groups exist on the realm
TOKEN="$(get_token)"
GROUPS_JSON=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/groups" -H "Authorization: Bearer $TOKEN")
if ! echo "$GROUPS_JSON" | jq -e '.[]? | select(.name=="studies")' >/dev/null 2>&1; then
  echo "==> Creating /studies/study-42 group hierarchy..."
  curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/groups" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"studies"}' > /dev/null
  PARENT_ID=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/groups" -H "Authorization: Bearer $TOKEN" | jq -r '.[] | select(.name=="studies") | .id')
  if [ -n "$PARENT_ID" ] && [ "$PARENT_ID" != "null" ]; then
    curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/groups/$PARENT_ID/children" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d '{"name":"study-42"}' > /dev/null
  fi
fi

# --- Step 4b: Disable first-broker-login review profile page ---
echo "==> Disabling the first-broker-login profile page..."
TOKEN="$(get_token)"
RP_EXEC="$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/authentication/flows/first%20broker%20login/executions" \
  -H "Authorization: Bearer $TOKEN")"
RP_CFG="$(printf '%s' "$RP_EXEC" | jq -r '.[]? | select(.providerId=="idp-review-profile") | .authenticationConfig // empty' | head -1)"
RP_ID="$(printf '%s' "$RP_EXEC" | jq -r '.[]? | select(.providerId=="idp-review-profile") | .id' | head -1)"
RP_BODY='{"alias":"review profile config","config":{"update.profile.on.first.login":"off"}}'
if [ -n "$RP_CFG" ]; then
  curl -s -o /dev/null -X PUT "$TIDECLOAK_URL/admin/realms/$REALM_NAME/authentication/config/$RP_CFG" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$RP_BODY"
elif [ -n "$RP_ID" ]; then
  curl -s -o /dev/null -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/authentication/executions/$RP_ID/config" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$RP_BODY"
fi
echo "    New users go straight into the app."

# --- Step 5: Initialize Tide + enable IGA ---
echo "==> Initializing Tide realm (license + VVK via ORK network)..."
TOKEN="$(get_token)"
SETUP_BODY="$(mktemp)"
SETUP_CODE="$(curl -s -o "$SETUP_BODY" -w '%{http_code}' -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/vendorResources/setUpTideRealm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "email=$ADMIN_EMAIL" \
  --data-urlencode "isRagnarokEnabled=false")" || SETUP_CODE="000"
SETUP_OUT="$(head -c 600 "$SETUP_BODY" 2>/dev/null || true)"
rm -f "$SETUP_BODY"
case "$SETUP_CODE" in
  2??) echo "    Tide realm licensed & VVK provisioned (HTTP $SETUP_CODE: $SETUP_OUT)." ;;
  303) echo "ERROR: setUpTideRealm answered 303 (paid checkout). Response: $SETUP_OUT" >&2; exit 1 ;;
  *)   echo "ERROR: setUpTideRealm failed (HTTP $SETUP_CODE). Response: $SETUP_OUT" >&2; exit 1 ;;
esac
case "$SETUP_OUT" in
  *NEED_PAYMENT*) echo "ERROR: setUpTideRealm answered NEED_PAYMENT. Check licence email ($ADMIN_EMAIL)." >&2; exit 1 ;;
esac

echo "==> Stamping iga.attestor=tide..."
TOKEN="$(get_token)"
REALM_REP=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME" -H "Authorization: Bearer $TOKEN")
UPDATED_REALM=$(echo "$REALM_REP" | jq '.attributes = ((.attributes // {}) + {"iga.attestor":"tide"})')
curl -s -X PUT "$TIDECLOAK_URL/admin/realms/$REALM_NAME" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "$UPDATED_REALM" > /dev/null

echo "==> Enabling Cryptographic IGA..."
TOKEN="$(get_token)"
IGA_NOW="$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.attributes.isIGAEnabled // "false"' 2>/dev/null | tr '[:upper:]' '[:lower:]')"
if [ "$IGA_NOW" = "true" ]; then
  echo "    IGA is already enabled on this realm."
else
  IGA_OUT="$(curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/tide-admin/toggle-iga" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "isIGAEnabled=true")"
  case "$IGA_OUT" in
    *'"enabled":true'*) echo "    IGA enabled (iga.attestor=tide)." ;;
    *) echo "ERROR: toggle-iga did not report enabled=true. Response: $IGA_OUT" >&2; exit 1 ;;
  esac
fi

# --- Step 6: Approve baseline client & role change requests ---
echo "==> Approving and committing baseline IGA change requests..."
sleep 2
approve_all_pending

# --- Step 7: Create admin + MedPool actors (3 Ethics Board Admins, Researcher, Patient) ---
echo "==> Creating admin and MedPool actor accounts..."
TOKEN="$(get_token)"
curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"email\":\"$ADMIN_EMAIL\",\"firstName\":\"Admin\",\"lastName\":\"Operator\",\"enabled\":true,\"emailVerified\":false,\"attributes\":{\"tideInvitable\":[\"true\"]}}" > /dev/null

for actor in \
  "dr.vance|dr.vance@stjude.medpool.org|Hannah|Vance" \
  "prof.weber|prof.weber@charite.medpool.org|Lukas|Weber" \
  "dr.takahashi|dr.takahashi@tokyo.medpool.org|Kenji|Takahashi" \
  "dr.chen|dr.chen@medpool.org|Marcus|Chen" \
  "patient.alex|patient.alex@medpool.org|Alex|Rivera"; do
  IFS='|' read -r uname uemail ufirst ulast <<< "$actor"
  TOKEN="$(get_token)"
  curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$uname\",\"email\":\"$uemail\",\"firstName\":\"$ufirst\",\"lastName\":\"$ulast\",\"enabled\":true,\"emailVerified\":false,\"attributes\":{\"tideInvitable\":[\"true\"]}}" > /dev/null || true
done

echo "==> Approving and committing user creation change requests..."
sleep 2
approve_all_pending

TOKEN="$(get_token)"
USER_ID=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users?username=admin" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

if [ -z "$USER_ID" ] || [ "$USER_ID" = "null" ]; then
  echo "ERROR: Could not find admin user after creation."
  exit 1
fi

# Ensure tideInvitable attribute is committed on admin
TOKEN="$(get_token)"
curl -s -X PUT "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users/$USER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"email\":\"$ADMIN_EMAIL\",\"firstName\":\"Admin\",\"lastName\":\"Operator\",\"enabled\":true,\"attributes\":{\"tideInvitable\":[\"true\"]}}" > /dev/null || true
approve_all_pending

# --- Step 8: Configure CustomAdminUIDomain + sign IdP & Client settings ---
echo "==> Configuring CustomAdminUIDomain and signing IdP settings with VVK..."
TIDE_CONSOLE_ORIGIN="$TIDECLOAK_URL/realms/$REALM_NAME/tide-console/"
TOKEN="$(get_token)"
INST=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/identity-provider/instances/tide" \
  -H "Authorization: Bearer $TOKEN")
UPDATED=$(echo "$INST" | jq --arg d "$TIDE_CONSOLE_ORIGIN" '.config.CustomAdminUIDomain=$d')
curl -s -X PUT "$TIDECLOAK_URL/admin/realms/$REALM_NAME/identity-provider/instances/tide" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d "$UPDATED" > /dev/null
approve_all_pending

TOKEN="$(get_token)"
curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/vendorResources/sign-idp-settings" \
  -H "Authorization: Bearer $TOKEN" > /dev/null
approve_all_pending

# --- Step 9: Export live adapter JSON (data/tidecloak.json) ---
echo "==> Exporting live adapter config to $ADAPTER_OUTPUT..."
TOKEN="$(get_token)"
CLIENT_UUID=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=$CLIENT_NAME" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

mkdir -p "$(dirname "$ADAPTER_OUTPUT")"
curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/vendorResources/get-installations-provider?clientId=$CLIENT_UUID&providerId=keycloak-oidc-keycloak-json" \
  -H "Authorization: Bearer $TOKEN" > "$ADAPTER_OUTPUT"

# Ensure useDPoP is enabled in the exported adapter JSON for @tidecloak/nextjs + tide-doctor.sh
if jq -e 'has("jwk")' "$ADAPTER_OUTPUT" > /dev/null 2>&1; then
  TMP_ADAPTER="$(mktemp)"
  jq '. + {"useDPoP": true}' "$ADAPTER_OUTPUT" > "$TMP_ADAPTER" && mv "$TMP_ADAPTER" "$ADAPTER_OUTPUT"
fi

# Sync live vendorId and VVK public key into data/medpool-db.json so RelationshipAttestation:1 policy matches live realm
if command -v node &>/dev/null && [ -f "$ADAPTER_OUTPUT" ]; then
  echo "==> Sealing RelationshipAttestation:1 policy for /studies/study-42 with live realm VVK..."
  node -e '
    const fs = require("fs");
    const path = require("path");
    const adapterPath = process.argv[1];
    const dbPath = path.join(path.dirname(adapterPath), "medpool-db.json");
    const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf8"));
    if (fs.existsSync(dbPath) && adapter.jwk && adapter.jwk.keys && adapter.jwk.keys[0]) {
      const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
      const vvk = adapter.jwk.keys[0];
      if (Array.isArray(db.relationshipPolicies) && db.relationshipPolicies[0]) {
        db.relationshipPolicies[0].keyId = vvk.kid || adapter.vendorId || db.relationshipPolicies[0].keyId;
      }
      fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf8");
      console.log("    Sealed RelationshipAttestation:1 with VVK kid=" + (vvk.kid || adapter.vendorId));
    }
  ' "$ADAPTER_OUTPUT"
fi

# --- Step 10: Generate invite link for admin Tide account linking ---
echo "==> Generating admin Tide account invite link..."
TOKEN="$(get_token)"
INVITE_LINK=$(curl -s -X POST \
  "$TIDECLOAK_URL/admin/realms/$REALM_NAME/tideAdminResources/get-required-action-link?userId=$USER_ID&lifespan=43200" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '["link-tide-account-action"]')

# Final sweep of any pending change requests
approve_all_pending

echo ""
echo "============================================"
echo "Open this link in your browser to link your admin Tide account:"
echo "$INVITE_LINK"
echo "============================================"
echo ""

cat <<'BANNER'

--------------------------------------------
WHILE YOU ARE HERE — two things your users will see. Both are your call.

1) BRANDING. Right now they see TIDE's logo at sign-in, not yours.
     - generate one from the app's type   (vault identity notes chat data finance health media commerce)
     - you supply artwork                 (drop logo.png + background.jpg in ./branding/)
     - write me a prompt for an image AI  (tailored to this app)
     - leave it as Tide's

2) NEW-USER DETAILS. Tide gives each new user an account with NO name or email, and the Keycloak
   signup form is turned OFF for this realm. What should the in-app form collect?
     - a display name        - first/last name        - email (Tide does NOT need it for recovery)
     - nothing; the vuid is enough

   AGENT: ask these as QUESTIONS and WAIT for the answer. Do not pick for the user and report it
   afterwards — that is the one failure this placement exists to prevent (AP-87).
--------------------------------------------

BANNER

if [ "${WAIT_FOR_LINK:-0}" = "1" ]; then
  echo "Waiting for admin to link Tide account (polling every 5s)..."
  while true; do
    TOKEN="$(get_token)"
    KEY=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users?username=admin" \
      -H "Authorization: Bearer $TOKEN" | jq -r '.[0].attributes.tideUserKey[0] // empty')
    [ -n "$KEY" ] && echo "  Account linked." && break
    sleep 5
  done
fi

# --- Verify exported adapter ---
if jq -e 'has("jwk") and has("vendorId") and has("homeOrkUrl")' "$ADAPTER_OUTPUT" > /dev/null 2>&1; then
  echo ""
  echo "============================================"
  echo "MedPool TideCloak Init Complete!"
  echo ""
  echo "  Adapter config: $ADAPTER_OUTPUT"
  echo "  TideCloak URL:  $TIDECLOAK_URL"
  echo "  Realm:          $REALM_NAME"
  echo "  Client:         $CLIENT_NAME"
  echo "  Home ORK:       $(jq -r '.homeOrkUrl' "$ADAPTER_OUTPUT")"
  echo "  Vendor ID:      $(jq -r '.vendorId' "$ADAPTER_OUTPUT")"
  echo "  VVK Key ID:     $(jq -r '.jwk.keys[0].kid' "$ADAPTER_OUTPUT")"
  echo "============================================"
else
  echo "WARNING: Adapter config exported but may be missing Tide extensions."
  exit 1
fi
