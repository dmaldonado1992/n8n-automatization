const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_NAME='Instagram Sales — Order Status Notifications';
const WEBHOOK_PATH='instagram-order-status-sync';
const WEBHOOK_ID='68732d0e-9cbb-46c7-8e84-ae1b76b101f9';

async function n8n(path,options={}){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{
    ...options,
    headers:{'X-N8N-API-KEY':N8N_API_KEY,'Content-Type':'application/json',...(options.headers||{})}
  });
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

const notifierCode=String.raw`
const cfg={
  notion:$env.NOTION_API_KEY,
  meta:$env.META_PAGE_ACCESS_TOKEN,
  ordersDs:'19161d20-4873-414d-b6b9-66e5ab736aca',
  messagesDs:'2b0b2910-b9f6-4b07-b666-423dd4c266e7',
  igAccountId:String($env.META_INSTAGRAM_ACCOUNT_ID||'17841441308562806'),
  graphVersion:'v26.0'
};
const now=new Date().toISOString();
const input=$json?.body??$json??{};
if(String(input.action||'').toLowerCase()==='health'){
  return [{json:{ok:true,service:'instagram-order-status-sync',status:'healthy',timestamp:now}}];
}
if(!cfg.notion||!cfg.meta) throw new Error('Missing NOTION_API_KEY or META_PAGE_ACCESS_TOKEN');

const safe=(v,max=1800)=>String(v??'').slice(0,max);
const rich=p=>p?.rich_text?.map(x=>x.plain_text??x.text?.content??'').join('')||'';
const title=p=>p?.title?.map(x=>x.plain_text??x.text?.content??'').join('')||'';
const log=(stage,data={})=>{try{console.log('[IG_ORDER_STATUS] '+JSON.stringify({ts:new Date().toISOString(),stage,...data}));}catch{}};
const errText=e=>safe(e?.response?.body?.error?.message||e?.response?.body?.message||e?.message||e,1600);

const notion=async(method,url,body)=>this.helpers.httpRequest({
  method,url,
  headers:{Authorization:'Bearer '+cfg.notion,'Notion-Version':'2026-03-11','Content-Type':'application/json'},
  ...(body!==undefined?{body,json:true}:{json:true}),
  timeout:15000
});

const queryAll=async(dataSourceId,baseBody={})=>{
  const out=[];
  let cursor=null;
  for(let i=0;i<20;i++){
    const body={...baseBody,page_size:100,...(cursor?{start_cursor:cursor}:{})};
    const r=await notion('POST','https://api.notion.com/v1/data_sources/'+encodeURIComponent(dataSourceId)+'/query',body);
    out.push(...(r.results||[]));
    if(!r.has_more||!r.next_cursor) break;
    cursor=r.next_cursor;
  }
  return out;
};

let pageCtxPromise=null;
const getPageContext=async()=>{
  if(pageCtxPromise) return pageCtxPromise;
  pageCtxPromise=(async()=>{
    const r=await this.helpers.httpRequest({
      method:'GET',url:'https://graph.facebook.com/'+cfg.graphVersion+'/me/accounts',
      headers:{Authorization:'Bearer '+cfg.meta},
      qs:{fields:'id,name,access_token,tasks,instagram_business_account{id,username}'},
      json:true,timeout:10000
    });
    const pages=r.data||[];
    const p=pages.find(x=>String(x.instagram_business_account?.id||'')===cfg.igAccountId)||pages.find(x=>x.instagram_business_account?.id);
    if(!p?.id||!p?.access_token) throw new Error('No Facebook Page with linked Instagram account was resolved');
    return {pageId:String(p.id),token:p.access_token,igAccountId:String(p.instagram_business_account?.id||cfg.igAccountId)};
  })();
  return pageCtxPromise;
};

const resolveProfile=async(igsid)=>{
  try{
    const ctx=await getPageContext();
    const p=await this.helpers.httpRequest({
      method:'GET',url:'https://graph.facebook.com/'+cfg.graphVersion+'/'+encodeURIComponent(igsid),
      headers:{Authorization:'Bearer '+ctx.token},qs:{fields:'name,username'},json:true,timeout:10000
    });
    return {name:String(p?.name||''),username:String(p?.username||'')};
  }catch(e){log('PROFILE_RESOLVE_FAILED',{igsid,error:errText(e)});return {name:'',username:''};}
};

const sendInstagram=async(igsid,message)=>{
  const ctx=await getPageContext();
  return this.helpers.httpRequest({
    method:'POST',url:'https://graph.facebook.com/'+cfg.graphVersion+'/'+encodeURIComponent(ctx.pageId)+'/messages',
    headers:{Authorization:'Bearer '+ctx.token,'Content-Type':'application/json'},
    body:{recipient:{id:String(igsid)},message:{text:message},messaging_type:'RESPONSE'},json:true,timeout:12000
  });
};

const productCache=new Map();
const getProductName=async(id)=>{
  if(!id) return '';
  if(productCache.has(id)) return productCache.get(id);
  try{
    const p=await notion('GET','https://api.notion.com/v1/pages/'+encodeURIComponent(id));
    const tp=Object.values(p.properties||{}).find(x=>x?.type==='title');
    const name=title(tp);
    productCache.set(id,name);
    return name;
  }catch(e){log('PRODUCT_RESOLVE_FAILED',{id,error:errText(e)});return '';}
};

const patchOrder=async(id,properties)=>notion('PATCH','https://api.notion.com/v1/pages/'+encodeURIComponent(id),{properties});
const textProp=v=>({rich_text:v?[{type:'text',text:{content:safe(v)}}]:[]});
const dateProp=v=>({date:v?{start:v}:null});

const [orders,templatePages]=await Promise.all([
  queryAll(cfg.ordersDs,{filter:{property:'Origen',select:{equals:'Instagram'}}}),
  queryAll(cfg.messagesDs,{sorts:[{property:'Orden',direction:'ascending'}]})
]);
const templates=new Map();
for(const p of templatePages){
  const state=title(p.properties?.Estado).trim();
  if(!state) continue;
  templates.set(state,{message:rich(p.properties?.['Mensaje Instagram']),active:!!p.properties?.Activo?.checkbox});
}

const summary={scanned:orders.length,changed:0,sent:0,disabled:0,failed:0,deliveryDates:0,profilesUpdated:0,skippedCooldown:0};
for(const order of orders){
  const props=order.properties||{};
  const state=String(props['Estado pedido']?.select?.name||'').trim();
  const last=rich(props['Último estado notificado']).trim();
  if(!state||state===last) continue;
  summary.changed++;

  const lastError=rich(props['Error última notificación']);
  const lastAttempt=props['Fecha última notificación']?.date?.start||'';
  if(lastError.startsWith('['+state+']')&&lastAttempt){
    const age=Date.now()-new Date(lastAttempt).getTime();
    if(Number.isFinite(age)&&age>=0&&age<15*60*1000){summary.skippedCooldown++;continue;}
  }

  const basePatch={};
  if(state==='Entregado'&&!props['Fecha entrega real']?.date?.start){
    basePatch['Fecha entrega real']={date:{start:now}};
    summary.deliveryDates++;
  }

  let igsid=rich(props.IGSID).trim();
  let username=rich(props['Usuario Instagram']).trim();
  let customerName=rich(props['Nombre cliente']).trim();
  if(igsid&&(!username||!customerName)){
    const profile=await resolveProfile(igsid);
    if(!username&&profile.username){username=profile.username;basePatch['Usuario Instagram']=textProp(username);}
    if(!customerName&&profile.name){customerName=profile.name;basePatch['Nombre cliente']=textProp(customerName);}
    if(profile.username||profile.name) summary.profilesUpdated++;
  }

  if(Object.keys(basePatch).length) await patchOrder(order.id,basePatch);

  const tpl=templates.get(state);
  if(!tpl){
    const e='['+state+'] No existe una plantilla en Mensajes por estado.';
    await patchOrder(order.id,{'Error última notificación':textProp(e),'Fecha última notificación':{date:{start:now}}});
    summary.failed++;log('TEMPLATE_MISSING',{orderId:order.id,state});continue;
  }
  if(!tpl.active){
    await patchOrder(order.id,{'Último estado notificado':textProp(state),'Error última notificación':textProp('')});
    summary.disabled++;log('NOTIFICATION_DISABLED',{orderId:order.id,state});continue;
  }
  if(!igsid){
    const e='['+state+'] El pedido no tiene IGSID.';
    await patchOrder(order.id,{'Error última notificación':textProp(e),'Fecha última notificación':{date:{start:now}}});
    summary.failed++;continue;
  }

  const productId=props['Producto(s)']?.relation?.[0]?.id||'';
  const productName=await getProductName(productId);
  const orderNumber=props['Pedido #']?.number??'';
  const vars={
    nombre:customerName||(username?'@'+username:'cliente'),
    username,
    pedido:String(orderNumber||''),
    producto:productName,
    cantidad:String(props.Cantidad?.number??''),
    total:String(props.Total?.number??''),
    direccion:rich(props['Dirección envío']),
    telefono:String(props.Teléfono?.phone_number||''),
    estado:state
  };
  let message=String(tpl.message||'');
  for(const [k,v] of Object.entries(vars)) message=message.replaceAll('{{'+k+'}}',String(v??''));
  message=message.trim();
  if(!message){
    const e='['+state+'] La plantilla está vacía.';
    await patchOrder(order.id,{'Error última notificación':textProp(e),'Fecha última notificación':{date:{start:now}}});
    summary.failed++;continue;
  }

  try{
    const sent=await sendInstagram(igsid,message);
    await patchOrder(order.id,{
      'Último estado notificado':textProp(state),
      'Fecha última notificación':{date:{start:now}},
      'Error última notificación':textProp('')
    });
    summary.sent++;
    log('NOTIFICATION_SENT',{orderId:order.id,orderNumber,state,igsid,messageId:sent?.message_id||null});
  }catch(e){
    const msg='['+state+'] '+errText(e);
    await patchOrder(order.id,{'Error última notificación':textProp(msg),'Fecha última notificación':{date:{start:now}}});
    summary.failed++;
    log('NOTIFICATION_FAILED',{orderId:order.id,orderNumber,state,igsid,error:errText(e)});
  }
}
return [{json:{ok:summary.failed===0,summary,timestamp:now}}];
`;

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_ORDER_STATUS_INSTALL] skipped: n8n config missing');return;}
  const nodes=[
    {id:'ig-order-status-schedule',name:'Every Minute',type:'n8n-nodes-base.scheduleTrigger',typeVersion:1.2,position:[0,-120],parameters:{rule:{interval:[{field:'cronExpression',expression:'0 * * * * *'}]}}},
    {id:'ig-order-status-webhook',name:'Manual Status Sync',type:'n8n-nodes-base.webhook',typeVersion:2,position:[0,120],webhookId:WEBHOOK_ID,parameters:{httpMethod:'POST',path:WEBHOOK_PATH,responseMode:'lastNode',options:{}}},
    {id:'ig-order-status-code',name:'Notify Instagram Order Status',type:'n8n-nodes-base.code',typeVersion:2,position:[300,0],parameters:{mode:'runOnceForAllItems',jsCode:notifierCode}}
  ];
  const connections={
    'Every Minute':{main:[[{node:'Notify Instagram Order Status',type:'main',index:0}]]},
    'Manual Status Sync':{main:[[{node:'Notify Instagram Order Status',type:'main',index:0}]]}
  };
  const settings={executionOrder:'v1',timezone:'America/Guatemala'};
  const listed=await n8n('/workflows?limit=100');
  const existing=(listed.data||[]).find(w=>w.name===WORKFLOW_NAME);
  let id;
  if(existing){
    id=existing.id;
    await n8n('/workflows/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify({name:WORKFLOW_NAME,nodes,connections,settings})});
    console.log('[IG_ORDER_STATUS_INSTALL] updated '+id);
  }else{
    const created=await n8n('/workflows',{method:'POST',body:JSON.stringify({name:WORKFLOW_NAME,nodes,connections,settings})});
    id=created.id;
    console.log('[IG_ORDER_STATUS_INSTALL] created '+id);
  }
  await n8n('/workflows/'+encodeURIComponent(id)+'/activate',{method:'POST'});
  console.log('[IG_ORDER_STATUS_INSTALL] active '+JSON.stringify({workflowId:id,webhookPath:WEBHOOK_PATH}));
  try{
    const r=await fetch(N8N_URL+'/webhook/'+WEBHOOK_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'sync',source:'installer'})});
    const t=await r.text();
    console.log('[IG_ORDER_STATUS_INSTALL] smoke '+JSON.stringify({status:r.status,body:t.slice(0,1000)}));
  }catch(e){console.log('[IG_ORDER_STATUS_INSTALL] smoke non-fatal '+String(e?.message||e));}
}

main().catch(e=>{console.error('[IG_ORDER_STATUS_INSTALL] failure: '+String(e?.stack||e?.message||e));process.exitCode=1;});
