import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "../secret-contract-api";
import { XmppConfigSchema } from "./config-schema";
import { hasXmppPassword, resolvedXmppPassword } from "./secret";

/**
 * SecretRef support (docs: homelab docs/security/openclaw-secrets.md). Runs
 * against the host SDK like sdk-contract.test.ts (`npm run test:host`).
 */
const ref = (id: string) => ({ source: "file", provider: "openbao", id });

// The resolver context the gateway builds (runtime-shared createResolverContext).
function context(sourceConfig: unknown) {
  return {
    sourceConfig,
    env: {},
    cache: {},
    warnings: [] as Array<{ code: string; path: string }>,
    warningKeys: new Set<string>(),
    assignments: [] as Array<{ path: string; apply: (v: unknown) => void }>,
  };
}

function collect(config: { channels: Record<string, unknown> }) {
  const ctx = context(config);
  collectRuntimeConfigAssignments({ config, context: ctx as never });
  return ctx;
}

describe("XMPP secret contract", () => {
  it("registers the channel and per-account password paths", () => {
    const ids = secretTargetRegistryEntries.map((e: { id: string }) => e.id);
    expect(ids).toContain("channels.xmpp.password");
    expect(ids).toContain("channels.xmpp.accounts.*.password");
  });

  it("collects refs in the multi-account layout (accounts.default + named)", () => {
    const config = {
      channels: {
        xmpp: {
          enabled: true,
          accounts: {
            default: { jid: "pierce@example.test", password: ref("/xmpp/default/password") },
            ledger: { jid: "ledger@example.test", password: ref("/xmpp/ledger/password") },
          },
        },
      },
    };
    const ctx = collect(config);
    const paths = ctx.assignments.map((a) => a.path).sort();
    expect(paths).toEqual([
      "channels.xmpp.accounts.default.password",
      "channels.xmpp.accounts.ledger.password",
    ]);
    for (const a of ctx.assignments) a.apply(`resolved:${a.path}`);
    const accounts = config.channels.xmpp.accounts;
    expect(accounts.default.password).toBe("resolved:channels.xmpp.accounts.default.password");
    expect(accounts.ledger.password).toBe("resolved:channels.xmpp.accounts.ledger.password");
  });

  it("collects the root password in the single-account layout", () => {
    const config = {
      channels: { xmpp: { enabled: true, jid: "atlas@example.test", password: ref("/xmpp/default/password") } },
    };
    const ctx = collect(config);
    expect(ctx.assignments.map((a) => a.path)).toEqual(["channels.xmpp.password"]);
    ctx.assignments[0].apply("s3cret");
    expect((config.channels.xmpp as { password: unknown }).password).toBe("s3cret");
  });

  it("leaves plaintext passwords alone (nothing to resolve)", () => {
    const ctx = collect({
      channels: { xmpp: { enabled: true, jid: "atlas@example.test", password: "plain" } },
    });
    expect(ctx.assignments).toHaveLength(0);
  });

  it("skips a disabled account's ref with an inactive-surface warning", () => {
    const ctx = collect({
      channels: {
        xmpp: {
          enabled: true,
          accounts: {
            default: { jid: "a@example.test", password: "plain" },
            off: { enabled: false, jid: "b@example.test", password: ref("/xmpp/off/password") },
          },
        },
      },
    });
    expect(ctx.assignments).toHaveLength(0);
    expect(ctx.warnings.map((w) => w.code)).toContain("SECRETS_REF_IGNORED_INACTIVE_SURFACE");
  });
});

describe("password schema and helpers", () => {
  it("zod schema accepts a string or a SecretRef, rejects junk", () => {
    expect(XmppConfigSchema.safeParse({ jid: "a@b.test", password: "x" }).success).toBe(true);
    expect(XmppConfigSchema.safeParse({ jid: "a@b.test", password: ref("/p") }).success).toBe(true);
    expect(
      XmppConfigSchema.safeParse({ jid: "a@b.test", accounts: { x: { password: ref("/p") } } }).success,
    ).toBe(true);
    expect(XmppConfigSchema.safeParse({ jid: "a@b.test", password: { nope: 1 } }).success).toBe(false);
  });

  it("manifest JSON schemas widen every password to string | SecretRef", () => {
    const m = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const schemas = [m.configSchema, m.channelConfigs.xmpp.schema];
    for (const s of schemas) {
      for (const pw of [s.properties.password, s.properties.accounts.additionalProperties.properties.password]) {
        expect(pw.anyOf?.[0]).toMatchObject({ type: "string" });
        const sources = pw.anyOf?.[1]?.oneOf?.map((o: { properties: { source: { const: string } } }) => o.properties.source.const);
        expect(sources).toEqual(["env", "store", "file", "exec"]);
      }
    }
  });

  it("treats a SecretRef as configured but never hands it to SASL", () => {
    expect(hasXmppPassword(ref("/p"))).toBe(true);
    expect(hasXmppPassword("x")).toBe(true);
    expect(hasXmppPassword("")).toBe(false);
    expect(hasXmppPassword(undefined)).toBe(false);
    expect(resolvedXmppPassword("pw", "channels.xmpp.password")).toBe("pw");
    expect(() => resolvedXmppPassword(ref("/p"), "channels.xmpp.password")).toThrow(/unresolved SecretRef/);
    expect(() => resolvedXmppPassword(undefined, "channels.xmpp.password")).toThrow(/missing/);
  });
});
