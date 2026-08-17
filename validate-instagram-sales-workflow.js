const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID='6l5IbTxGdwcL24wT';

async function n8n(path){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{headers:{'X-N8N-API-KEY':N8N_API_KEY}});
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_WORKFLOW_SYNTAX] skipped: n8n config missing');return;}
  const wf=await n8n('/workflows/'+WORKFLOW_ID);
  const node=(wf.nodes||[]).find(n=>n.name==='Dynamic Notion Sales Engine');
  const code=String(node?.parameters?.jsCode||'');
  if(!code) throw new Error('Dynamic Notion Sales Engine code missing');
  new Function('return async function __validateInstagramSalesWorkflow(){\n'+code+'\n}');
  console.log('[IG_WORKFLOW_SYNTAX] valid '+JSON.stringify({workflowId:WORKFLOW_ID,active:!!wf.active,dynamicProducts:code.includes('INSTAGRAM_DYNAMIC_PRODUCT_CATALOG_V1'),length:code.length}));
}

main().catch(e=>{console.error('[IG_WORKFLOW_SYNTAX] invalid: '+String(e?.stack||e?.message||e));process.exitCode=1;});
