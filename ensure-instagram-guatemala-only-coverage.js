const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const NOTION_API_KEY=process.env.NOTION_API_KEY||'';
const WORKFLOW_ID='6l5IbTxGdwcL24wT';
const MARKER='/* INSTAGRAM_GUATEMALA_ONLY_COVERAGE_V1 */';
const SESSIONS_DB='03b8bddb49ce40d3bee435b2c25863ab';
const COVERAGE_STEP='3bf62fd8-699b-816c-b3cb-f85e91daf421';
const DOWNSTREAM_STEPS=new Set([
  '3bf62fd8-699b-8144-941c-e16aab625696',
  '3be62fd8-699b-8192-90c5-e376d49dd31b',
  '3be62fd8-699b-8168-9f95-feea1d0f5315',
  '3bf62fd8-699b-8185-8d1e-c7bf5ccfa7d4',
  '3be62fd8-699b-813e-b816-e27f06cc18d1'
]);

async function n8n(path,options={}){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{
    ...options,
    headers:{'X-N8N-API-KEY':N8N_API_KEY,'Content-Type':'application/json',...(options.headers||{})}
  });
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

async function notion(method,url,body){
  const r=await fetch(url,{
    method,
    headers:{Authorization:'Bearer '+NOTION_API_KEY,'Notion-Version':'2022-06-28','Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined
  });
  const t=await r.text();
  if(!r.ok) throw new Error(`Notion ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

async function migrateOpenSessions(){
  if(!NOTION_API_KEY){console.log('[IG_GUATEMALA_COVERAGE] session migration skipped: NOTION_API_KEY missing');return;}
  let cursor;
  let migrated=0;
  do{
    const payload={page_size:100};
    if(cursor) payload.start_cursor=cursor;
    const q=await notion('POST',`https://api.notion.com/v1/databases/${SESSIONS_DB}/query`,payload);
    for(const row of q.results||[]){
      const current=row.properties?.['Paso actual']?.relation?.[0]?.id||'';
      if(!DOWNSTREAM_STEPS.has(current)) continue;
      await notion('PATCH',`https://api.notion.com/v1/pages/${row.id}`,{properties:{
        'Paso actual':{relation:[{id:COVERAGE_STEP}]},
        'Departamento (temporal)':{rich_text:[]},
        'Código departamento (temporal)':{rich_text:[]},
        'Municipio (temporal)':{rich_text:[]},
        'Código municipio (temporal)':{rich_text:[]},
        'Dirección (temporal)':{rich_text:[]},
        'Teléfono (temporal)':{phone_number:null},
        'Método de pago (temporal)':{rich_text:[]},
        'Última actividad':{date:{start:new Date().toISOString()}}
      }});
      migrated++;
    }
    cursor=q.has_more?q.next_cursor:null;
  }while(cursor);
  console.log('[IG_GUATEMALA_COVERAGE] migrated sessions '+migrated);
}

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_GUATEMALA_COVERAGE] skipped: n8n config missing');return;}
  const wf=await n8n('/workflows/'+WORKFLOW_ID);
  const node=(wf.nodes||[]).find(n=>n.name==='Dynamic Notion Sales Engine');
  if(!node?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine node not found');
  let code=String(node.parameters.jsCode);
  if(!code.includes(MARKER)){
    const anchor="    }else if(current.field==='departamento'){";
    if(!code.includes(anchor)) throw new Error('Missing checkout coverage branch anchor');
    const branch=`    }else if(current.field==='cobertura_guatemala'){
      ${MARKER}
      const n=__normProduct(text);
      const yes=/^(si|s|yes|claro|correcto|afirmativo)\\b/.test(n)||n==='guatemala'||n==='departamento de guatemala';
      const no=/^(no|n|nop|nope|negativo)\\b/.test(n)||/fuera de guatemala|otro departamento|no esta en guatemala|no se encuentra en guatemala/.test(n);
      if(!yes&&!no){
        reply='Por favor responde Sí o No. '+currentPrompt;
      }else if(no){
        const noCoverage=await getSalesMessageTemplate('Sin cobertura Guatemala',{nombre:clientName||'',username:igUsername||'',pedido:orderNumber||''});
        await notionReq('PATCH','https://api.notion.com/v1/pages/'+session.id,{archived:true});
        reply=noCoverage||'¡Gracias por preferirnos! 💛 Por el momento, nuestras entregas están disponibles únicamente dentro del departamento de Guatemala. Lamentablemente todavía no contamos con cobertura en otros departamentos, pero estamos trabajando para llegar a más lugares muy pronto. Te informaremos cuando ampliemos nuestra zona de entrega. ¡Esperamos poder atenderte pronto!';
      }else{
        const next=steps.find(s=>s.order>current.order);
        if(!next) throw new Error('No active step found after cobertura_guatemala');
        await notionReq('PATCH','https://api.notion.com/v1/pages/'+session.id,{properties:{
          'Departamento (temporal)':{rich_text:[{text:{content:'Guatemala'}}]},
          'Código departamento (temporal)':{rich_text:[{text:{content:'01'}}]},
          'Municipio (temporal)':{rich_text:[]},
          'Código municipio (temporal)':{rich_text:[]},
          'Paso actual':{relation:[{id:next.id}]},
          'Última actividad':{date:{start:now}}
        }});
        reply=next.message;
      }
`;
    code=code.replace(anchor,branch+anchor);
    node.parameters.jsCode=code;
    const payload={name:wf.name,nodes:wf.nodes,connections:wf.connections,settings:wf.settings||{}};
    await n8n('/workflows/'+WORKFLOW_ID,{method:'PUT',body:JSON.stringify(payload)});
    console.log('[IG_GUATEMALA_COVERAGE] installed '+JSON.stringify({workflowId:WORKFLOW_ID,marker:MARKER}));
  }else{
    console.log('[IG_GUATEMALA_COVERAGE] already installed');
  }
  await migrateOpenSessions();
}

main().catch(e=>{console.error('[IG_GUATEMALA_COVERAGE] failure: '+String(e?.stack||e?.message||e));process.exitCode=1;});
