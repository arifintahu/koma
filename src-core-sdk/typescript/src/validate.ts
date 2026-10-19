import { isAbsolute } from 'node:path';
import { SdkError, type ConfigureOptions, type Method, type ModelRoleName, type Policy, type Input } from './types.js';
export function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SdkError('protocol', 'Expected object');
}
export function string(value: unknown, nonempty = false): asserts value is string {
  if (typeof value !== 'string' || (nonempty && !value.length)) throw new SdkError('protocol', 'Expected string');
}
function nullableString(x: unknown): void { if (x !== null) string(x); }
function bool(x: unknown): void { if (typeof x !== 'boolean') throw new SdkError('protocol', 'Expected boolean'); }
function member(x: unknown, allowed: readonly unknown[]): void { if (!allowed.includes(x)) throw new SdkError('protocol', `Unexpected enum: ${String(x)}`); }
export function validatePolicy(x: unknown): asserts x is Policy { object(x); member(x.plan, ['allow', 'forbid']); member(x.approval, ['default', 'reject']); }
export function validateState(x: unknown): void {
  object(x);
  if (!Number.isSafeInteger(x.revision) || (x.revision as number) < 1) throw new SdkError('protocol', 'Invalid state revision');
  bool(x.external_approvals);
  if (x.pending_approval !== null) { object(x.pending_approval); string(x.pending_approval.call_id, true); nullableString(x.pending_approval.reason); }
  if (x.gate !== null) { object(x.gate); member(x.gate.kind, ['tool','plan','mission','unknown']); nullableString(x.gate.reason); bool(x.gate.supported); }
  string(x.session_id, true); string(x.cwd, true); string(x.model_id); validatePolicy(x.policy);
  if (x.turn !== null) { object(x.turn); string(x.turn.id, true); member(x.turn.state, ['running', 'finished', 'interrupted', 'failed']); nullableString(x.turn.error); }
  bool(x.working); bool(x.awaiting_approval); nullableString(x.approval_reason); nullableString(x.streaming);
  if (!Number.isInteger(x.pending_count) || (x.pending_count as number) < 0 || (x.pending_count as number) > 5) throw new SdkError('protocol', 'Invalid pending_count');
  if (!Array.isArray(x.messages)) throw new SdkError('protocol', 'Expected messages array');
  for (const m of x.messages) { object(m); member(m.role, ['system', 'user', 'assistant', 'tool']); string(m.content); }
}
export function validateHello(x: Record<string, unknown>, required: readonly Method[]): void {
  if (x.type !== 'hello' || x.protocol !== 1) throw new SdkError('incompatible_protocol', 'First frame must be a protocol 1 hello');
  object(x.binary); string(x.binary.path, true); string(x.binary.version, true);
  if (!Array.isArray(x.diagnostics) || !x.diagnostics.every(d => typeof d === 'string')) throw new SdkError('protocol', 'Invalid diagnostics');
  if (!Array.isArray(x.capabilities) || !x.capabilities.every(c => typeof c === 'string') || new Set(x.capabilities).size !== x.capabilities.length) throw new SdkError('protocol', 'Invalid capabilities');
  const missing = required.filter(m => !(x.capabilities as unknown[]).includes(m));
  if (missing.length) throw new SdkError('incompatible_capabilities', `Missing required capabilities: ${missing.join(', ')}`);
}
export function validateEvent(x: Record<string, unknown>): void {
  if (x.event === 'state') { validateState(x.state); bool(x.resynced); return; }
  if (!Number.isSafeInteger(x.revision) || (x.revision as number) < 1) throw new SdkError('protocol', 'Invalid event revision');
  if (x.event === 'output_append') {
    if (!Number.isSafeInteger(x.offset) || (x.offset as number) < 0) throw new SdkError('protocol', 'Invalid append offset');
    string(x.text, true);
  } else if (x.turn !== null) { object(x.turn); string(x.turn.id, true); member(x.turn.state, ['running','finished','interrupted','failed']); nullableString(x.turn.error); }
}
const ROLES: readonly ModelRoleName[] = ['main', 'awareness', 'safeguard', 'compactor', 'planner'];
export function configureParams(options: ConfigureOptions): Record<string, unknown> {
  return local(() => {
    object(options);
    const params: Record<string, unknown> = {};
    if (options.providers !== undefined) {
      if (!Array.isArray(options.providers) || options.providers.length > 32) throw new Error('providers must be a list of at most 32');
      const seen = new Set<string>();
      params.providers = options.providers.map(provider => {
        object(provider);
        string(provider.name, true);
        string(provider.endpoint, true);
        const name = provider.name.trim();
        if (!name) throw new Error('provider name is empty');
        if (seen.has(name)) throw new Error(`duplicate provider name '${name}'`);
        seen.add(name);
        if (provider.api_type !== 'openai' && provider.api_type !== 'anthropic') throw new Error("api_type must be 'openai' or 'anthropic'");
        const entry: Record<string, unknown> = { name, endpoint: provider.endpoint.trim(), api_type: provider.api_type };
        if (provider.api_key !== undefined && provider.api_key !== null) {
          if (typeof provider.api_key !== 'string' || !provider.api_key.trim()) throw new Error('api_key must be non-empty when provided');
          entry.api_key = provider.api_key.trim();
        }
        return entry;
      });
    }
    if (options.models !== undefined) {
      object(options.models);
      const models: Record<string, unknown> = {};
      for (const [role, spec] of Object.entries(options.models)) {
        if (!ROLES.includes(role as ModelRoleName)) throw new Error(`unknown model role '${role}'`);
        if (spec === undefined) continue;
        object(spec);
        string(spec.provider, true);
        string(spec.model_id, true);
        const provider = spec.provider.trim();
        const modelId = spec.model_id.trim();
        if (!provider || !modelId) throw new Error('model provider and model_id are required');
        const assignment: Record<string, unknown> = { provider, model_id: modelId };
        if (spec.route !== undefined) { string(spec.route); assignment.route = spec.route; }
        models[role] = assignment;
      }
      params.models = models;
    }
    const listed = params.providers as unknown[] | undefined;
    const assigned = params.models as Record<string, unknown> | undefined;
    if ((!listed || listed.length === 0) && (!assigned || Object.keys(assigned).length === 0)) throw new Error('providers or models required');
    return params;
  });
}
function validateConfigure(result: Record<string, unknown>): void {
  if (!Array.isArray(result.providers) || !result.models || typeof result.models !== 'object' || Array.isArray(result.models)) throw new SdkError('protocol', 'Invalid configure result');
  for (const provider of result.providers) {
    object(provider); string(provider.name, true); string(provider.uuid, true);
    if ('api_key' in provider || 'key' in provider) throw new SdkError('protocol', 'Configure result must not include a key');
  }
  for (const [role, spec] of Object.entries(result.models)) {
    if (!ROLES.includes(role as ModelRoleName)) throw new SdkError('protocol', 'Invalid configure role');
    object(spec); string(spec.uuid, true); string(spec.model_id, true); string(spec.provider, true);
    if ('api_key' in spec || 'key' in spec) throw new SdkError('protocol', 'Configure result must not include a key');
  }
}
export function validateResult(method: Method, result: unknown, params: Record<string, unknown>): void {
  object(result);
  if (method === 'configure') { validateConfigure(result); return; }
  if (method === 'create' || method === 'resume' || method === 'state') { validateState(result.state); return; }
  if (method === 'detach') { if (result.detached !== true) throw new SdkError('protocol', 'Invalid detach result'); return; }
  if (method === 'approve') { bool(result.approved); if (result.approved !== params.approve) throw new SdkError('protocol', 'Approval decision mismatch'); return; }
  const success = method === 'enqueue' ? 'queued' : method === 'interrupt' ? 'interrupted' : 'started';
  member(result.disposition, [success, 'rejected']); nullableString(result.turn_id);
  if (result.disposition === 'rejected') { object(result.reason); string(result.reason.code, true); string(result.reason.message); }
  else {
    if (result.reason !== null) throw new SdkError('protocol', 'Success reason must be null');
    if (success === 'queued') { if (result.turn_id !== null) throw new SdkError('protocol', 'Queued input cannot reserve a turn'); }
    else string(result.turn_id, true);
  }
  if (method === 'interrupt' && result.turn_id !== params.turn_id) throw new SdkError('protocol', 'Interrupt target mismatch');
  if (method === 'interrupt_and_submit') {
    nullableString(result.interrupted_turn_id);
    if (result.interrupted_turn_id !== null && result.interrupted_turn_id !== params.turn_id) throw new SdkError('protocol', 'Replacement interruption target mismatch');
    if (result.disposition === 'started' && (result.interrupted_turn_id !== params.turn_id || result.turn_id === params.turn_id)) throw new SdkError('protocol', 'Replacement must start a new turn after interrupting target');
  }
}
export function local<T>(check: () => T): T {
  try { return check(); } catch (e) { throw new SdkError('invalid_input', e instanceof Error ? e.message : String(e)); }
}
export function textId(x: unknown): asserts x is string { local(() => string(x, true)); }
export function validateInput(x: Input): Record<string, unknown> {
  return local(() => {
    object(x); string(x.text, true);
    if (!x.text.trim() || Buffer.byteLength(x.text) > 2 * 1024 * 1024) throw new Error('Prompt must be nonblank and at most 2 MiB UTF-8');
    const out: Record<string, unknown> = { text: x.text };
    if (x.attachments !== undefined) {
      if (!Array.isArray(x.attachments) || x.attachments.length > 16) throw new Error('At most 16 attachments');
      let total = 0;
      out.attachments = x.attachments.map(a => {
        object(a);
        if (a.kind === 'pasted_text') {
          string(a.text); const n = Buffer.byteLength(a.text); total += n;
          if (n > 2 * 1024 * 1024) throw new Error('Pasted text exceeds 2 MiB UTF-8');
          if (a.name !== undefined && a.name !== null) string(a.name);
          return { kind: a.kind, text: a.text, ...(a.name !== undefined ? { name: a.name } : {}) };
        }
        if (a.kind === 'image_file') {
          string(a.path, true); if (!isAbsolute(a.path)) throw new Error('Image path must be absolute on daemon host');
          return { kind: a.kind, path: a.path };
        }
        throw new Error('Unsupported attachment kind');
      });
      if (total > 32 * 1024 * 1024) throw new Error('Pasted attachments exceed 32 MiB');
    }
    return out;
  });
}
