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

async function main() {
  if (!N8N_URL || !N8N_API_KEY) {
    console.log('[IG_PAGE_TOKEN] skipped: N8N_URL/N8N_API_KEY not configured');
    return;
  }

  const workflow = await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`);
  const codeNode = (workflow.nodes || []).find(node => node.name === 'Dynamic Notion Sales Engine');
  if (!codeNode?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine code node not found');

  const code = codeNode.parameters.jsCode;
  if (code.includes(MARKER)) {
    console.log('[IG_PAGE_TOKEN] page token resolver already installed');
    return;
  }

  const sendStart = code.indexOf('const sendMeta=');
  const arrowAt = sendStart >= 0 ? code.indexOf('=>', sendStart) : -1;
  const sendOpen = arrowAt >= 0 ? code.indexOf('{', arrowAt) : -1;

  if (sendStart < 0 || arrowAt < 0 || sendOpen < 0) {
    console.log('[IG_PAGE_TOKEN] sender positions not found', JSON.stringify({ sendStart, arrowAt, sendOpen }));
    return;
  }

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
   __igLog('META_PAGE_TOKEN_RESOLVED',{igAccountId:key,pageId:String(page.id||''),pageName:page.name||null,username:page.instagram_business_account?.username||null});
   return page.access_token;
  }
  __igLog('META_PAGE_TOKEN_NOT_FOUND',{igAccountId:key,managedPages:(accounts.data||[]).map(p=>({pageId:String(p.id||''),pageName:p.name||null,igAccountId:String(p.instagram_business_account?.id||''),username:p.instagram_business_account?.username||null}))});
 }catch(error){
  __igLog('META_PAGE_TOKEN_FAILURE',{igAccountId:key,error:__igError(error)});
 }
 return cfg.meta;
};
${code.slice(sendStart, sendOpen + 1)}
 const __metaToken=await resolveMetaPageToken(igAccountId);
 const metaHeaders={Authorization:'Bearer '+__metaToken,'Content-Type':'application/json'};`;

  codeNode.parameters.jsCode = code.slice(0, sendStart) + replacement + code.slice(sendOpen + 1);

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

  console.log(`[IG_PAGE_TOKEN] resolver installed on workflow ${WORKFLOW_ID}`);
}

main().catch(error => {
  console.error('[IG_PAGE_TOKEN] non-fatal failure:', String(error?.message || error));
});
