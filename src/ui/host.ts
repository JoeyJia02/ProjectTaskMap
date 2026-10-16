import { App as McpApp } from '@modelcontextprotocol/ext-apps';
import { observeContentSize } from './resize';
import type { HostAdapter, HostContext, ProjectState, Delta } from './types';

interface OpenAiHost {
  toolOutput?: unknown;
  toolResponseMetadata?: Record<string, unknown>;
  sendFollowUpMessage?: (options: { prompt: string }) => Promise<unknown>;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}
declare global { interface Window { openai?: OpenAiHost } }

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
export function parseToolResult(output: unknown, suppliedMeta?: unknown): HostContext {
  const envelope = record(output);
  const structured = record(envelope.structuredContent || envelope);
  const supplied = record(suppliedMeta);
  // Partial metadata must not hide valid fields from a lower-priority source.
  const metadata = [record(record(supplied.call_tool_result)._meta), record(record(supplied.mcp_tool_result)._meta), supplied, record(envelope._meta)];
  const meta = {
    projectToken: metadata.find(value => typeof value.projectToken === 'string' && value.projectToken.trim().length > 0)?.projectToken,
    apiBaseUrl: metadata.find(value => typeof value.apiBaseUrl === 'string' && value.apiBaseUrl.trim().length > 0)?.apiBaseUrl,
    pendingDelta: metadata.find(value => value.pendingDelta && typeof value.pendingDelta === 'object' && !Array.isArray(value.pendingDelta))?.pendingDelta,
  };
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
  let stopResize: (() => void) | undefined;
  let closed = false;
  return {
    canCallTools: () => !closed && (typeof window.openai?.callTool === 'function' || standardConnected && Boolean(app?.getHostCapabilities()?.serverTools)),
    async callTool(name, args) {
      if (closed) throw new Error('地图连接已关闭，请重新打开。');
      if (typeof window.openai?.callTool === 'function') return window.openai.callTool(name, args);
      if (app && standardConnected) return app.callServerTool({ name, arguments: args });
      throw new Error('宿主尚未提供地图工具连接，请重新打开地图。');
    },
    async connect(onContext) {
      const legacy = window.openai;
      if (legacy && (parseToolResult(legacy.toolOutput, legacy.toolResponseMetadata).state || typeof legacy.sendFollowUpMessage === 'function')) {
        onContext(parseToolResult(legacy.toolOutput, legacy.toolResponseMetadata));
        listener = event => {
          const detail = record((event as CustomEvent).detail);
          const globals = record(detail.globals);
          onContext(parseToolResult(globals.toolOutput || window.openai?.toolOutput, globals.toolResponseMetadata || window.openai?.toolResponseMetadata));
        };
        window.addEventListener('openai:set_globals', listener);
        // The injected bridge already owns this widget's lifecycle. Starting a
        // second ui/initialize can re-resolve its cached resource in the host.
        return;
      }
      if (window.parent === window) return;
      app = new McpApp({ name: 'Project Task Map', version: '0.1.0' }, {}, { autoResize: false });
      const connectingApp = app;
      app.ontoolresult = result => onContext(parseToolResult(result));
      await app.connect(undefined, { timeout: 6000 });
      if (closed) { await connectingApp.close(); return; }
      standardConnected = true;
      const root = document.getElementById('root');
      if (root) stopResize = observeContentSize(root, size => connectingApp.sendSizeChanged(size));
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
      closed = true;
      stopResize?.();
      if (listener) window.removeEventListener('openai:set_globals', listener);
      if (app) void app.close();
      app = null; standardConnected = false;
    },
  };
}
