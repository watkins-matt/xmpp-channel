/**
 * Post-connect OMEMO session-resync helper.
 *
 * Sends a small OMEMO-encrypted no-op message to each known human contact
 * immediately after the XMPP connection comes online and OMEMO has
 * initialized. The goal is to recover from the session-state asymmetry that
 * happens whenever our side restarts: the peer's client (e.g. Matt's
 * Conversations) holds a more-recent double-ratchet state than what got
 * persisted to `xmpp-omemo.json` before we went down. Without an active
 * recovery signal the asymmetry only clears when the peer's client times
 * out the session or notices a missing delivery — anywhere from seconds to
 * many minutes. Sending a bootstrap stanza from our side prompts the peer's
 * ratchet to step forward (or reset via the prekey-initiated path if
 * libsignal decides the current session can't be salvaged), restoring
 * bi-directional delivery within ~1 second.
 *
 * The encrypted payload is empty: Conversations / Dino / Gajim treat
 * empty-payload OMEMO messages as session-machinery stanzas and do not
 * render a visible bubble, which is what we want. XEP-0334 transient hints
 * (`no-store` + `no-copy` + `no-permanent-store`) tell Prosody not to
 * archive in MAM and not to replicate via Carbons, so the bootstrap doesn't
 * leak into the user's message history.
 *
 * Rate-limited per account (one bootstrap per BOOTSTRAP_MIN_INTERVAL_MS) so
 * a flapping XMPP connection can't trigger a storm. Agent JIDs are
 * filtered out so coordinated restart cascades (where Pierce + Atlas
 * restart together) don't ratchet-storm each other.
 */
import { xml } from "@xmpp/client";
import { bareJid } from "./config-schema.js";
import { encryptOmemoMessage, NS_OMEMO } from "./omemo/index.js";
import { activeClients } from "./state.js";
import type { Logger } from "./types.js";

/**
 * Minimum interval between bootstrap broadcasts on the same account. If the
 * XMPP connection flaps repeatedly we don't want to spam Prosody (or burn
 * peer prekeys if libsignal renegotiates) — one bootstrap per minute is
 * plenty for session-state recovery purposes.
 */
const BOOTSTRAP_MIN_INTERVAL_MS = 60_000;

const lastBootstrapAt = new Map<string, number>();

/**
 * Local-parts of the openclaw agent fleet. Used to skip bootstrap to other
 * bots so two simultaneously-restarting agents don't ratchet-storm each
 * other. Conservative explicit list rather than "anything @astra.buzz"
 * because Matt himself is matt@xmpp.astra.buzz and obviously SHOULD get
 * bootstrap.
 */
const AGENT_LOCAL_PARTS = new Set([
  "atlas",
  "pierce",
  "forge",
  "vigil",
  "ledger",
  "civic",
  "pixel",
  "argus",
  "scout",
  "echo",
]);

function isAgentJid(jid: string): boolean {
  const bare = bareJid(jid);
  const local = bare.split("@")[0]?.toLowerCase() ?? "";
  return AGENT_LOCAL_PARTS.has(local);
}

/**
 * Encrypt an empty plaintext to `contactJid` using the current OMEMO
 * session, send the resulting stanza with XEP-0334 transient hints so
 * Prosody doesn't archive or replicate it. Returns silently on encryption
 * failure — bootstrap is best-effort; if it fails the regular fallback
 * recovery (peer-side timeout + bundle re-fetch) still applies.
 */
async function sendOmemoBootstrap(
  accountId: string,
  contactJid: string,
  log?: Logger,
): Promise<void> {
  const xmpp = activeClients.get(accountId);
  if (!xmpp) {
    log?.warn?.(`[${accountId}] bootstrap skipped: no active client for ${contactJid}`);
    return;
  }

  const target = bareJid(contactJid);

  const encryptedElement = await encryptOmemoMessage(accountId, target, "", log);
  if (!encryptedElement) {
    log?.warn?.(`[${accountId}] bootstrap encryption returned empty for ${target} (no recovery this round)`);
    return;
  }

  const stanza = xml(
    "message",
    {
      to: target,
      type: "chat",
      id: `bootstrap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    },
    encryptedElement,
    xml("encryption", { xmlns: "urn:xmpp:eme:0", namespace: NS_OMEMO, name: "OMEMO" }),
    // XEP-0334 transient hints: don't archive in MAM, don't replicate via
    // Carbons, don't store at all. Bootstrap is pure session machinery and
    // should not leak into history anywhere.
    xml("no-store", { xmlns: "urn:xmpp:hints" }),
    xml("no-copy", { xmlns: "urn:xmpp:hints" }),
    xml("no-permanent-store", { xmlns: "urn:xmpp:hints" }),
  );

  await xmpp.send(stanza);
  log?.info?.(`[${accountId}] OMEMO bootstrap sent to ${target}`);
}

/**
 * Fire OMEMO bootstrap to every non-agent JID in `allowFrom`, with
 * per-account rate limiting and per-target error isolation.
 *
 * Call this from the XMPP `online` handler AFTER OMEMO has initialized and
 * device-list prefetch has populated the cache, otherwise the encryption
 * will fail with empty-cache and fall back to plaintext (which we refuse
 * to send, per the OMEMO-only invariant).
 */
export async function bootstrapKnownContacts(
  accountId: string,
  allowFrom: readonly string[] | undefined,
  log?: Logger,
): Promise<void> {
  if (!allowFrom || allowFrom.length === 0) return;

  const now = Date.now();
  const lastTs = lastBootstrapAt.get(accountId) ?? 0;
  if (now - lastTs < BOOTSTRAP_MIN_INTERVAL_MS) {
    log?.debug?.(
      `[${accountId}] OMEMO bootstrap skipped (rate-limit): last fired ${Math.round(
        (now - lastTs) / 1000,
      )}s ago, min interval ${BOOTSTRAP_MIN_INTERVAL_MS / 1000}s`,
    );
    return;
  }
  lastBootstrapAt.set(accountId, now);

  const targets = allowFrom.filter((jid) => !isAgentJid(jid));
  if (targets.length === 0) {
    log?.debug?.(`[${accountId}] OMEMO bootstrap skipped: no non-agent JIDs in allowFrom`);
    return;
  }

  log?.info?.(
    `[${accountId}] OMEMO bootstrap: sending session-resync to ${targets.length} contact(s): ${targets.join(", ")}`,
  );

  for (const target of targets) {
    try {
      await sendOmemoBootstrap(accountId, target, log);
    } catch (err) {
      log?.warn?.(
        `[${accountId}] OMEMO bootstrap to ${target} failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
