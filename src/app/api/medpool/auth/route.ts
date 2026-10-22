import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { verifyTideCloakToken } from "@tidecloak/nextjs/server";
import { verifyTideJWT, extractToken, hasRole } from "@/lib/auth/tideJWT";
import { verifyDpop } from "@/lib/auth/verifyDpop";
import { loadTideConfig } from "@/lib/auth/tidecloakConfig";
import { readDb, writeDb, type MedPoolRole } from "@/lib/medpool/store";

/**
 * Server-side token & role verification endpoint following Tide MCP `protect-api-nextjs` and `add-rbac-nextjs`.
 * Uses both `verifyTideCloakToken` (`@tidecloak/nextjs/server`) and `verifyTideJWT` + `verifyDpop` (embedded VVK JWKS).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const requiredRole = url.searchParams.get("requiredRole") as MedPoolRole | null;
  const authHeader = req.headers.get("authorization");
  const accountIdHeader =
    req.headers.get("x-medpool-account-id") || url.searchParams.get("accountId");

  // 1. Live TideCloak Token Verification (Primary MCP pattern: verifyTideCloakToken + verifyTideJWT + verifyDpop)
  if (authHeader) {
    try {
      const token = extractToken(authHeader);
      const tcConfig = loadTideConfig();
      const allowedList = requiredRole ? [requiredRole] : [];

      // Verify signature, iss, azp, exp against embedded adapter JWK
      const jwt = await verifyTideJWT(token);
      if (req.headers.get("dpop")) {
        await verifyDpop(req, token, jwt as { cnf?: { jkt?: string } });
      }

      const verifiedByHelper = await verifyTideCloakToken(
        tcConfig as any,
        token,
        allowedList
      );

      const realmRoles: string[] =
        ((jwt.realm_access as any)?.roles as string[]) || [];

      if (requiredRole && (!hasRole(jwt, requiredRole) || !verifiedByHelper)) {
        const db = readDb();
        db.auditLog.unshift({
          id: `audit-${randomUUID().slice(0, 8)}`,
          timestamp: new Date().toISOString(),
          actor: `Tide User (${String(jwt.vuid || jwt.sub).slice(0, 14)}...)`,
          category: "AUTH",
          action: `PROTECTED_ROUTE_DENIED (required=${requiredRole})`,
          httpStatus: 403,
          outcome: "DENIED_403",
          detail: `No Access (HTTP 403): Tide JWT verified, but caller roles [${realmRoles.join(
            ", "
          )}] do not include required role '${requiredRole}'.`,
        });
        writeDb(db);

        return Response.json(
          {
            authenticated: true,
            authorized: false,
            vuid: jwt.vuid,
            roles: realmRoles,
            requiredRole,
            error: `No Access (HTTP 403): Your Tide identity lacks the required '${requiredRole}' role.`,
          },
          { status: 403 }
        );
      }

      return Response.json({
        authenticated: true,
        authorized: true,
        verifiedBy: "TIDECLOAK_VVK_JWK",
        vuid: jwt.vuid,
        subject: jwt.sub,
        roles: realmRoles,
        exp: jwt.exp,
      });
    } catch (err) {
      return Response.json(
        {
          authenticated: false,
          authorized: false,
          error:
            err instanceof Error
              ? `Invalid or expired TideCloak token: ${err.message}`
              : "Unauthorized",
        },
        { status: 401 }
      );
    }
  }

  // 2. Demo Session / Account Role Verification
  if (accountIdHeader) {
    const db = readDb();
    const account = db.accounts.find((a) => a.id === accountIdHeader);
    if (!account) {
      return Response.json(
        {
          authenticated: false,
          authorized: false,
          error: "Unauthorized: Session account not found.",
        },
        { status: 401 }
      );
    }

    if (
      requiredRole &&
      account.activeRole !== requiredRole &&
      !account.realmRoles.includes(requiredRole)
    ) {
      db.auditLog.unshift({
        id: `audit-${randomUUID().slice(0, 8)}`,
        timestamp: new Date().toISOString(),
        actor: `${account.name} (${account.email})`,
        actorAccountId: account.id,
        category: "AUTH",
        action: `PROTECTED_ROUTE_DENIED (required=${requiredRole}, actual=${account.activeRole})`,
        httpStatus: 403,
        outcome: "DENIED_403",
        detail: `No Access (HTTP 403): Role '${account.activeRole}' is not authorized to access route requiring '${requiredRole}'.`,
      });
      writeDb(db);

      return Response.json(
        {
          authenticated: true,
          authorized: false,
          accountId: account.id,
          currentRole: account.activeRole,
          requiredRole,
          error: `No Access (HTTP 403): Active role '${account.activeRole}' is not authorized. This route requires role '${requiredRole}'.`,
        },
        { status: 403 }
      );
    }

    return Response.json({
      authenticated: true,
      authorized: true,
      accountId: account.id,
      vuid: account.vuid,
      currentRole: account.activeRole,
      roles: account.realmRoles,
    });
  }

  return Response.json(
    {
      authenticated: false,
      authorized: false,
      error: "Unauthorized (HTTP 401): Please sign in with TideCloak first.",
    },
    { status: 401 }
  );
}

