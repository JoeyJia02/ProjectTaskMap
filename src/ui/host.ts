import { App as McpApp } from '@modelcontextprotocol/ext-apps';
import type { HostAdapter, HostContext, ProjectState, Delta } from './types';

interface OpenAiHost {
  toolOutput?: unknown;
  toolResponseMetadata?: Record<string, unknown>;
  sendFollowUpMessage?: (options: { prompt: string }) => Promise<unknown>;
}
declare global { interface Window { openai?: OpenAiHost } }

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
export function parseToolResult(output: unknown, suppliedMeta?: unknown): HostContext {
  const envelope = record(output);
  const structured = record(envelope.structuredContent || envelope);
  const supplied = record(suppliedMeta);
  const nested = record(supplied.call_tool_result || supplied.mcp_tool_result);
  const meta = record(nested._meta || suppliedMeta || envelope._meta);
  const state = record(structured.state);
  const binding = record(structured.binding);
  return {
    ...(typeof state.projectId === 'string' && Array.isArray(state.nodes) && typeof state.version === 'number' ? { state: state as unknown as ProjectState } : {}),
    ...(typeof binding.bindingKey === 'string' ? { bindingKey: binding.bindingKey } : {}),
    ...(typeof meta.projectToken === 'string' ? { projectToken: meta.projectToken } : {}),
    ...(typeof meta.apiBaseUrl === 'string' ? { apiBaseUrl: meta.apiBaseUrl } : {}),
    ...(meta.pendingDelta && typeof meta.pendingDelta === 'object' ? { pendingDelta: meta.pendingDelta as Delta } : {}),
  };
}

export function createHostAdapter(): HostAdapter {
  let app: McpApp | null = null;
  let standardConnected = false;
  let listener: EventListener | null = null;
  return {
    async connect(onContext) {
      if (window.openai) {
        onContext(parseToolResult(window.openai.toolOutput, window.openai.toolResponseMetadata));
        listener = event => {
          const detail = record((event as CustomEvent).detail);
          const globals = record(detail.globals);
          onContext(parseToolResult(globals.toolOutput || window.openai?.toolOutput, globals.toolResponseMetadata || window.openai?.toolResponseMetadata));
        };
        window.addEventListener('openai:set_globals', listener);
      }
      if (window.parent === window) return;
      app = new McpApp({ name: 'Project Task Map', version: '0.1.0' }, {}, { autoResize: true });
      app.ontoolresult = result => onContext(parseToolResult(result));
      await app.connect(undefined, { timeout: 6000 });
      standardConnected = true;
    },
    async sendRefresh(prompt) {
      if (app && standardConnected && app.getHostCapabilities()?.message?.text) {
        const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: prompt }] });
        return !result.isError;
      }
      if (window.openai?.sendFollowUpMessage) { await window.openai.sendFollowUpMessage({ prompt }); return true; }
      return false;
    },
    close() {
      if (listener) window.removeEventListener('openai:set_globals', listener);
      if (app) void app.close();
      app = null; standardConnected = false;
    },
  };
}
