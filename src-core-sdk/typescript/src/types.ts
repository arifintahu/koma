export const METHODS = ['create', 'resume', 'state', 'submit', 'enqueue', 'interrupt', 'interrupt_and_submit', 'approve', 'configure', 'detach'] as const;
export type Method = typeof METHODS[number];
export interface Policy { plan: 'allow' | 'forbid'; approval: 'default' | 'reject' }
export type Attachment = { kind: 'image_file'; path: string } | { kind: 'pasted_text'; text: string; name?: string | null };
export interface Input { text: string; attachments?: Attachment[] }
export interface CreateOptions { cwd: string; model_id?: string; policy?: Policy; external_approvals?: boolean }
export type ModelRoleName = 'main' | 'awareness' | 'safeguard' | 'compactor' | 'planner';
export interface ProviderInput { name: string; endpoint: string; api_type: 'openai' | 'anthropic'; api_key?: string }
export interface ModelAssignment { provider: string; model_id: string; route?: string }
export interface ConfigureOptions { providers?: ProviderInput[]; models?: Partial<Record<ModelRoleName, ModelAssignment>> }
export interface ConfigureResult {
  providers: { name: string; uuid: string }[];
  models: Partial<Record<ModelRoleName, { uuid: string; model_id: string; provider: string }>>;
}
export interface ResumeOptions { session_id: string; policy?: Policy; external_approvals?: boolean }
export type Turn = { id: string; state: 'running'; error: string | null } | { id: string; state: 'finished' | 'interrupted' | 'failed'; error: string | null };
export interface State {
  revision: number; external_approvals: boolean; pending_approval: { call_id: string; reason: string | null } | null; gate: { kind: "tool" | "plan" | "mission" | "unknown"; reason: string | null; supported: boolean } | null;
  session_id: string; cwd: string; model_id: string; policy: Policy; turn: Turn | null;
  working: boolean; awaiting_approval: boolean; approval_reason: string | null;
  pending_count: number; messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[];
  streaming: string | null;
}
export interface Reason { code: string; message: string }
export type Rejected = { disposition: 'rejected'; turn_id: string | null; reason: Reason };
export type SubmitResult = { disposition: 'started'; turn_id: string; reason: null } | Rejected;
export type EnqueueResult = { disposition: 'queued'; turn_id: null; reason: null } | Rejected;
export type InterruptResult = { disposition: 'interrupted'; turn_id: string; reason: null } | Rejected;
export type ReplacementResult = SubmitResult & { interrupted_turn_id: string | null };
export type StateEvent = { type: 'event'; event: 'state'; seq: number; state: State; resynced: boolean };
export type OutputAppendEvent = { type: 'event'; event: 'output_append'; seq: number; revision: number; offset: number; text: string };
export type TurnEvent = { type: 'event'; event: 'turn'; seq: number; revision: number; turn: Turn | null };
export type Event = StateEvent | OutputAppendEvent | TurnEvent;
export interface Hello { type: 'hello'; protocol: 1; binary: { path: string; version: string }; diagnostics: string[]; capabilities: string[] }
export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface ClientOptions {
  /** Absolute path to the Koma executable. Always launched as [executable, 'sdk', 'serve'], never through a shell. */
  executable?: string;
  /** Test/custom adapter argument override; default sdk serve. Never interpreted by a shell. */
  adapterArgs?: readonly string[];
  /** Required at handshake; defaults to every v1 method. */
  requiredCapabilities?: readonly Method[];
  timeoutMs?: number;
  /** Inherited environment plus these overrides. Useful for isolated configuration. */
  env?: NodeJS.ProcessEnv;
}
export type Delivery = 'not_sent' | 'unknown';
export class SdkError extends Error {
  constructor(public readonly code: string, message: string, public readonly delivery: Delivery = 'not_sent', public readonly requestId?: string, public readonly method?: Method) {
    super(message); this.name = 'SdkError';
  }
}
/** A dispatched mutation may have taken effect. Never automatically retry. */
export class DeliveryUnknownError extends SdkError {
  sessionId?: string;
  turnId?: string;
  constructor(code: string, message: string, requestId: string, method: Method) {
    super(code, message, 'unknown', requestId, method); this.name = 'DeliveryUnknownError';
  }
}
export class TurnReplacedError extends SdkError {
  constructor(public readonly turnId: string, public readonly observedTurnId: string) {
    super('turn_replaced', `Turn ${turnId} was replaced by ${observedTurnId}; its final outcome is not available`); this.name = 'TurnReplacedError';
  }
}
