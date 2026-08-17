const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID=process.env.INSTAGRAM_SALES_WORKFLOW_ID||'6l5IbTxGdwcL24wT';
const MARKER_V1='/* INSTAGRAM_PAYMENT_IMAGE_V1 */';
const MARKER_V2='/* INSTAGRAM_PAYMENT_IMAGE_NOTION_UPLOAD_V2 */';

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
  if(code.includes(MARKER_V2)){console.log('[IG_PAYMENT_IMAGE] Notion upload handler already installed');return;}

  // Preserve/upgrade the V1 attachment recognition when needed.
  if(!code.includes(MARKER_V1)){
    const imageNeedle="const image=(event.message?.attachments||[]).find(a=>a.type==='image')?.payload?.url||null;";
    const imageIdx=code.indexOf(imageNeedle);
    if(imageIdx<0) throw new Error('payment attachment extractor source not found');
    const imageReplacement=`${MARKER_V1}\nconst attachments=Array.isArray(event.message?.attachments)?event.message.attachments:[];\nconst imageAttachment=attachments.find(a=>String(a?.type||'').toLowerCase()==='image'&&a?.payload?.url);\nconst image=imageAttachment?.payload?.url||null;\nconst ephemeralAttachment=attachments.find(a=>String(a?.type||'').toLowerCase()==='ephemeral')||null;\nconst hasEphemeral=!!ephemeralAttachment;`;
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
  }

  // Inject a byte-copy uploader: Meta CDN -> n8n Buffer -> Notion File Upload API.
  const nowNeedle='const now=new Date().toISOString();';
  const nowIdx=code.indexOf(nowNeedle);
  if(nowIdx<0) throw new Error('event timestamp source not found');
  const uploader=`${MARKER_V2}\nconst uploadNotionReceipt=async(sourceUrl)=>{\n  const media=await this.helpers.httpRequest({method:'GET',url:sourceUrl,encoding:'arraybuffer',returnFullResponse:true,timeout:15000});\n  const bytes=media?.body;\n  if(!bytes||!bytes.length) throw new Error('Meta receipt download returned no bytes');\n  const rawType=String(media?.headers?.['content-type']||media?.headers?.['Content-Type']||'image/jpeg');\n  const contentType=rawType.split(';')[0].trim().toLowerCase()||'image/jpeg';\n  const extMap={'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','image/heic':'heic','image/heif':'heif','application/pdf':'pdf'};\n  const ext=extMap[contentType]||'jpg';\n  const filename='comprobante-'+Date.now()+'.'+ext;\n  log('NOTION_RECEIPT_DOWNLOAD_SUCCESS',{bytes:bytes.length,contentType,filename});\n\n  const created=await this.helpers.httpRequest({\n    method:'POST',\n    url:'https://api.notion.com/v1/file_uploads',\n    headers:{Authorization:'Bearer '+cfg.notion,'Notion-Version':'2026-03-11','Content-Type':'application/json'},\n    body:{mode:'single_part',filename,content_type:contentType},\n    json:true,\n    timeout:15000\n  });\n  if(!created?.id) throw new Error('Notion did not return a file_upload id');\n\n  if(typeof FormData==='undefined'||typeof Blob==='undefined') throw new Error('Native FormData/Blob unavailable in n8n Code node');\n  const form=new FormData();\n  form.append('file',new Blob([bytes],{type:contentType}),filename);\n  let sent=await this.helpers.httpRequest({\n    method:'POST',\n    url:'https://api.notion.com/v1/file_uploads/'+encodeURIComponent(created.id)+'/send',\n    headers:{Authorization:'Bearer '+cfg.notion,'Notion-Version':'2026-03-11'},\n    body:form,\n    encoding:'json',\n    timeout:30000\n  });\n\n  for(let i=0;i<5&&sent?.status!=='uploaded';i++){\n    await new Promise(r=>setTimeout(r,250));\n    sent=await this.helpers.httpRequest({\n      method:'GET',\n      url:'https://api.notion.com/v1/file_uploads/'+encodeURIComponent(created.id),\n      headers:{Authorization:'Bearer '+cfg.notion,'Notion-Version':'2026-03-11'},\n      encoding:'json',\n      timeout:10000\n    });\n    if(sent?.status==='failed'||sent?.status==='expired') break;\n  }\n  if(sent?.status!=='uploaded') throw new Error('Notion file upload status: '+String(sent?.status||'unknown'));\n  log('NOTION_RECEIPT_UPLOAD_SUCCESS',{fileUploadId:created.id,bytes:bytes.length,contentType,filename});\n  return {id:created.id,filename,contentType,size:bytes.length};\n};\n`;
  code=code.slice(0,nowIdx)+uploader+code.slice(nowIdx);

  const oldSave="if(image) orderProps['Foto boleta']={files:[{name:'comprobante.jpg',external:{url:image}}]};";
  if(!code.includes(oldSave)) throw new Error('legacy external receipt save source not found');
  const newSave="if(image){ const receiptUpload=await uploadNotionReceipt(image); orderProps['Foto boleta']={files:[{name:receiptUpload.filename,type:'file_upload',file_upload:{id:receiptUpload.id}}]}; }";
  code=code.replace(oldSave,newSave);

  node.parameters.jsCode=code;
  await saveAndActivate(wf);
  console.log('[IG_PAYMENT_IMAGE] Notion byte-upload handler installed '+JSON.stringify({workflowId:WORKFLOW_ID}));
}

main().catch(e=>{console.error('[IG_PAYMENT_IMAGE] non-fatal failure: '+String(e?.message||e));});
