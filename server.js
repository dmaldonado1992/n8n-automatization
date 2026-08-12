import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const app = express();
app.use(express.json());

const N8N_URL = (process.env.N8N_URL || '').replace(/\/$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY || '';

async function n8n(path, options = {}) {
  if (!N8N_URL || !N8N_API_KEY) throw new Error('N8N_URL and N8N_API_KEY must be configured');
  const response = await fetch(`${N8N_URL}/api/v1${path}`, {
    ...options,
    headers: {
      'X-N8N-API-KEY': N8N_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`n8n ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function createServer() {
  const server = new McpServer({ name: 'n8n-mcp', version: '1.0.0' });

  server.tool('list_workflows', 'List workflows from n8n', {}, async () => {
    const data = await n8n('/workflows');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('get_workflow', 'Get an n8n workflow by ID', { id: z.string() }, async ({ id }) => {
    const data = await n8n(`/workflows/${encodeURIComponent(id)}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('create_workflow', 'Create an n8n workflow', { workflow: z.record(z.any()) }, async ({ workflow }) => {
    const data = await n8n('/workflows', { method: 'POST', body: JSON.stringify(workflow) });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('update_workflow', 'Update an n8n workflow', { id: z.string(), workflow: z.record(z.any()) }, async ({ id, workflow }) => {
    const data = await n8n(`/workflows/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(workflow) });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('activate_workflow', 'Activate an n8n workflow', { id: z.string() }, async ({ id }) => {
    const data = await n8n(`/workflows/${encodeURIComponent(id)}/activate`, { method: 'POST' });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('deactivate_workflow', 'Deactivate an n8n workflow', { id: z.string() }, async ({ id }) => {
    const data = await n8n(`/workflows/${encodeURIComponent(id)}/deactivate`, { method: 'POST' });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  return server;
}

const transports = {};
app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => { transports[id] = transport; }
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      const server = createServer();
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: String(error.message || error) });
  }
});

app.get('/mcp', async (req, res) => {
  const transport = transports[req.headers['mcp-session-id']];
  if (!transport) return res.status(400).send('Missing or invalid MCP session');
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const transport = transports[req.headers['mcp-session-id']];
  if (!transport) return res.status(400).send('Missing or invalid MCP session');
  await transport.handleRequest(req, res);
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'n8n-mcp' }));

const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => console.log(`n8n MCP listening on ${port}`));
