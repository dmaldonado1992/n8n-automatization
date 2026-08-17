const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID='6l5IbTxGdwcL24wT';
const MARKER='/* INSTAGRAM_CANCEL_PHONE_COVERAGE_V1 */';

async function n8n(path,options={}){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{
    ...options,
    headers:{'X-N8N-API-KEY':N8N_API_KEY,'Content-Type':'application/json',...(options.headers||{})}
  });
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

function mustReplace(source,needle,replacement,label){
  if(!source.includes(needle)) throw new Error(`Missing anchor: ${label}`);
  return source.replace(needle,replacement);
}

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_COVERAGE_FLOW] skipped: n8n config missing');return;}
  const wf=await n8n('/workflows/'+WORKFLOW_ID);
  const node=(wf.nodes||[]).find(n=>n.name==='Dynamic Notion Sales Engine');
  if(!node?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine node not found');
  let code=String(node.parameters.jsCode);
  if(code.includes(MARKER)){
    console.log('[IG_COVERAGE_FLOW] already installed');
    return;
  }

  code=mustReplace(
    code,
    "  sessions:'03b8bddb49ce40d3bee435b2c25863ab',\n  orders:'9d95088977fa4dc0be46d4bb1841f7d0'",
    "  sessions:'03b8bddb49ce40d3bee435b2c25863ab',\n  orders:'9d95088977fa4dc0be46d4bb1841f7d0',\n  departments:'9db67484180541e88a6a5e3bccf035f3',\n  municipalities:'ffd242fcbfea4bd68094396208322bcf'",
    'territorial databases config'
  );

  const helpers=String.raw`${MARKER}
const __cancelIntent=(input,current)=>{
  const n=__normProduct(input);
  if(/^(cancelar|cancela|cancelar pedido|cancela pedido|ya no|ya no quiero|ya no gracias|mejor no|dejalo|dejalo asi)$/.test(n)) return true;
  return !!current&&current.order===10&&/^(no|no gracias|nop)$/.test(n);
};
const __phoneDigits=value=>String(value||'').replace(/\D/g,'');
const __validPhone=value=>{const d=__phoneDigits(value);return d.length>=8&&d.length<=15;};
const __geoTitle=p=>p?.title?.map(t=>t?.plain_text??t?.text?.content??'').join('')||'';
const __geoRich=p=>p?.rich_text?.map(t=>t?.plain_text??t?.text?.content??'').join('')||'';
const getDepartments=async()=>{
  const r=await notionReq('POST','https://api.notion.com/v1/databases/'+cfg.departments+'/query',{
    filter:{property:'Activo',checkbox:{equals:true}},sorts:[{property:'Código',direction:'ascending'}],page_size:100
  });
  return (r.results||[]).map(x=>({id:x.id,name:__geoTitle(x.properties?.Departamento),code:__geoRich(x.properties?.['Código'])})).filter(x=>x.name&&x.code);
};
const getMunicipalities=async(departmentCode)=>{
  const r=await notionReq('POST','https://api.notion.com/v1/databases/'+cfg.municipalities+'/query',{
    filter:{and:[{property:'Activo',checkbox:{equals:true}},{property:'Código departamento',rich_text:{equals:String(departmentCode||'')}}]},
    sorts:[{property:'Código INE',direction:'ascending'}],page_size:100
  });
  return (r.results||[]).map(x=>({
    id:x.id,
    name:__geoTitle(x.properties?.Municipio),
    code:__geoRich(x.properties?.['Código INE']),
    department:__geoRich(x.properties?.Departamento),
    departmentCode:__geoRich(x.properties?.['Código departamento']),
    coverage:!!x.properties?.Cobertura?.checkbox
  })).filter(x=>x.name&&x.code);
};
const __matchGeo=(input,items)=>{
  const n=__normProduct(input);
  if(!n) return null;
  const numberMatch=n.match(/^(?:(?:opcion|numero|departamento|municipio)\s*)?(\d{1,2})$/);
  if(numberMatch){const idx=Number(numberMatch[1])-1;if(items[idx])return items[idx];}
  const exact=items.filter(x=>__normProduct(x.name)===n);
  if(exact.length===1)return exact[0];
  const partial=items.filter(x=>{const name=__normProduct(x.name);return name.includes(n)||n.includes(name);});
  return partial.length===1?partial[0]:null;
};
const __departmentPrompt=(intro,items)=>{
  const list=(items||[]).map((x,i)=>(i+1)+'. '+x.name).join('\n');
  return String(intro||'Selecciona tu departamento.')+(list?'\n\n'+list+'\n\nResponde con el número o nombre del departamento.':'');
};
const __municipalityPrompt=(intro,departmentName,items)=>{
  const list=(items||[]).map((x,i)=>(i+1)+'. '+x.name).join('\n');
  return String(intro||'Selecciona tu municipio.')+(departmentName?'\nDepartamento: '+departmentName:'')+(list?'\n\n'+list+'\n\nResponde con el número o nombre del municipio.':'');
};
const __stepPrompt=async(step,sessionLike)=>{
  if(!step)return '';
  if(step.field==='departamento')return __departmentPrompt(step.message,await getDepartments());
  if(step.field==='municipio'){
    const code=__geoRich(sessionLike?.properties?.['Código departamento (temporal)']);
    const department=__geoRich(sessionLike?.properties?.['Departamento (temporal)']);
    return __municipalityPrompt(step.message,department,code?await getMunicipalities(code):[]);
  }
  return step.message;
};`;
  code=mustReplace(code,"const getProducts=async()=>{",helpers+"\nconst getProducts=async()=>{",'coverage helpers');

  const activeContext=String.raw`    const exactReferenced=referencedProduct&&__normProduct(text)===referencedProduct.normalizedName;
    const changeRequested=referencedProduct&&activeProduct&&referencedProduct.id!==activeProduct.id&&(__wantsProductChange(text)||exactReferenced||/^quiero\b/.test(__normProduct(text)));
    if(__wantsCatalog(text)){`;
  const activeContextReplacement=String.raw`    const exactReferenced=referencedProduct&&__normProduct(text)===referencedProduct.normalizedName;
    const changeRequested=referencedProduct&&activeProduct&&referencedProduct.id!==activeProduct.id&&(__wantsProductChange(text)||exactReferenced||/^quiero\b/.test(__normProduct(text)));
    const currentPrompt=await __stepPrompt(current,session);
    if(__cancelIntent(text,current)){
      await notionReq('PATCH','https://api.notion.com/v1/pages/'+session.id,{archived:true});
      const list=__catalogText(products);
      reply='Pedido cancelado. Empecemos de nuevo.'+(list?'\n\nProductos disponibles:\n'+list+'\n\nResponde con el número o nombre del producto.':'');
    }else if(__wantsCatalog(text)){`;
  code=mustReplace(code,activeContext,activeContextReplacement,'cancel flow');

  code=code.replaceAll("+'\\nSeguimos donde quedamos: '+current.message", "+'\\nSeguimos donde quedamos: '+currentPrompt");
  code=code.replaceAll("+'\\n\\nSeguimos con tu pedido #'+orderNumber+': '+current.message", "+'\\n\\nSeguimos con tu pedido #'+orderNumber+': '+currentPrompt");
  code=code.replaceAll("+'Seguimos donde quedamos: '+current.message", "+'Seguimos donde quedamos: '+currentPrompt");

  const paymentBranchAnchor="    }else if(current.field==='metodo_pago'){";
  const geoBranches=String.raw`    }else if(current.field==='departamento'){
      const departments=await getDepartments();
      const selectedDepartment=__matchGeo(text,departments);
      if(!selectedDepartment){
        reply=__departmentPrompt(current.message,departments);
      }else{
        const next=steps.find(s=>s.order>current.order);
        if(!next||next.field!=='municipio') throw new Error('No active municipio step found after departamento');
        await notionReq('PATCH','https://api.notion.com/v1/pages/'+session.id,{properties:{
          'Departamento (temporal)':{rich_text:[{text:{content:selectedDepartment.name}}]},
          'Código departamento (temporal)':{rich_text:[{text:{content:selectedDepartment.code}}]},
          'Municipio (temporal)':{rich_text:[]},
          'Código municipio (temporal)':{rich_text:[]},
          'Paso actual':{relation:[{id:next.id}]},
          'Última actividad':{date:{start:now}}
        }});
        const municipalities=await getMunicipalities(selectedDepartment.code);
        reply=__municipalityPrompt(next.message,selectedDepartment.name,municipalities);
      }
    }else if(current.field==='municipio'){
      const departmentCode=rich(session.properties['Código departamento (temporal)']);
      const departmentName=rich(session.properties['Departamento (temporal)']);
      const municipalities=await getMunicipalities(departmentCode);
      const selectedMunicipality=__matchGeo(text,municipalities);
      if(!selectedMunicipality){
        reply=__municipalityPrompt(current.message,departmentName,municipalities);
      }else if(!selectedMunicipality.coverage){
        const noCoverage=String($env.INSTAGRAM_NO_COVERAGE_MESSAGE||'Lastimosamente no tenemos cobertura en este municipio por el momento. Puedes elegir otro municipio con cobertura.').trim();
        reply=noCoverage+'\n\n'+__municipalityPrompt(current.message,departmentName,municipalities);
      }else{
        const next=steps.find(s=>s.order>current.order);
        if(!next) throw new Error('No active step found after municipio');
        await notionReq('PATCH','https://api.notion.com/v1/pages/'+session.id,{properties:{
          'Municipio (temporal)':{rich_text:[{text:{content:selectedMunicipality.name}}]},
          'Código municipio (temporal)':{rich_text:[{text:{content:selectedMunicipality.code}}]},
          'Paso actual':{relation:[{id:next.id}]},
          'Última actividad':{date:{start:now}}
        }});
        reply=next.message;
      }
    }else if(current.field==='metodo_pago'){`;
  code=mustReplace(code,paymentBranchAnchor,geoBranches,'department municipality branches');

  code=mustReplace(
    code,
    "      const valid=current.expected==='imagen'?!!image:current.expected==='telefono'?/^\\+?[0-9 ()-]{7,20}$/.test(text):current.expected==='numero'?/^\\d+(\\.\\d+)?$/.test(text):!!text;",
    "      const valid=current.expected==='imagen'?!!image:current.expected==='telefono'?__validPhone(text):current.expected==='numero'?/^\\d+(\\.\\d+)?$/.test(text):!!text;",
    'minimum phone length validation'
  );

  code=mustReplace(
    code,
    "      reply=current.expected==='imagen'?current.message:'Necesito recibir '+(current.expected==='telefono'?'un teléfono válido':'el dato solicitado')+'. '+current.message;",
    "      reply=current.expected==='imagen'?currentPrompt:current.expected==='telefono'?('El número de teléfono debe tener entre 8 y 15 dígitos. '+currentPrompt):('Necesito recibir el dato solicitado. '+currentPrompt);",
    'phone validation message'
  );

  code=mustReplace(
    code,
    "        reply=next.message;",
    "        reply=await __stepPrompt(next,session);",
    'dynamic next-step prompt'
  );

  code=mustReplace(
    code,
    "        const address=rich(session.properties['Dirección (temporal)']);\n        const phone=session.properties['Teléfono (temporal)']?.phone_number||'';\n        const total=(product?.price||0)*qty+(product?.shipping||0);",
    "        const address=rich(session.properties['Dirección (temporal)']);\n        const department=rich(session.properties['Departamento (temporal)']);\n        const municipality=rich(session.properties['Municipio (temporal)']);\n        const municipalityCode=rich(session.properties['Código municipio (temporal)']);\n        const fullAddress=[address,municipality,department].filter(Boolean).join(', ');\n        const phone=session.properties['Teléfono (temporal)']?.phone_number||'';\n        const total=(product?.price||0)*qty+(product?.shipping||0);",
    'cash geo variables'
  );
  code=mustReplace(
    code,
    "          'Dirección envío':{rich_text:address?[{text:{content:address}}]:[]},\n          'Producto(s)':{relation:productRel},",
    "          'Dirección envío':{rich_text:fullAddress?[{text:{content:fullAddress}}]:[]},\n          'Departamento':{rich_text:department?[{text:{content:department}}]:[]},\n          'Municipio':{rich_text:municipality?[{text:{content:municipality}}]:[]},\n          'Código municipio':{rich_text:municipalityCode?[{text:{content:municipalityCode}}]:[]},\n          'Producto(s)':{relation:productRel},",
    'cash geo order properties'
  );

  code=mustReplace(
    code,
    "        const address=current.field==='direccion'?text:rich(session.properties['Dirección (temporal)']);\n        const phone=current.field==='telefono'?text:session.properties['Teléfono (temporal)']?.phone_number||'';\n        const total=(product?.price||0)*qty+(product?.shipping||0);",
    "        const address=current.field==='direccion'?text:rich(session.properties['Dirección (temporal)']);\n        const department=rich(session.properties['Departamento (temporal)']);\n        const municipality=rich(session.properties['Municipio (temporal)']);\n        const municipalityCode=rich(session.properties['Código municipio (temporal)']);\n        const fullAddress=[address,municipality,department].filter(Boolean).join(', ');\n        const phone=current.field==='telefono'?text:session.properties['Teléfono (temporal)']?.phone_number||'';\n        const total=(product?.price||0)*qty+(product?.shipping||0);",
    'transfer geo variables'
  );
  code=mustReplace(
    code,
    "'Pedido #':{number:orderNumber},'Dirección envío':{rich_text:[{text:{content:address}}]},'Producto(s)':{relation:productRel},",
    "'Pedido #':{number:orderNumber},'Dirección envío':{rich_text:fullAddress?[{text:{content:fullAddress}}]:[]},'Departamento':{rich_text:department?[{text:{content:department}}]:[]},'Municipio':{rich_text:municipality?[{text:{content:municipality}}]:[]},'Código municipio':{rich_text:municipalityCode?[{text:{content:municipalityCode}}]:[]},'Producto(s)':{relation:productRel},",
    'transfer geo order properties'
  );

  node.parameters.jsCode=code;
  const payload={name:wf.name,nodes:wf.nodes,connections:wf.connections,settings:wf.settings||{}};
  await n8n('/workflows/'+WORKFLOW_ID,{method:'PUT',body:JSON.stringify(payload)});
  console.log('[IG_COVERAGE_FLOW] installed '+JSON.stringify({workflowId:WORKFLOW_ID,marker:MARKER}));
}

main().catch(e=>{console.error('[IG_COVERAGE_FLOW] failure: '+String(e?.stack||e?.message||e));process.exitCode=1;});
