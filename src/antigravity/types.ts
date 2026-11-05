/**
 * Antigravity CLI Integration Types
 */

export interface AgyInitData {
  cwd?: string;
  tools?: string[];
  [key: string]: unknown;
}

export interface AgyInitEvent {
  event: 'init';
  conversation_id: string;
  init?: AgyInitData;
}

export interface AgyStepUpdateData {
  conversation_id: string;
  step_index: number;
  state: 'PENDING' | 'ACTIVE' | 'DONE' | string;
  step_type: 'user_input' | 'agent_response' | 'tool_call' | 'tool_result' | string;
  text_delta?: string;
  delta?: string;
  content?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgyStepUpdateEvent {
  event: 'step_update';
  step_update: AgyStepUpdateData;
}

export interface AgyErrorEvent {
  event: 'error';
  error?: string | { message?: string; [key: string]: unknown };
  message?: string;
  [key: string]: unknown;
}

export interface AgyResultData {
  conversation_id: string;
  status: 'SUCCESS' | 'ERROR' | string;
  response: string;
  error_details?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgyResultEvent {
  event: 'result';
  result: AgyResultData;
}

export type AgyOutputEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent | AgyErrorEvent;

export interface AgyUserMessageInput {
  event: 'user';
  message: {
    content: string;
    [key: string]: unknown;
  };
}

export interface AntigravityConfig {
  /** Path to agy executable */
  agyPath?: string;
  /** Working directory for agy */
  cwd?: string;
  /** Automatically skip permission prompts (--dangerously-skip-permissions) */
  dangerouslySkipPermissions?: boolean;
  /** Maximum idle time before child process is terminated (ms). Default: 15 minutes */
  idleTimeoutMs?: number;
  /** Maximum time allowed for a single turn (ms). Default: 10 minutes */
  turnTimeoutMs?: number;
  /** Additional CLI flags to pass to agy */
  extraArgs?: string[];
  /** Extra environment variables for the agy child process (e.g. HOME to select a restricted profile) */
  env?: Record<string, string>;
  /**
   * Replace the child's environment entirely with this map (plus FORCE_COLOR), instead of inheriting
   * process.env. Used to run the tag-correction agy without secrets (PIXIV_REFRESH_TOKEN 等)。
   * When set, `env` is ignored.
   */
  replaceEnv?: Record<string, string>;
  /** Debug logging */
  debug?: boolean;
}

export interface AntigravityBotConfig {
  /** QQ Bot AppID */
  appId?: string;
  /** QQ Bot AppSecret */
  appSecret?: string;
  /** Antigravity CLI settings */
  antigravity?: AntigravityConfig;
  /** Whether @mention is required in group chats (default: true) */
  requireMention?: boolean;
  /** Enable streaming response for private chats (default: true) */
  streaming?: boolean;
  /** Max characters per message chunk (default: 4000) */
  textChunkLimit?: number;
  /** Throttle interval in ms for stream updates (default: 600ms) */
  streamThrottleMs?: number;
  /** Group session scope: 'user' or 'group' */
  groupSessionScope?: 'user' | 'group';
  /** System prompt */
  systemPrompt?: string;
  /** Debug logging */
  debug?: boolean;
}
