import { describe, expect, it } from 'vitest';
// Setup scripts run directly in Node; exercise their real origin boundary.
// @ts-expect-error JavaScript deployment module has no declaration file.
import { parsePublicRuntime } from '../scripts/public-runtime-config.mjs';

describe('fixed public runtime configuration', () => {
  it('accepts an exact assigned HTTPS device address on the isolated fixed-entry port', () => {
    expect(parsePublicRuntime({ provider: 'tailscale', origin: 'https://project-task-map.tailabc.ts.net', port: 3002 })).toEqual({
      provider: 'tailscale', origin: 'https://project-task-map.tailabc.ts.net', port: 3002,
    });
  });
  it('rejects credential-bearing URLs, lookalike domains, paths and accidental local-port replacement', () => {
    for (const origin of ['http://project-task-map.tailabc.ts.net', 'https://user:password@project-task-map.tailabc.ts.net',
      'https://project-task-map.tailabc.ts.net.evil.example', 'https://project-task-map.tailabc.ts.net/mcp',
      'https://project-task-map.tailabc.ts.net?key=value', 'https://project-task-map.tailabc.ts.net#fragment',
      'https://project-task-map.tailabc.ts.net:8443', 'https://127.0.0.1', 'https://project-task-map.tailabc.ts.net/']) {
      expect(() => parsePublicRuntime({ provider: 'tailscale', origin, port: 3002 })).toThrow();
    }
    expect(() => parsePublicRuntime({ provider: 'tailscale', origin: 'https://project-task-map.tailabc.ts.net', port: 3000 })).toThrow();
    expect(() => parsePublicRuntime({ provider: 'unknown', origin: 'https://project-task-map.tailabc.ts.net', port: 3002 })).toThrow();
  });
});
