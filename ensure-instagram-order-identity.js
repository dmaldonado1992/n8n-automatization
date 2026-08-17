const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID=process.env.INSTAGRAM_SALES_WORKFLOW_ID||'6l5IbTxGdwcL24wT';
const MARKER='/* INSTAGRAM_ORDER_IDENTITY_V1 */';

async function n8n(path,options={}){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{
    ...options,
    headers:{'X-N8N-API-KEY':N8N_API_KEY,'Content-Type':'application/json',...(options.headers||{})}
  });
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

async function saveAndActivate(workflow){
  await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`,{
    method:'PUT',
    body:JSON.stringify({name:workflow.name,nodes:workflow.nodes,connections:workflow.connections,settings:workflow.settings||{}})
  });
  try{await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}/activate`,{method:'POST'});}catch(e){
    console.log('[IG_ORDER_IDENTITY] activate non-fatal '+String(e?.message||e));
  }
}

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_ORDER_IDENTITY] skipped: n8n config missing');return;}
  const wf=await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`);
  const node=(wf.nodes||[]).find(n=>n.name==='Dynamic Notion Sales Engine');
  if(!node?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine not found');
  let code=node.parameters.jsCode;
  if(code.includes(MARKER)){console.log('[IG_ORDER_IDENTITY] handler already installed');return;}

  // The Notion title property was renamed from "IG username" to "IGSID".
  code=code.replaceAll("property:'IG username'","property:'IGSID'");
  code=code.replaceAll("'IG username':{title:[{text:{content:sender}}]}","'IGSID':{title:[{text:{content:sender}}]}");

  const nowNeedle='const now=new Date().toISOString();';
  const nowIdx=code.indexOf(nowNeedle);
  if(nowIdx<0) throw new Error('timestamp insertion point not found');
  const helper=`${MARKER}\nconst __boolEnv=(v,fallback=false)=>v==null||v===''?fallback:/^(1|true|yes|on)$/i.test(String(v));\nconst nextOrderNumber=async()=>{\n  const {Client}=require('pg');\n  const sslEnabled=__boolEnv($env.DB_POSTGRESDB_SSL_ENABLED,false);\n  const client=new Client({\n    host:$env.DB_POSTGRESDB_HOST,\n    port:Number($env.DB_POSTGRESDB_PORT||5432),\n    database:$env.DB_POSTGRESDB_DATABASE,\n    user:$env.DB_POSTGRESDB_USER,\n    password:$env.DB_POSTGRESDB_PASSWORD,\n    connectionTimeoutMillis:6000,\n    ssl:sslEnabled?{rejectUnauthorized:__boolEnv($env.DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED,false)}:false\n  });\n  await client.connect();\n  try{\n    const r=await client.query(\"SELECT nextval('public.instagram_order_number_seq')::bigint AS order_number\");\n    const n=Number(r.rows?.[0]?.order_number);\n    if(!Number.isSafeInteger(n)||n<1000) throw new Error('Invalid order sequence value');\n    log('ORDER_NUMBER_ALLOCATED',{orderNumber:n});\n    return n;\n  }finally{await client.end();}\n};\nconst resolveInstagramProfile=async(senderId,accountId)=>{\n  try{\n    const ctx=await resolveMetaPageContext(accountId);\n    const profile=await this.helpers.httpRequest({\n      method:'GET',\n      url:'https://graph.facebook.com/v26.0/'+encodeURIComponent(senderId),\n      headers:{Authorization:'Bearer '+ctx.token},\n      qs:{fields:'name,username'},\n      json:true,timeout:HTTP_TIMEOUT\n    });\n    const out={name:String(profile?.name||''),username:String(profile?.username||'')};\n    log('INSTAGRAM_PROFILE_RESOLVED',{sender:senderId,username:out.username||null,hasName:!!out.name});\n    return out;\n  }catch(error){\n    log('INSTAGRAM_PROFILE_FAILURE',{sender:senderId,error:errInfo(error)});\n    return {name:'',username:''};\n  }\n};\n`;
  code=code.slice(0,nowIdx)+helper+code.slice(nowIdx);

  const createSessionOld="await notionReq('POST','https://api.notion.com/v1/pages',{parent:{database_id:cfg.sessions},properties:{'IGSID':{title:[{text:{content:sender}}]},'Producto elegido':{relation:[{id:product.id}]},Cantidad:{number:1},'Paso actual':{relation:[{id:first.id}]},'Última actividad':{date:{start:now}}}});\n      reply='El '+product.name+' cuesta Q'+product.price+'. '+(product.shipping?'El envío cuesta Q'+product.shipping+'. ':'')+first.message;";
  const createSessionNew="const [profile,orderNumber]=await Promise.all([resolveInstagramProfile(sender,igAccountId),nextOrderNumber()]);\n      await notionReq('POST','https://api.notion.com/v1/pages',{parent:{database_id:cfg.sessions},properties:{'IGSID':{title:[{text:{content:sender}}]},'Usuario Instagram':{rich_text:profile.username?[{text:{content:profile.username}}]:[]},'Nombre cliente':{rich_text:profile.name?[{text:{content:profile.name}}]:[]},'Pedido #':{number:orderNumber},'Producto elegido':{relation:[{id:product.id}]},Cantidad:{number:1},'Paso actual':{relation:[{id:first.id}]},'Última actividad':{date:{start:now}}}});\n      reply='Pedido #'+orderNumber+' iniciado. El '+product.name+' cuesta Q'+product.price+'. '+(product.shipping?'El envío cuesta Q'+product.shipping+'. ':'')+first.message;";
  if(!code.includes(createSessionOld)) throw new Error('session creation source not found');
  code=code.replace(createSessionOld,createSessionNew);

  const existingNeedle="  }else{\n    const currentId=session.properties['Paso actual']?.relation?.[0]?.id;";
  const existingReplacement="  }else{\n    let orderNumber=session.properties['Pedido #']?.number||null;\n    let igUsername=rich(session.properties['Usuario Instagram']);\n    let clientName=rich(session.properties['Nombre cliente']);\n    if(!orderNumber||!igUsername||!clientName){\n      const profile=await resolveInstagramProfile(sender,igAccountId);\n      const identityProps={};\n      if(!orderNumber){orderNumber=await nextOrderNumber();identityProps['Pedido #']={number:orderNumber};}\n      if(!igUsername&&profile.username){igUsername=profile.username;identityProps['Usuario Instagram']={rich_text:[{text:{content:igUsername}}]};}\n      if(!clientName&&profile.name){clientName=profile.name;identityProps['Nombre cliente']={rich_text:[{text:{content:clientName}}]};}\n      if(Object.keys(identityProps).length) await notionReq('PATCH','https://api.notion.com/v1/pages/'+session.id,{properties:identityProps});\n    }\n    const currentId=session.properties['Paso actual']?.relation?.[0]?.id;";
  if(!code.includes(existingNeedle)) throw new Error('existing session source not found');
  code=code.replace(existingNeedle,existingReplacement);

  const orderPrefixOld="const orderProps={Name:{title:[{text:{content:'Pedido Instagram - '+sender}}]},'Teléfono':{phone_number:phone},'Instagram username':{rich_text:[{text:{content:sender}}]},";
  const orderPrefixNew="const orderProps={Name:{title:[{text:{content:'Pedido #'+orderNumber+(igUsername?' - @'+igUsername:'')}}]},'Teléfono':{phone_number:phone},'IGSID':{rich_text:[{text:{content:sender}}]},'Usuario Instagram':{rich_text:igUsername?[{text:{content:igUsername}}]:[]},'Nombre cliente':{rich_text:clientName?[{text:{content:clientName}}]:[]},'Pedido #':{number:orderNumber},";
  if(!code.includes(orderPrefixOld)) throw new Error('order identity source not found');
  code=code.replace(orderPrefixOld,orderPrefixNew);

  const replyOld="reply='Pedido registrado. Total: Q'+total+'. Te avisaremos cuando esté en camino.';";
  const replyNew="reply='Pedido #'+orderNumber+' registrado. Total: Q'+total+'. Te avisaremos cuando esté en camino.';";
  if(code.includes(replyOld)) code=code.replace(replyOld,replyNew);

  node.parameters.jsCode=code;
  await saveAndActivate(wf);
  console.log('[IG_ORDER_IDENTITY] handler installed '+JSON.stringify({workflowId:WORKFLOW_ID}));
}

main().catch(e=>{console.error('[IG_ORDER_IDENTITY] non-fatal failure: '+String(e?.message||e));});
