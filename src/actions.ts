/**
 * XMPP actions handler (reactions, polls, etc.)
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
// NOTE: jsonResult is local rather than imported from openclaw/plugin-sdk. The
// SDK's jsonResult is bound through a chain of single-letter Rollup re-exports
// ("c as jsonResult") and under OpenClaw's plugin-loader runtime context that
// binding loses its callable, throwing
//   (0 , _pluginSdk.jsonResult) is not a function
// from inside any handler reached via the runtime's
// plugin.actions.handleAction dispatcher (it works fine in isolation; only
// the runtime-loader path is affected). The send action goes through a
// different code path and was unaffected, which masked the issue for as
// long as react was an LLM-invisible no-op (no describeMessageTool surface).
// The shape we emit here matches the SDK's jsonResult contract exactly
// ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
//   details: payload }) so OpenClaw's tool-result handling is identical.
function jsonResult(payload: unknown): {
  content: { type: "text"; text: string }[];
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}
import type { ChannelMessageActionName } from "./types.js";
import { getActiveClient } from "./monitor.js";
import { resolveXmppAccount } from "./accounts.js";
import { bareJid } from "./config-schema.js";
import { xml } from "@xmpp/client";
import { getServerMessageId, getRecentInboundMessageId } from "./state.js";
import {
  isOmemoEnabled,
  encryptOmemoMessage,
  encryptMucOmemoMessage,
  NS_OMEMO,
} from "./omemo/index.js";
import {
  buildLmcReplaceElement,
  buildRetractElement,
  buildRetractBodyFallbackMarker,
  RETRACT_BODY_FALLBACK,
} from "./edits.js";

/**
 * Resolve the target JID for a message.
 * For MUC (groupchat), messages are sent to the bare room JID without a resource.
 * The /nickname resource is only used when JOINING a room, not when sending messages.
 */
function resolveMucTarget(targetJid: string, isMuc: boolean, _config: { nickname?: string }): string {
  if (!isMuc) {
    return targetJid;
  }
  // For MUC, always use bare room JID (no resource/nickname)
  // Messages to MUC rooms go to room@service, not room@service/nick
  return bareJid(targetJid);
}

/**
 * Action gate - check if action is enabled in config
 */
function createActionGate(
  actions?: Record<string, boolean>
): (action: string) => boolean {
  return (action: string) => {
    if (!actions) return false;
    return actions[action] === true;
  };
}

/**
 * Collect every `actions` block in the XMPP channel config, regardless of
 * whether the deployment uses the single-account top-level shape
 * (`channels.xmpp.actions.*`) or the multi-account shape
 * (`channels.xmpp.accounts.<id>.actions.*`). Returns an empty array if no
 * actions block is configured anywhere.
 *
 * An action is considered enabled if ANY configured location has it set true.
 * This matches user expectation: if you've enabled reactions on any account,
 * the agent's `react` tool should be discoverable. Per-account dispatch is
 * still scoped inside handleAction by the resolved account.
 */
function collectXmppActionBlocks(
  xmppConfig?: Record<string, unknown>
): Record<string, boolean>[] {
  if (!xmppConfig) return [];
  const blocks: Record<string, boolean>[] = [];

  const topLevel = xmppConfig.actions as Record<string, boolean> | undefined;
  if (topLevel) blocks.push(topLevel);

  const accounts = xmppConfig.accounts as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (accounts) {
    for (const account of Object.values(accounts)) {
      const accountActions = account?.actions as
        | Record<string, boolean>
        | undefined;
      if (accountActions) blocks.push(accountActions);
    }
  }

  return blocks;
}

/**
 * True if `action` is enabled in any of the collected action blocks.
 */
function anyGateEnabled(
  blocks: Record<string, boolean>[],
  action: string
): boolean {
  for (const block of blocks) {
    if (createActionGate(block)(action)) return true;
  }
  return false;
}

/**
 * List available actions for XMPP — legacy adapter shape, kept for any caller
 * that still queries it. The canonical discovery surface used by OpenClaw's
 * tool-schema builder is `describeXmppMessageTool` below; modifications to
 * the supported-action set should land in both to stay consistent.
 */
