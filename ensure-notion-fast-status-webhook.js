const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_NAME='Instagram Sales — Notion Fast Status Trigger';
const WEBHOOK_PATH='notion-fast-status-4f8c2a71';
const WEBHOOK_ID='7f8f3a7c-2f9b-4e8b-94d8-6dd4a97b9a51';

async function n8n(path,options={}){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{
    ...options,
    headers:{'X-N8N-API-KEY':N8N_API_KEY,'Content-Type':'application/json',...(options.headers||{})}
  });
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

const dispatchCode=String.raw`
const input=$json?.body??$json??{};
const base='${N8N_URL}';
const result={ok:true,source:'notion_database_automation',receivedAt:new Date().toISOString(),inputKeys:Object.keys(input||{}).slice(0,50),dispatched:[]};
for(const target of [
  {name:'order',path:'/webhook/instagram-order-status-sync'},
  {name:'billing',path:'/webhook/instagram-billing-status-sync'}
]){
  try{
    const r=await this.helpers.httpRequest({
      method:'POST',url:base+target.path,
      headers:{'Content-Type':'application/json'},
      body:{action:'sync',source:'notion_database_automation'},
      json:true,timeout:45000
    });
    result.dispatched.push({target:target.name,ok:r?.ok!==false,summary:r?.summary||null});
  }catch(e){
    result.ok=false;
    result.dispatched.push({target:target.name,ok:false,error:String(e?.message||e)});
  }
}
return [{json:result}];
`;

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[NOTION_FAST_STATUS] skipped: n8n config missing');return;}
  const nodes=[
    {id:'notion-fast-status-webhook',name:'Notion Fast Status',type:'n8n-nodes-base.webhook',typeVersion:2,position:[0,0],webhookId:WEBHOOK_ID,parameters:{httpMethod:'POST',path:WEBHOOK_PATH,responseMode:'responseNode',options:{}}},
    {id:'notion-fast-status-ack',name:'Acknowledge Fast Status',type:'n8n-nodes-base.respondToWebhook',typeVersion:1.4,position:[260,0],parameters:{respondWith:'text',responseBody:'OK',options:{responseCode:200}}},
    {id:'notion-fast-status-dispatch',name:'Dispatch Fast Status',type:'n8n-nodes-base.code',typeVersion:2,position:[520,0],parameters:{mode:'runOnceForAllItems',jsCode:dispatchCode}}
  ];
  const connections={
    'Notion Fast Status':{main:[[{node:'Acknowledge Fast Status',type:'main',index:0}]]},
    'Acknowledge Fast Status':{main:[[{node:'Dispatch Fast Status',type:'main',index:0}]]}
  };
  const settings={executionOrder:'v1',timezone:'America/Guatemala'};
  const listed=await n8n('/workflows?limit=100');
  const existing=(listed.data||[]).find(w=>w.name===WORKFLOW_NAME);
  let id;
  if(existing){
    id=existing.id;
    await n8n('/workflows/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify({name:WORKFLOW_NAME,nodes,connections,settings})});
    console.log('[NOTION_FAST_STATUS] updated '+id);
  }else{
    const created=await n8n('/workflows',{method:'POST',body:JSON.stringify({name:WORKFLOW_NAME,nodes,connections,settings})});
    id=created.id;
    console.log('[NOTION_FAST_STATUS] created '+id);
  }
  await n8n('/workflows/'+encodeURIComponent(id)+'/activate',{method:'POST'});
  const url=N8N_URL+'/webhook/'+WEBHOOK_PATH;
  console.log('[NOTION_FAST_STATUS] active '+JSON.stringify({workflowId:id,url}));
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'health'})});
  console.log('[NOTION_FAST_STATUS] smoke '+JSON.stringify({status:r.status,body:(await r.text()).slice(0,200)}));
}

main().catch(e=>{console.error('[NOTION_FAST_STATUS] failure: '+String(e?.stack||e?.message||e));process.exitCode=1;});
