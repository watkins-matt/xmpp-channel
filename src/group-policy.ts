/**
 * Who may reach an agent through a room (MUC), and whose room invitation it accepts.
 *
 * A room message is a prompt for the agent, so these checks fail CLOSED:
 *
 * - `groupPolicy` is "allowlist" unless the config says "open".
 * - A groupchat stanza counts only when it comes from a room this account joined on
 *   purpose: one in `groups`, or one an owner invited it to (persisted). A stanza that
 *   merely says type="groupchat" (any JID can send one to a full JID) is not a room.
 * - Under "allowlist" the sender's REAL JID must be known and listed in
 *   `groupAllowFrom` (falling back to `allowFrom`). A sender whose real JID is not known
 *   (a semi-anonymous room, or a message that arrives before the occupant's presence)
 *   is blocked. Before this module that case was allowed, so an allowlist held only
 *   while occupant tracking was complete.
 * - An empty list allows nobody here. (`normalizeAllowFrom` treats an empty list as
 *   "everyone", which is the upstream meaning for owners of an unconfigured bot.)
 * - A room invitation is followed only when the inviter is an owner (`allowFrom`).
 *   Before, any JID could pull the account into a room of its choosing.
 */

import { bareJid } from "./config-schema.js";
import type { XmppConfig } from "./types.js";

export interface GroupDecision {
  allowed: boolean;
  reason: string;
}

type PolicyConfig = Pick<XmppConfig, "groupPolicy" | "groupAllowFrom" | "allowFrom" | "groups">;

function strictList(list?: string[]): { entries: string[]; wildcard: boolean } {
  const entries = (list ?? [])
    .map((jid) => (jid.trim() === "*" ? "*" : bareJid(jid.trim()).toLowerCase()))
    .filter((jid) => jid.length > 0);
  return { entries, wildcard: entries.includes("*") };
}

function sameJid(a: string, b: string): boolean {
  return bareJid(a).toLowerCase() === bareJid(b).toLowerCase();
}

/** "open" only when the config says so; anything else, and no value at all, is "allowlist". */
export function resolveGroupPolicy(config: Pick<XmppConfig, "groupPolicy">): "open" | "allowlist" {
  return config.groupPolicy === "open" ? "open" : "allowlist";
}

/** True when roomJid is a room this account was told to be in. */
export function isKnownRoom(roomJid: string | undefined, rooms: readonly string[]): boolean {
  if (!roomJid) return false;
  return rooms.some((room) => sameJid(room, roomJid));
}

/**
 * Decide whether a groupchat message (or reaction) may reach the agent.
 *
 * @param knownRooms - `groups` from the config plus the persisted (invited) rooms
 * @param realSenderJid - the occupant's real JID from presence tracking, or null
 */
export function decideGroupMessage(
  config: PolicyConfig,
  opts: { roomJid?: string; realSenderJid: string | null; knownRooms: readonly string[] }
): GroupDecision {
  if (!isKnownRoom(opts.roomJid, opts.knownRooms)) {
    return { allowed: false, reason: `not a joined room: ${opts.roomJid ?? "(none)"}` };
  }
  if (resolveGroupPolicy(config) === "open") {
    return { allowed: true, reason: "groupPolicy: open" };
  }
  const list = strictList(config.groupAllowFrom ?? config.allowFrom);
  if (list.wildcard) {
    return { allowed: true, reason: "groupAllowFrom: *" };
  }
  if (!opts.realSenderJid) {
    return { allowed: false, reason: "sender's real JID is unknown" };
  }
  const sender = bareJid(opts.realSenderJid).toLowerCase();
  return list.entries.includes(sender)
    ? { allowed: true, reason: `${sender} in groupAllowFrom` }
    : { allowed: false, reason: `${sender} not in groupAllowFrom` };
}

/** A room invitation is followed only when an owner (`allowFrom`) sent it. */
export function isInviteAllowed(config: Pick<XmppConfig, "allowFrom">, inviterJid: string): boolean {
  const owners = strictList(config.allowFrom);
  if (owners.wildcard) return true;
  if (!inviterJid) return false;
  return owners.entries.includes(bareJid(inviterJid).toLowerCase());
}
