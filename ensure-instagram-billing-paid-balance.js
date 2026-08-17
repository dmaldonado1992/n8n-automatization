const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_NAME='Instagram Sales — Billing Status Notifications';
const NODE_NAME='Notify Instagram Billing Status';
const MARKER='/* BILLING_PAID_BALANCE_SETTLEMENT_V1 */';

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
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_BILLING_BALANCE] skipped: n8n config missing');return;}
  const listed=await n8n('/workflows?limit=100');
  const wf=(listed.data||[]).find(w=>w.name===WORKFLOW_NAME);
  if(!wf) throw new Error('Billing status workflow not found');
  const full=await n8n('/workflows/'+encodeURIComponent(wf.id));
  const node=(full.nodes||[]).find(n=>n.name===NODE_NAME);
  if(!node) throw new Error('Billing status code node not found');
  let code=String(node.parameters?.jsCode||'');
  if(code.includes(MARKER)){
    console.log('[IG_BILLING_BALANCE] paid balance settlement already installed');
    return;
  }

  const oldSummary="const summary={scanned:orders.length,changed:0,sent:0,disabled:0,failed:0,profilesUpdated:0,skippedCooldown:0};";
  const newSummary="const summary={scanned:orders.length,changed:0,sent:0,disabled:0,failed:0,profilesUpdated:0,skippedCooldown:0,balancesSettled:0};";
  if(!code.includes(oldSummary)) throw new Error('Summary anchor not found');
  code=code.replace(oldSummary,newSummary);

  const oldBase=`  const basePatch={};\n  let igsid=rich(props.IGSID).trim();`;
  const newBase=`  const basePatch={};\n  ${MARKER}\n  let saldoCobrado=Number(props['Saldo cobrado']?.number??0);\n  let saldoPendiente=Number(props['Saldo pendiente']?.number??0);\n  if(!Number.isFinite(saldoCobrado)) saldoCobrado=0;\n  if(!Number.isFinite(saldoPendiente)) saldoPendiente=0;\n  if(state==='Pagado'){\n    const previousCobrado=saldoCobrado;\n    const previousPendiente=saldoPendiente;\n    saldoCobrado=previousCobrado+previousPendiente;\n    saldoPendiente=0;\n    basePatch['Saldo cobrado']={number:saldoCobrado};\n    basePatch['Saldo pendiente']={number:0};\n    summary.balancesSettled++;\n    log('BALANCE_SETTLED',{orderId:order.id,previousCobrado,previousPendiente,newCobrado:saldoCobrado,newPendiente:0});\n  }\n  let igsid=rich(props.IGSID).trim();`;
  if(!code.includes(oldBase)) throw new Error('Balance insertion anchor not found');
  code=code.replace(oldBase,newBase);

  const oldVars=`    saldo_cobrado:String(props['Saldo cobrado']?.number??''),\n    saldo_pendiente:String(props['Saldo pendiente']?.number??''),`;
  const newVars=`    saldo_cobrado:String(saldoCobrado),\n    saldo_pendiente:String(saldoPendiente),`;
  if(!code.includes(oldVars)) throw new Error('Balance vars anchor not found');
  code=code.replace(oldVars,newVars);

  node.parameters.jsCode=code;
  const payload={name:full.name,nodes:full.nodes,connections:full.connections,settings:full.settings||{executionOrder:'v1',timezone:'America/Guatemala'}};
  await n8n('/workflows/'+encodeURIComponent(full.id),{method:'PUT',body:JSON.stringify(payload)});
  await n8n('/workflows/'+encodeURIComponent(full.id)+'/activate',{method:'POST'});
  console.log('[IG_BILLING_BALANCE] installed '+JSON.stringify({workflowId:full.id}));
}

main().catch(e=>{console.error('[IG_BILLING_BALANCE] failure: '+String(e?.stack||e?.message||e));process.exitCode=1;});
