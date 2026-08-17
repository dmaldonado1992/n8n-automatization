const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_NAME='Instagram Sales — Notion Order Events';
const WEBHOOK_PATH='notion-order-events';
const WEBHOOK_ID='d90a0a33-2ee6-4c10-9f5a-a870a1f814b3';
const ORDERS_DS='19161d20-4873-414d-b6b9-66e5ab736aca';

async function n8n(path,options={}){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{
    ...options,
    headers:{'X-N8N-API-KEY':N8N_API_KEY,'Content-Type':'application/json',...(options.headers||{})}
  });
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

const classifyCode=String.raw`
const payload=$json?.body??$json??{};
if(payload?.verification_token){
  return [{json:{kind:'verification',verification_token:String(payload.verification_token),received_at:new Date().toISOString()}}];
}
const type=String(payload?.type||'');
const pageId=String(payload?.entity?.id||'');
const dataSourceId=String(payload?.data?.parent?.data_source_id||'');
if(type!=='page.properties_updated'){
  return [{json:{kind:'ignored',reason:'unsupported_event',type,pageId,dataSourceId}}];
}
if(dataSourceId!=='${ORDERS_DS}'){
  return [{json:{kind:'ignored',reason:'different_data_source',type,pageId,dataSourceId}}];
}
return [{json:{kind:'order_page_update',type,pageId,dataSourceId,eventId:String(payload?.id||''),updatedProperties:payload?.data?.updated_properties||[],received_at:new Date().toISOString()}}];
`;

const dispatchCode=String.raw`
const input=$json||{};
if(input.kind!=='order_page_update') return [{json:{...input,processed:false}}];
const notionToken=$env.NOTION_API_KEY;
if(!notionToken) return [{json:{...input,processed:false,error:'NOTION_API_KEY missing'}}];
const n8nBase='${N8N_URL}';
const safeText=p=>p?.rich_text?.map(x=>x?.plain_text??x?.text?.content??'').join('')||'';
try{
  const page=await this.helpers.httpRequest({
    method:'GET',
    url:'https://api.notion.com/v1/pages/'+encodeURIComponent(input.pageId),
    headers:{Authorization:'Bearer '+notionToken,'Notion-Version':'2026-03-11'},
    json:true,timeout:12000
  });
  const props=page?.properties||{};
  const orderState=String(props['Estado pedido']?.select?.name||'').trim();
  const orderLast=safeText(props['Último estado notificado']).trim();
  const billingState=String(props['Estado facturación']?.select?.name||'').trim();
  const billingLast=safeText(props['Último estado facturación notificado']).trim();
  const orderChanged=!!orderState&&orderState!==orderLast;
  const billingChanged=!!billingState&&billingState!==billingLast;
  const result={...input,processed:true,orderState,orderLast,billingState,billingLast,orderChanged,billingChanged,dispatched:[]};
  if(orderChanged){
    const r=await this.helpers.httpRequest({method:'POST',url:n8nBase+'/webhook/instagram-order-status-sync',headers:{'Content-Type':'application/json'},body:{action:'sync',source:'notion_webhook',pageId:input.pageId,eventId:input.eventId},json:true,timeout:45000});
    result.dispatched.push({target:'order',ok:r?.ok!==false,summary:r?.summary||null});
  }
  if(billingChanged){
    const r=await this.helpers.httpRequest({method:'POST',url:n8nBase+'/webhook/instagram-billing-status-sync',headers:{'Content-Type':'application/json'},body:{action:'sync',source:'notion_webhook',pageId:input.pageId,eventId:input.eventId},json:true,timeout:45000});
    result.dispatched.push({target:'billing',ok:r?.ok!==false,summary:r?.summary||null});
  }
  return [{json:result}];
}catch(error){
  return [{json:{...input,processed:false,error:String(error?.message||error)}}];
}
`;

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[NOTION_ORDER_WEBHOOK] skipped: n8n config missing');return;}
  const nodes=[
    {id:'notion-order-events-webhook',name:'Notion Order Events',type:'n8n-nodes-base.webhook',typeVersion:2,position:[0,0],webhookId:WEBHOOK_ID,parameters:{httpMethod:'POST',path:WEBHOOK_PATH,responseMode:'responseNode',options:{}}},
    {id:'notion-order-events-classify',name:'Classify Notion Event',type:'n8n-nodes-base.code',typeVersion:2,position:[240,0],parameters:{mode:'runOnceForAllItems',jsCode:classifyCode}},
    {id:'notion-order-events-ack',name:'Acknowledge Notion',type:'n8n-nodes-base.respondToWebhook',typeVersion:1.4,position:[480,0],parameters:{respondWith:'text',responseBody:'OK',options:{responseCode:200}}},
    {id:'notion-order-events-dispatch',name:'Dispatch Status Notifications',type:'n8n-nodes-base.code',typeVersion:2,position:[720,0],parameters:{mode:'runOnceForAllItems',jsCode:dispatchCode}}
  ];
  const connections={
    'Notion Order Events':{main:[[{node:'Classify Notion Event',type:'main',index:0}]]},
    'Classify Notion Event':{main:[[{node:'Acknowledge Notion',type:'main',index:0}]]},
    'Acknowledge Notion':{main:[[{node:'Dispatch Status Notifications',type:'main',index:0}]]}
  };
  const settings={executionOrder:'v1',timezone:'America/Guatemala'};
  const listed=await n8n('/workflows?limit=100');
  const existing=(listed.data||[]).find(w=>w.name===WORKFLOW_NAME);
  let id;
  if(existing){
    id=existing.id;
    await n8n('/workflows/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify({name:WORKFLOW_NAME,nodes,connections,settings})});
    console.log('[NOTION_ORDER_WEBHOOK] updated '+id);
  }else{
    const created=await n8n('/workflows',{method:'POST',body:JSON.stringify({name:WORKFLOW_NAME,nodes,connections,settings})});
    id=created.id;
    console.log('[NOTION_ORDER_WEBHOOK] created '+id);
  }
  await n8n('/workflows/'+encodeURIComponent(id)+'/activate',{method:'POST'});
  console.log('[NOTION_ORDER_WEBHOOK] active '+JSON.stringify({workflowId:id,webhookPath:WEBHOOK_PATH,url:N8N_URL+'/webhook/'+WEBHOOK_PATH}));
  const r=await fetch(N8N_URL+'/webhook/'+WEBHOOK_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'health.test'})});
  console.log('[NOTION_ORDER_WEBHOOK] smoke '+JSON.stringify({status:r.status,body:(await r.text()).slice(0,200)}));
}

main().catch(e=>{console.error('[NOTION_ORDER_WEBHOOK] failure: '+String(e?.stack||e?.message||e));process.exitCode=1;});
