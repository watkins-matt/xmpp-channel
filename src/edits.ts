/**
 * XEP-0308 (Last Message Correction) + XEP-0424 (Message Retraction) helpers.
 *
 * Both modify a previously-sent message via a top-level child element on a
 * new outgoing stanza that references the original by id:
 *
 *   - XEP-0308 `<replace id="..."/>` swaps the original's body with the new
 *     body. Reply-aware clients render an inline edit (e.g. Conversations
 *     shows a small pencil mark and replaces the bubble); older clients
 *     just see a new message.
 *   - XEP-0424 `<retract id="..."/>` removes the original from the chat.
 *     Reply-aware clients render a tombstone; older clients see a stub body
 *     ({@link RETRACT_BODY_FALLBACK}) wrapped in a XEP-0428 fallback marker
 *     so the spec-compliant tombstone behavior degrades cleanly.
 *
 * Both elements MUST be plaintext siblings of any OMEMO `<encrypted>` payload
 * — receiving clients use them at parse time (before decryption) to identify
 * the target message in local history. For LMC the body is the real
 * (decrypted) correction content; for retract the body is fallback text only.
 */
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/client";

/**
 * Plaintext fallback body used inside a XEP-0424 retract message. Tells
 * clients that don't understand `<retract>` (and therefore won't render the
 * tombstone) that a retraction was attempted. The accompanying XEP-0428
 * `<fallback>` marker tells reply-aware clients to strip this body entirely.
 *
 * Wording follows the canonical example in XEP-0424.
 */
export const RETRACT_BODY_FALLBACK =
  "This person attempted to retract a previous message, but it's still visible to unsupported clients.";

/**
 * XEP-0308 message-correction pointer. Goes as a top-level child of the new
 * outgoing `<message>`; the new `<body>` is the corrected content.
 *
 * @param originalMsgId  `id` attribute of the message being replaced. MUST
 *                       be one our account previously sent in the same
 *                       conversation; servers and clients refuse corrections
 *                       across senders or conversations.
 */
export function buildLmcReplaceElement(originalMsgId: string): Element {
  return xml("replace", {
    xmlns: "urn:xmpp:message-correct:0",
    id: originalMsgId,
  });
}

/**
 * XEP-0424 retract pointer. Top-level child of a new outgoing `<message>`;
 * pair with {@link buildRetractBodyFallbackMarker} and a body containing
 * {@link RETRACT_BODY_FALLBACK} so non-retract-aware clients still see a
 * comprehensible note.
 *
 * @param originalMsgId  `id` of the message to retract. Same scoping rules
 *                       as LMC — must be our own previously-sent message.
 */
export function buildRetractElement(originalMsgId: string): Element {
  return xml("retract", {
    xmlns: "urn:xmpp:message-retract:1",
    id: originalMsgId,
  });
}

/**
 * XEP-0428 fallback marker scoped to retract. Empty `<body/>` inside means
 * "the ENTIRE body of this stanza is fallback for the retract protocol —
 * strip it before rendering if you understand `<retract>`." Used together
 * with {@link RETRACT_BODY_FALLBACK} in the body.
 */
export function buildRetractBodyFallbackMarker(): Element {
  return xml(
    "fallback",
    { xmlns: "urn:xmpp:fallback:0", for: "urn:xmpp:message-retract:1" },
    xml("body"),
  );
}

/**
 * `<store xmlns="urn:xmpp:hints"/>` — XEP-0334 hint requesting the server
 * archive this message in MAM. Retract stanzas in particular should be
 * archived so a peer that fetches history later still sees the retraction.
 */
export function buildStoreHint(): Element {
  return xml("store", { xmlns: "urn:xmpp:hints" });
}
