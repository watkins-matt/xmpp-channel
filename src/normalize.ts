/**
 * XMPP target normalization utilities
 */

import { bareJid } from "./config-schema.js";

/**
 * Check if a string looks like an XMPP JID
 */
export function looksLikeXmppJid(id: string): boolean {
  const trimmed = id.trim();
  if (!trimmed) return false;
  
  // Must have @ symbol
  if (!trimmed.includes("@")) return false;
  
  // Must have domain after @
  const parts = trimmed.split("@");
  if (parts.length !== 2) return false;
  if (!parts[0] || !parts[1]) return false;
  
  // Domain should have at least one dot or be localhost
  const domain = parts[1].split("/")[0];
  if (domain !== "localhost" && !domain.includes(".")) return false;
  
  return true;
}

/**
 * Check if JID is a MUC room
 */
export function isXmppMucJid(jid: string, mucDomains?: string[]): boolean {
  const domain = bareJid(jid).split("@")[1];
  if (!domain) return false;
  
  // Common MUC domain patterns
  const mucPatterns = [
    "conference.",
    "muc.",
    "rooms.",
    "chat.",
    "groupchat.",
  ];
  
  // Check custom domains
  if (mucDomains?.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return true;
  }
  
  // Check common patterns
  return mucPatterns.some((pattern) => domain.startsWith(pattern));
}

/**
 * Tell OpenClaw whether an outbound target is a person or a room.
 *
 * Without this hook, OpenClaw 9.x classifies every bare JID as a GROUP
 * (detectTargetKind's fallback), so a message-tool send to
 * `matt@xmpp.astra.buzz` -- the heartbeat's morning briefing -- had its
 * delivery-mirror copy filed under `agent:<id>:xmpp:group:matt@...`, a session
 * no inbound DM ever reads. Pierce then had no record of what he had posted
 * when Matt replied (2026-10-01; 202 briefings in that dead session since
 * April). Explicit kind prefixes win; otherwise a MUC-domain JID is a room and
 * every other JID is a person. Returns undefined for non-JIDs so OpenClaw's
 * own fallbacks still apply.
 */
export function inferXmppTargetChatType(params: {
  to?: string;
}): "direct" | "group" | undefined {
  let target = (params.to ?? "").trim().replace(/^(xmpp|jabber):/i, "");
  if (!target) return undefined;
  if (/^(user|dm):/i.test(target)) return "direct";
  if (/^(group|room|channel):/i.test(target)) return "group";
  target = target.replace(/^(user|dm|group|room|channel):/i, "");
  if (!looksLikeXmppJid(target)) return undefined;
  return isXmppMucJid(target) ? "group" : "direct";
}

/**
 * Normalize XMPP target for messaging
 */
export function normalizeXmppTarget(raw: string | null | undefined): string | null {
  if (!raw) return null;
  
  let target = raw.trim();
  
  // Strip xmpp: or jabber: prefix
  target = target.replace(/^(xmpp|jabber):/i, "");
  
  // Validate
  if (!looksLikeXmppJid(target)) return null;
  
  // Return bare JID
  return bareJid(target);
}

/**
 * Normalize XMPP messaging target (for plugin interface)
 */
export function normalizeXmppMessagingTarget(params: {
  target?: string;
}): { targetId: string } | null {
  const normalized = normalizeXmppTarget(params.target);
  return normalized ? { targetId: normalized } : null;
}

/**
 * Format JID for display
 */
export function formatXmppJid(jid: string): string {
  return bareJid(jid);
}

/**
 * Extract resource from full JID
 */
export function extractResource(jid: string): string | undefined {
  const parts = jid.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : undefined;
}

/**
 * Build full JID from bare JID and resource
 */
export function buildFullJid(bareJid: string, resource: string): string {
  return `${bareJid}/${resource}`;
}

/**
 * Normalized allowFrom list result
 */
export interface NormalizedAllowFrom {
  entries: string[];
  hasWildcard: boolean;
}

/**
 * Normalize allowFrom list for matching
 */
export function normalizeAllowFrom(list?: string[]): NormalizedAllowFrom {
  if (!list || list.length === 0) {
    return { entries: [], hasWildcard: true }; // Empty = allow all
  }
  const entries = list.map((jid) => bareJid(jid).toLowerCase());
  const hasWildcard = entries.includes("*");
  return { entries, hasWildcard };
}

/**
 * Check if sender is allowed based on normalized allowFrom
 */
export function isSenderAllowed(allowFrom: NormalizedAllowFrom, senderJid: string): boolean {
  if (allowFrom.hasWildcard || allowFrom.entries.length === 0) return true;
  const normalized = bareJid(senderJid).toLowerCase();
  return allowFrom.entries.includes(normalized);
}
