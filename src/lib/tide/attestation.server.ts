/**
 * SERVER entry point for Tide attestations.
 *
 * `./attestation.ts` is a Tide-provided file and is intentionally NOT edited. It is isomorphic by
 * design (browser `signAttestation()` + server `buildAttestation()` / `verifyAttestation()`), and it
 * has no Node built-ins or secrets in it, so it was never the cause of the `fs` build error.
 *
 * This facade draws the boundary in OUR code instead:
 *   - Server code (route handlers, `store.ts`) imports the decision-making half from here.
 *   - `import "server-only"` makes the build FAIL if a client component ever imports this file,
 *     so the statement-building and verification path cannot drift into the browser bundle by
 *     accident. Client code uses `./attestation.client` instead.
 *
 * The decision "is this attestation valid?" must only ever be made on the server (AP-AT01):
 * a check that runs in the browser can be skipped by whoever controls the browser.
 */
import "server-only";

export {
  ATTESTATION_MODEL,
  buildAttestation,
  buildSigningRule,
  readSigningRule,
  verifyAttestation,
  wrapForEnclave,
  statements,
  container,
  values,
  toBase64,
  fromBase64,
} from "./attestation";

export type { Attestation, SigningRule, IssuerRule } from "./attestation";

