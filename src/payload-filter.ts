/**
 * Outbound payload filtering.
 *
 * OpenClaw hands the channel a list of reply payloads to deliver. Two kinds of
 * payload must never reach a human, and both have been observed on XMPP:
 *
 * 1. **Agent control tokens.** `NO_REPLY` is the documented way an announce-mode
 *    cron says "there is nothing to send today" (`HEARTBEAT_OK` and `REPLY_SKIP`
 *    are the older equivalents). The host normally consumes these, but any gap in
 *    that handling turns a deliberately silent run into a literal "NO_REPLY" DM.
 *
 * 2. **Host finalization fallbacks.** OpenClaw 2026.8.2 added settled-turn
 *    finalization: when a turn settles after tool calls without what it judges to
 *    be a final answer, it runs an isolated pass to synthesise one, and if that
 *    pass fails it substitutes a canned string. On the Codex agent runtime the
 *    pass always fails ("Codex settled-turn finalization context is unavailable"),
 *    so every cron that correctly ended in `NO_REPLY` delivered the canned text
 *    instead of staying silent. Observed nightly on openclaw.lxc from 2026-09-02.
 *
 * Both are dropped here rather than in the agent prompt, because a prompt cannot
 * stop text the host generates on the agent's behalf.
 *
 * Deliberately narrow: only a payload whose entire visible text is one of these
 * strings is dropped, and only when it carries no media or other content. A
 * payload that merely *contains* a control token keeps its normal path.
 */

/** Tokens an agent emits to mean "deliver nothing". Never user-facing. */
const CONTROL_TOKENS: ReadonlySet<string> = new Set([
  "NO_REPLY",
  "HEARTBEAT_OK",
  "REPLY_SKIP",
]);

/**
 * Canned text the host substitutes when its own finalization pass fails.
 * Compared case-sensitively and in full; see the 2026.8.2 note above.
 */
const HOST_FINALIZATION_FALLBACKS: readonly string[] = [
  "The tool run finished, but no final summary was produced. I did not repeat any completed actions.",
];

/** Keys that mean the payload carries something besides plain text. */
const CONTENT_BEARING_KEYS = [
  "mediaUrl",
  "mediaUrls",
  "attachments",
  "poll",
  "buttons",
  "presentation",
  "card",
] as const;

export interface OutboundPayloadLike {
  text?: string | null;
  [key: string]: unknown;
}

/** True when the payload's whole visible text is a token that must not be sent. */
export function isNonDeliverableText(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (CONTROL_TOKENS.has(trimmed)) return true;
  return HOST_FINALIZATION_FALLBACKS.some((fallback) => trimmed === fallback);
}

/** True when the payload has media or other non-text content worth delivering. */
function carriesNonTextContent(payload: OutboundPayloadLike): boolean {
  return CONTENT_BEARING_KEYS.some((key) => {
    const value = payload[key];
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") return value.trim().length > 0;
    return true;
  });
}

/**
 * Unwraps the argument OpenClaw passes to `normalizePayload`.
 *
 * The runtime calls it with the payload directly, while the bundled adapters
 * destructure `{ payload }`. Accept both so this keeps working across host
 * versions rather than silently filtering nothing.
 */
function unwrapPayload(arg: unknown): OutboundPayloadLike | undefined {
  if (!arg || typeof arg !== "object") return undefined;
  const candidate = arg as Record<string, unknown>;
  const nested = candidate.payload;
  if (nested && typeof nested === "object") return nested as OutboundPayloadLike;
  return candidate as OutboundPayloadLike;
}

/**
 * `normalizePayload` hook: return the payload to deliver it, or `null` to drop it.
 * Returns the ORIGINAL argument on the pass-through path so the host keeps
 * whatever wrapper shape it gave us.
 */
export function normalizeXmppOutboundPayload<T>(arg: T): T | null {
  const payload = unwrapPayload(arg);
  if (!payload) return arg;
  if (carriesNonTextContent(payload)) return arg;
  return isNonDeliverableText(payload.text) ? null : arg;
}
