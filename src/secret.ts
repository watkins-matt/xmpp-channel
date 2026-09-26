/**
 * XMPP password handling for SecretRef-backed config.
 *
 * In config, `password` is a SecretInput: a plain string or a SecretRef
 * (`{ source, provider, id }`, see secret-contract-api.ts). The gateway resolves
 * refs into the runtime config before an account starts, so the connection
 * sees a string. Read-only CLI paths (status, onboarding, heartbeat) may still
 * see the unresolved ref: that counts as "configured".
 */
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  type SecretInput,
} from "openclaw/plugin-sdk/secret-input";

export type { SecretInput };

/** True when a password is set, either literally or as a SecretRef. */
export function hasXmppPassword(value: unknown): boolean {
  return hasConfiguredSecretInput(value);
}

/**
 * The resolved password string for a connection. Throws (instead of handing
 * `[object Object]` to SASL, whose repeated failures would trip Prosody's
 * rate limits) when the value is still an unresolved SecretRef: the secret
 * contract didn't load, or the ref's owner is cold.
 */
export function resolvedXmppPassword(value: unknown, path: string): string {
  const password = normalizeResolvedSecretInputString({ value, path });
  if (!password) {
    throw new Error(`XMPP password missing at ${path}`);
  }
  return password;
}
