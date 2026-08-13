import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const N8N_URL = (process.env.N8N_URL || '').replace(/\/$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const N8N_TIMEOUT_MS = Number(process.env.N8N_TIMEOUT_MS || 15000);
const N8N_RETRY_ATTEMPTS = Number(process.env.N8N_RETRY_ATTEMPTS || 5);
const N8N_RETRY_BASE_MS = Number(process.env.N8N_RETRY_BASE_MS || 750);
const MCP_SESSION_MODE = String(process.env.MCP_SESSION_MODE || 'stateless').toLowerCase();
const MCP_STATEFUL = MCP_SESSION_MODE === 'stateful';
const MCP_SESSION_TTL_MS = Number(process.env.MCP_SESSION_TTL_MS || 30 * 60 * 1000);

const sessions = new Map();
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

    const baseDelay = Math.min(N8N_RETRY_BASE_MS * (2 ** (attempt - 1)), 8000);
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(baseDelay * 0.2)));
    await sleep(baseDelay + jitter);
  }

  throw lastError || new Error('Unknown n8n request failure');
}

function createServer() {
  const server = new McpServer({ name: 'n8n-mcp', version: '1.2.0' });

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

function jsonRpcError(res, status, message, id = null, code = -32000) {
  return res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id
  });
}

async function handleStatelessPost(req, res) {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    Promise.resolve(transport.close()).catch(() => {});
    Promise.resolve(server.close()).catch(() => {});
  };

  res.once('finish', cleanup);
  res.once('close', cleanup);

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

async function createStatefulSession(req, res) {
  const server = createServer();
  let transport;

  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: sessionId => {
      sessions.set(sessionId, {
        transport,
        server,
        lastSeen: Date.now()
      });
    }
  });

  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
    Promise.resolve(server.close()).catch(() => {});
  };

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

async function handleStateful(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  const isInitialize = req.method === 'POST' && req.body?.method === 'initialize';

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return jsonRpcError(res, 404, 'Session not found; start a new MCP session.', req.body?.id ?? null, -32001);
    }

    session.lastSeen = Date.now();
    return session.transport.handleRequest(req, res, req.body);
  }

  if (isInitialize) {
    return createStatefulSession(req, res);
  }

  return jsonRpcError(res, 400, 'Mcp-Session-Id is required in stateful mode.', req.body?.id ?? null);
}

app.post('/mcp', async (req, res) => {
  try {
    if (MCP_STATEFUL) {
      await handleStateful(req, res);
    } else {
      await handleStatelessPost(req, res);
    }
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) {
      jsonRpcError(res, 500, String(error?.message || error), req.body?.id ?? null, -32603);
    }
  }
});

app.get('/mcp', async (req, res) => {
  if (!MCP_STATEFUL) {
    return res.status(405).set('Allow', 'POST').json({
      error: 'This MCP endpoint is stateless. Use POST /mcp.'
    });
  }

  try {
    await handleStateful(req, res);
  } catch (error) {
    console.error('MCP GET failed:', error);
    if (!res.headersSent) jsonRpcError(res, 500, String(error?.message || error), null, -32603);
  }
});

app.delete('/mcp', async (req, res) => {
  if (!MCP_STATEFUL) {
    return res.status(405).set('Allow', 'POST').json({
      error: 'This MCP endpoint is stateless and has no server-side session to delete.'
    });
  }

  try {
    await handleStateful(req, res);
  } catch (error) {
    console.error('MCP DELETE failed:', error);
    if (!res.headersSent) jsonRpcError(res, 500, String(error?.message || error), null, -32603);
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'n8n-mcp',
    mode: MCP_STATEFUL ? 'stateful' : 'stateless',
    version: '1.2.0',
    sessions: MCP_STATEFUL ? sessions.size : 0
  });
});

app.get('/ready', async (_req, res) => {
  if (!N8N_URL || !N8N_API_KEY) {
    return res.status(503).json({ ok: false, service: 'n8n-mcp', n8n: 'not_configured' });
  }

  try {
    await n8n('/workflows?limit=1');
    return res.json({
      ok: true,
      service: 'n8n-mcp',
      n8n: 'reachable',
      mode: MCP_STATEFUL ? 'stateful' : 'stateless'
    });
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

const cleanupTimer = setInterval(async () => {
  if (!MCP_STATEFUL) return;
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastSeen > MCP_SESSION_TTL_MS) {
      sessions.delete(sessionId);
      try {
        await session.transport.close();
      } catch {}
      try {
        await session.server.close();
      } catch {}
    }
  }
}, Math.min(Math.max(60_000, Math.floor(MCP_SESSION_TTL_MS / 2)), 5 * 60_000));
cleanupTimer.unref();

const port = Number(process.env.PORT || 10000);
const httpServer = app.listen(port, '0.0.0.0', () => {
  console.log(`n8n MCP listening on ${port} in ${MCP_STATEFUL ? 'stateful' : 'stateless'} mode`);
});

async function shutdown(signal) {
  console.log(`${signal} received; closing MCP cleanly`);
  clearInterval(cleanupTimer);

  for (const [sessionId, session] of sessions.entries()) {
    sessions.delete(sessionId);
    try {
      await session.transport.close();
    } catch {}
    try {
      await session.server.close();
    } catch {}
  }

  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
