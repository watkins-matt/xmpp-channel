import { describe, expect, it } from "vitest";
import { isNonDeliverableText, normalizeXmppOutboundPayload } from "./payload-filter";
import { xmppPlugin } from "./channel";

const FALLBACK =
  "The tool run finished, but no final summary was produced. I did not repeat any completed actions.";

/**
 * Mirrors how OpenClaw delivers through a channel plugin (2026.8.2 – 2026.9.3,
 * `deliver-prepare` + `normalizePayloadsForChannelDelivery`):
 *
 *   normalizePayload: (payload) => outbound.normalizePayload({ payload, cfg, accountId })
 *
 * The return value is used AS the payload, then `normalizeEmptyPayloadForDelivery`
 * drops anything without string text or media as `no_visible_payload`.
 */
function hostDeliver(payload: Record<string, unknown>): Record<string, unknown> | null {
  const out = xmppPlugin.outbound.normalizePayload({ payload, cfg: {}, accountId: "default" });
  if (!out) return null;
  const text = typeof out.text === "string" ? out.text : "";
  const hasMedia = Boolean(out.mediaUrl) || (Array.isArray(out.mediaUrls) && out.mediaUrls.length > 0);
  if (!text.trim() && !hasMedia) return null;
  return out as Record<string, unknown>;
}

describe("host delivery contract", () => {
  it("is wired as the channel's outbound.normalizePayload", () => {
    expect(xmppPlugin.outbound.normalizePayload).toBe(normalizeXmppOutboundPayload);
  });

  it("delivers ordinary text through the host's wrapper call shape", () => {
    const payload = { text: "Your PG&E bill is $12.89 due September 24." };
    expect(hostDeliver(payload)).toEqual(payload);
  });

  it("returns the bare payload, never the { payload, cfg, accountId } wrapper", () => {
    const payload = { text: "hello" };
    const out = normalizeXmppOutboundPayload({ payload, cfg: {}, accountId: "default" });
    expect(out).toBe(payload);
    expect(out).not.toHaveProperty("cfg");
    expect(out).not.toHaveProperty("payload");
  });

  it("delivers media payloads even when their text is a control token", () => {
    const payload = { text: "NO_REPLY", mediaUrl: "https://example.com/a.png" };
    expect(hostDeliver(payload)).toEqual(payload);
  });

  it("drops a whole-text control token", () => {
    expect(hostDeliver({ text: "NO_REPLY" })).toBeNull();
    expect(hostDeliver({ text: "  HEARTBEAT_OK\n" })).toBeNull();
  });

  it("drops the host finalization fallback", () => {
    expect(hostDeliver({ text: FALLBACK })).toBeNull();
  });

  it("delivers prose that merely mentions a token", () => {
    const payload = { text: "Nothing new today, so the cron replied NO_REPLY." };
    expect(hostDeliver(payload)).toEqual(payload);
  });
});

describe("bare-payload call shape", () => {
  it("passes ordinary text through unchanged", () => {
    const payload = { text: "hello" };
    expect(normalizeXmppOutboundPayload(payload)).toBe(payload);
  });

  it("drops a control token", () => {
    expect(normalizeXmppOutboundPayload({ text: "REPLY_SKIP" })).toBeNull();
  });
});

describe("isNonDeliverableText", () => {
  it("ignores empty and non-string text", () => {
    expect(isNonDeliverableText("")).toBe(false);
    expect(isNonDeliverableText(undefined)).toBe(false);
    expect(isNonDeliverableText(null)).toBe(false);
  });
});
