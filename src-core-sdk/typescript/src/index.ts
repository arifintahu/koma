import { isAbsolute } from 'node:path';
import { Transport } from './transport.js';
import { local, textId, validateInput, validatePolicy } from './validate.js';
import { DeliveryUnknownError, SdkError, TurnReplacedError, type ClientOptions, type CreateOptions, type ResumeOptions, type RequestOptions, type State, type Hello, type Input, type SubmitResult, type EnqueueResult, type InterruptResult, type ReplacementResult, type Event, type Turn, type Method } from './types.js';
export * from './types.js';

export class Client {
  private connections = new Set<Transport>();
  private closed = false;
  constructor(private readonly options: ClientOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new SdkError('invalid_input', 'timeoutMs must be positive');
  }
  private async connect(): Promise<Transport> {
    if (this.closed) throw new SdkError('closed', 'Client is closed');
    const t = new Transport(this.options); this.connections.add(t);
    try { await t.ready; return t; }
    catch (e) { await this.release(t); throw e; }
  }
  async release(t: Transport): Promise<void> { this.connections.delete(t); await t.close(); }
  async probe(): Promise<Hello> { const t = await this.connect(); try { return t.hello!; } finally { await this.release(t); } }
  async create(options: CreateOptions, request?: RequestOptions): Promise<Session> {
    textId(options.cwd);
    if (!isAbsolute(options.cwd)) throw new SdkError('invalid_input', 'cwd must be absolute on daemon host');
    const policy = options.policy ?? { plan: 'forbid', approval: 'reject' };
    local(() => validatePolicy(policy));
    if (policy.approval === 'default' && !options.external_approvals) throw new SdkError('invalid_input', 'approval default requires external_approvals');
    return this.bind('create', { ...options, policy }, request);
  }
  async resume(options: ResumeOptions, request?: RequestOptions): Promise<Session> {
    textId(options.session_id);
    if (options.policy) {
      local(() => validatePolicy(options.policy));
      if (options.policy.approval === 'default' && !options.external_approvals) throw new SdkError('invalid_input', 'approval default requires external_approvals');
    }
    return this.bind('resume', { ...options }, request);
  }
  private async bind(method: 'create' | 'resume', params: Record<string, unknown>, options?: RequestOptions): Promise<Session> {
    const t = await this.connect();
    try {
      const result = await t.request<{ state: State }>(method, params, options);
      return new Session(this, t, result.state);
    } catch (e) { await this.release(t); throw e; }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.connections].map(t => this.release(t)));
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

export class Session {
  constructor(private readonly client: Client, private readonly transport: Transport, private state: State) {}
  get sessionId(): string { return this.state.session_id; }
  get stderrTail(): string { return this.transport.diagnostics; }
  private async request<T>(method: Method, params: Record<string, unknown>, options?: RequestOptions): Promise<T> {
    try { return await this.transport.request<T>(method, params, options); }
    catch (e) { if (e instanceof DeliveryUnknownError) e.sessionId = this.sessionId; throw e; }
  }
  async getState(options?: RequestOptions): Promise<State> {
    const result = await this.request<{ state: State }>('state', {}, options);
    if (result.state.revision > this.state.revision) this.state = result.state;
    return this.state;
  }
  async *events(options?: Pick<RequestOptions, 'signal'>): AsyncGenerator<Event> {
    for await (const event of this.transport.events(options, () => this.getState(options))) {
      if (event.gap) {
        yield { type: 'event', event: 'state', seq: event.seq, state: await this.getState(), resynced: true }; continue;
      }
      if (event.event === 'state') {
        if (event.state.revision < this.state.revision || (event.state.revision === this.state.revision && !event.resynced)) continue;
        this.state = event.state;
      } else if (event.event === 'output_append') {
        if (event.revision <= this.state.revision) continue;
        if (event.revision !== this.state.revision + 1 || event.offset !== Buffer.byteLength(this.state.streaming ?? '')) {
          const state = await this.getState();
          yield { type: 'event', event: 'state', seq: event.seq, state, resynced: true }; continue;
        }
        this.state = { ...this.state, revision: event.revision, streaming: (this.state.streaming ?? '') + event.text };
      } else if (event.revision !== this.state.revision) continue;
      yield event;
    }
  }
  submit(input: Input, options?: RequestOptions): Promise<SubmitResult> { return this.request('submit', validateInput(input), options); }
  enqueue(input: Input, options?: RequestOptions): Promise<EnqueueResult> { return this.request('enqueue', validateInput(input), options); }
  interrupt(turnId: string, options?: RequestOptions): Promise<InterruptResult> { textId(turnId); return this.request('interrupt', { turn_id: turnId }, options); }
  interruptAndSubmit(turnId: string, input: Input, options?: RequestOptions): Promise<ReplacementResult> {
    textId(turnId); return this.request('interrupt_and_submit', { ...validateInput(input), turn_id: turnId }, options);
  }
  approve(callId: string, approve: boolean, options?: RequestOptions): Promise<{ approved: boolean }> {
    textId(callId);
    if (!this.state.external_approvals || typeof approve !== 'boolean') throw new SdkError('invalid_input', 'External tool approvals require opt-in and a boolean decision');
    return this.request('approve', { call_id: callId, approve }, options);
  }
  async waitTurn(turnId: string, options: RequestOptions = {}): Promise<Turn> {
    textId(turnId); const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      const state = await this.getState({ ...options, timeoutMs: Math.max(1, deadline - Date.now()) });
      if (state.turn?.id === turnId && state.turn.state !== 'running') return state.turn;
      if (state.turn && state.turn.id !== turnId) throw new TurnReplacedError(turnId, state.turn.id);
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
    }
    throw new SdkError('observation_unavailable', 'Terminal state not observed before timeout; work may continue');
  }
  async detach(options?: RequestOptions): Promise<void> {
    try { await this.request('detach', {}, options); } finally { await this.close(); }
  }
  async close(): Promise<void> { await this.client.release(this.transport); }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}