export function listXmppActions(cfg: OpenClawConfig): ChannelMessageActionName[] {
  const xmppConfig = cfg.channels?.xmpp as Record<string, unknown> | undefined;
  const blocks = collectXmppActionBlocks(xmppConfig);
  if (blocks.length === 0) return [];

  const actions: ChannelMessageActionName[] = [];

  // XEP-0444: Message Reactions
  if (anyGateEnabled(blocks, "reactions")) {
    actions.push("react");
  }

  return actions;
}

/**
 * Canonical discovery surface for the shared `message` tool.
 *
 * OpenClaw's runtime (resolveMessageActionDiscoveryForPlugin in
 * @openclaw/plugin-sdk) calls `adapter.describeMessageTool(...)` at tool
 * registration time to learn which actions a channel adds to the LLM's
 * `message(action=..., ...)` enum, and to merge any plugin-owned parameters
 * into the tool schema. Without this method present, the legacy `listActions`
 * is NOT consulted — the action is silently dropped and the agent never sees
 * `react` as a callable action.
 *
 * Returns the action set gated on `channels.xmpp.actions.*` config plus a
 * schema contribution that surfaces the `react`-specific parameters
 * (`emoji`, `messageId`, `remove`) on the shared `message` tool. The schema
 * is scoped to the `react` action so unrelated actions don't inherit it.
 */
type SchemaContribution = {
  properties: Record<string, unknown>;
  actions: ChannelMessageActionName[];
  visibility: "current-channel" | "all-configured";
};

export function describeXmppMessageTool(
  { cfg }: { cfg: OpenClawConfig }
): {
  actions: ChannelMessageActionName[];
  schema?: SchemaContribution[];
} | null {
  const xmppConfig = cfg.channels?.xmpp as Record<string, unknown> | undefined;
  // Walk both the single-account top-level shape (channels.xmpp.actions.*) and
  // the multi-account shape (channels.xmpp.accounts.<id>.actions.*) so this
  // works across all deployment layouts. See collectXmppActionBlocks above.
  const blocks = collectXmppActionBlocks(xmppConfig);

  const actions: ChannelMessageActionName[] = [];

  // XEP-0444: Message Reactions — config-gated because reaction spam can be
  // noisy and some operators want to disable it.
  if (blocks.length > 0 && anyGateEnabled(blocks, "reactions")) {
    actions.push("react");
  }

  // XEP-0308 LMC (edit) and XEP-0424 Retraction — surfaced unconditionally
  // whenever the XMPP channel is configured at all. There's no good reason
  // to disable "fix my typo" or "I sent that to the wrong room": both are
  // strictly remedial, can't be spammed against the user's will (each one
  // targets a specific prior message id), and the agent only invokes them
  // when it chose to.
  //
  // The action name "unsend" follows the SDK's canonical vocabulary
  // (iMessage and other plugins use the same name for their XEP-0424
  // equivalent); the wire element is still `<retract>` per the spec.
  if (xmppConfig) {
    actions.push("edit");
    actions.push("unsend");
  }

  if (actions.length === 0) {
    return null;
  }

  // Schema contributions are split per param so they can be precisely scoped:
  //   - messageId is shared by react/edit/retract (target the prior message)
  //   - emoji/remove are react-only
  // OpenClaw merges contributions when they target overlapping actions.
  const schema: SchemaContribution[] = [
    {
      properties: {
        messageId: {
          type: "string",
          description:
            "Stanza id of the prior message this action targets. For react, optional — defaults to the most recent inbound message from this conversation. For edit/unsend, REQUIRED and must be one our account previously sent (LMC/Retract refuse to cross senders or conversations).",
        },
      },
      actions: actions.filter((a) => a === "react" || a === "edit" || a === "unsend"),
      visibility: "current-channel",
    },
  ];

  if (actions.includes("react")) {
    schema.push({
      properties: {
        emoji: {
          type: "string",
          description: "Emoji to react with (XEP-0444). Required for react.",
        },
        remove: {
          type: "boolean",
          description:
            "True to remove an existing reaction with the given emoji (otherwise adds it).",
        },
      },
      actions: ["react"],
      visibility: "current-channel",
    });
  }

  return { actions, schema };
}

