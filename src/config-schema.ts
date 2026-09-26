import { z } from "zod";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { registerSensitiveConfigSchema } from "openclaw/plugin-sdk/secret-input";

const PROVIDER_ALIAS = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_STYLE_ID = /^[A-Z][A-Z0-9_]{0,127}$/;

/**
 * SecretRef ({ source, provider, id }): same shape and patterns as the host's
 * SecretRefSchema, built with the plugin's own zod (mixing the host's zod
 * instance into these objects breaks declaration emit). Resolution is the
 * host's job, via secret-contract-api.ts.
 */
const SecretRefSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("env"), provider: z.string().regex(PROVIDER_ALIAS), id: z.string().regex(ENV_STYLE_ID) }).strict(),
  z.object({ source: z.literal("store"), provider: z.string().regex(PROVIDER_ALIAS), id: z.string().regex(ENV_STYLE_ID) }).strict(),
  z.object({ source: z.literal("file"), provider: z.string().regex(PROVIDER_ALIAS), id: z.string() }).strict(),
  z.object({ source: z.literal("exec"), provider: z.string().regex(PROVIDER_ALIAS), id: z.string() }).strict(),
]);

/** Password: a plain string or a SecretRef. */
const XmppPasswordSchema = z.union([z.string(), SecretRefSchema]);
// Mark it sensitive for the host's config redaction. The host types this with
// its own zod instance; the registry only keys on the schema object, so the
// cast is safe and keeps our declarations free of the host's zod types.
registerSensitiveConfigSchema(XmppPasswordSchema as never);

/**
 * XMPP action configuration schema
 */
export const XmppActionSchema = z.object({
  /** Enable XEP-0444 reactions */
  reactions: z.boolean().optional(),
  /** Enable send message action */
  sendMessage: z.boolean().optional(),
});

/**
 * Tool policy schema for group tool access control
 */
export const ToolPolicySchema = z.object({
  /** Tools to explicitly allow */
  allow: z.array(z.string()).optional(),
  /** Tools to add to an existing allow list */
  alsoAllow: z.array(z.string()).optional(),
  /** Tools to explicitly deny */
  deny: z.array(z.string()).optional(),
});

/**
 * Group-specific configuration schema
 */
export const XmppGroupConfigSchema = z.object({
  /** Require @mention in this group */
  requireMention: z.boolean().optional(),
  /** Group-level tool access policy */
  tools: ToolPolicySchema.optional(),
  /** Per-sender tool access overrides */
  toolsBySender: z.record(z.string(), ToolPolicySchema.optional()).optional(),
});

/**
 * OMEMO encryption configuration schema
 */
export const XmppOmemoConfigSchema = z.object({
  /** Enable OMEMO encryption support */
  enabled: z.boolean().optional().default(false).describe("Enable OMEMO encryption (XEP-0384)"),
  /** Device label for this bot instance */
  deviceLabel: z.string().optional().describe("Display label for this device in OMEMO device list"),
});

/**
 * XMPP account configuration schema
 */
export const XmppAccountSchema = z.object({
  /** Account name (optional display name) */
  name: z.string().optional().describe("Display name for this account"),

  /** Allow the agent to write to config (e.g., add users to allowlist) */
  configWrites: z.boolean().optional().describe("Allow agent to modify config (default: true)"),

  /** Bot JID (e.g., bot@example.com) */
  jid: z.string().optional().describe("Bot JID (e.g., bot@example.com)"),

  /** XMPP account password: a plain string or a SecretRef ({ source, provider, id }) */
  password: XmppPasswordSchema.optional().describe("XMPP account password (string or SecretRef)"),

  /** XMPP server hostname (defaults to JID domain) */
  server: z.string().optional().describe("XMPP server hostname (defaults to JID domain)"),

  /** XMPP server port */
  port: z.number().int().min(1).max(65535).optional().default(5222).describe("XMPP server port"),

  /** XMPP resource identifier (internal, auto-generated if not set) */
  resource: z.string().optional().describe("XMPP resource identifier (auto-generated for uniqueness)"),

  /** Nickname shown in group chats (defaults to local part of JID, e.g., 'Aurora') */
  nickname: z.string().optional().describe("Display name in group chats (defaults to local part of JID, e.g., 'Aurora')"),

  /** Direct chat policy for guests (JIDs not in allowFrom) */
  dmPolicy: z.enum(["disabled", "open", "pairing", "allowlist"]).optional().default("open").describe("Direct chat policy: disabled (owners only), open (allow all), pairing (require pairing), allowlist (only dmAllowlist JIDs)"),

  /** Group message policy */
  groupPolicy: z.enum(["open", "allowlist"]).optional().default("open").describe("Group message policy: open (respond to all), allowlist (require mention or allowlist)"),

  /** Bot owner / trusted JIDs — always have direct chat access */
  allowFrom: z.array(z.string()).optional().describe("Bot owner JIDs (always have direct chat access, cannot be removed by guests)"),

  /** DM allowlist — additional JIDs allowed to direct-chat when dmPolicy is 'allowlist' */
  dmAllowlist: z.array(z.string()).optional().describe("JIDs allowed to direct-chat when dmPolicy is 'allowlist' (owners always have access regardless)"),

  /** Allowed sender JIDs for groups */
  groupAllowFrom: z.array(z.string()).optional().describe("Allowed sender JIDs for groups (defaults to allowFrom, use * for all)"),

  /** Group chat rooms to join */
  groups: z.array(z.string()).optional().describe("Group chat rooms to join on startup"),

  /** Action configuration */
  actions: XmppActionSchema.optional().describe("Action configuration (reactions, sendMessage)"),

  /** Inbound message prefix */
  messagePrefix: z.string().optional().describe("Prefix added to inbound messages"),

  /** Heartbeat visibility */
  heartbeatVisibility: z.enum(["visible", "hidden"]).optional().describe("Heartbeat visibility in status"),

  /** Per-group settings (keyed by room JID or "*" for default) */
  groupSettings: z.record(z.string(), XmppGroupConfigSchema).optional().describe("Per-group settings for tool policies and mentions"),

  /** Send read receipts for incoming messages (XEP-0333, default true) */
  sendReadReceipts: z.boolean().optional().describe("Send read receipts (XEP-0333 chat markers) for incoming messages (default: true)"),

  /** OMEMO encryption configuration */
  omemo: XmppOmemoConfigSchema.optional().describe("OMEMO encryption settings (XEP-0384)"),
});

/**
 * XMPP configuration schema using Zod
 */
export const XmppConfigSchema = XmppAccountSchema.extend({
  /** Multi-account configuration */
  accounts: z.record(z.string(), XmppAccountSchema.partial()).optional(),
});

export type XmppConfigSchemaType = z.infer<typeof XmppConfigSchema>;

/**
 * Build channel config schema using OpenClaw SDK helper
 */
export function xmppChannelConfigSchema() {
  return buildChannelConfigSchema(XmppConfigSchema);
}

/**
 * Extract server from JID if not explicitly provided
 */
export function resolveServer(config: { jid: string; server?: string }): string {
  if (config.server) return config.server;
  const domain = config.jid.split("@")[1];
  if (!domain) throw new Error(`Invalid JID: ${config.jid}`);
  return domain;
}

/**
 * Extract username from JID
 */
export function extractUsername(jid: string): string {
  const username = jid.split("@")[0];
  if (!username) throw new Error(`Invalid JID: ${jid}`);
  return username;
}

/**
 * Normalize JID to bare JID (strip resource)
 */
export function bareJid(jid: string): string {
  return jid.split("/")[0];
}
