import { describe, expect, it } from 'vitest';
import { parseToolResult } from '../src/ui/host';

const state = { projectId: 'synthetic-metadata-project', nodes: [], version: 0 };
const fallback = { projectToken: 'synthetic-envelope-token', apiBaseUrl: 'https://envelope.example.invalid' };
const envelope = { structuredContent: { state }, _meta: fallback };

describe('host metadata read recovery', () => {
  it.each([
    {},
    { decoration: true },
    { projectToken: null, apiBaseUrl: undefined },
    { projectToken: '', apiBaseUrl: 42 },
  ])('recovers envelope connection fields when supplied metadata is incomplete: %j', supplied => {
    const result = parseToolResult(envelope, supplied);
    expect(result.state).toBe(state);
    expect(result.projectToken).toBe(fallback.projectToken);
    expect(result.apiBaseUrl).toBe(fallback.apiBaseUrl);
  });

  it('keeps a canonical token while recovering its missing URL from the envelope', () => {
    const result = parseToolResult(envelope, { call_tool_result: { _meta: { projectToken: 'synthetic-nested-token' } } });
    expect(result.projectToken).toBe('synthetic-nested-token');
    expect(result.apiBaseUrl).toBe(fallback.apiBaseUrl);
  });

  it('keeps a legacy URL while recovering its missing token from the envelope', () => {
    const result = parseToolResult(envelope, { apiBaseUrl: 'https://legacy.example.invalid' });
    expect(result.projectToken).toBe(fallback.projectToken);
    expect(result.apiBaseUrl).toBe('https://legacy.example.invalid');
  });

  it('preserves canonical metadata priority over legacy and envelope fields', () => {
    const result = parseToolResult(envelope, {
      ...fallback,
      call_tool_result: { _meta: { projectToken: 'synthetic-nested-token', apiBaseUrl: 'https://nested.example.invalid' } },
    });
    expect(result.projectToken).toBe('synthetic-nested-token');
    expect(result.apiBaseUrl).toBe('https://nested.example.invalid');
  });

  it('keeps the mcp_tool_result canonical wrapper compatible', () => {
    const result = parseToolResult(envelope, { mcp_tool_result: { _meta: { projectToken: 'synthetic-mcp-token' } } });
    expect(result.projectToken).toBe('synthetic-mcp-token');
    expect(result.apiBaseUrl).toBe(fallback.apiBaseUrl);
  });

  it('does not infer credentials from public structured content', () => {
    const result = parseToolResult({ structuredContent: { state, ...fallback } }, {});
    expect(result.state).toBe(state);
    expect(result.projectToken).toBeUndefined();
    expect(result.apiBaseUrl).toBeUndefined();
  });

  it('keeps a pending delta available when higher priority metadata only supplies a token', () => {
    const pendingDelta = { projectId: state.projectId, idempotencyKey: 'synthetic-pending' };
    const result = parseToolResult({ ...envelope, _meta: { ...fallback, pendingDelta } }, { projectToken: 'synthetic-legacy-token' });
    expect(result.pendingDelta).toBe(pendingDelta);
    expect(result.projectToken).toBe('synthetic-legacy-token');
  });
});
