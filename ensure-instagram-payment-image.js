const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID=process.env.INSTAGRAM_SALES_WORKFLOW_ID||'6l5IbTxGdwcL24wT';
const MARKER='/* INSTAGRAM_PAYMENT_IMAGE_V1 */';

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
    console.log('[IG_PAYMENT_IMAGE] activate non-fatal '+String(e?.message||e));
  }
}

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_PAYMENT_IMAGE] skipped: n8n config missing');return;}
  const wf=await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`);
  const node=(wf.nodes||[]).find(n=>n.name==='Dynamic Notion Sales Engine');
  if(!node?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine not found');
  let code=node.parameters.jsCode;
  if(code.includes(MARKER)){console.log('[IG_PAYMENT_IMAGE] handler already installed');return;}

  const oldExtract="const lower=text.toLowerCase();\\nconst image=(event.message?.attachments||[]).find(a=>a.type==='image')?.payload?.url||null;\\nconst now=new Date().toISOString();";
  const newExtract=`const lower=text.toLowerCase();\n${MARKER}\nconst attachments=Array.isArray(event.message?.attachments)?event.message.attachments:[];\nconst imageAttachment=attachments.find(a=>String(a?.type||'').toLowerCase()==='image'&&a?.payload?.url);\nconst image=imageAttachment?.payload?.url||null;\nconst ephemeralAttachment=attachments.find(a=>String(a?.type||'').toLowerCase()==='ephemeral')||null;\nconst hasEphemeral=!!ephemeralAttachment;\nconst now=new Date().toISOString();`;
  if(!code.includes(oldExtract)) throw new Error('payment attachment extractor source not found');
  code=code.replace(oldExtract,newExtract);

  const oldLog="log('EVENT_SELECTED',{eventType,sender,igAccountId,text,hasImage:!!image,rawEvent:event});";
  const newLog="log('EVENT_SELECTED',{eventType,sender,igAccountId,text,hasImage:!!image,hasEphemeral,attachmentTypes:attachments.map(a=>a?.type||null),rawEvent:event});";
  if(!code.includes(oldLog)) throw new Error('EVENT_SELECTED logger source not found');
  code=code.replace(oldLog,newLog);

  const oldValidation="const valid=current.expected==='imagen'?!!image:current.expected==='telefono'?/^\\\\+?[0-9 ()-]{7,20}$/.test(text):current.expected==='numero'?/^\\\\d+(\\\\.\\\\d+)?$/.test(text):!!text;\\n    if(!valid){\\n      reply='Necesito recibir '+(current.expected==='imagen'?'una imagen':current.expected==='telefono'?'un teléfono válido':'el dato solicitado')+'. '+current.message;\\n    }else{";
  const newValidation=`const valid=current.expected==='imagen'?!!image:current.expected==='telefono'?/^\\+?[0-9 ()-]{7,20}$/.test(text):current.expected==='numero'?/^\\d+(\\.\\d+)?$/.test(text):!!text;\n    if(current.expected==='imagen'&&hasEphemeral){\n      reply='Recibí la foto, pero Instagram la envió como temporal y no me permite guardar el comprobante. Reenvíala como foto normal desde la galería (no como “Ver una vez” o foto temporal).';\n    }else if(!valid){\n      reply='Necesito recibir '+(current.expected==='imagen'?'una imagen':current.expected==='telefono'?'un teléfono válido':'el dato solicitado')+'. '+current.message;\n    }else{`;
  if(!code.includes(oldValidation)) throw new Error('payment validation source not found');
  code=code.replace(oldValidation,newValidation);

  node.parameters.jsCode=code;
  await saveAndActivate(wf);
  console.log('[IG_PAYMENT_IMAGE] handler installed '+JSON.stringify({workflowId:WORKFLOW_ID}));
}

main().catch(e=>{console.error('[IG_PAYMENT_IMAGE] non-fatal failure: '+String(e?.message||e));});
