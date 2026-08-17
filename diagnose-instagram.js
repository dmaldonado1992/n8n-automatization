const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID=process.env.INSTAGRAM_SALES_WORKFLOW_ID||'6l5IbTxGdwcL24wT';
const VERIFY_WORKFLOW_ID=process.env.INSTAGRAM_VERIFY_WORKFLOW_ID||'PnM3CU0JZ26urysi';

async function n8n(path){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{headers:{'X-N8N-API-KEY':N8N_API_KEY,'Accept':'application/json'}});
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

function safe(obj,depth=0){
  if(depth>6) return '[DEPTH_LIMIT]';
  if(obj==null||typeof obj!=='object') return obj;
  if(Array.isArray(obj)) return obj.slice(0,20).map(v=>safe(v,depth+1));
  const out={};
  for(const [k,v] of Object.entries(obj)){
    if(/token|authorization|cookie|secret|api.?key|credential/i.test(k)){out[k]='[REDACTED]';continue;}
    out[k]=safe(v,depth+1);
  }
  return out;
}

const summarizeWorkflow=wf=>({
  id:wf.id,name:wf.name,active:wf.active,
  nodes:(wf.nodes||[]).map(n=>({
    name:n.name,type:n.type,webhookId:n.webhookId||null,
    path:n.parameters?.path||null,httpMethod:n.parameters?.httpMethod||null,
    responseMode:n.parameters?.responseMode||null
  }))
});

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_DIAG] skipped: n8n config missing');return;}
  const [wf,verifyWf]=await Promise.all([
    n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`),
    n8n(`/workflows/${encodeURIComponent(VERIFY_WORKFLOW_ID)}`)
  ]);
  console.log('[IG_DIAG] workflow '+JSON.stringify(summarizeWorkflow(wf)));
  console.log('[IG_DIAG] verification_workflow '+JSON.stringify(summarizeWorkflow(verifyWf)));
  const envKeys=Object.keys(process.env).filter(k=>/(META|INSTAGRAM|IG_)/i.test(k)).sort();
  console.log('[IG_DIAG] env_keys '+JSON.stringify(envKeys));
  try{
    const ex=await n8n(`/executions?workflowId=${encodeURIComponent(WORKFLOW_ID)}&limit=10&includeData=true`);
    const rows=ex.data||ex.results||ex;
    const arr=Array.isArray(rows)?rows:[];
    console.log('[IG_DIAG] executions '+JSON.stringify(arr.map(e=>({id:e.id,status:e.status,finished:e.finished,startedAt:e.startedAt,stoppedAt:e.stoppedAt,mode:e.mode,waitTill:e.waitTill,data:safe(e.data)}))));
  }catch(e){console.log('[IG_DIAG] executions_error '+e.message);}
}
main().catch(e=>{console.error('[IG_DIAG] failed: '+e.message);});
