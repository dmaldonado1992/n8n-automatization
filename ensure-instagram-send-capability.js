const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID=process.env.INSTAGRAM_SALES_WORKFLOW_ID||'6l5IbTxGdwcL24wT';
const MARKER='/* INSTAGRAM_FACEBOOK_LOGIN_SEND_V4 */';

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
  if(code.includes(MARKER)){console.log('[IG_SEND_CAPABILITY] Facebook Login Instagram sender already installed');return;}

  const block=findFunctionBlock(code,'const sendMeta=async(igAccountId,payload)=>');
  if(!block) throw new Error('sendMeta function not found');

  const replacement=`${MARKER}\nconst sendMeta=async(igAccountId,payload)=>{\n  const ctx=await resolveMetaPageContext(igAccountId);\n  const pageToken=ctx?.token||'';\n  const url='https://graph.facebook.com/v26.0/'+encodeURIComponent(igAccountId)+'/messages';\n  delivery={attempted:true,ok:null,route:'facebook-login-instagram',url,igAccountId,pageId:ctx?.pageId||'',payload:redact(payload)};\n  if(!pageToken){\n    delivery={attempted:true,ok:false,route:'facebook-login-instagram',url,igAccountId,pageId:ctx?.pageId||'',error:{message:'Unable to resolve Facebook Page access token',code:'MISSING_PAGE_TOKEN'}};\n    log('META_SEND_TOKEN_MISSING',{route:'facebook-login-instagram',igAccountId,pageId:ctx?.pageId||''});\n    return null;\n  }\n  const metaHeaders={Authorization:'Bearer '+pageToken,'Content-Type':'application/json'};\n  log('META_SEND_ATTEMPT',{route:'facebook-login-instagram',url,igAccountId,pageId:ctx?.pageId||'',payload});\n  try{\n    const response=await this.helpers.httpRequest({method:'POST',url,headers:metaHeaders,body:payload,json:true,timeout:HTTP_TIMEOUT});\n    delivery={attempted:true,ok:true,route:'facebook-login-instagram',url,igAccountId,pageId:ctx?.pageId||'',response:redact(response)};\n    log('META_SEND_SUCCESS',{route:'facebook-login-instagram',url,igAccountId,pageId:ctx?.pageId||'',response});\n    return response;\n  }catch(e){\n    const detail=errInfo(e);\n    delivery={attempted:true,ok:false,route:'facebook-login-instagram',url,igAccountId,pageId:ctx?.pageId||'',error:detail};\n    log('META_SEND_FAILURE',{route:'facebook-login-instagram',url,igAccountId,pageId:ctx?.pageId||'',error:detail});\n    return null;\n  }\n};`;

  code=code.slice(0,block.start)+replacement+code.slice(block.end);
  node.parameters.jsCode=code;
  await saveAndActivate(wf);
  console.log('[IG_SEND_CAPABILITY] Facebook Login Instagram sender installed '+JSON.stringify({workflowId:WORKFLOW_ID}));
}

main().catch(e=>{console.error('[IG_SEND_CAPABILITY] non-fatal failure: '+String(e?.message||e));});
