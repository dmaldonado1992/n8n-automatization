const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID=process.env.INSTAGRAM_SALES_WORKFLOW_ID||'6l5IbTxGdwcL24wT';
const MARKER='/* INSTAGRAM_SEND_CAPABILITY_FALLBACK_V1 */';

async function n8n(path,options={}){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{
    ...options,
    headers:{'X-N8N-API-KEY':N8N_API_KEY,'Content-Type':'application/json',...(options.headers||{})}
  });
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

function findFunctionBlock(code,startNeedle){
  const start=code.indexOf(startNeedle);
  if(start<0) return null;
  const arrow=code.indexOf('=>',start);
  const open=arrow>=0?code.indexOf('{',arrow):-1;
  if(open<0) return null;
  let depth=0,quote=null,escaped=false;
  for(let i=open;i<code.length;i++){
    const ch=code[i];
    if(quote){
      if(escaped){escaped=false;continue;}
      if(ch==='\\'){escaped=true;continue;}
      if(ch===quote) quote=null;
      continue;
    }
    if(ch==='"'||ch==="'"||ch==='`'){quote=ch;continue;}
    if(ch==='{') depth++;
    else if(ch==='}'){
      depth--;
      if(depth===0){
        let end=i+1;
        if(code[end]===';') end++;
        return {start,end};
      }
    }
  }
  return null;
}

async function saveAndActivate(workflow){
  await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`,{
    method:'PUT',
    body:JSON.stringify({name:workflow.name,nodes:workflow.nodes,connections:workflow.connections,settings:workflow.settings||{}})
  });
  try{await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}/activate`,{method:'POST'});}catch(e){
    console.log('[IG_SEND_CAPABILITY] activate non-fatal '+String(e?.message||e));
  }
}

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_SEND_CAPABILITY] skipped: n8n config missing');return;}
  const wf=await n8n(`/workflows/${encodeURIComponent(WORKFLOW_ID)}`);
  const node=(wf.nodes||[]).find(n=>n.name==='Dynamic Notion Sales Engine');
  if(!node?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine not found');
  let code=node.parameters.jsCode;
  if(code.includes(MARKER)){console.log('[IG_SEND_CAPABILITY] fallback already installed');return;}

  const block=findFunctionBlock(code,'const sendMeta=async(igAccountId,payload)=>');
  if(!block) throw new Error('sendMeta function not found');

  const replacement=`${MARKER}\nconst resolveMetaPageContext=async(igAccountId)=>{\n  const key=String(igAccountId||'');\n  try{\n    const accounts=await this.helpers.httpRequest({\n      method:'GET',\n      url:'https://graph.facebook.com/v26.0/me/accounts',\n      headers:{Authorization:'Bearer '+cfg.meta},\n      qs:{fields:'id,name,access_token,tasks,instagram_business_account{id,username}'},\n      json:true,timeout:HTTP_TIMEOUT\n    });\n    const page=(accounts.data||[]).find(p=>String(p.instagram_business_account?.id||'')===key);\n    if(page?.access_token){\n      return {token:page.access_token,pageId:String(page.id||''),pageName:page.name||null,tasks:page.tasks||[],igAccountId:key};\n    }\n  }catch(e){log('META_PAGE_CONTEXT_FAILURE',{igAccountId:key,error:errInfo(e)});}\n  return {token:cfg.meta,pageId:'',pageName:null,tasks:[],igAccountId:key};\n};\nconst sendMeta=async(igAccountId,payload)=>{\n  const ctx=await resolveMetaPageContext(igAccountId);\n  const metaHeaders={Authorization:'Bearer '+ctx.token,'Content-Type':'application/json'};\n  const body=(payload?.recipient?.id&&!payload.messaging_type)?{...payload,messaging_type:'RESPONSE'}:payload;\n  delivery={attempted:true,ok:null,igAccountId,payload:redact(body)};\n  log('META_SEND_ATTEMPT',{route:'ig-account',igAccountId,pageId:ctx.pageId,payload:body});\n  try{\n    const response=await this.helpers.httpRequest({method:'POST',url:'https://graph.facebook.com/v26.0/'+encodeURIComponent(igAccountId)+'/messages',headers:metaHeaders,body,json:true,timeout:HTTP_TIMEOUT});\n    delivery={attempted:true,ok:true,route:'ig-account',igAccountId,pageId:ctx.pageId,response:redact(response)};\n    log('META_SEND_SUCCESS',{route:'ig-account',igAccountId,pageId:ctx.pageId,response});\n    return response;\n  }catch(e){\n    const first=errInfo(e);\n    const graphCode=Number(e?.response?.body?.error?.code||e?.response?.data?.error?.code||e?.response?.error?.code||0);\n    log('META_SEND_FAILURE',{route:'ig-account',igAccountId,pageId:ctx.pageId,error:first});\n    if(graphCode===3&&ctx.pageId&&payload?.recipient?.id){\n      log('META_SEND_FALLBACK_ATTEMPT',{route:'page',igAccountId,pageId:ctx.pageId,payload:body});\n      try{\n        const response=await this.helpers.httpRequest({method:'POST',url:'https://graph.facebook.com/v26.0/'+encodeURIComponent(ctx.pageId)+'/messages',headers:metaHeaders,body,json:true,timeout:HTTP_TIMEOUT});\n        delivery={attempted:true,ok:true,route:'page',igAccountId,pageId:ctx.pageId,response:redact(response),firstError:first};\n        log('META_SEND_FALLBACK_SUCCESS',{route:'page',igAccountId,pageId:ctx.pageId,response});\n        return response;\n      }catch(e2){\n        const second=errInfo(e2);\n        delivery={attempted:true,ok:false,route:'page-fallback',igAccountId,pageId:ctx.pageId,error:second,firstError:first};\n        log('META_SEND_FALLBACK_FAILURE',{route:'page',igAccountId,pageId:ctx.pageId,error:second,firstError:first});\n        return null;\n      }\n    }\n    delivery={attempted:true,ok:false,route:'ig-account',igAccountId,pageId:ctx.pageId,error:first};\n    return null;\n  }\n};`;

  code=code.slice(0,block.start)+replacement+code.slice(block.end);
  node.parameters.jsCode=code;
  await saveAndActivate(wf);
  console.log('[IG_SEND_CAPABILITY] fallback installed '+JSON.stringify({workflowId:WORKFLOW_ID}));
}

main().catch(e=>{console.error('[IG_SEND_CAPABILITY] non-fatal failure: '+String(e?.message||e));});
