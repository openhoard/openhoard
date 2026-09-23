/* Generated from plugin-manifest.v1.schema.json by scripts/generate.ts. Do not edit. */

/**
 * Declares what a plugin is and the capabilities it requests. The core grants nothing beyond what is declared and approved by an admin.
 */
export interface PluginManifest {
manifest_version: 1
/**
 * Lowercase, hyphenated, unique within the registry.
 */
name: string
version: string
type: ("connector" | "enricher" | "pack" | "skill" | "client")
description?: string
publisher?: string
homepage?: string
license?: string
/**
 * Enrichers: MIME types this plugin handles.
 */
accepts?: string[]
/**
 * Plugins can never hold grant, share, policy:write or audit:write. Those belong to the core.
 */
capabilities: ("read:metadata" | "read:content" | "write:content" | "write:fields" | "propose:tags" | "read:acl" | "import:acl" | "source:crawl" | "source:delta" | "source:write" | "source:redirect" | "notify:send")[]
/**
 * Hostnames the plugin may reach. Empty means no network. Exact hostnames or one leading wildcard label ("*.example.com"); a bare "*" (any host) is rejected. (Security review #8.)
 */
network?: string[]
/**
 * The most sensitive exposure level this plugin may receive. It never sees content above this level.
 */
max_exposure?: ("full" | "commercial-only" | "local-only" | "metadata-only")
/**
 * wasm (sandboxed) or process (isolated OS process) for code, declarative for packs, agent for skills. No containers.
 */
runtime?: ("wasm" | "process" | "declarative" | "agent")
limits?: {
cpu_ms?: number
memory_mb?: number
timeout_s?: number
}
/**
 * Publisher key ID. Required for registry listing.
 */
signed_by?: string
}
