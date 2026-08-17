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

  const imageNeedle="const image=(event.message?.attachments||[]).find(a=>a.type==='image')?.payload?.url||null;";
  const imageIdx=code.indexOf(imageNeedle);
  if(imageIdx<0) throw new Error('payment attachment extractor source not found');
  const imageReplacement=`${MARKER}\nconst attachments=Array.isArray(event.message?.attachments)?event.message.attachments:[];\nconst imageAttachment=attachments.find(a=>String(a?.type||'').toLowerCase()==='image'&&a?.payload?.url);\nconst image=imageAttachment?.payload?.url||null;\nconst ephemeralAttachment=attachments.find(a=>String(a?.type||'').toLowerCase()==='ephemeral')||null;\nconst hasEphemeral=!!ephemeralAttachment;`;
  code=code.slice(0,imageIdx)+imageReplacement+code.slice(imageIdx+imageNeedle.length);

  const oldLog="log('EVENT_SELECTED',{eventType,sender,igAccountId,text,hasImage:!!image,rawEvent:event});";
  const newLog="log('EVENT_SELECTED',{eventType,sender,igAccountId,text,hasImage:!!image,hasEphemeral,attachmentTypes:attachments.map(a=>a?.type||null),rawEvent:event});";
  if(code.includes(oldLog)) code=code.replace(oldLog,newLog);

  const validIdx=code.indexOf("const valid=current.expected==='imagen'?!!image:");
  if(validIdx<0) throw new Error('payment validation source not found');
  const ifIdx=code.indexOf('if(!valid){',validIdx);
  if(ifIdx<0) throw new Error('payment invalid branch not found');
  const branch="if(current.expected==='imagen'&&hasEphemeral){\n      reply='Recibí la foto, pero Instagram la envió como temporal y no me permite guardar el comprobante. Reenvíala como foto normal desde la galería (no como “Ver una vez” o foto temporal).';\n    }else if(!valid){";
  code=code.slice(0,ifIdx)+branch+code.slice(ifIdx+'if(!valid){'.length);

  node.parameters.jsCode=code;
  await saveAndActivate(wf);
  console.log('[IG_PAYMENT_IMAGE] handler installed '+JSON.stringify({workflowId:WORKFLOW_ID}));
}

main().catch(e=>{console.error('[IG_PAYMENT_IMAGE] non-fatal failure: '+String(e?.message||e));});
