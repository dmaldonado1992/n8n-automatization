const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID=process.env.INSTAGRAM_SALES_WORKFLOW_ID||'6l5IbTxGdwcL24wT';
const MARKER='/* INSTAGRAM_IMAGE_PROMPT_NO_REDUNDANT_PREFIX */';

async function n8n(path,options={}){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{
    ...options,
    headers:{'X-N8N-API-KEY':N8N_API_KEY,'Content-Type':'application/json',...(options.headers||{})}
  });
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_IMAGE_PROMPT] skipped: n8n config missing');return;}
  const wf=await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`);
  const node=(wf.nodes||[]).find(n=>n.name==='Dynamic Notion Sales Engine');
  if(!node?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine not found');
  let code=node.parameters.jsCode;
  if(code.includes(MARKER)){console.log('[IG_IMAGE_PROMPT] redundant image prefix already removed');return;}

  const oldLine="reply='Necesito recibir '+(current.expected==='imagen'?'una imagen':current.expected==='telefono'?'un teléfono válido':'el dato solicitado')+'. '+current.message;";
  const newLine=`${MARKER}\n      reply=current.expected==='imagen'?current.message:'Necesito recibir '+(current.expected==='telefono'?'un teléfono válido':'el dato solicitado')+'. '+current.message;`;
  if(!code.includes(oldLine)) throw new Error('image validation reply source not found');
  code=code.replace(oldLine,newLine);
  node.parameters.jsCode=code;

  await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`,{
    method:'PUT',
    body:JSON.stringify({name:wf.name,nodes:wf.nodes,connections:wf.connections,settings:wf.settings||{}})
  });
  try{await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}/activate`,{method:'POST'});}catch(e){console.log('[IG_IMAGE_PROMPT] activate non-fatal '+String(e?.message||e));}
  console.log('[IG_IMAGE_PROMPT] removed redundant image prompt prefix '+JSON.stringify({workflowId:WORKFLOW_ID}));
}

main().catch(e=>{console.error('[IG_IMAGE_PROMPT] non-fatal failure: '+String(e?.message||e));});