/**
 * Check if action is supported
 */
export function supportsXmppAction(action: string): boolean {
  return action === "react" || action === "edit" || action === "unsend";
}

/**
 * XEP-0308 Last Message Correction (edit).
 *
 * Sends a new message containing the corrected body plus a plaintext
 * `<replace id="originalMsgId"/>` pointer. The new body IS the content
 * (unlike retract or react), so we encrypt it via OMEMO when enabled and
 * keep `<replace>` as a plaintext sibling — receiving clients need the
 * pointer at parse time, before decryption, to locate the original.
 */
export async function handleXmppEditAction(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  chatJid: string;
  originalMsgId: string;
  newBody: string;
}) {
  const { cfg, accountId, chatJid, originalMsgId, newBody } = params;
  const targetJid = chatJid.replace(/^xmpp:/, "");

  console.log(`[XMPP:actions] handleXmppEditAction: chatJid=${targetJid} originalMsgId=${originalMsgId} accountId=${accountId} newBodyLen=${newBody?.length ?? 0}`);

  if (!originalMsgId) {
    return jsonResult({ ok: false, error: "messageId is required for edit (the id of the message you want to correct)" });
  }
  if (!newBody) {
    return jsonResult({ ok: false, error: "message is required for edit (the corrected text)" });
  }

  const account = resolveXmppAccount({ cfg, accountId });
  const config = account.config;
  const client = getActiveClient(account.accountId);
  if (!client) {
    return jsonResult({ ok: false, error: "XMPP client not connected" });
  }

  const isMuc = Boolean(config.groups?.some((room) => bareJid(room) === bareJid(targetJid)));
  const msgType = isMuc ? "groupchat" : "chat";
  const resolvedTarget = resolveMucTarget(targetJid, isMuc, config);
  const editMsgId = `lmc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const replaceEl = buildLmcReplaceElement(originalMsgId);

  try {
    if (isOmemoEnabled(account.accountId)) {
      const encryptedElement = isMuc
        ? await encryptMucOmemoMessage(account.accountId, bareJid(targetJid), newBody, undefined)
        : await encryptOmemoMessage(account.accountId, bareJid(targetJid), newBody, undefined);

      if (encryptedElement) {
        const message = xml(
          "message",
          { to: resolvedTarget, type: msgType, id: editMsgId },
          encryptedElement,
          replaceEl,
          xml("encryption", { xmlns: "urn:xmpp:eme:0", namespace: NS_OMEMO, name: "OMEMO" }),
          xml("store", { xmlns: "urn:xmpp:hints" }),
          // Plaintext fallback body so non-OMEMO clients see something.
          xml("body", {}, "I sent you an OMEMO encrypted edit but your client doesn't seem to support that."),
        );
        await client.send(message);
        console.log(`[XMPP:actions] Sent OMEMO+LMC edit: to=${resolvedTarget} type=${msgType} replaceId=${originalMsgId}`);
        return jsonResult({ ok: true, messageId: editMsgId, replacedId: originalMsgId });
      }
      // OMEMO encryption returned empty — refuse to send plaintext (mirrors
      // the inbound.ts deliverReply policy: warn instead of leaking content).
      return jsonResult({ ok: false, error: "OMEMO encryption returned empty; refusing to send plaintext edit" });
    }

    // Plaintext path
    const message = xml(
      "message",
      { to: resolvedTarget, type: msgType, id: editMsgId },
      replaceEl,
      xml("body", {}, newBody),
      xml("store", { xmlns: "urn:xmpp:hints" }),
    );
    await client.send(message);
    console.log(`[XMPP:actions] Sent plaintext LMC edit: to=${resolvedTarget} type=${msgType} replaceId=${originalMsgId}`);
    return jsonResult({ ok: true, messageId: editMsgId, replacedId: originalMsgId });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return jsonResult({ ok: false, error: `XMPP edit failed: ${errMsg}` });
  }
}

/**
 * XEP-0424 Message Retraction.
 *
 * Sends a `<retract id="originalMsgId"/>` element with a XEP-0428 fallback
 * marker covering the entire body so reply-aware clients strip the
 * fallback text and render a tombstone, while older clients still see a
 * comprehensible note. No OMEMO encryption on the body because the body
 * IS the fallback text — there's no protected content to hide; the retract
 * id itself is metadata.
 */
export async function handleXmppRetractAction(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  chatJid: string;
  originalMsgId: string;
}) {
  const { cfg, accountId, chatJid, originalMsgId } = params;
  const targetJid = chatJid.replace(/^xmpp:/, "");

  console.log(`[XMPP:actions] handleXmppRetractAction: chatJid=${targetJid} originalMsgId=${originalMsgId} accountId=${accountId}`);

  if (!originalMsgId) {
    return jsonResult({ ok: false, error: "messageId is required for retract (the id of the message you want to retract)" });
  }

  const account = resolveXmppAccount({ cfg, accountId });
  const config = account.config;
  const client = getActiveClient(account.accountId);
  if (!client) {
    return jsonResult({ ok: false, error: "XMPP client not connected" });
  }

  const isMuc = Boolean(config.groups?.some((room) => bareJid(room) === bareJid(targetJid)));
  const msgType = isMuc ? "groupchat" : "chat";
  const resolvedTarget = resolveMucTarget(targetJid, isMuc, config);
  const retractMsgId = `retract_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const message = xml(
      "message",
      { to: resolvedTarget, type: msgType, id: retractMsgId },
      buildRetractElement(originalMsgId),
      buildRetractBodyFallbackMarker(),
      xml("body", {}, RETRACT_BODY_FALLBACK),
      xml("store", { xmlns: "urn:xmpp:hints" }),
    );
    await client.send(message);
    console.log(`[XMPP:actions] Sent retract: to=${resolvedTarget} type=${msgType} retractId=${originalMsgId}`);
    return jsonResult({ ok: true, messageId: retractMsgId, retractedId: originalMsgId });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return jsonResult({ ok: false, error: `XMPP retract failed: ${errMsg}` });
  }
}

