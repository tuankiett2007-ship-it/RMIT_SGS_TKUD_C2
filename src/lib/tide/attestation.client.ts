/**
 * BROWSER entry point for Tide attestations.
 *
 * Re-exports only what a client component legitimately needs from the Tide-provided
 * `./attestation.ts` (left unedited):
 *   - byte codecs (`container`, `values`, `toBase64`, `fromBase64`) used to handle TideMemory
 *     envelopes and the statement bytes the SERVER prepared, and
 *   - `signAttestation()`, which must run in the signer's browser (the enclave holds the credential).
 *
 * It deliberately does NOT re-export `buildAttestation`, `verifyAttestation`, `readSigningRule` or
 * `buildSigningRule`: statements are built and verified on the server only (AP-AT01 / AP-AT04).
 * Server code imports those from `./attestation.server` (guarded by `server-only`). Because every
 * export of `./attestation.ts` is a side-effect-free function, webpack drops the unused server half
 * from the client bundle.
 */
export {
  container,
  values,
  toBase64,
  fromBase64,
  signAttestation,
} from "./attestation";

