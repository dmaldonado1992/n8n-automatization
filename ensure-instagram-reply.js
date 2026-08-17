const N8N_URL = (process.env.N8N_URL || '').replace(/\/$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const WORKFLOW_ID = process.env.INSTAGRAM_SALES_WORKFLOW_ID || '6l5IbTxGdwcL24wT';
const MARKER = '/* INSTAGRAM_REPLY_FALLBACK_V1 */';

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

async function main() {
  if (!N8N_URL || !N8N_API_KEY) {
    console.log('[INSTAGRAM_REPLY] skipped: N8N_URL/N8N_API_KEY not configured');
    return;
  }

  const workflow = await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`);
  const codeNode = (workflow.nodes || []).find(node => node.name === 'Dynamic Notion Sales Engine');
  if (!codeNode?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine code node not found');

  let code = codeNode.parameters.jsCode;
  if (code.includes(MARKER)) {
    console.log('[INSTAGRAM_REPLY] fallback already installed');
    return;
  }

  const needle = "__igLog('ENGINE_RESULT',{ok:true,eventType,sender,igAccountId,reply,delivery:__igDelivery});\nreturn [{json:{ok:true,eventType,sender,igAccountId,reply,delivery:__igDelivery}}];";
  if (!code.includes(needle)) throw new Error('Message final-return anchor not found');

  const replacement = `${MARKER}\nif(__igDelivery.attempted===false && sender && igAccountId && typeof reply==='string' && reply.trim()){\n  __igLog('META_SEND_FALLBACK',{sender,igAccountId,replyLength:reply.length});\n  await sendMeta(igAccountId,{recipient:{id:String(sender)},message:{text:reply}});\n}\n__igLog('ENGINE_RESULT',{ok:true,eventType,sender,igAccountId,reply,delivery:__igDelivery});\nreturn [{json:{ok:true,eventType,sender,igAccountId,reply,delivery:__igDelivery}}];`;

  codeNode.parameters.jsCode = code.replace(needle, replacement);

  const payload = {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings || {}
  };

  const updated = await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });

  console.log(`[INSTAGRAM_REPLY] fallback installed on workflow ${updated.id || WORKFLOW_ID}`);
}

main().catch(error => {
  console.error('[INSTAGRAM_REPLY] failed:', error);
  process.exitCode = 1;
});
