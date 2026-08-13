import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const app = express();
app.use(express.json({ limit: '2mb' }));

const N8N_URL = (process.env.N8N_URL || '').replace(/\/$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const N8N_TIMEOUT_MS = Number(process.env.N8N_TIMEOUT_MS || 15000);
const N8N_RETRY_ATTEMPTS = Number(process.env.N8N_RETRY_ATTEMPTS || 5);
const N8N_RETRY_BASE_MS = Number(process.env.N8N_RETRY_BASE_MS || 750);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function retryableMethod(method, path) {
  const normalized = String(method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'PUT', 'DELETE'].includes(normalized)) return true;
  if (normalized === 'POST' && /\/(activate|deactivate)$/.test(path)) return true;
  return false;
}

function retryableStatus(status) {
  return [429, 502, 503, 504].includes(status);
}

async function n8n(path, options = {}) {
  if (!N8N_URL || !N8N_API_KEY) {
    throw new Error('N8N_URL and N8N_API_KEY must be configured');
  }

  const method = String(options.method || 'GET').toUpperCase();
  const attempts = retryableMethod(method, path) ? Math.max(1, N8N_RETRY_ATTEMPTS) : 1;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), N8N_TIMEOUT_MS);

    try {
      const response = await fetch(`${N8N_URL}/api/v1${path}`, {
        ...options,
        method,
        signal: controller.signal,
        headers: {
          'X-N8N-API-KEY': N8N_API_KEY,
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });

      const text = await response.text();

      if (response.ok) {
        return text ? JSON.parse(text) : {};
      }

      const error = new Error(`n8n ${response.status}: ${text}`);
      error.status = response.status;
      lastError = error;

      if (attempt >= attempts || !retryableStatus(response.status)) {
        throw error;
      }
    } catch (error) {
      lastError = error;
      const networkFailure = error?.name === 'AbortError' || error instanceof TypeError;
      const statusFailure = retryableStatus(error?.status);

      if (attempt >= attempts || (!networkFailure && !statusFailure)) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }

    const delay = Math.min(N8N_RETRY_BASE_MS * (2 ** (attempt - 1)), 8000);
    await sleep(delay);
  }

  throw lastError || new Error('Unknown n8n request failure');
}

function createServer() {
  const server = new McpServer({ name: 'n8n-mcp', version: '1.1.0' });

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

app.post('/mcp', async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  res.on('close', () => {
    Promise.resolve(transport.close()).catch(() => {});
    Promise.resolve(server.close()).catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: String(error?.message || error) },
        id: req.body?.id ?? null
      });
    }
  }
});

app.get('/mcp', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    error: 'This MCP endpoint is stateless. Use POST /mcp.'
  });
});

app.delete('/mcp', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    error: 'This MCP endpoint is stateless and has no server-side session to delete.'
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'n8n-mcp', mode: 'stateless', version: '1.1.0' });
});

app.get('/ready', async (_req, res) => {
  if (!N8N_URL || !N8N_API_KEY) {
    return res.status(503).json({ ok: false, service: 'n8n-mcp', n8n: 'not_configured' });
  }

  try {
    await n8n('/workflows?limit=1');
    return res.json({ ok: true, service: 'n8n-mcp', n8n: 'reachable' });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      service: 'n8n-mcp',
      n8n: 'unreachable',
      error: String(error?.message || error)
    });
  }
});

app.use((error, _req, res, next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  return next(error);
});

const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => console.log(`n8n MCP listening on ${port} in stateless mode`));
