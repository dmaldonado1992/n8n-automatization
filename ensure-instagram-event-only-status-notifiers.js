const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const TARGETS=[
  {id:'eNiZkcaktVps9FXz',name:'Instagram Sales — Order Status Notifications'},
  {id:'0ARsAiAavbmiyXti',name:'Instagram Sales — Billing Status Notifications'}
];

async function n8n(path,options={}){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{
    ...options,
    headers:{'X-N8N-API-KEY':N8N_API_KEY,'Content-Type':'application/json',...(options.headers||{})}
  });
  const text=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${text}`);
  return text?JSON.parse(text):{};
}

async function main(){
  if(!N8N_URL||!N8N_API_KEY){
    console.log('[IG_EVENT_ONLY] skipped: n8n config missing');
    return;
  }

  for(const target of TARGETS){
    const wf=await n8n('/workflows/'+encodeURIComponent(target.id));
    const removedNames=new Set(
      (wf.nodes||[])
        .filter(n=>n.type==='n8n-nodes-base.scheduleTrigger')
        .map(n=>n.name)
    );
    const nodes=(wf.nodes||[]).filter(n=>n.type!=='n8n-nodes-base.scheduleTrigger');
    const connections={};
    for(const [name,value] of Object.entries(wf.connections||{})){
      if(!removedNames.has(name)) connections[name]=value;
    }

    await n8n('/workflows/'+encodeURIComponent(target.id),{
      method:'PUT',
      body:JSON.stringify({
        name:wf.name||target.name,
        nodes,
        connections,
        settings:wf.settings||{executionOrder:'v1',timezone:'America/Guatemala'}
      })
    });
    await n8n('/workflows/'+encodeURIComponent(target.id)+'/activate',{method:'POST'});
    console.log('[IG_EVENT_ONLY] updated '+JSON.stringify({workflowId:target.id,removedSchedules:[...removedNames],remainingNodes:nodes.map(n=>n.name)}));
  }
}

main().catch(e=>{
  console.error('[IG_EVENT_ONLY] failure: '+String(e?.stack||e?.message||e));
  process.exitCode=1;
});
