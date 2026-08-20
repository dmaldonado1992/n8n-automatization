import fs from 'node:fs';

const file = new URL('./server.js', import.meta.url);
let s = fs.readFileSync(file, 'utf8');
const MARKER = '// EXTENDED_ADMIN_TOOLS_V1';
if (s.includes(MARKER)) {
  console.log('Extended admin MCP tools already installed');
  process.exit(0);
}

const names = [
  'get_instagram_bot_status','get_recent_instagram_executions','diagnose_instagram_message','test_instagram_webhook','get_order_by_instagram_user','get_order_status','update_order_status','get_product_catalog','sync_product_catalog','get_meta_subscription_status','test_instagram_send',
  'search_job_applications','get_job_application','get_application_status','update_application_status','get_recent_job_automation_executions','diagnose_job_application','generate_tailored_cv','generate_cover_letter','get_generated_cv','retry_job_processing','test_job_pipeline','get_job_automation_status',
  'get_workflow_health','diagnose_workflow','get_failed_executions','get_node_execution_data','test_webhook'
];

s = s.replace(
  "const ENGLISH_LEARNING_SYNC_PATH = process.env.ENGLISH_LEARNING_SYNC_PATH || '/webhook/english-learning-sync';",
  "const ENGLISH_LEARNING_SYNC_PATH = process.env.ENGLISH_LEARNING_SYNC_PATH || '/webhook/english-learning-sync';\nconst JOB_APPLICATIONS_SYNC_PATH = process.env.JOB_APPLICATIONS_SYNC_PATH || '/webhook/job-applications-sync';\nconst INSTAGRAM_ADMIN_WEBHOOK_PATH = process.env.INSTAGRAM_ADMIN_WEBHOOK_PATH || '';\nconst JOB_ADMIN_WEBHOOK_PATH = process.env.JOB_ADMIN_WEBHOOK_PATH || JOB_APPLICATIONS_SYNC_PATH;"
);

s = s.replace(
  "  'execute_english_learning_sync'\n];",
  "  'execute_english_learning_sync',\n  " + names.map(n => `'${n}'`).join(',') + "\n];"
);

const helpers = String.raw`
${MARKER}
function redactAdmin(value, key = '') {
  if (/(api[_-]?key|token|secret|password|authorization|client[_-]?secret|access[_-]?token|refresh[_-]?token)/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(v => redactAdmin(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, redactAdmin(v,k)]));
  return value;
}
const adminOutput = data => output(redactAdmin(data));
const arr = r => Array.isArray(r?.data) ? r.data : Array.isArray(r) ? r : [];
async function adminWorkflows() { return arr(await n8n('/workflows?limit=250')); }
async function workflowsLike(rx) { return (await adminWorkflows()).filter(w => rx.test(String(w?.name || ''))); }
async function execs(workflowId, limit=20, includeData=false, status) { return arr(await n8n('/executions'+qs({workflowId,limit,includeData,status}))); }
const compactW = w => ({id:w?.id,name:w?.name,active:w?.active,createdAt:w?.createdAt,updatedAt:w?.updatedAt,projectId:w?.projectId ?? w?.homeProject?.id ?? null});
const compactE = e => ({id:e?.id,workflowId:e?.workflowId,status:e?.status,mode:e?.mode,startedAt:e?.startedAt,stoppedAt:e?.stoppedAt,finished:e?.finished});
function hasAny(v, terms) { const h=JSON.stringify(v ?? {}).toLowerCase(); return terms.filter(Boolean).some(t=>h.includes(String(t).toLowerCase())); }
async function resolveW(idOrName) { try { return await n8n('/workflows/'+encodeURIComponent(idOrName)); } catch {} const ws=await adminWorkflows(); return ws.find(w=>String(w?.name||'').toLowerCase().includes(String(idOrName).toLowerCase())) || null; }
async function health(id,recent=10) { const w=await n8n('/workflows/'+encodeURIComponent(id)); const es=await execs(id,recent,false); const failed=es.filter(e=>['error','crashed'].includes(String(e?.status||'').toLowerCase())); return {workflow:compactW(w),recentExecutions:es.map(compactE),summary:{checked:es.length,failures:failed.length,healthy:Boolean(w?.active)&&failed.length===0}}; }
async function adminHook(path, action, payload={}) { if (!path) return {ok:false,configured:false,reason:'Admin webhook path is not configured'}; return n8nWebhook(path,{action,...payload,source:'chatgpt_n8n_mcp'}); }
`;
s = s.replace('function createServer() {', helpers + '\nfunction createServer() {');

