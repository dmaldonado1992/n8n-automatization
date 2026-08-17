const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID='6l5IbTxGdwcL24wT';
const MARKER='/* INSTAGRAM_DYNAMIC_PRODUCT_CATALOG_V1 */';

async function n8n(path,options={}){
  const r=await fetch(`${N8N_URL}/api/v1${path}`,{
    ...options,
    headers:{'X-N8N-API-KEY':N8N_API_KEY,'Content-Type':'application/json',...(options.headers||{})}
  });
  const t=await r.text();
  if(!r.ok) throw new Error(`n8n ${r.status}: ${t}`);
  return t?JSON.parse(t):{};
}

function replaceBetween(source,start,end,replacement,label){
  const a=source.indexOf(start);
  if(a<0) throw new Error(`Missing start anchor for ${label}`);
  const b=source.indexOf(end,a+start.length);
  if(b<0) throw new Error(`Missing end anchor for ${label}`);
  return source.slice(0,a)+replacement+source.slice(b);
}

async function main(){
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_DYNAMIC_PRODUCTS] skipped: n8n config missing');return;}
  const wf=await n8n('/workflows/'+WORKFLOW_ID);
  const node=(wf.nodes||[]).find(n=>n.name==='Dynamic Notion Sales Engine');
  if(!node?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine node not found');
  let code=String(node.parameters.jsCode);
  if(code.includes(MARKER)){
    console.log('[IG_DYNAMIC_PRODUCTS] already installed');
    return;
  }

  const helpers=String.raw`${MARKER}
const __productRich=p=>p?.rich_text?.map(t=>t?.plain_text??t?.text?.content??'').join('')||'';
const __productTitle=p=>p?.title?.map(t=>t?.plain_text??t?.text?.content??'').join('')||'';
const __normProduct=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const __productFromPage=x=>{
  const p=x?.properties||{};
  const name=__productTitle(p['Nombre producto'])||Object.values(p).find(v=>v?.type==='title')?.title?.map(t=>t?.plain_text||'').join('')||'';
  const aliasText=__productRich(p['Alias / palabras clave']);
  const aliases=aliasText.split(/[,;|\n]/).map(v=>v.trim()).filter(Boolean);
  return {
    id:x.id,
    name,
    aliases,
    normalizedName:__normProduct(name),
    price:Number(p.Precio?.number||0),
    shipping:Number(p['Costo envío']?.number||0),
    freeShippingFrom:p['Envío gratis desde']?.number==null?null:Number(p['Envío gratis desde'].number),
    stock:Number(p['Stock disponible']?.number||0),
    description:__productRich(p['Descripción']),
    contents:__productRich(p['Contenido incluido']),
    ingredients:__productRich(p['Ingredientes']),
    allergens:__productRich(p['Alérgenos']),
    portions:__productRich(p['Porciones']),
    size:__productRich(p['Tamaño']),
    customizable:!!p.Personalizable?.checkbox,
    customizationOptions:__productRich(p['Opciones de personalización']),
    leadTime:__productRich(p['Tiempo mínimo de pedido']),
    order:Number(p['Orden catálogo']?.number??9999)
  };
};
const __usableProducts=rows=>(rows||[]).map(__productFromPage).filter(p=>p.name&&p.stock>0).sort((a,b)=>(a.order-b.order)||a.name.localeCompare(b.name));
const __catalogText=products=>products.map((p,i)=>(i+1)+'. '+p.name+' — Q'+p.price+(p.shipping?' + envío Q'+p.shipping:'')).join('\n');
const __matchProduct=(input,products,{allowIndex=true}={})=>{
  const n=__normProduct(input);
  if(!n) return null;
  if(allowIndex){
    const m=n.match(/^(?:(?:quiero|dame|producto|opcion|numero)\s*)?(\d{1,2})$/);
    if(m){const idx=Number(m[1])-1;if(products[idx])return products[idx];}
  }
  const scored=products.map(product=>{
    const keys=[product.name,...(product.aliases||[])].map(__normProduct).filter(Boolean);
    let score=0;
    for(const key of keys){
      if(n===key) score=Math.max(score,100);
      else if(n.includes(key)) score=Math.max(score,90);
      else {
        const keyTokens=key.split(' ').filter(Boolean);
        const inputTokens=n.split(' ').filter(Boolean);
        if(keyTokens.length&&keyTokens.every(t=>inputTokens.includes(t))) score=Math.max(score,80);
        else if(n.length>=4&&key.includes(n)) score=Math.max(score,65);
      }
    }
    return {product,score};
  }).sort((a,b)=>b.score-a.score);
  if(!scored[0]||scored[0].score<65) return null;
  if(scored[1]&&scored[1].score===scored[0].score) return null;
  return scored[0].product;
};
const __productQuestion=input=>{
  const raw=String(input||'');
  const n=__normProduct(raw);
  const kinds=[];
  if(/precio|cuanto cuesta|cuesta|vale|valor/.test(n)) kinds.push('price');
  if(/envio|delivery|shipping|domicilio|gratis/.test(n)) kinds.push('shipping');
  if(/ingrediente|lleva|hecho de|contiene/.test(n)) kinds.push('ingredients');
  if(/alergen|alergia|gluten|lactosa|mani|nuez/.test(n)) kinds.push('allergens');
  if(/incluye|trae|contenido|viene con/.test(n)) kinds.push('contents');
  if(/porcion|personas|rinde/.test(n)) kinds.push('portions');
  if(/tamano|medida|grande|pequeno/.test(n)) kinds.push('size');
  if(/personaliz|decorar|decoracion|opciones/.test(n)) kinds.push('custom');
  if(/anticipacion|tiempo minimo|cuando pedir|dias antes|entrega/.test(n)) kinds.push('leadTime');
  if(/stock|disponible|disponibilidad|cuantos quedan|hay /.test(n)) kinds.push('stock');
  if(/descripcion|que es|como es/.test(n)) kinds.push('description');
  const isQuestion=kinds.length>0||/[?¿]/.test(raw)||/^(que|cual|cuanto|cuantos|como|cuando|tiene|incluye|trae|hay|puedo|se puede)\b/.test(n);
  return {isQuestion,kinds:[...new Set(kinds)]};
};
const __fmtConfigured=(label,value,productName)=>value?label+': '+value:(label+': este dato todavía no está configurado en Notion para '+productName+'.');
const __answerProduct=(input,p)=>{
  const q=__productQuestion(input);
  const kinds=q.kinds.length?q.kinds:['description'];
  const out=[];
  for(const kind of kinds){
    if(kind==='price') out.push(p.price>0?'El '+p.name+' cuesta Q'+p.price+'.':'El precio todavía no está configurado en Notion para '+p.name+'.');
    else if(kind==='shipping'){
      if(p.shipping>0){
        let s='El envío para '+p.name+' cuesta Q'+p.shipping+'.';
        if(Number.isFinite(p.freeShippingFrom)&&p.freeShippingFrom>0) s+=' El envío es gratis desde Q'+p.freeShippingFrom+'.';
        out.push(s);
      }else out.push('El envío para '+p.name+' no tiene costo configurado.');
    }else if(kind==='ingredients') out.push(__fmtConfigured('Ingredientes',p.ingredients,p.name));
    else if(kind==='allergens') out.push(__fmtConfigured('Alérgenos',p.allergens,p.name));
    else if(kind==='contents') out.push(__fmtConfigured('Incluye',p.contents,p.name));
    else if(kind==='portions') out.push(__fmtConfigured('Porciones',p.portions,p.name));
    else if(kind==='size') out.push(__fmtConfigured('Tamaño',p.size,p.name));
    else if(kind==='custom') out.push(p.customizable?('Sí, '+p.name+' es personalizable.'+(p.customizationOptions?' Opciones: '+p.customizationOptions+'.':'')):('No, '+p.name+' no está marcado como personalizable en Notion.'));
    else if(kind==='leadTime') out.push(__fmtConfigured('Tiempo mínimo de pedido',p.leadTime,p.name));
    else if(kind==='stock') out.push(p.stock>0?('Sí, '+p.name+' está disponible. Stock registrado: '+p.stock+'.'):('En este momento '+p.name+' no tiene stock disponible.'));
    else if(kind==='description') out.push(__fmtConfigured('Descripción',p.description,p.name));
  }
  if(out.length===1&&kinds[0]==='description'&&p.contents) out.push('Incluye: '+p.contents);
  return out.filter(Boolean).join('\n');
};
const __wantsCatalog=input=>/(catalogo|productos|menu|que tienen|que venden|ver productos|mostrar productos|opciones disponibles)/.test(__normProduct(input));
const __wantsProductChange=input=>/(cambiar|cambia|cambio|prefiero|mejor|otro producto|quiero otro)/.test(__normProduct(input));
const getProducts=async()=>{
  const data=await notionReq('POST','https://api.notion.com/v1/databases/'+cfg.products+'/query',{filter:{property:'Activo',checkbox:{equals:true}},page_size:100});
  return __usableProducts(data.results||[]);
};
`;

  code=replaceBetween(
    code,
    'const getProducts=async()=>{',
    '\n\nconst reaction=',
    helpers,
    'product helpers'
  );

  const productMapStart='  const products=(productData.results||[]).map';
  const productMapEnd=';\n  const session=(sessionData.results||[])[0];';
  const a=code.indexOf(productMapStart);
  const b=code.indexOf(productMapEnd,a);
  if(a<0||b<0) throw new Error('Could not locate main product mapping');
  code=code.slice(0,a)+'  const products=__usableProducts(productData.results||[])'+code.slice(b);

  const noSessionStart='  }else if(!session){';
  const noSessionEnd='\n  }else{\n    let orderNumber=';
  const newNoSession=String.raw`  }else if(!session){
    const product=__matchProduct(text,products,{allowIndex:true});
    const question=__productQuestion(text);
    if(__wantsCatalog(text)){
      const list=__catalogText(products);
      reply=list?('Productos disponibles:\n'+list+'\n\nPuedes responder con el número o con el nombre del producto.'):'No hay productos disponibles por ahora.';
    }else if(question.isQuestion&&product){
      reply=__answerProduct(text,product)+'\n\nSi deseas pedirlo, escribe: "Quiero '+product.name+'".';
    }else if(!product){
      const list=__catalogText(products);
      reply=list?('Productos disponibles:\n'+list+'\n\nPuedes responder con el número o con el nombre del producto que te interesa.'):'No hay productos disponibles por ahora.';
    }else{
      const first=steps[0];
      const [profile,orderNumber]=await Promise.all([resolveInstagramProfile(sender,igAccountId),nextOrderNumber()]);
      await notionReq('POST','https://api.notion.com/v1/pages',{parent:{database_id:cfg.sessions},properties:{'IGSID':{title:[{text:{content:sender}}]},'Usuario Instagram':{rich_text:profile.username?[{text:{content:profile.username}}]:[]},'Nombre cliente':{rich_text:profile.name?[{text:{content:profile.name}}]:[]},'Pedido #':{number:orderNumber},'Producto elegido':{relation:[{id:product.id}]},Cantidad:{number:1},'Paso actual':{relation:[{id:first.id}]},'Última actividad':{date:{start:now}}}});
      reply='Pedido #'+orderNumber+' iniciado. El '+product.name+' cuesta Q'+product.price+'. '+(product.shipping?'El envío cuesta Q'+product.shipping+'. ':'')+first.message;
    }`;
  code=replaceBetween(code,noSessionStart,noSessionEnd,newNoSession,'no-session product selection');

  const sessionAnchor=String.raw`    const currentId=session.properties['Paso actual']?.relation?.[0]?.id;
    const current=steps.find(s=>s.id===currentId)||steps[0];
    const valid=current.expected==='imagen'?!!image:current.expected==='telefono'?/^\+?[0-9 ()-]{7,20}$/.test(text):current.expected==='numero'?/^\d+(\.\d+)?$/.test(text):!!text;`;
  if(!code.includes(sessionAnchor)) throw new Error('Could not locate active-session validation anchor');
  const enhancedSession=String.raw`    const currentId=session.properties['Paso actual']?.relation?.[0]?.id;
    const current=steps.find(s=>s.id===currentId)||steps[0];
    const activeProductId=session.properties['Producto elegido']?.relation?.[0]?.id||'';
    let activeProduct=products.find(p=>p.id===activeProductId)||null;
    const referencedProduct=__matchProduct(text,products,{allowIndex:false});
    const question=__productQuestion(text);
    const exactReferenced=referencedProduct&&__normProduct(text)===referencedProduct.normalizedName;
    const changeRequested=referencedProduct&&activeProduct&&referencedProduct.id!==activeProduct.id&&(__wantsProductChange(text)||exactReferenced||/^quiero\b/.test(__normProduct(text)));
    if(__wantsCatalog(text)){
      const list=__catalogText(products);
      reply=(list?('Productos disponibles:\n'+list):'No hay productos disponibles por ahora.')+(activeProduct?'\n\nTu pedido actual es '+activeProduct.name+'.':'')+'\nSeguimos donde quedamos: '+current.message;
    }else if(question.isQuestion&&(referencedProduct||activeProduct)){
      const targetProduct=referencedProduct||activeProduct;
      reply=__answerProduct(text,targetProduct)+'\n\nSeguimos con tu pedido #'+orderNumber+': '+current.message;
    }else if(changeRequested){
      await notionReq('PATCH','https://api.notion.com/v1/pages/'+session.id,{properties:{'Producto elegido':{relation:[{id:referencedProduct.id}]},'Última actividad':{date:{start:now}}}});
      activeProduct=referencedProduct;
      reply='Listo, cambié tu pedido #'+orderNumber+' a '+activeProduct.name+'. Precio Q'+activeProduct.price+'. '+(activeProduct.shipping?'Envío Q'+activeProduct.shipping+'. ':'')+'Seguimos donde quedamos: '+current.message;
    }else{
      const valid=current.expected==='imagen'?!!image:current.expected==='telefono'?/^\+?[0-9 ()-]{7,20}$/.test(text):current.expected==='numero'?/^\d+(\.\d+)?$/.test(text):!!text;`;
  code=code.replace(sessionAnchor,enhancedSession);

  const normalFlowEnd=String.raw`      }
    }
  }
}catch(e){`;
  const normalFlowEndReplacement=String.raw`      }
    }
    }
  }
}catch(e){`;
  if(!code.includes(normalFlowEnd)) throw new Error('Could not locate active-session closing braces');
  code=code.replace(normalFlowEnd,normalFlowEndReplacement);

  node.parameters.jsCode=code;
  const payload={name:wf.name,nodes:wf.nodes,connections:wf.connections,settings:wf.settings||{}};
  await n8n('/workflows/'+WORKFLOW_ID,{method:'PUT',body:JSON.stringify(payload)});
  if(!wf.active) await n8n('/workflows/'+WORKFLOW_ID+'/activate',{method:'POST'});
  console.log('[IG_DYNAMIC_PRODUCTS] installed '+JSON.stringify({workflowId:WORKFLOW_ID,marker:MARKER}));
}

main().catch(e=>{console.error('[IG_DYNAMIC_PRODUCTS] failure: '+String(e?.stack||e?.message||e));process.exitCode=1;});
