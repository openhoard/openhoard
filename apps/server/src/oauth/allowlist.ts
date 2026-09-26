import { redirectIdentity, type OAuthClient, type TrustResolver } from "@openhoard/core-identity";
import type { ApprovedClient, AuthConfig } from "../config.js";

/*
 * Which MCP clients a tenant lets in (T-105, T-106): an admin's decision in the app
 * (`oauth_clients`, the admin API) and the operator's list in the config (`auth.clients`).
 *
 * Precedence, most binding first:
 *
 * 1. A refusal made in the app stands, whatever the config says (fail closed): core/identity
 *    approvedTrust() checks it before anything else.
 * 2. A client the config lists is approved, with the config's trust label. The app can't refuse,
 *    revoke or relabel it (the admin API answers 409): the config is the operator's, and a change
 *    in the app would silently lose to it. Its approval is also recorded in the database, as
 *    decided by `system:config`, for the admins' list.
 * 3. A client approved through the config once and no longer listed is not approved: taking it
 *    out of the config ends the approval it gave. An admin may approve it in the app from then on.
 * 4. Otherwise the app's decision: approved with its trust label, or pending.
 */

/** Whether an approved-client entry of the config names this client in this tenant. */
export function approves(
  a: ApprovedClient,
  tenantId: string,
  client: Pick<OAuthClient, "kind" | "clientRef" | "redirectUris">,
): boolean {
  if (a.tenantId !== tenantId) return false;
  if (a.clientId !== undefined) return client.kind === "cimd" && client.clientRef === a.clientId;
  if (client.kind !== "dcr" || !a.redirectUris) return false;
  const listed = new Set(a.redirectUris.map(redirectIdentity));
  return client.redirectUris.every((r) => listed.has(redirectIdentity(r)));
}

/** The config's entry for a client in a tenant, if it lists it. */
export function listedIn(
  auth: Pick<AuthConfig, "clients">,
  tenantId: string,
  client: Pick<OAuthClient, "kind" | "clientRef" | "redirectUris">,
): ApprovedClient | undefined {
  return auth.clients.find((a) => approves(a, tenantId, client));
}

/** What the config says about a tenant's clients (core/identity TrustResolver): 2 and 3 above. */
export function configuredTrust(
  auth: Pick<AuthConfig, "clients">,
  tenantId: string,
): TrustResolver {
  return (client: OAuthClient) => {
    const listed = listedIn(auth, tenantId, client);
    if (listed) return listed.trust;
    return client.decidedBy === "system:config" ? null : undefined;
  };
}
