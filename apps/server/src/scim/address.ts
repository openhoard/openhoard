import { isIP } from "node:net";

/*
 * Who a request comes from, for counting failed authentications (limiter.ts).
 *
 * - The address is the socket's peer, unless that peer is a trusted proxy (`scim.trustedProxies`,
 *   off by default): then X-Forwarded-For is read from the right, skipping trusted proxies, and
 *   the first address that isn't one is the client. Addresses further left were written by the
 *   client itself and prove nothing.
 * - IPv6 clients are counted by /64, the block one subscriber usually holds: counting single
 *   addresses would let one client rotate through 2^64 of them.
 */

/** An address in one spelling: IPv4-mapped IPv6 as IPv4, IPv6 expanded, lower case. */
export function normalizeAddress(address: string): string | null {
  // No address is longer (an expanded IPv6 with a zone and a port); X-Forwarded-For is the
  // client's to write.
  if (address.length > 100) return null;
  // With a port, as Azure Application Gateway, Front Door and IIS ARR write X-Forwarded-For:
  // `1.2.3.4:5678`, `[2001:db8::1]:443`. (A bare IPv6 address has colons but no brackets.)
  const ported = /^(?:\[(.*)\]|(\d{1,3}(?:\.\d{1,3}){3}))(?::(\d{1,5}))?$/.exec(address.trim());
  if (ported?.[3] !== undefined && Number(ported[3]) > 65535) return null;
  const trimmed = ported ? (ported[1] ?? ported[2] ?? "") : address.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  if (mapped?.[1] !== undefined && isIP(mapped[1]) === 4) return mapped[1];
  const kind = isIP(trimmed);
  if (kind === 4) return trimmed;
  if (kind !== 6) return null;
  const zone = trimmed.indexOf("%");
  return expand((zone === -1 ? trimmed : trimmed.slice(0, zone)).toLowerCase());
}

/** An IPv6 address as eight groups of four hex digits. */
function expand(v6: string): string {
  let text = v6;
  // A trailing IPv4 part (::ffff:1.2.3.4 other than mapped, 64:ff9b::1.2.3.4) as two groups.
  // Split, not a regular expression: an unanchored one backtracks on long runs of digits.
  const last = text.lastIndexOf(":");
  const quad = text.slice(last + 1).split(".");
  if (quad.length === 4) {
    const [a, b, c, d] = quad.map(Number) as [number, number, number, number];
    text = `${text.slice(0, last + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const zeros = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((g) => g.padStart(4, "0")).join(":");
}

/** The key failures are counted under: an IPv4 address, or an IPv6 /64. */
export function addressKey(address: string): string {
  const normal = normalizeAddress(address);
  if (normal === null) return address === "" ? "unknown" : address.slice(0, 64);
  if (!normal.includes(":")) return normal;
  return `${normal.split(":").slice(0, 4).join(":")}::/64`;
}

/**
 * The client's address: the peer, or, when the peer is a trusted proxy, the right-most address
 * in X-Forwarded-For that isn't one. "unknown" when there is no peer (in-process requests).
 */
export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | undefined,
  trusted: ReadonlySet<string>,
): string {
  const from = peer === undefined ? null : normalizeAddress(peer);
  if (from === null) return "unknown";
  if (!trusted.has(from) || forwardedFor === undefined) return from;
  const hops = forwardedFor
    .split(",")
    .map((h) => normalizeAddress(h))
    .reverse();
  for (const hop of hops) {
    // A hop that isn't an address (a proxy wrote garbage, or the client did): stop trusting.
    if (hop === null) return from;
    if (!trusted.has(hop)) return hop;
  }
  // Every hop is a trusted proxy: the left-most is as close to the client as there is.
  return hops[hops.length - 1] ?? from;
}

/** The trusted proxies from the configuration, normalized; throws on a non-address. */
export function trustedSet(proxies: readonly string[]): Set<string> {
  return new Set(
    proxies.map((p) => {
      const normal = normalizeAddress(p);
      if (normal === null) throw new TypeError(`not an IP address: ${p}`);
      return normal;
    }),
  );
}