const tools = String.raw`
  // INSTAGRAM ADMIN
  server.tool('get_instagram_bot_status','Summarize Instagram workflows and health.',{},async()=>{const ws=await workflowsLike(/instagram/i);const hs=[];for(const w of ws.slice(0,20))hs.push(await health(w.id,5));return adminOutput({workflowCount:ws.length,workflows:ws.map(compactW),health:hs});});
  server.tool('get_recent_instagram_executions','Get recent Instagram executions.',{limit:z.number().int().min(1).max(100).optional(),includeData:z.boolean().optional()},async({limit=20,includeData=false})=>{const ws=await workflowsLike(/instagram/i),rows=[];for(const w of ws)for(const e of await execs(w.id,limit,includeData))rows.push({...compactE(e),workflowName:w.name,data:includeData?redactAdmin(e):undefined});rows.sort((a,b)=>String(b.startedAt||'').localeCompare(String(a.startedAt||'')));return adminOutput(rows.slice(0,limit));});
  server.tool('diagnose_instagram_message','Find Instagram executions matching sender/message/text.',{senderId:z.string().optional(),messageId:z.string().optional(),text:z.string().optional(),limit:z.number().int().min(1).max(100).optional()},async({senderId,messageId,text,limit=40})=>{const ws=await workflowsLike(/instagram/i),matches=[];for(const w of ws)for(const e of await execs(w.id,limit,true))if(hasAny(e,[senderId,messageId,text]))matches.push({workflow:compactW(w),execution:redactAdmin(e)});return adminOutput({matched:matches.length,matches:matches.slice(0,20)});});
  server.tool('test_instagram_webhook','Test configured Instagram admin webhook.',{payload:z.record(z.any()).optional()},async({payload={}})=>adminOutput(await adminHook(INSTAGRAM_ADMIN_WEBHOOK_PATH,'test_webhook',{payload})));
  for (const [name,desc,schema,action] of [
    ['get_order_by_instagram_user','Get order by Instagram user.',{instagramUserId:z.string()},'get_order_by_instagram_user'],
    ['get_order_status','Get Instagram order status.',{orderId:z.string()},'get_order_status'],
    ['update_order_status','Update Instagram order status.',{orderId:z.string(),status:z.string(),data:z.record(z.any()).optional()},'update_order_status'],
    ['get_product_catalog','Get Instagram product catalog.',{},'get_product_catalog'],
    ['sync_product_catalog','Synchronize product catalog.',{payload:z.record(z.any()).optional()},'sync_product_catalog'],
    ['get_meta_subscription_status','Get Meta subscription status.',{},'get_meta_subscription_status'],
    ['test_instagram_send','Send controlled Instagram test message.',{recipientId:z.string(),text:z.string()},'test_instagram_send']
  ]) server.tool(name,desc,schema,async a=>adminOutput(await adminHook(INSTAGRAM_ADMIN_WEBHOOK_PATH,action,a)));

  // JOB AUTOMATION ADMIN
  for (const [name,desc,schema,action] of [
    ['search_job_applications','Search job applications.',{query:z.string().optional(),status:z.string().optional(),limit:z.number().int().min(1).max(100).optional()},'search_job_applications'],
    ['get_job_application','Get job application.',{id:z.string()},'get_job_application'],
    ['get_application_status','Get application status.',{id:z.string()},'get_application_status'],
    ['update_application_status','Update application status.',{id:z.string(),status:z.string(),note:z.string().optional()},'update_application_status'],
    ['generate_tailored_cv','Generate tailored CV without submitting.',{job:z.record(z.any()),baseCvId:z.string().optional(),language:z.string().optional()},'generate_tailored_cv'],
    ['generate_cover_letter','Generate cover letter.',{job:z.record(z.any()),language:z.string().optional()},'generate_cover_letter'],
    ['get_generated_cv','Get generated CV reference.',{id:z.string()},'get_generated_cv'],
    ['retry_job_processing','Retry job processing.',{id:z.string()},'retry_job_processing']
  ]) server.tool(name,desc,schema,async a=>adminOutput(await adminHook(JOB_ADMIN_WEBHOOK_PATH,action,a)));
  server.tool('test_job_pipeline','Run dry-run job pipeline test; never submit.',{payload:z.record(z.any()).optional()},async({payload={}})=>adminOutput(await adminHook(JOB_ADMIN_WEBHOOK_PATH,'test_job_pipeline',{payload,dryRun:true,submit:false})));
  server.tool('get_recent_job_automation_executions','Get recent job automation executions.',{limit:z.number().int().min(1).max(100).optional(),includeData:z.boolean().optional()},async({limit=20,includeData=false})=>{const ws=await workflowsLike(/job|empleo|vacan|application|postul/i),rows=[];for(const w of ws)for(const e of await execs(w.id,limit,includeData))rows.push({...compactE(e),workflowName:w.name,data:includeData?redactAdmin(e):undefined});rows.sort((a,b)=>String(b.startedAt||'').localeCompare(String(a.startedAt||'')));return adminOutput(rows.slice(0,limit));});
  server.tool('diagnose_job_application','Find job executions matching application/vacancy/company.',{applicationId:z.string().optional(),vacancyId:z.string().optional(),company:z.string().optional(),limit:z.number().int().min(1).max(100).optional()},async({applicationId,vacancyId,company,limit=40})=>{const ws=await workflowsLike(/job|empleo|vacan|application|postul/i),matches=[];for(const w of ws)for(const e of await execs(w.id,limit,true))if(hasAny(e,[applicationId,vacancyId,company]))matches.push({workflow:compactW(w),execution:redactAdmin(e)});return adminOutput({matched:matches.length,matches:matches.slice(0,20)});});
  server.tool('get_job_automation_status','Summarize job workflows and health.',{},async()=>{const ws=await workflowsLike(/job|empleo|vacan|application|postul/i),hs=[];for(const w of ws.slice(0,20))hs.push(await health(w.id,5));return adminOutput({workflowCount:ws.length,workflows:ws.map(compactW),health:hs});});

  // DIAGNOSTICS
  server.tool('get_workflow_health','Summarize workflow health.',{idOrName:z.string(),recent:z.number().int().min(1).max(100).optional()},async({idOrName,recent=10})=>{const w=await resolveW(idOrName);return adminOutput(w?await health(w.id,recent):{found:false,idOrName});});
  server.tool('diagnose_workflow','Get workflow plus recent failed execution data.',{idOrName:z.string(),limit:z.number().int().min(1).max(50).optional()},async({idOrName,limit=10})=>{const w=await resolveW(idOrName);if(!w)return adminOutput({found:false,idOrName});const es=await execs(w.id,limit,true);return adminOutput({workflow:compactW(w),recent:es.map(compactE),failures:es.filter(e=>String(e?.status||'').toLowerCase()==='error').map(redactAdmin)});});
  server.tool('get_failed_executions','List failed executions.',{workflowId:z.string().optional(),limit:z.number().int().min(1).max(100).optional(),includeData:z.boolean().optional()},async({workflowId,limit=20,includeData=false})=>adminOutput(await n8n('/executions'+qs({workflowId,status:'error',limit,includeData}))));
  server.tool('get_node_execution_data','Get run data for one node in an execution.',{executionId:z.string(),nodeName:z.string()},async({executionId,nodeName})=>{const e=await n8n('/executions/'+encodeURIComponent(executionId)+'?includeData=true');const rd=e?.data?.resultData?.runData||e?.data?.runData||{};return adminOutput({executionId,nodeName,found:Object.prototype.hasOwnProperty.call(rd,nodeName),data:rd[nodeName]??null});});
  server.tool('test_webhook','POST a payload to an explicitly supplied n8n webhook path.',{path:z.string().min(1),payload:z.record(z.any()).optional()},async({path,payload={}})=>adminOutput(await n8nWebhook(path,payload)));
`;

s = s.replace("  server.tool('execute_english_learning_sync'", tools + "\n  server.tool('execute_english_learning_sync'");
s = s.replaceAll("version: '1.4.0'", "version: '1.5.0'").replaceAll("version:'1.4.0'", "version:'1.5.0'");
fs.writeFileSync(file, s);
console.log(`Installed ${names.length} extended admin MCP tools`);
