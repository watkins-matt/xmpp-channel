declare module "openclaw/plugin-sdk" {
  export interface ChannelConfigSchema {
    schema: Record<string, unknown>;
    uiHints?: Record<string, unknown>;
  }

  /** Tool policy for group tool access control */
  export interface GroupToolPolicyConfig {
    /** Tools to explicitly allow */
    allow?: string[];
    /** Tools to explicitly deny */
    deny?: string[];
  }
  
  /** Per-sender tool policy configuration */
  export type GroupToolPolicyBySenderConfig = Record<string, GroupToolPolicyConfig | undefined>;

  /** Command authorizer for resolveControlCommandGate */
  export interface CommandAuthorizer {
    configured: boolean;
    allowed: boolean;
  }

  /** Resolve control command authorization */
  export function resolveControlCommandGate(params: {
    useAccessGroups: boolean;
    authorizers: CommandAuthorizer[];
    allowTextCommands: boolean;
    hasControlCommand: boolean;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  }): { commandAuthorized: boolean; shouldBlock: boolean };

  export interface OpenClawPluginApi {
    runtime: PluginRuntime;
    registerChannel: (registration: { plugin: unknown; dock?: unknown }) => void;
    [key: string]: unknown;
  }

  export interface OpenClawConfig {
    channels?: {
      xmpp?: unknown;
      [key: string]: unknown;
    };
    session?: {
      store?: unknown;
    };
    [key: string]: unknown;
  }

  export interface RuntimeEnv {
    log: (message: string) => void;
    error: (message: string) => void;
    [key: string]: unknown;
  }

  export interface WizardPrompter {
    text: (options: {
      message: string;
      placeholder?: string;
      initialValue?: string;
      validate?: (value: string) => string | undefined;
    }) => Promise<string>;
    password: (options: {
      message: string;
      validate?: (value: string) => string | undefined;
    }) => Promise<string>;
    confirm: (options: {
      message: string;
      initialValue?: boolean;
    }) => Promise<boolean>;
    select: <T extends string>(options: {
      message: string;
      options: Array<{ value: T; label: string }>;
    }) => Promise<T>;
    note: (message: string, title?: string) => Promise<void>;
    outro: (message: string) => Promise<void>;
    [key: string]: unknown;
  }

  export interface PluginRuntime {
    channel: {
      routing: {
        resolveAgentRoute: (params: unknown) => {
          agentId: string;
          sessionKey: string;
          mainSessionKey: string;
          accountId: string;
        };
      };
      session: {
        resolveStorePath: (store: unknown, params: { agentId: string }) => string;
        recordInboundSession: (params: unknown) => Promise<void>;
      };
      text: {
        hasControlCommand: (text: string, cfg: OpenClawConfig) => boolean;
        chunkMarkdownText: (text: string, limit: number) => string[];
        resolveTextChunkLimit: (cfg: OpenClawConfig, channel: string, accountId?: string) => number;
      };
      reply: {
        buildReplyContext: (params: unknown) => Record<string, unknown>;
        finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T, opts?: unknown) => T & { CommandAuthorized: boolean };
        dispatchReplyWithBufferedBlockDispatcher: (params: unknown) => Promise<{ queuedFinal: boolean }>;
      };
    };
    [key: string]: unknown;
  }

}

// Runtime SDK values come from the HOST's OpenClaw through these subpaths
// (2026.9 has no root `openclaw/plugin-sdk` export). On a gateway host,
// node_modules/openclaw links to the installed package, so TypeScript resolves
// the real declarations and these ambient ones are ignored. They only exist so
// the fork still compiles where OpenClaw is not installed.
declare module "openclaw/plugin-sdk/account-id" {
  export const DEFAULT_ACCOUNT_ID: "default";
  export function normalizeAccountId(value: string | null | undefined): string;
}

declare module "openclaw/plugin-sdk/core" {
  export function formatPairingApproveHint(channelId: string): string;
}

declare module "openclaw/plugin-sdk/plugin-entry" {
  export function emptyPluginConfigSchema(): Record<string, unknown>;
}

declare module "openclaw/plugin-sdk/channel-config-schema" {
  export function buildChannelConfigSchema(schema: unknown): { schema: Record<string, unknown> };
}

declare module "openclaw/plugin-sdk/channel-policy" {
  import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "openclaw/plugin-sdk";
  /** Resolve tool policy for a sender from toolsBySender config */
  export function resolveToolsBySender(params: {
    toolsBySender?: GroupToolPolicyBySenderConfig;
    senderId?: string | null;
    senderName?: string | null;
    senderUsername?: string | null;
    senderE164?: string | null;
  }): GroupToolPolicyConfig | undefined;
}

declare module "openclaw/plugin-sdk/setup" {
  import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
  export function formatDocsLink(path: string | undefined | null, label?: string): string;
  export function promptAccountId(params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    label: string;
    currentId?: string;
    listAccountIds: (cfg: OpenClawConfig) => string[];
    defaultAccountId: string;
  }): Promise<string>;
}

declare module "@xmpp/client" {
  export function client(options: {
    service: string;
    domain: string;
    username: string;
    password: string;
    resource?: string;
  }): XmppClient;

  export function xml(name: string, attrs?: Record<string, string>, ...children: unknown[]): Element;

  export interface XmppClient {
    jid?: { toString(): string };
    on(event: "stanza", handler: (stanza: Element) => void): void;
    on(event: "online", handler: (address: { toString(): string }) => void): void;
    on(event: "offline", handler: () => void): void;
    on(event: "error", handler: (err: Error) => void): void;
    off(event: "stanza", handler: (stanza: Element) => void): void;
    off(event: string, handler: (...args: unknown[]) => void): void;
    removeListener(event: "stanza", handler: (stanza: Element) => void): void;
    removeListener(event: string, handler: (...args: unknown[]) => void): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    send(stanza: Element): Promise<void>;
  }

  export interface Element {
    name: string;
    is(name: string): boolean;
    attrs: Record<string, string>;
    getChildText(name: string): string | null;
    getChild(name: string, xmlns?: string): Element | undefined;
    getChildren(name: string): Element[];
    text(): string;
    children?: Array<Element | string>;
    toString(): string;
    // Builder methods from ltx Element class
    c(name: string, attrs?: Record<string, string>): Element;
    t(text: string): Element;
  }
}

declare module "@xmpp/debug" {
  export default function debug(client: unknown, enabled?: boolean): void;
}
