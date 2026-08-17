const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const IDS=['6l5IbTxGdwcL24wT','PnM3CU0JZ26urysi'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function call(path,options={}){
  let last;
  for(let i=0;i<6;i++){
    try{
      const r=await fetch(`${N8N_URL}/api/v1${path}`,{...options,headers:{'X-N8N-API-KEY':N8N_API_KEY,'Content-Type':'application/json',...(options.headers||{})}});
      const t=await r.text();
      if(r.ok) return t?JSON.parse(t):{};
      last=new Error(`n8n ${r.status}: ${t.slice(0,200)}`);
    }catch(e){last=e;}
    await sleep(3000);
  }
  throw last;
}
async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_REACTIVATE] skipped: config missing');return;}
  for(const id of IDS){
    try{await call(`/workflows/${encodeURIComponent(id)}/deactivate`,{method:'POST'});}catch(e){console.log(`[IG_REACTIVATE] deactivate ${id}: ${e.message}`);}
    await sleep(500);
    const w=await call(`/workflows/${encodeURIComponent(id)}/activate`,{method:'POST'});
    console.log(`[IG_REACTIVATE] active ${w.id||id} ${w.name||''}`);
  }
}
main().catch(e=>{console.error('[IG_REACTIVATE] failed:',e);process.exitCode=1;});
