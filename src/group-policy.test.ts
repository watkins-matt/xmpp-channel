import { describe, expect, it } from "vitest";
import { decideGroupMessage, isInviteAllowed, isKnownRoom, resolveGroupPolicy } from "./group-policy";

/**
 * Room messages are prompts, so the room checks fail closed (2026-11-17).
 *
 * Atlas (wide fleet access) sat in ops@conference with Pierce, who reads untrusted
 * email. Atlas had no groupPolicy, which meant "open": a mention from Pierce was an
 * Atlas turn. An allowlist alone did not close it either, because a sender whose real
 * JID was not tracked was let through, and any JID could invite an account into a room.
 */
const ROOM = "ops@conference.xmpp.astra.buzz";
const MATT = "matt@xmpp.astra.buzz";
const PIERCE = "pierce@xmpp.astra.buzz";
const base = { groups: [ROOM], allowFrom: [MATT, "zenith@xmpp.astra.buzz"] };
const strict = { ...base, groupPolicy: "allowlist" as const, groupAllowFrom: [MATT] };

describe("resolveGroupPolicy", () => {
  it("is allowlist when unset", () => {
    expect(resolveGroupPolicy({})).toBe("allowlist");
  });
  it("is open only when the config says open", () => {
    expect(resolveGroupPolicy({ groupPolicy: "open" })).toBe("open");
    expect(resolveGroupPolicy({ groupPolicy: "allowlist" })).toBe("allowlist");
  });
});

describe("decideGroupMessage", () => {
  const known = [ROOM];

  it("lets the listed sender through", () => {
    expect(decideGroupMessage(strict, { roomJid: ROOM, realSenderJid: `${MATT}/phone`, knownRooms: known }).allowed).toBe(true);
  });

  it("blocks another agent in the same room", () => {
    const d = decideGroupMessage(strict, { roomJid: ROOM, realSenderJid: PIERCE, knownRooms: known });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("not in groupAllowFrom");
  });

  it("blocks a sender whose real JID is unknown", () => {
    expect(decideGroupMessage(strict, { roomJid: ROOM, realSenderJid: null, knownRooms: known }).allowed).toBe(false);
  });

  it("applies the allowlist when groupPolicy is unset", () => {
    const cfg = { ...base, groupAllowFrom: [MATT] };
    expect(decideGroupMessage(cfg, { roomJid: ROOM, realSenderJid: PIERCE, knownRooms: known }).allowed).toBe(false);
    expect(decideGroupMessage(cfg, { roomJid: ROOM, realSenderJid: MATT, knownRooms: known }).allowed).toBe(true);
  });

  it("falls back to allowFrom when groupAllowFrom is unset", () => {
    const cfg = { ...base, groupPolicy: "allowlist" as const };
    expect(decideGroupMessage(cfg, { roomJid: ROOM, realSenderJid: "zenith@xmpp.astra.buzz", knownRooms: known }).allowed).toBe(true);
    expect(decideGroupMessage(cfg, { roomJid: ROOM, realSenderJid: PIERCE, knownRooms: known }).allowed).toBe(false);
  });

  it("allows nobody on an empty list", () => {
    const cfg = { groups: [ROOM], groupPolicy: "allowlist" as const, groupAllowFrom: [] };
    expect(decideGroupMessage(cfg, { roomJid: ROOM, realSenderJid: MATT, knownRooms: known }).allowed).toBe(false);
    expect(decideGroupMessage({ groups: [ROOM] }, { roomJid: ROOM, realSenderJid: MATT, knownRooms: known }).allowed).toBe(false);
  });

  it("blocks a groupchat stanza that is not from a joined room, even under open", () => {
    const open = { ...base, groupPolicy: "open" as const };
    // type="groupchat" sent straight to the account's full JID: the "room" is the sender.
    expect(decideGroupMessage(open, { roomJid: PIERCE, realSenderJid: null, knownRooms: known }).allowed).toBe(false);
    expect(decideGroupMessage(open, { roomJid: "x@conference.xmpp.astra.buzz", realSenderJid: MATT, knownRooms: known }).allowed).toBe(false);
    expect(decideGroupMessage(open, { roomJid: undefined, realSenderJid: MATT, knownRooms: known }).allowed).toBe(false);
  });

  it("open and wildcard still mean everyone in a joined room", () => {
    const open = { ...base, groupPolicy: "open" as const };
    expect(decideGroupMessage(open, { roomJid: ROOM, realSenderJid: null, knownRooms: known }).allowed).toBe(true);
    const star = { ...base, groupPolicy: "allowlist" as const, groupAllowFrom: ["*"] };
    expect(decideGroupMessage(star, { roomJid: ROOM, realSenderJid: null, knownRooms: known }).allowed).toBe(true);
  });

  it("matches rooms and senders without regard to case or resource", () => {
    expect(isKnownRoom("OPS@Conference.xmpp.astra.buzz/Atlas", known)).toBe(true);
    expect(decideGroupMessage(strict, { roomJid: ROOM, realSenderJid: "Matt@XMPP.astra.buzz/x", knownRooms: known }).allowed).toBe(true);
  });
});

describe("isInviteAllowed", () => {
  it("follows an owner's invitation only", () => {
    expect(isInviteAllowed(base, `${MATT}/phone`)).toBe(true);
    expect(isInviteAllowed(base, PIERCE)).toBe(false);
    expect(isInviteAllowed(base, "")).toBe(false);
  });
  it("follows nobody when there are no owners", () => {
    expect(isInviteAllowed({}, MATT)).toBe(false);
    expect(isInviteAllowed({ allowFrom: [] }, MATT)).toBe(false);
  });
  it("keeps the explicit wildcard", () => {
    expect(isInviteAllowed({ allowFrom: ["*"] }, PIERCE)).toBe(true);
  });
});
