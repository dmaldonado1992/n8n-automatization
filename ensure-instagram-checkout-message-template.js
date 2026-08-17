const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID=process.env.INSTAGRAM_SALES_WORKFLOW_ID||'6l5IbTxGdwcL24wT';
const MESSAGES_DS='2b0b2910-b9f6-4b07-b666-423dd4c266e7';
const MARKER='/* INSTAGRAM_CHECKOUT_MESSAGE_NOTION_V1 */';

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
    console.log('[IG_CHECKOUT_MESSAGE] activate non-fatal '+String(e?.message||e));
  }
}

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_CHECKOUT_MESSAGE] skipped: n8n config missing');return;}
  const wf=await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`);
  const node=(wf.nodes||[]).find(n=>n.name==='Dynamic Notion Sales Engine');
  if(!node?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine not found');
  let code=node.parameters.jsCode;
  if(code.includes(MARKER)){console.log('[IG_CHECKOUT_MESSAGE] Notion checkout template already installed');return;}

  const nowNeedle='const now=new Date().toISOString();';
  const nowIdx=code.indexOf(nowNeedle);
  if(nowIdx<0) throw new Error('timestamp insertion point not found');

  const helper=`${MARKER}\nconst __salesMessagesDs='${MESSAGES_DS}';\nconst getSalesMessageTemplate=async(templateName,vars={})=>{\n  try{\n    const r=await notionReq('POST','https://api.notion.com/v1/data_sources/'+encodeURIComponent(__salesMessagesDs)+'/query',{\n      filter:{property:'Estado',title:{equals:String(templateName)}},\n      page_size:1\n    });\n    const row=r.results?.[0];\n    if(!row){\n      log('SALES_MESSAGE_TEMPLATE_MISSING',{templateName});\n      return '';\n    }\n    if(!row.properties?.Activo?.checkbox){\n      log('SALES_MESSAGE_TEMPLATE_DISABLED',{templateName});\n      return '';\n    }\n    let message=(row.properties?.['Mensaje Instagram']?.rich_text||[])\n      .map(x=>x?.plain_text??x?.text?.content??'').join('');\n    for(const [key,value] of Object.entries(vars||{})){\n      message=message.replaceAll('{{'+key+'}}',String(value??''));\n    }\n    message=message.trim();\n    log('SALES_MESSAGE_TEMPLATE_RENDERED',{templateName,hasMessage:!!message});\n    return message;\n  }catch(error){\n    log('SALES_MESSAGE_TEMPLATE_FAILURE',{templateName,error:errInfo(error)});\n    return '';\n  }\n};\n`;
  code=code.slice(0,nowIdx)+helper+code.slice(nowIdx);

  const old="reply='Pedido #'+orderNumber+' registrado. Total: Q'+total+'. Te avisaremos cuando esté en camino.';";
  const replacement="reply=await getSalesMessageTemplate('Pedido registrado',{pedido:orderNumber,total});";
  if(!code.includes(old)) throw new Error('hardcoded checkout confirmation source not found');
  code=code.replace(old,replacement);

  node.parameters.jsCode=code;
  await saveAndActivate(wf);
  console.log('[IG_CHECKOUT_MESSAGE] Notion checkout template installed '+JSON.stringify({workflowId:WORKFLOW_ID,messagesDataSource:MESSAGES_DS}));
}

main().catch(e=>{console.error('[IG_CHECKOUT_MESSAGE] non-fatal failure: '+String(e?.message||e));});
