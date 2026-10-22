import { webcrypto } from "crypto";

const subtle = webcrypto.subtle;
const BASE_URL = "http://localhost:3000";

function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(str) {
  return new Uint8Array(Buffer.from(str, "base64"));
}

async function runDemoFlow() {
  console.log("=== STARTING FULL DEMO FLOW VERIFICATION ===");

  // 1. Reset demo state
  console.log("\n[Step 1] Reset demo state...");
  const resetRes = await fetch(`${BASE_URL}/api/medpool/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "RESET_DEMO" }),
  });
  if (!resetRes.ok) throw new Error(`Reset failed: ${resetRes.status}`);
  console.log("✓ Demo database reset to default state.");

  // Check state
  const stateRes = await fetch(`${BASE_URL}/api/medpool/state`);
  const state = await stateRes.json();
  console.log(`✓ Total records: ${state.records.length}, Active share grants: ${state.shareGrants.length}`);
  if (state.records.length !== 3 || state.shareGrants.length !== 0) {
    throw new Error("Unexpected initial state");
  }

  // Helper to grant share
  async function grantShare(recordId, clinicianAccountId) {
    // A. Prepare share
    const prepRes = await fetch(`${BASE_URL}/api/medpool/state`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-medpool-account-id": "acct-patient-1",
      },
      body: JSON.stringify({
        action: "PREPARE_SHARE_GRANT",
        recordId,
        clinicianAccountId,
        callerRole: "patient",
      }),
    });
    if (!prepRes.ok) throw new Error(`Prepare share failed: ${prepRes.status}`);
    const prep = await prepRes.json();

    // B. Generate Ed25519 keypair and sign bytes
    const keyPair = await subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const bytesToSign = fromBase64(prep.bytesToSignB64);
    const sigBuffer = await subtle.sign("Ed25519", keyPair.privateKey, bytesToSign);
    const signatureB64 = toBase64(new Uint8Array(sigBuffer));
    const signerPublicJwk = await subtle.exportKey("jwk", keyPair.publicKey);

    // C. Grant share
    const grantRes = await fetch(`${BASE_URL}/api/medpool/state`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-medpool-account-id": "acct-patient-1",
      },
      body: JSON.stringify({
        action: "GRANT_RECORD_SHARE",
        recordId,
        clinicianAccountId,
        expiry: prep.statement.expiry,
        signatureB64,
        signerPublicJwk,
        callerRole: "patient",
      }),
    });
    const grantData = await grantRes.json();
    if (!grantRes.ok) throw new Error(`Grant share failed: ${grantRes.status} ${JSON.stringify(grantData)}`);
    return grantData;
  }

  // 2. Patient grants: CP-REC-001 -> GP (acct-gp-1), CP-REC-002 -> Physio (acct-physio-1)
  console.log("\n[Step 2] Patient grants CP-REC-001 to GP and CP-REC-002 to Physio...");
  await grantShare("CP-REC-001", "acct-gp-1");
  console.log("✓ Granted CP-REC-001 to GP (acct-gp-1) via WebCrypto Ed25519");
  await grantShare("CP-REC-002", "acct-physio-1");
  console.log("✓ Granted CP-REC-002 to Physio (acct-physio-1) via WebCrypto Ed25519");

  // Helper to attempt decryption
  async function attemptDecrypt(recordId, clinicianAccountId) {
    const res = await fetch(`${BASE_URL}/api/medpool/state`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-medpool-account-id": clinicianAccountId,
      },
      body: JSON.stringify({
        action: "DECRYPT_SHARED_RECORD",
        recordId,
        clinicianAccountId,
      }),
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  // 3. Verify Clinician Decryption Matrix
  console.log("\n[Step 3] Verifying Clinician Decryption Matrix...");

  // GP accessing CP-REC-001 -> Should SUCCEED (200)
  const gpRec1 = await attemptDecrypt("CP-REC-001", "acct-gp-1");
  console.log(`GP on CP-REC-001: HTTP ${gpRec1.status} (expected 200, ok=${gpRec1.data.ok}) [Decrypted in RAM]`);
  if (gpRec1.status !== 200 || !gpRec1.data.ok) throw new Error("GP could not decrypt shared record CP-REC-001");

  // GP accessing CP-REC-002 -> Should be REFUSED (403)
  const gpRec2 = await attemptDecrypt("CP-REC-002", "acct-gp-1");
  console.log(`GP on CP-REC-002: HTTP ${gpRec2.status} (expected 403, code=${gpRec2.data.code}) [Passed]`);
  if (gpRec2.status !== 403) throw new Error("GP was not refused on unshared record CP-REC-002");

  // GP accessing CP-REC-003 -> Should be REFUSED (403)
  const gpRec3 = await attemptDecrypt("CP-REC-003", "acct-gp-1");
  console.log(`GP on CP-REC-003: HTTP ${gpRec3.status} (expected 403, code=${gpRec3.data.code}) [Passed]`);
  if (gpRec3.status !== 403) throw new Error("GP was not refused on unshared record CP-REC-003");

  // Physio accessing CP-REC-002 -> Should SUCCEED (200)
  const physioRec2 = await attemptDecrypt("CP-REC-002", "acct-physio-1");
  console.log(`Physio on CP-REC-002: HTTP ${physioRec2.status} (expected 200, ok=${physioRec2.data.ok}) [Decrypted in RAM]`);
  if (physioRec2.status !== 200 || !physioRec2.data.ok) throw new Error("Physio could not decrypt shared record CP-REC-002");

  // Physio accessing CP-REC-001 -> Should be REFUSED (403)
  const physioRec1 = await attemptDecrypt("CP-REC-001", "acct-physio-1");
  console.log(`Physio on CP-REC-001: HTTP ${physioRec1.status} (expected 403, code=${physioRec1.data.code}) [Passed]`);
  if (physioRec1.status !== 403) throw new Error("Physio was not refused on unshared record CP-REC-001");

  // 4. Verify Rogue Admin attack blocked
  console.log("\n[Step 4] Verifying Rogue Admin read attempt blocked...");
  const adminRec1 = await attemptDecrypt("CP-REC-001", "acct-rogue-1");
  console.log(`Rogue Admin on CP-REC-001: HTTP ${adminRec1.status} (expected 403, code=${adminRec1.data.code}) [Passed]`);
  if (adminRec1.status !== 403) throw new Error("Rogue admin was not blocked on CP-REC-001");

  // 5. Patient revokes Physio on CP-REC-002 + refreshes access
  console.log("\n[Step 5] Revoking Physio access on CP-REC-002 and refreshing session...");
  const revokeRes = await fetch(`${BASE_URL}/api/medpool/state`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-medpool-account-id": "acct-patient-1",
    },
    body: JSON.stringify({
      action: "REVOKE_RECORD_SHARE",
      recordId: "CP-REC-002",
      clinicianAccountId: "acct-physio-1",
    }),
  });
  if (!revokeRes.ok) throw new Error(`Revocation failed: ${revokeRes.status}`);
  console.log("✓ Patient revoked Physio on CP-REC-002");

  // Physio refreshes session
  const refreshRes = await fetch(`${BASE_URL}/api/medpool/state`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-medpool-account-id": "acct-physio-1",
    },
    body: JSON.stringify({
      action: "REFRESH_CLINICIAN_ACCESS",
      accountId: "acct-physio-1",
    }),
  });
  if (!refreshRes.ok) throw new Error(`Refresh failed: ${refreshRes.status}`);
  console.log("✓ Physio refreshed access token and policy table");

  // Physio tries to decrypt CP-REC-002 again -> Must return 403
  const physioAfterRevoke = await attemptDecrypt("CP-REC-002", "acct-physio-1");
  console.log(`Physio on CP-REC-002 after revoke: HTTP ${physioAfterRevoke.status} (expected 403, code=${physioAfterRevoke.data.code}) [Passed]`);
  if (physioAfterRevoke.status !== 403) throw new Error("Physio could still decrypt after revocation");

  // GP accessing CP-REC-001 -> Must STILL SUCCEED (200)
  const gpStillAllowed = await attemptDecrypt("CP-REC-001", "acct-gp-1");
  console.log(`GP on CP-REC-001 after Physio revoked: HTTP ${gpStillAllowed.status} (expected 200, ok=${gpStillAllowed.data.ok}) [Passed]`);
  if (gpStillAllowed.status !== 200 || !gpStillAllowed.data.ok) throw new Error("GP access was inadvertently disrupted");

  console.log("\n=== ALL DEMO FLOW CHECKS PASSED PERFECTLY! ===");
}

runDemoFlow().catch((err) => {
  console.error("Demo flow verification failed:", err);
  process.exit(1);
});

