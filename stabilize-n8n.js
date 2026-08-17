const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const TEMP_WORKFLOW_IDS=['X44E2zwq2E8Ui2DB','IngT4r40mKRRuc8U'];

async function n8n(path,options={}){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{
    ...options,
    headers:{'X-N8N-API-KEY':N8N_API_KEY,'Content-Type':'application/json',...(options.headers||{})}
  });
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t.slice(0,300)}`);
  return t?JSON.parse(t):{};
}

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[N8N_STABILIZE] skipped: n8n config missing');return;}
  for(const id of TEMP_WORKFLOW_IDS){
    try{
      const wf=await n8n(`/workflows/${encodeURIComponent(id)}`);
      if(wf.active){
        await n8n(`/workflows/${encodeURIComponent(id)}/deactivate`,{method:'POST'});
        console.log(`[N8N_STABILIZE] deactivated ${id} ${wf.name||''}`);
      }else{
        console.log(`[N8N_STABILIZE] already inactive ${id} ${wf.name||''}`);
      }
    }catch(e){
      console.log(`[N8N_STABILIZE] ${id} skipped: ${e.message}`);
    }
  }
}
main().catch(e=>{console.error('[N8N_STABILIZE] failed:',e);process.exitCode=1;});