/**
 * Handle XMPP action (reaction / edit / retract dispatcher).
 */
export async function handleXmppAction(params: {
  action: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
  chatJid: string;
  messageId: string;
  emoji?: string;
  remove?: boolean;
  message?: string;
}) {
  const { action, cfg, accountId, chatJid, messageId, emoji, remove, message } = params;

  // Safety: strip xmpp: prefix if it leaked through
  const targetJid = chatJid.replace(/^xmpp:/, "");

  // Log action attempt for debugging
  console.log(`[XMPP:actions] handleXmppAction: action=${action} chatJid=${targetJid} messageId=${messageId} emoji=${emoji} accountId=${accountId} remove=${remove}`);

  if (action === "edit") {
    return handleXmppEditAction({
      cfg,
      accountId,
      chatJid: targetJid,
      originalMsgId: messageId,
      newBody: message || "",
    });
  }
  if (action === "unsend") {
    return handleXmppRetractAction({
      cfg,
      accountId,
      chatJid: targetJid,
      originalMsgId: messageId,
    });
  }
  if (action !== "react") {
    return jsonResult({ ok: false, error: `Unsupported XMPP action: ${action}` });
  }

  const account = resolveXmppAccount({ cfg, accountId });
  const xmppConfig = cfg.channels?.xmpp as Record<string, unknown> | undefined;
  // Walk both top-level (single-account) and per-account (multi-account)
  // shapes so the gate behaves consistently with describeXmppMessageTool —
  // otherwise multi-account configs (e.g. Pierce's pierce/ledger/civic/pixel
  // under channels.xmpp.accounts.<id>.actions) silently report "reactions
  // are disabled" even when reactions: true is set per-account.
  const reactionBlocks = collectXmppActionBlocks(xmppConfig);
  if (!anyGateEnabled(reactionBlocks, "reactions")) {
    return jsonResult({ ok: false, error: "XMPP reactions are disabled — set actions.reactions: true in config" });
  }

  const config = account.config;
  const client = getActiveClient(account.accountId);
  if (!client) {
    return jsonResult({ ok: false, error: "XMPP client not connected" });
  }

  // Check if targetJid is in groups list
  const isMuc = Boolean(config.groups?.some((room) => bareJid(room) === bareJid(targetJid)));

  // Determine message type: groupchat for MUC rooms, chat for DMs
  const msgType = isMuc ? "groupchat" : "chat";

  try {
    // The messageId from the AI/LLM is based on the INBOUND message's stanza-id.
    // We need to look up the server-assigned ID, or use fallback if AI passes wrong ID.
    const serverMessageId = getServerMessageId(account.accountId, messageId, targetJid);

    // Build reactions element - use simple xml() call which works correctly
    // (The c()/t() approach causes circular JSON errors, but the simple approach works)
    const reactionsEl = remove
      ? xml("reactions", { id: serverMessageId, xmlns: "urn:xmpp:reactions:0" })
      : xml("reactions", { id: serverMessageId, xmlns: "urn:xmpp:reactions:0" },
          xml("reaction", {}, emoji || "👍"));

    const reactionMsgId = `reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // XEP-0444 + XEP-0420: Send reactions BOTH encrypted AND as plaintext sibling
    // 
    // Native XMPP clients (Conversations, Gajim) send reactions as:
    // 1. Plaintext <reactions> sibling - for display by the receiving client
    // 2. OMEMO-encrypted payload (can be empty) - to keep session active
    //
    // The plaintext sibling is what clients display as emoji reactions.
    // Without it, clients show the decrypted XML payload as plain text!
    //
    // Message structure (correct format):
    // <message>
    //   <encrypted xmlns="eu.siacs.conversations.axolotl">
    //     <header sid="...">
    //       <key rid="...">...</key>
    //       <iv>...</iv>
    //     </header>
    //     <payload>BASE64</payload>  <- Can be empty or contain SCE wrapper
    //   </encrypted>
    //   <reactions id="..." xmlns="urn:xmpp:reactions:0">  <- Plaintext sibling for display!
    //     <reaction>👍</reaction>
    //   </reactions>
    //   <encryption xmlns="urn:xmpp:eme:0" namespace="eu.siacs.conversations.axolotl" name="OMEMO"/>
    //   <store xmlns="urn:xmpp:hints"/>
    // </message>
    if (isOmemoEnabled(account.accountId)) {
      // Build the OMEMO encrypted payload (keep session active, can be empty)
      const payloadContent = ""; // Empty - the plaintext sibling handles the reaction display

      const encryptedElement = isMuc
        ? await encryptMucOmemoMessage(account.accountId, bareJid(targetJid), payloadContent, undefined)
        : await encryptOmemoMessage(account.accountId, bareJid(targetJid), payloadContent, undefined);

      if (encryptedElement) {
        // Send BOTH encrypted payload (keeps session active) AND plaintext reactions (for display)
        const resolvedTarget = resolveMucTarget(targetJid, isMuc, config);
        const message = xml(
          "message",
          { to: resolvedTarget, type: msgType, id: reactionMsgId },
          encryptedElement,
          reactionsEl,  // Plaintext sibling - THIS is what clients display as emoji!
          xml("encryption", {
            xmlns: "urn:xmpp:eme:0",
            namespace: NS_OMEMO,
            name: "OMEMO",
          }),
          xml("store", { xmlns: "urn:xmpp:hints" })
        );

        console.log(`[XMPP:actions] Sending OMEMO + plaintext reaction sibling: to=${resolvedTarget} type=${msgType} refId=${serverMessageId} emoji=${emoji || "👍"}`);
        await client.send(message);
      } else {
        // Encryption failed — fall back to plaintext reaction only
        console.log(`[XMPP:actions] OMEMO encryption failed for reaction, sending plaintext: to=${targetJid}`);
        const resolvedTarget = resolveMucTarget(targetJid, isMuc, config);
        const message = xml(
          "message",
          { to: resolvedTarget, type: msgType, id: reactionMsgId },
          reactionsEl,
          xml("store", { xmlns: "urn:xmpp:hints" })
        );
        await client.send(message);
      }
    } else {
      // No OMEMO — send plaintext reaction
      // Note: Don't include empty body - it can cause issues with some clients (like Gajim)
      // The <reactions> element is sufficient per XEP-0444
      const resolvedTarget = resolveMucTarget(targetJid, isMuc, config);
      const message = xml(
        "message",
        { to: resolvedTarget, type: msgType, id: reactionMsgId },
        reactionsEl,
        xml("store", { xmlns: "urn:xmpp:hints" })
      );

      console.log(`[XMPP:actions] Sending plaintext reaction: to=${resolvedTarget} type=${msgType} refId=${serverMessageId} emoji=${emoji || "👍"}`);
      await client.send(message);
    }

    if (remove) {
      return jsonResult({ ok: true, removed: true });
    }
    return jsonResult({ ok: true, added: emoji || "👍" });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return jsonResult({ ok: false, error: `XMPP reaction failed: ${error}` });
  }
}

/**
 * XMPP Message Actions adapter
 */
export const xmppMessageActions = {
  // Canonical discovery surface — what OpenClaw's tool builder actually calls.
  // Returning null disables every XMPP-specific action on the message tool
  // (the channel still works for plain `send`, which is built into the tool).
  describeMessageTool: ({ cfg }: { cfg: OpenClawConfig }) =>
    describeXmppMessageTool({ cfg }),

  // Legacy / fallback shape; some older code paths still query this.
  listActions: ({ cfg }: { cfg: OpenClawConfig }) => listXmppActions(cfg),

  supportsAction: ({ action }: { action: string }) => supportsXmppAction(action),

  handleAction: async (params: {
    action: string;
    params: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
    toolContext?: { currentChannelId?: string; currentThreadId?: string };
  }) => {
    const { action, params: actionParams, cfg, accountId, toolContext } = params;

    let messageId = actionParams.messageId as string | undefined;
    const emoji = actionParams.emoji as string | undefined;
    const remove = typeof actionParams.remove === "boolean" ? actionParams.remove : undefined;
    const messageBody = actionParams.message as string | undefined;

    // Resolve target: chatJid > to > toolContext.currentChannelId (same pattern as WhatsApp)
    let chatJid = (actionParams.chatJid as string) || (actionParams.to as string);
    if (!chatJid && toolContext?.currentChannelId) {
      chatJid = toolContext.currentChannelId;
    }
    // Always strip channel prefix — LLM may pass "xmpp:user@server"
    if (chatJid) {
      chatJid = chatJid.replace(/^xmpp:/, "");
    }

    if (!chatJid) {
      return jsonResult({ ok: false, error: "Target JID is required (pass chatJid, to, or use within a session context)" });
    }

    // For react ONLY: if messageId is not provided, fall back to the most
    // recent inbound message in this conversation. For edit/retract the
    // messageId MUST refer to one of OUR OWN outbound messages (LMC and
    // Retract refuse to cross senders), so an inbound fallback would be
    // wrong; require the agent to pass it explicitly.
    if (!messageId && action === "react") {
      const account = resolveXmppAccount({ cfg, accountId });
      const recentId = getRecentInboundMessageId(account.accountId, bareJid(chatJid));
      if (recentId) {
        messageId = recentId;
        console.log(`[XMPP:actions] No messageId provided, using recent inbound message ID: ${messageId}`);
      }
    }

    if (!messageId) {
      const hint = action === "react"
        ? "messageId is required for reactions"
        : `messageId is required for ${action} (must be the id of one of your previously-sent messages in this conversation)`;
      return jsonResult({ ok: false, error: hint });
    }

    try {
      return await handleXmppAction({
        action,
        cfg,
        accountId,
        chatJid: bareJid(chatJid),
        messageId,
        emoji,
        remove,
        message: messageBody,
      });
    } catch (err) {
      // Always return jsonResult so content[] is never undefined in session history
      return jsonResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  extractToolSend: () => null,
};
