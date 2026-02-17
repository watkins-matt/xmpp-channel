# SKILL.md - XMPP Reactions Support

## Purpose
This skill enables emoji reactions for messages via the XMPP plugin on OpenClaw. It supports sending, receiving, and debugging emoji reactions to ensure compatibility with XMPP clients like Conversations and Gajim.

## Features
- **React to Messages:** Add emoji reactions to specific message IDs using the `message action=react` functionality.
- **Debug Reactions:** Capture and inspect stanzas related to reactions for troubleshooting or standards compliance.
- **Test Automation:** Simulate reactions and validate behavior programmatically.

## Instructions

### Adding Emoji Reactions
1. Ensure the XMPP plugin is active and configured.
2. Use the `message` tool with the following parameters:
    - `action`: Set to `react`.
    - `channel`: Set to `xmpp`.
    - `messageId`: The ID of the message you want to react to.
    - `emoji`: The emoji you want to use as a reaction.

Example:
```json
{
  "action": "react",
  "channel": "xmpp",
  "messageId": "1234567890",
  "emoji": "👍"
}