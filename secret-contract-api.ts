/**
 * Channel secret contract: tells OpenClaw's secrets system which XMPP config
 * fields are credentials, so `channels.xmpp.password` and
 * `channels.xmpp.accounts.<id>.password` may be SecretRefs
 * (`{ source, provider, id }`) that the gateway resolves into the runtime
 * config before an account starts, and `openclaw secrets audit/configure/apply/reload`
 * can see them.
 *
 * OpenClaw loads this module by file name (`dist/secret-contract-api.js`) in
 * read-only CLI paths too, so it must stay import-light: SDK helpers only.
 *
 * `account-inheritance`: an account without its own password inherits the
 * channel-level one; a single-account config (no `accounts`) is the implicit
 * `default` account backed by the channel root. Both layouts we run.
 */
import { createSimpleChannelSecretContract } from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const channelSecrets = createSimpleChannelSecretContract({
  channelKey: "xmpp",
  label: "XMPP",
  accountFields: ["password"],
  channelFields: ["password"],
  mode: "account-inheritance",
});

export const secretTargetRegistryEntries = channelSecrets.secretTargetRegistryEntries;
export const collectRuntimeConfigAssignments = channelSecrets.collectRuntimeConfigAssignments;
