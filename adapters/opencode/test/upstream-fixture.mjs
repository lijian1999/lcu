#!/usr/bin/env node
// Minimal fake LCU upstream for the OpenCode relay tests: a stdio MCP server that lists the
// four real tools (the two model tools plus the host-only ones the relay must hide), records
// every call to LCU_OPENCODE_FIXTURE_LOG, and switches behavior by environment so tests can
// hang calls, fail turn ends, or raise approval elicitations. Modeled on the shared
// adapters/test/mcp-fixture.mjs but owned by the opencode tests; add new switches here.
// Only the recorded log and the tool results leave this process; nothing writes to HOME.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const record = value => {
  if (process.env.LCU_OPENCODE_FIXTURE_LOG) {
    appendFileSync(process.env.LCU_OPENCODE_FIXTURE_LOG, `${JSON.stringify(value)}\n`);
  }
};

const tools = [
  {
    name: 'js', description: 'Fixture JS description.', inputSchema: {
      type: 'object', properties: { code: { type: 'string' }, timeout_ms: { type: 'integer' } },
      required: ['code'], additionalProperties: false,
    },
  },
  {
    name: 'js_reset', description: 'Fixture reset description.', inputSchema: {
      type: 'object', properties: {}, additionalProperties: false,
    },
  },
  { name: 'js_add_node_module_dir', description: 'Host-only.', inputSchema: { type: 'object' } },
  {
    name: 'turn_ended', description: 'Host-only.', inputSchema: {
      type: 'object',
      properties: { hook_event_name: { type: 'string' }, session_id: { type: 'string' }, turn_id: { type: 'string' } },
      required: ['hook_event_name', 'session_id', 'turn_id'], additionalProperties: false,
    },
  },
];

const server = new Server({ name: 'opencode-upstream-fixture', version: '1' }, {
  capabilities: { tools: {} },
  instructions: 'Fixture CUA initialization guide.',
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// `timeout-N-session` reproduces the original host's turn-ended wait limit for the first N calls
// of that session; later turn ends of the same session succeed.
const cleanupTimeouts = new Map();

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args, _meta } = request.params;
  record({ name, args, meta: _meta });
  if (name === 'turn_ended') {
    const timeoutSession = /^timeout-(\d+)-session$/.exec(args?.session_id ?? '');
    if (timeoutSession) {
      const seen = cleanupTimeouts.get(args.session_id) ?? 0;
      cleanupTimeouts.set(args.session_id, seen + 1);
      if (seen < Number(timeoutSession[1])) {
        return { isError: true, content: [{ type: 'text', text: 'turn-ended handlers timed out' }] };
      }
    }
    if (args?.session_id === 'fail-session') {
      return { isError: true, content: [{ type: 'text', text: 'cleanup failed' }] };
    }
    if (args?.session_id === 'fail-once-session' && cleanupTimeouts.get('fail-once-started') === undefined) {
      cleanupTimeouts.set('fail-once-started', 1);
      return { isError: true, content: [{ type: 'text', text: 'cleanup failed once' }] };
    }
    return { content: [{ type: 'text', text: `ended ${args?.session_id}` }] };
  }
  if (name === 'js_reset') return { content: [{ type: 'text', text: 'reset' }] };
  if (name === 'js_add_node_module_dir') return { content: [{ type: 'text', text: 'module dir registered' }] };
  // `sleep-N`: hang the call for N milliseconds so tests can observe in-flight sessions.
  if (/^sleep-\d+$/.test(args?.code ?? '')) {
    await new Promise(resolve => setTimeout(resolve, Number(args.code.slice(6))));
    return { content: [{ type: 'text', text: args.code }] };
  }
  // `approval`: a native-app approval the relay policy should accept.
  // `approval-host`: an approval for an app that hosts the agent; the client's guard declines it.
  if (args?.code === 'approval' || args?.code === 'approval-host') {
    const decision = await server.elicitInput({
      mode: 'form',
      message: 'Allow Computer Use to use "Fixture App"?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        connector_id: 'computer-use',
        riskLevel: 'low',
        tool_name: 'get_app_state',
        tool_params: { app: args.code === 'approval-host' ? 'com.apple.Terminal' : 'dev.lcu.fixture.generated' },
        persist: ['session', 'always'],
      },
    });
    return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
  }
  if (args?.code === 'throw') throw new Error('fixture js failure');
  return { content: [{ type: 'text', text: String(args?.code ?? '') }] };
});

record({ type: 'fixture-start', pid: process.pid });
process.stdin.on('end', () => process.exit(0));
await server.connect(new StdioServerTransport());