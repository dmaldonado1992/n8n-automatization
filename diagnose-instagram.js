const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID=process.env.INSTAGRAM_SALES_WORKFLOW_ID||'6l5IbTxGdwcL24wT';
const VERIFY_WORKFLOW_ID=process.env.INSTAGRAM_VERIFY_WORKFLOW_ID||'PnM3CU0JZ26urysi';

async function n8n(path){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{headers:{'X-N8N-API-KEY':N8N_API_KEY,'Accept':'application/json'}});
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

function safe(obj,depth=0,seen=new WeakSet()){
  if(depth>6) return '[DEPTH_LIMIT]';
  if(obj==null||typeof obj!=='object') return obj;
  if(seen.has(obj)) return '[CIRCULAR]';
  seen.add(obj);
  if(Array.isArray(obj)) return obj.slice(0,20).map(v=>safe(v,depth+1,seen));
  const out={};
  for(const [k,v] of Object.entries(obj)){
    if(/token|authorization|cookie|secret|api.?key|credential/i.test(k)){out[k]='[REDACTED]';continue;}
    out[k]=safe(v,depth+1,seen);
  }
  return out;
}

const summarizeWorkflow=wf=>({
  id:wf.id,name:wf.name,active:wf.active,
  nodes:(wf.nodes||[]).map(n=>({
    name:n.name,type:n.type,webhookId:n.webhookId||null,
    path:n.parameters?.path||null,httpMethod:n.parameters?.httpMethod||null,
    responseMode:n.parameters?.responseMode||null
  }))
});

function deliveryOutput(execution){
  const runData=execution?.data?.resultData?.runData||{};
  const engineRuns=runData['Dynamic Notion Sales Engine']||[];
  const engine=engineRuns[engineRuns.length-1];
  const output=engine?.data?.main?.[0]?.[0]?.json||null;
  return {engine,output};
}

function latestDeliverySummary(execution){
  const {engine,output}=deliveryOutput(execution);
  return {
    id:execution?.id||null,
    status:execution?.status||null,
    finished:execution?.finished??null,
    startedAt:execution?.startedAt||null,
    engineStatus:engine?.executionStatus||null,
    eventType:output?.eventType||null,
    sender:output?.sender||null,
    igAccountId:output?.igAccountId||null,
    reply:typeof output?.reply==='string'?output.reply:null,
    delivery:safe(output?.delivery??null)
  };
}

function webhookSummary(execution){
  const runData=execution?.data?.resultData?.runData||{};
  const web=runData['Instagram Incoming Message']?.[0]?.data?.main?.[0]?.[0]?.json||{};
  const body=web.body||{};
  const entries=Array.isArray(body.entry)?body.entry:[];
  const events=[];
  for(const entry of entries){
    for(const m of (entry.messaging||[])){
      events.push({
        envelope:'messaging',entryId:String(entry.id||''),
        sender:String(m?.sender?.id||''),recipient:String(m?.recipient?.id||''),
        isSelf:m?.is_self===true,isEcho:m?.message?.is_echo===true,
        mid:m?.message?.mid||m?.postback?.mid||null,
        text:m?.message?.text||null,
        hasPostback:!!m?.postback
      });
    }
    for(const c of (entry.changes||[])){
      const v=c?.value||{};
      events.push({
        envelope:'changes',entryId:String(entry.id||''),field:c?.field||null,
        sender:String(v?.sender?.id||v?.from?.id||''),recipient:String(v?.recipient?.id||''),
        isSelf:v?.is_self===true,isEcho:v?.message?.is_echo===true,
        mid:v?.message?.mid||v?.postback?.mid||null,
        text:v?.message?.text||v?.text||null
      });
    }
  }
  if(body.field&&body.value){
    const v=body.value;
    events.push({
      envelope:'root',entryId:String(body.id||''),field:body.field,
      sender:String(v?.sender?.id||v?.from?.id||''),recipient:String(v?.recipient?.id||''),
      isSelf:v?.is_self===true,isEcho:v?.message?.is_echo===true,
      mid:v?.message?.mid||v?.postback?.mid||null,
      text:v?.message?.text||v?.text||null
    });
  }
  return {id:execution?.id||null,startedAt:execution?.startedAt||null,object:body.object||null,events};
}

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_DIAG] skipped: n8n config missing');return;}
  const [wf,verifyWf]=await Promise.all([
    n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`),
    n8n(`/workflows/${encodeURIComponent(VERIFY_WORKFLOW_ID)}`)
  ]);
  console.log('[IG_DIAG] workflow '+JSON.stringify(summarizeWorkflow(wf)));
  console.log('[IG_DIAG] verification_workflow '+JSON.stringify(summarizeWorkflow(verifyWf)));
  const envKeys=Object.keys(process.env).filter(k=>/(META|INSTAGRAM|IG_)/i.test(k)).sort();
  console.log('[IG_DIAG] env_keys '+JSON.stringify(envKeys));
  try{
    const ex=await n8n(`/executions?workflowId=${encodeURIComponent(WORKFLOW_ID)}&limit=15&includeData=true`);
    const rows=ex.data||ex.results||ex;
    const arr=Array.isArray(rows)?rows:[];
    if(arr.length) console.log('[IG_DIAG] latest_delivery '+JSON.stringify(latestDeliverySummary(arr[0])));
    const attempted=arr.find(e=>deliveryOutput(e).output?.delivery?.attempted===true);
    if(attempted) console.log('[IG_DIAG] latest_attempted_delivery '+JSON.stringify(latestDeliverySummary(attempted)));
    console.log('[IG_DIAG] recent_webhooks '+JSON.stringify(arr.slice(0,5).map(webhookSummary)));
    console.log('[IG_DIAG] executions '+JSON.stringify(arr.map(e=>({id:e.id,status:e.status,finished:e.finished,startedAt:e.startedAt,stoppedAt:e.stoppedAt,mode:e.mode,waitTill:e.waitTill,data:safe(e.data)}))));
  }catch(e){console.log('[IG_DIAG] executions_error '+e.message);}
}
main().catch(e=>{console.error('[IG_DIAG] failed: '+e.message);});
