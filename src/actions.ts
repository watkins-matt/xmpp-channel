/**
 * XMPP actions handler (reactions, polls, etc.)
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
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
export function describeXmppMessageTool(
  { cfg }: { cfg: OpenClawConfig }
): {
  actions: ChannelMessageActionName[];
  schema?: {
    properties: Record<string, unknown>;
    actions: ChannelMessageActionName[];
    visibility: "current-channel" | "all-configured";
  };
} | null {
  const xmppConfig = cfg.channels?.xmpp as Record<string, unknown> | undefined;
  // Walk both the single-account top-level shape (channels.xmpp.actions.*) and
  // the multi-account shape (channels.xmpp.accounts.<id>.actions.*) so this
  // works across all deployment layouts. See collectXmppActionBlocks above.
  const blocks = collectXmppActionBlocks(xmppConfig);
  if (blocks.length === 0) return null;

  const actions: ChannelMessageActionName[] = [];

  // XEP-0444: Message Reactions
  if (anyGateEnabled(blocks, "reactions")) {
    actions.push("react");
  }

  if (actions.length === 0) {
    return null;
  }

  return {
    actions,
    // Plugin-owned react params. `messageId` defaults to "most recent inbound
    // message from this conversation" inside handleAction when omitted, so
    // it's only useful when the agent wants to react to a non-most-recent
    // message — keep it optional so the LLM isn't forced to invent one.
    schema: {
      properties: {
        emoji: {
          type: "string",
          description: "Emoji to react with (XEP-0444). Required for react.",
        },
        messageId: {
          type: "string",
          description:
            "Stanza id of the message to react to. Optional — defaults to the most recent inbound message from this conversation.",
        },
        remove: {
          type: "boolean",
          description:
            "True to remove an existing reaction with the given emoji (otherwise adds it).",
        },
      },
      actions: ["react"],
      visibility: "current-channel",
    },
  };
}

/**
 * Check if action is supported
 */
export function supportsXmppAction(action: string): boolean {
  return action === "react";
}

/**
 * Handle XMPP action (reaction)
 */
export async function handleXmppAction(params: {
  action: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
  chatJid: string;
  messageId: string;
  emoji?: string;
  remove?: boolean;
}) {
  const { action, cfg, accountId, chatJid, messageId, emoji, remove } = params;

  // Safety: strip xmpp: prefix if it leaked through
  const targetJid = chatJid.replace(/^xmpp:/, "");

  // Log action attempt for debugging
  console.log(`[XMPP:actions] handleXmppAction: action=${action} chatJid=${targetJid} messageId=${messageId} emoji=${emoji} accountId=${accountId} remove=${remove}`);

  if (action !== "react") {
    return jsonResult({ ok: false, error: `Unsupported XMPP action: ${action}` });
  }

  const account = resolveXmppAccount({ cfg, accountId });
  const xmppConfig = cfg.channels?.xmpp as Record<string, unknown> | undefined;
  const actionsConfig = xmppConfig?.actions as Record<string, boolean> | undefined;

  const gate = createActionGate(actionsConfig);
  if (!gate("reactions")) {
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

    // If messageId is not provided, try to use the most recent inbound message ID from this conversation
    if (!messageId) {
      // Get the account ID to look up the recent message
      const account = resolveXmppAccount({ cfg, accountId });
      const recentId = getRecentInboundMessageId(account.accountId, bareJid(chatJid));
      if (recentId) {
        messageId = recentId;
        console.log(`[XMPP:actions] No messageId provided, using recent inbound message ID: ${messageId}`);
      }
    }

    if (!messageId) {
      return jsonResult({ ok: false, error: "messageId is required for reactions" });
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
      });
    } catch (err) {
      // Always return jsonResult so content[] is never undefined in session history
      return jsonResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  extractToolSend: () => null,
};
