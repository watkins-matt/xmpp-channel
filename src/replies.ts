/**
 * XEP-0461 (Message Replies) + XEP-0428 (Fallback Indication) helpers.
 *
 * Used by the inbound→outbound reply path to thread the bot's response under
 * the message that triggered it. Reply-aware clients (Conversations, Dino,
 * Gajim) render the response as a quote-thread referring back to the original;
 * older clients see the quoted text inline at the top of the body so they
 * still have context.
 *
 * For OMEMO chats only the {@link buildReplyElement} pointer is emitted as a
 * plaintext sibling of the `<encrypted>` payload — the body itself is the
 * canned "encrypted message" notice, so a body-range fallback marker doesn't
 * apply. For plaintext chats, all three pieces are used together: the pointer,
 * a `> quoted line\n>\n` prefix on the body, and the matching `<fallback>`
 * marker telling reply-aware clients to strip the prefix before rendering.
 */
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/client";

/**
 * XEP-0461 reply pointer. MUST be a top-level child of the outgoing
 * `<message>` and — when paired with OMEMO — MUST be a plaintext sibling of
 * the `<encrypted>` element (not inside the SCE envelope), because the
 * receiving client uses it at parse time to look up the original message in
 * local history before any decryption happens.
 *
 * @param originalMsgId      `id` attribute of the message being replied to.
 * @param originalSenderJid  For 1:1 chats: bare JID of the original sender.
 *                            For MUCs: full occupant JID (`room@conf/nick`).
 */
export function buildReplyElement(
  originalMsgId: string,
  originalSenderJid: string,
): Element {
  return xml("reply", {
    xmlns: "urn:xmpp:reply:0",
    id: originalMsgId,
    to: originalSenderJid,
  });
}

/**
 * Build a Markdown-style quoted prefix from the original body for use as the
 * XEP-0428 fallback. Each line of the original is prefixed with `> `, with a
 * trailing `>` separator line so the parser-side line-prefix heuristic stops
 * cleanly at the start of the real reply text.
 *
 * Long originals are truncated to {@link MAX_QUOTE_CHARS} — reply-aware
 * clients render the full quoted text from their own history anyway, so the
 * fallback only needs to give dumb clients enough context to follow the
 * conversation.
 *
 * Returns `{ prefix: "", length: 0 }` for empty / whitespace-only originals,
 * in which case the caller should skip emitting the fallback marker.
 *
 * The `length` is JavaScript string `.length` (UTF-16 code units) to match
 * how Conversations and other major clients interpret the XEP-0428 range
 * attributes.
 */
const MAX_QUOTE_CHARS = 280;

export function buildReplyFallbackPrefix(
  originalBody: string,
): { prefix: string; length: number } {
  const trimmed = originalBody.trim();
  if (!trimmed) return { prefix: "", length: 0 };

  const quoted =
    trimmed.length > MAX_QUOTE_CHARS
      ? trimmed.slice(0, MAX_QUOTE_CHARS).trimEnd() + "…"
      : trimmed;

  const quotedLines = quoted.split("\n").map((line) => `> ${line}`);
  // Trailing `>\n` separates the quote block from the reply body so the
  // inbound parser's line-prefix loop terminates exactly at the response.
  const prefix = quotedLines.join("\n") + "\n>\n";
  return { prefix, length: prefix.length };
}

/**
 * XEP-0428 fallback marker. Tells reply-aware clients to strip
 * `body[start:end]` before rendering — they'll show their own quote frame
 * instead. Older clients ignore the marker and render the full body as-is.
 */
export function buildReplyFallbackMarker(start: number, end: number): Element {
  return xml(
    "fallback",
    { xmlns: "urn:xmpp:fallback:0", for: "urn:xmpp:reply:0" },
    xml("body", { start: String(start), end: String(end) }),
  );
}
