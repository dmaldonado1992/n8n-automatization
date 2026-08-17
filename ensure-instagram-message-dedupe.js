const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID='6l5IbTxGdwcL24wT';
const MARKER='/* INSTAGRAM_MESSAGE_DEDUPE_V1 */';

async function n8n(path,options={}){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{
    ...options,
    headers:{'X-N8N-API-KEY':N8N_API_KEY,'Content-Type':'application/json',...(options.headers||{})}
  });
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

function replaceOnce(code,from,to,label){
  if(!code.includes(from)) throw new Error(`Missing anchor: ${label}`);
  return code.replace(from,to);
}

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_MESSAGE_DEDUPE] skipped: n8n config missing');return;}
  const wf=await n8n('/workflows/'+WORKFLOW_ID);
  const node=(wf.nodes||[]).find(n=>n.name==='Dynamic Notion Sales Engine');
  if(!node?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine node not found');
  let code=String(node.parameters.jsCode);
  if(code.includes(MARKER)){
    console.log('[IG_MESSAGE_DEDUPE] already installed');
    return;
  }

  const senderGuard="if(!sender||!igAccountId) return [{json:{ok:true,ignored:true,eventType,reason:'Instagram event without sender/account id'}}];";
  const emptyGuard=`${senderGuard}\n${MARKER}\nif(eventType==='messages'&&!text&&!image&&!hasEphemeral){\n  log('IGNORED_EMPTY_MESSAGE_EVENT',{sender,igAccountId,attachmentTypes:attachments.map(a=>a?.type||null)});\n  return [{json:{ok:true,ignored:true,eventType,sender,igAccountId,reason:'Instagram message event without text or usable media'}}];\n}`;
  code=replaceOnce(code,senderGuard,emptyGuard,'empty message guard');

  const retryOld="reply='Por favor elige un método de pago: Efectivo o Transferencia.\\n\\n'+current.message;";
  const retryNew="reply=current.message||'Por favor elige un método de pago: Efectivo o Transferencia.';";
  code=replaceOnce(code,retryOld,retryNew,'payment retry text');

  const billingState="'Estado facturación':{select:{name:'Pendiente'}},";
  const baselineFields="'Estado facturación':{select:{name:'Pendiente'}},'Último estado notificado':{rich_text:[{text:{content:'Recibido'}}]},'Fecha última notificación':{date:{start:now}},'Último estado facturación notificado':{rich_text:[{text:{content:'Pendiente'}}]},'Fecha última notificación facturación':{date:{start:now}},";
  const occurrences=code.split(billingState).length-1;
  if(occurrences<2) throw new Error(`Expected at least 2 billing-state anchors, found ${occurrences}`);
  code=code.split(billingState).join(baselineFields);

  const cashOld="reply=await getSalesMessageTemplate('Pedido registrado',{pedido:orderNumber,total,metodo_pago:'Efectivo'});";
  const cashNew="reply=await getSalesMessageTemplate('Pedido registrado · Efectivo',{nombre:clientName||igUsername||'',username:igUsername||'',pedido:orderNumber,total,metodo_pago:'Efectivo'}); if(!reply) reply='Hola '+(clientName||igUsername||'')+' 👋 Recibimos tu pedido #'+orderNumber+'. Ya estamos preparando tu pedido. Total: Q'+total+'.';";
  code=replaceOnce(code,cashOld,cashNew,'cash confirmation template');

  const transferOld="reply=await getSalesMessageTemplate('Pedido registrado',{pedido:orderNumber,total});";
  const transferNew="reply=await getSalesMessageTemplate('Facturación · Pendiente',{nombre:clientName||igUsername||'',username:igUsername||'',pedido:orderNumber,total,estado_facturacion:'Pendiente',metodo_pago:'Transferencia'}); if(!reply) reply='🧾 Hola '+(clientName||igUsername||'')+'. El pago de tu pedido #'+orderNumber+' está pendiente de confirmación. Total del pedido: Q'+total+'.';";
  code=replaceOnce(code,transferOld,transferNew,'transfer pending template');

  node.parameters.jsCode=code;
  const payload={name:wf.name,nodes:wf.nodes,connections:wf.connections,settings:wf.settings||{}};
  await n8n('/workflows/'+WORKFLOW_ID,{method:'PUT',body:JSON.stringify(payload)});
  console.log('[IG_MESSAGE_DEDUPE] installed '+JSON.stringify({workflowId:WORKFLOW_ID,marker:MARKER,baselineAnchors:occurrences}));
}

main().catch(e=>{console.error('[IG_MESSAGE_DEDUPE] failure: '+String(e?.stack||e?.message||e));process.exitCode=1;});
