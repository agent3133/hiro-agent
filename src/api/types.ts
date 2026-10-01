/**
 * The shapes the chat view, the settings, the command line and the agent share: agents, connections, turns, the
 * configuration document. Conversations are the core's (`core/sessions.ts` SessionSummary).
 */

export interface AgentSummary {
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
  /** The config's default agent, used when none is chosen. */
  default?: boolean;
  /** Where its file is: built in, the user's folder, the vault's .agents, or elsewhere. */
  source?: AgentSource;
}

/** One named LLM connection from the config: where a turn's notes would actually be sent. */
export interface ProfileSummary {
  name: string;
  provider?: string;
  model?: string | null;
  base_url?: string | null;
  default?: boolean;
}

/** `GET /agents/{name}`: everything the Agents tab edits, and what it may do with the agent. */
export interface AgentDetail extends AgentFields {
  name: string;
  /** The body below the frontmatter. */
  prompt: string;
  /** "bundled" ships with the runtime and is saved as the user's own copy; anything else is edited in place. */
  source: AgentSource;
  path: string;
  is_default: boolean;
  /** A user copy of a built-in agent, which can be dropped to get the built-in one back. */
  can_reset: boolean;
  /** A built-in agent (or a copy of one) is never deleted. */
  can_delete: boolean;
  /** What `{{ ... }}` can name in the prompt. */
  variables: string[];
}

export type AgentSource = "bundled" | "user" | "vault" | "other";

/** The frontmatter the Agents tab may set. null removes a key, so the runtime's default applies. */
export interface AgentFields {
  description: string | null;
  tools: string[];
  vault_scope: string[];
  llm_profile: string | null;
  max_iterations: number | null;
  model: string | null;
  temperature: number | null;
  enable_thinking: boolean | null;
}

/** `GET /extras/detect`, per program: what the configured value runs, and what is on PATH. */
export interface ProgramFound {
  configured: string;
  resolved: string | null;
  on_path: string | null;
}

/** `POST /extras/test`: whether a configured program runs, and what it said first. */
export interface ProgramCheck {
  ok: boolean;
  program: string;
  said: string[];
  error?: string;
}

/** One entry of `GET /tools`: what an agent can be given, and what the settings should say about it. */
export interface ToolInfo {
  name: string;
  /** How the settings show it, when not by its name: an MCP tool as "server: tool" (#87). */
  label?: string;
  group: string;
  description: string;
  destructive: boolean;
  /** Could reach notes outside a folder restriction, so it is withheld from a restricted agent. */
  ignores_scope: boolean;
  leaves_machine: boolean;
  runs_programs: boolean;
  /** The Features switch that is off for this tool, by name: the model is not offered it until it is on (#145). */
  off_in?: string;
}

/** A save or create the runtime refused, field by field, with nothing written. */
export type AgentWrite = { ok: true; agent: AgentDetail } | { ok: false; error: string; fields: ConfigFieldError[] };

/** `GET /config`: enough for a settings UI to render every field without knowing this project. */
export interface ConfigDocument {
  path: string;
  exists: boolean;
  values: Record<string, unknown>;
  /** Dotted paths of the fields that hold a secret. */
  secrets: Record<string, boolean>;
  schema: JsonSchema;
}

/** The subset of JSON Schema that Pydantic emits for `AppConfig`. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: JsonSchema | boolean;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: unknown[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  default?: unknown;
  description?: string;
  title?: string;
}

export interface ConfigFieldError {
  path: string;
  message: string;
}

export interface ConfigWriteResult {
  ok: boolean;
  changed: string[];
  error?: string;
  fields: ConfigFieldError[];
}

/** What the chat header and the command line list: the agents and connections, and the default connection. */
export interface ReadyInfo {
  version: string;
  vault: string;
  agents: AgentSummary[];
  profiles: ProfileSummary[];
  defaultProfile: string;
}

export interface ToolCall {
  callId: string;
  name: string;
  input?: unknown;
}

/** What a turn left in the vault, when it left anything. `turn` addresses the runtime's journal. */
export interface TurnChanges {
  turn: string;
  files: string[];
}

/** One journalled turn, as the runtime lists it. */
export interface TurnSummary {
  id: string;
  prompt: string;
  started: string;
  files: string[];
  undone: boolean;
}

/** The outcome of taking a turn back. A file edited since the agent wrote it is refused, never overwritten. */
export interface UndoResult {
  ok: boolean;
  undone: boolean;
  restored: string[];
  refused: { path: string; reason: string }[];
}

/** What a turn does while it runs. Every turn ends in exactly one of onDone or onError. */
export interface TurnHandlers {
  onToken(text: string): void;
  onThinking(text: string): void;
  onToolCall(call: ToolCall): void;
  onToolResult(callId: string, result: string, isError: boolean): void;
  onConfirmRequest(callId: string, name: string, input: unknown): void;
  /**
   * The conversation was just summarised (#154): *exchanges* went into *summary*, *before* this answer was asked
   * for (the history no longer fitted) or after it.
   */
  onSummary?(exchanges: number, summary: string, when: "before" | "after"): void;
  /** Older tool results of this answer were set aside to stay inside the context window (#154); *total* so far. */
  onSetAside?(total: number): void;
  /**
   * How full the context window is after the answer (#151, #154): the tokens the conversation takes now — what the
   * next message carries — of the window, whether estimated, and the most the answer took along the way.
   */
  onContext?(tokens: number, window: number, estimated: boolean, peak?: number): void;
  onDone(reply: string, cancelled: boolean, usage: Record<string, unknown>,
         changed: TurnChanges | null, compacted: number): void;
  onError(message: string, recoverable: boolean): void;
}
