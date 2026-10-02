import { describe, expect, it } from "vitest";
import { inferXmppTargetChatType } from "./normalize";
import { resolveXmppTargets } from "./directory";
import { xmppPlugin } from "./channel";

/**
 * Person vs room classification of outbound targets (2026-10-01).
 *
 * OpenClaw 9.x files the delivery-mirror copy of a sent message under a session
 * keyed by the target's kind. With no inferTargetChatType hook, a bare JID fell
 * through to "group", so Pierce's morning briefing to matt@xmpp.astra.buzz was
 * filed under agent:main:xmpp:group:matt@..., a session Matt's DMs never read.
 */
describe("inferXmppTargetChatType", () => {
  it.each([
    ["matt@xmpp.astra.buzz", "direct"],
    ["xmpp:matt@xmpp.astra.buzz", "direct"],
    ["matt@xmpp.astra.buzz/phone", "direct"],
    ["user:matt@xmpp.astra.buzz", "direct"],
    ["ops@conference.xmpp.astra.buzz", "group"],
    ["room:ops@conference.xmpp.astra.buzz", "group"],
    ["channel:matt@xmpp.astra.buzz", "group"], // an explicit prefix wins
  ])("%s -> %s", (to, kind) => {
    expect(inferXmppTargetChatType({ to })).toBe(kind);
  });

  it.each(["", "   ", "matt", "last", "#general"])("leaves non-JID %j to OpenClaw", (to) => {
    expect(inferXmppTargetChatType({ to })).toBeUndefined();
  });

  it("is wired into the plugin's messaging adapter", () => {
    // OpenClaw calls messaging.inferTargetChatType({ to }) in detectTargetKind
    // and in the outbound session-route fallback; a missing hook means "group".
    expect(xmppPlugin.messaging.inferTargetChatType).toBe(inferXmppTargetChatType);
    expect(xmppPlugin.messaging.inferTargetChatType({ to: "matt@xmpp.astra.buzz" })).toBe("direct");
  });
});

describe("resolveXmppTargets only resolves a JID as the kind asked for", () => {
  const cfg = {
    channels: { xmpp: { jid: "pierce@xmpp.astra.buzz", groups: ["ops@conference.xmpp.astra.buzz"] } },
  } as any;
  const run = (kind: "user" | "group", inputs: string[]) =>
    resolveXmppTargets({ cfg, accountId: null, inputs, kind, runtime: {} as any });

  it("resolves a person's JID as a user, not as a group", async () => {
    const [asUser] = await run("user", ["matt@xmpp.astra.buzz"]);
    const [asGroup] = await run("group", ["matt@xmpp.astra.buzz"]);
    expect(asUser).toMatchObject({ resolved: true, id: "matt@xmpp.astra.buzz" });
    expect(asGroup).toMatchObject({ resolved: false });
  });

  it("resolves a room's JID as a group, not as a user", async () => {
    const [asGroup] = await run("group", ["ops@conference.xmpp.astra.buzz"]);
    const [asUser] = await run("user", ["ops@conference.xmpp.astra.buzz"]);
    expect(asGroup).toMatchObject({ resolved: true, id: "ops@conference.xmpp.astra.buzz" });
    expect(asUser).toMatchObject({ resolved: false });
  });
});
