const N8N_URL = (process.env.N8N_URL || '').replace(/\/$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const WORKFLOW_ID = process.env.INSTAGRAM_SALES_WORKFLOW_ID || '6l5IbTxGdwcL24wT';
const MARKER = '/* INSTAGRAM_PAGE_TOKEN_RESOLUTION_V1 */';

async function n8n(path, options = {}) {
  if (!N8N_URL || !N8N_API_KEY) throw new Error('N8N_URL and N8N_API_KEY must be configured');
  const response = await fetch(`${N8N_URL}/api/v1${path}`, {
    ...options,
    headers: {
      'X-N8N-API-KEY': N8N_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`n8n ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function saveAndActivate(workflow) {
  await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: workflow.name,
      nodes: workflow.nodes,
      connections: workflow.connections,
      settings: workflow.settings || {},
    }),
  });

  try {
    await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}/activate`, { method: 'POST' });
  } catch (error) {
    console.log('[IG_PAGE_TOKEN] activate after update non-fatal', String(error?.message || error));
  }
}

function repairInstalledResolver(code) {
  let next = code;
  const changes = [];

  // Engine V3 renamed the logger helpers. Old injected resolver references crash at runtime.
  if (next.includes('/* INSTAGRAM_SALES_ENGINE_V3_TIMEOUT_SAFE */') || next.includes('const log=')) {
    if (next.includes('__igLog(')) {
      next = next.replaceAll('__igLog(', 'log(');
      changes.push('logger');
    }
    if (next.includes('__igError(')) {
      next = next.replaceAll('__igError(', 'errInfo(');
      changes.push('error-helper');
    }
  }

  // Logging must never recurse forever on circular/proxy error objects returned by vm2/httpRequest.
  const unsafeRedactor = `const redact=(value)=>{
  if(value===null||value===undefined)return value;
  if(Array.isArray(value))return value.map(redact);
  if(typeof value!=='object')return value;
  const out={};
  for(const [k,v] of Object.entries(value)) out[k]=/(authorization|cookie|access[_-]?token|secret|api[_-]?key)/i.test(k)?'[REDACTED]':redact(v);
  return out;
};`;

  const safeRedactor = `/* INSTAGRAM_SAFE_REDACT_V1 */
const redact=(value,depth=0,seen)=>{
  if(value===null||value===undefined)return value;
  if(depth>6)return '[DEPTH_LIMIT]';
  const t=typeof value;
  if(t!=='object'){
    if(t==='bigint')return String(value);
    if(t==='function')return '[FUNCTION]';
    return value;
  }
  const refs=seen||new WeakSet();
  try{
    if(refs.has(value))return '[CIRCULAR]';
    refs.add(value);
    if(Array.isArray(value))return value.slice(0,50).map(v=>redact(v,depth+1,refs));
    const out={};
    for(const [k,v] of Object.entries(value).slice(0,100)){
      out[k]=/(authorization|cookie|access[_-]?token|secret|api[_-]?key)/i.test(k)?'[REDACTED]':redact(v,depth+1,refs);
    }
    return out;
  }catch{
    return '[UNSERIALIZABLE]';
  }
};`;

  if (next.includes(unsafeRedactor)) {
    next = next.replace(unsafeRedactor, safeRedactor);
    changes.push('safe-redactor');
  }

  // The sender resolves a Page token into metaHeaders; the Graph POST must actually use it.
  const wrongHeaders = "headers:{Authorization:'Bearer '+cfg.meta,'Content-Type':'application/json'},body:payload";
  const correctHeaders = 'headers:metaHeaders,body:payload';
  if (next.includes(wrongHeaders)) {
    next = next.replaceAll(wrongHeaders, correctHeaders);
    changes.push('send-headers');
  }

  return { code: next, changes };
}

async function main() {
  if (!N8N_URL || !N8N_API_KEY) {
    console.log('[IG_PAGE_TOKEN] skipped: N8N_URL/N8N_API_KEY not configured');
    return;
  }

  const workflow = await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`);
  const codeNode = (workflow.nodes || []).find(node => node.name === 'Dynamic Notion Sales Engine');
  if (!codeNode?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine code node not found');

  let code = codeNode.parameters.jsCode;

  if (code.includes(MARKER)) {
    const repaired = repairInstalledResolver(code);
    if (!repaired.changes.length) {
      console.log('[IG_PAGE_TOKEN] page token resolver already installed and healthy');
      return;
    }

    codeNode.parameters.jsCode = repaired.code;
    await saveAndActivate(workflow);
    console.log('[IG_PAGE_TOKEN] stale resolver repaired', JSON.stringify({ workflowId: WORKFLOW_ID, changes: repaired.changes }));
    return;
  }

  const sendStart = code.indexOf('const sendMeta=');
  const arrowAt = sendStart >= 0 ? code.indexOf('=>', sendStart) : -1;
  const sendOpen = arrowAt >= 0 ? code.indexOf('{', arrowAt) : -1;

  if (sendStart < 0 || arrowAt < 0 || sendOpen < 0) {
    console.log('[IG_PAGE_TOKEN] sender positions not found', JSON.stringify({ sendStart, arrowAt, sendOpen }));
    return;
  }

  const usesV3Helpers = code.includes('/* INSTAGRAM_SALES_ENGINE_V3_TIMEOUT_SAFE */') || code.includes('const log=');
  const logFn = usesV3Helpers ? 'log' : '__igLog';
  const errorFn = usesV3Helpers ? 'errInfo' : '__igError';

  const replacement = `${MARKER}
const __metaPageTokenCache={};
const resolveMetaPageToken=async(igAccountId)=>{
 const key=String(igAccountId||'');
 if(__metaPageTokenCache[key]) return __metaPageTokenCache[key];
 try{
  const accounts=await this.helpers.httpRequest({
   method:'GET',
   url:'https://graph.facebook.com/v26.0/me/accounts',
   headers:{Authorization:'Bearer '+cfg.meta},
   qs:{fields:'id,name,access_token,instagram_business_account{id,username}'},
   json:true
  });
  const page=(accounts.data||[]).find(p=>String(p.instagram_business_account?.id||'')===key);
  if(page?.access_token){
   __metaPageTokenCache[key]=page.access_token;
   ${logFn}('META_PAGE_TOKEN_RESOLVED',{igAccountId:key,pageId:String(page.id||''),pageName:page.name||null,username:page.instagram_business_account?.username||null});
   return page.access_token;
  }
  ${logFn}('META_PAGE_TOKEN_NOT_FOUND',{igAccountId:key,managedPages:(accounts.data||[]).map(p=>({pageId:String(p.id||''),pageName:p.name||null,igAccountId:String(p.instagram_business_account?.id||''),username:p.instagram_business_account?.username||null}))});
 }catch(error){
  ${logFn}('META_PAGE_TOKEN_FAILURE',{igAccountId:key,error:${errorFn}(error)});
 }
 return cfg.meta;
};
${code.slice(sendStart, sendOpen + 1)}
 const __metaToken=await resolveMetaPageToken(igAccountId);
 const metaHeaders={Authorization:'Bearer '+__metaToken,'Content-Type':'application/json'};`;

  code = code.slice(0, sendStart) + replacement + code.slice(sendOpen + 1);
  codeNode.parameters.jsCode = repairInstalledResolver(code).code;

  await saveAndActivate(workflow);
  console.log(`[IG_PAGE_TOKEN] resolver installed on workflow ${WORKFLOW_ID}`);
}

main().catch(error => {
  console.error('[IG_PAGE_TOKEN] non-fatal failure:', String(error?.message || error));
});
