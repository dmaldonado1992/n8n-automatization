const N8N_URL = (process.env.N8N_URL || '').replace(/\/$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const WORKFLOW_ID = process.env.INSTAGRAM_SALES_WORKFLOW_ID || '6l5IbTxGdwcL24wT';
const MARKER = '/* INSTAGRAM_SALES_LOG_V1 */';

async function n8n(path, options = {}) {
  if (!N8N_URL || !N8N_API_KEY) throw new Error('N8N_URL and N8N_API_KEY must be configured');
  const response = await fetch(`${N8N_URL}/api/v1${path}`, {
    ...options,
    headers: {
      'X-N8N-API-KEY': N8N_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`n8n ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function instrument(code) {
  if (code.includes(MARKER)) return { code, changed: false };

  const bodyAnchor = "const body=$json.body||{};";
  const parsedAnchor = "const messagingEvents=entries.flatMap(e=>(e.messaging||[]).map(v=>({value:v,igAccountId:String(e.id||v?.recipient?.id||'')})));";
  const sendAnchor = "const sendMeta=(igAccountId,payload)=>this.helpers.httpRequest({method:'POST',url:'https://graph.facebook.com/v26.0/'+encodeURIComponent(igAccountId)+'/messages',headers:metaHeaders,body:payload,json:true});";
  const noEventAnchor = "if(!wrap) return [{json:{ok:true,ignored:true,reason:'No supported customer Instagram event found'}}];";
  const selectedAnchor = "const image=(event.message?.attachments||[]).find(a=>a.type==='image')?.payload?.url||null; const now=new Date().toISOString();";
  const finalReturnAnchor = "return [{json:{ok:true,eventType,sender,igAccountId,reply}}];";

  for (const [name, anchor] of Object.entries({ bodyAnchor, parsedAnchor, sendAnchor, noEventAnchor, selectedAnchor, finalReturnAnchor })) {
    if (!code.includes(anchor)) throw new Error(`Instrumentation anchor not found: ${name}`);
  }

  const logger = `${MARKER}\nconst __igRedact=(value)=>{\n if(value===null||value===undefined)return value;\n if(Array.isArray(value))return value.map(__igRedact);\n if(typeof value!=='object')return value;\n const out={};\n for(const [k,v] of Object.entries(value)){\n  out[k]=/(authorization|cookie|access[_-]?token|secret|api[_-]?key)/i.test(k)?'[REDACTED]':__igRedact(v);\n }\n return out;\n};\nconst __igError=(error)=>({message:String(error?.message||error),name:error?.name||null,statusCode:error?.statusCode||error?.status||error?.httpCode||null,description:error?.description||null,response:__igRedact(error?.response?.body||error?.response||error?.cause||null),stack:error?.stack||null});\nconst __igLog=(stage,data={})=>{try{console.log('[INSTAGRAM_SALES] '+JSON.stringify({ts:new Date().toISOString(),stage,...__igRedact(data)}));}catch(e){console.log('[INSTAGRAM_SALES] '+stage+' log_serialization_failed '+String(e?.message||e));}};\nlet __igDelivery={attempted:false,ok:null};`;

  const sendReplacement = `const sendMeta=async(igAccountId,payload)=>{\n __igDelivery={attempted:true,ok:null,igAccountId,payload:__igRedact(payload)};\n __igLog('META_SEND_ATTEMPT',{igAccountId,payload});\n try{\n  const response=await this.helpers.httpRequest({method:'POST',url:'https://graph.facebook.com/v26.0/'+encodeURIComponent(igAccountId)+'/messages',headers:metaHeaders,body:payload,json:true});\n  __igDelivery={attempted:true,ok:true,igAccountId,response:__igRedact(response)};\n  __igLog('META_SEND_SUCCESS',{igAccountId,response});\n  return response;\n }catch(error){\n  const detail=__igError(error);\n  __igDelivery={attempted:true,ok:false,igAccountId,error:detail};\n  __igLog('META_SEND_FAILURE',{igAccountId,payload,error:detail});\n  return null;\n }\n};`;

  let next = code;
  next = next.replace(bodyAnchor, `${logger}\n${bodyAnchor}\n__igLog('WEBHOOK_RECEIVED',{headers:$json.headers||{},params:$json.params||{},query:$json.query||{},body,webhookUrl:$json.webhookUrl||null,executionMode:$json.executionMode||null});`);
  next = next.replace(parsedAnchor, `${parsedAnchor}\n__igLog('EVENTS_PARSED',{object:body.object||null,entryCount:entries.length,fieldEvents,messagingEvents});`);
  next = next.replace(sendAnchor, sendReplacement);
  next = next.replace(noEventAnchor, `if(!wrap){__igLog('EVENT_IGNORED',{reason:'No supported customer Instagram event found',fieldEvents,messagingEvents});return [{json:{ok:true,ignored:true,reason:'No supported customer Instagram event found',delivery:__igDelivery}}];}`);
  next = next.replace(selectedAnchor, `${selectedAnchor}\n__igLog('EVENT_SELECTED',{eventType,sender,igAccountId,text,hasImage:!!image,rawEvent:event});`);
  next = next.replace(finalReturnAnchor, "__igLog('ENGINE_RESULT',{ok:true,eventType,sender,igAccountId,reply,delivery:__igDelivery});\nreturn [{json:{ok:true,eventType,sender,igAccountId,reply,delivery:__igDelivery}}];");

  // Add delivery result to the comment/referral success paths when those exact shapes are present.
  next = next.replace(
    "return [{json:{ok:true,eventType:isLive?'live_comment':'comment',privateReplySent:true,sender,commentId:String(c.id),reply}}];",
    "__igLog('ENGINE_RESULT',{ok:true,eventType:isLive?'live_comment':'comment',privateReplySent:__igDelivery.ok===true,sender,commentId:String(c.id),reply,delivery:__igDelivery});return [{json:{ok:true,eventType:isLive?'live_comment':'comment',privateReplySent:__igDelivery.ok===true,sender,commentId:String(c.id),reply,delivery:__igDelivery}}];"
  );
  next = next.replace(
    "return [{json:{ok:true,eventType:'referral',sender,ref:ev.referral?.ref||'',source:ev.referral?.source||'',referralType:ev.referral?.type||'',reply}}];",
    "__igLog('ENGINE_RESULT',{ok:true,eventType:'referral',sender,ref:ev.referral?.ref||'',source:ev.referral?.source||'',referralType:ev.referral?.type||'',reply,delivery:__igDelivery});return [{json:{ok:true,eventType:'referral',sender,ref:ev.referral?.ref||'',source:ev.referral?.source||'',referralType:ev.referral?.type||'',reply,delivery:__igDelivery}}];"
  );

  return { code: next, changed: true };
}

async function main() {
  if (!N8N_URL || !N8N_API_KEY) {
    console.log('[INSTAGRAM_INSTRUMENT] skipped: N8N_URL/N8N_API_KEY not configured');
    return;
  }

  const workflow = await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`);
  const codeNode = (workflow.nodes || []).find(node => node.name === 'Dynamic Notion Sales Engine');
  if (!codeNode?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine code node not found');

  const result = instrument(codeNode.parameters.jsCode);
  if (!result.changed) {
    console.log('[INSTAGRAM_INSTRUMENT] logging already installed');
    return;
  }

  codeNode.parameters.jsCode = result.code;
  const payload = {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings || {}
  };

  const updated = await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });

  console.log(`[INSTAGRAM_INSTRUMENT] installed on workflow ${updated.id || WORKFLOW_ID}`);
}

main().catch(error => {
  console.error('[INSTAGRAM_INSTRUMENT] failed:', error);
  process.exitCode = 1;
});
