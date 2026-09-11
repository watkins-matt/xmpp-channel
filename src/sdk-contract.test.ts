import { describe, expect, it } from "vitest";
import { xmppPlugin } from "./channel";
import { resolveXmppAccount } from "./accounts";
import plugin from "../index";

/**
 * Contract with the HOST's OpenClaw SDK. The fork no longer bundles its own
 * copy of `openclaw`: node_modules/openclaw links to the gateway's installed
 * package, so these run against the exact SDK the plugin will load inside.
 * Run them where that link exists — `npm run test:host`, or the xmpp.yml deploy.
 */
describe("host SDK contract", () => {
  it("builds the channel config schema from the plugin's own zod", () => {
    // buildChannelConfigSchema is the host's; XmppConfigSchema was built with the
    // plugin's zod. A cross-instance mismatch shows up as a missing/empty schema.
    const built = xmppPlugin.configSchema as { schema?: { properties?: Record<string, unknown> } };
    const props = built.schema?.properties ?? {};
    for (const key of ["jid", "password", "server", "accounts", "allowFrom"]) {
      expect(props, `config schema property ${key}`).toHaveProperty(key);
    }
  });

  it("gives the plugin entry an (empty) plugin config schema", () => {
    expect(plugin.configSchema).toBeTypeOf("object");
  });

  it("resolves the default account when it lives under accounts.default", () => {
    // Bug #9 (2026-05-31): pierce@ never started when its settings sat under
    // accounts.default beside named accounts. Account ids now normalize through
    // the host's normalizeAccountId.
    const cfg = {
      channels: {
        xmpp: {
          accounts: {
            default: { jid: "pierce@example.com", password: "p" },
            ledger: { jid: "ledger@example.com", password: "l" },
          },
        },
      },
    };
    expect(resolveXmppAccount({ cfg, accountId: undefined }).config.jid).toBe("pierce@example.com");
    expect(resolveXmppAccount({ cfg, accountId: "default" }).accountId).toBe("default");
    const ledger = resolveXmppAccount({ cfg, accountId: " Ledger " });
    expect(ledger.accountId).toBe("ledger");
    expect(ledger.config.jid).toBe("ledger@example.com");
  });
});
