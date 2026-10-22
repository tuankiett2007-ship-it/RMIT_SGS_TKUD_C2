/**
 * SERVER entry point for TideCloak token verification and adapter config.
 *
 * `tidecloakConfig.ts` reads `data/tidecloak.json` with Node `fs`, and `tideJWT.ts` / `verifyDpop.ts` /
 * `middleware.ts` come from the Tide template. They are left unedited. Route handlers import them
 * through this facade, whose `server-only` import turns any accidental client import into a clear
 * build error rather than a "Can't resolve 'fs'" failure deep in the import graph.
 */
import "server-only";

export { loadTideConfig } from "./tidecloakConfig";
export type { TidecloakConfig } from "./tidecloakConfig";
export { verifyTideJWT, extractToken, hasRole } from "./tideJWT";
export { verifyDpop } from "./verifyDpop";
export { withAuth, withRole } from "./middleware";

