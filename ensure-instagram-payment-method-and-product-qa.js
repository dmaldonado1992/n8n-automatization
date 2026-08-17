const N8N_URL=(process.env.N8N_URL||'').replace(/\/$/,'');
const N8N_API_KEY=process.env.N8N_API_KEY||'';
const WORKFLOW_ID='6l5IbTxGdwcL24wT';
const MARKER='/* INSTAGRAM_PAYMENT_BRANCH_AND_PRODUCT_QA_V1 */';

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
  if(!N8N_URL||!N8N_API_KEY){console.log('[IG_PAYMENT_QA] skipped: n8n config missing');return;}
  const wf=await n8n('/workflows/'+WORKFLOW_ID);
  const node=(wf.nodes||[]).find(n=>n.name==='Dynamic Notion Sales Engine');
  if(!node?.parameters?.jsCode) throw new Error('Dynamic Notion Sales Engine node not found');
  let code=String(node.parameters.jsCode);
  if(code.includes(MARKER)){
    console.log('[IG_PAYMENT_QA] already installed');
    return;
  }

  code=mustReplace(
    code,
    "    contents:__productRich(p['Contenido incluido']),\n    ingredients:__productRich(p['Ingredientes']),",
    "    contents:__productRich(p['Contenido incluido']),\n    flavors:__productRich(p['Sabores']),\n    includedQty:__productRich(p['Cantidad incluida']),\n    ingredients:__productRich(p['Ingredientes']),",
    'product extra fields'
  );

  code=mustReplace(
    code,
    "  if(/ingrediente|lleva|hecho de|contiene/.test(n)) kinds.push('ingredients');",
    "  if(/sabor|sabores|relleno|rellenos/.test(n)) kinds.push('flavors');\n  if(/ingrediente|lleva|hecho de|contiene/.test(n)) kinds.push('ingredients');",
    'flavor question detection'
  );

  code=mustReplace(
    code,
    "  if(/incluye|trae|contenido|viene con/.test(n)) kinds.push('contents');",
    "  if(/incluye|trae|contenido|viene con/.test(n)) kinds.push('contents');\n  if(/cantidad|cantidades|cuantos trae|cuantas trae|cuantas unidades|cuantos pasteles|unidades|piezas/.test(n)) kinds.push('includedQty');",
    'quantity question detection'
  );

  code=mustReplace(
    code,
    "    }else if(kind==='ingredients') out.push(__fmtConfigured('Ingredientes',p.ingredients,p.name));",
    "    }else if(kind==='flavors') out.push(__fmtConfigured('Sabores',p.flavors,p.name));\n    else if(kind==='ingredients') out.push(__fmtConfigured('Ingredientes',p.ingredients,p.name));",
    'flavor answer'
  );

  code=mustReplace(
    code,
    "    else if(kind==='contents') out.push(__fmtConfigured('Incluye',p.contents,p.name));",
    "    else if(kind==='contents') out.push(__fmtConfigured('Incluye',p.contents,p.name));\n    else if(kind==='includedQty') out.push(__fmtConfigured('Cantidad incluida',p.includedQty,p.name));",
    'quantity answer'
  );

  code=mustReplace(
    code,
    "const __wantsProductChange=input=>/(cambiar|cambia|cambio|prefiero|mejor|otro producto|quiero otro)/.test(__normProduct(input));",
    `const __wantsProductChange=input=>/(cambiar|cambia|cambio|prefiero|mejor|otro producto|quiero otro)/.test(__normProduct(input));
${MARKER}
const __paymentChoice=input=>{
  const n=__normProduct(input);
  if(/^(efectivo|cash|contra entrega|pago en efectivo)$/.test(n)||/\befectivo\b|\bcash\b|\bcontra entrega\b/.test(n)) return 'Efectivo';
  if(/^(transferencia|transferir|transferencia bancaria|transferencia electronica)$/.test(n)||/\btransferencia\b|\btransferir\b/.test(n)) return 'Transferencia';
  return '';
};`,
    'payment parser'
  );

  const genericValidation="    }else{\n      const valid=current.expected==='imagen'?!!image:current.expected==='telefono'?/^\\+?[0-9 ()-]{7,20}$/.test(text):current.expected==='numero'?/^\\d+(\\.\\d+)?$/.test(text):!!text;";
  const paymentBranch=String.raw`    }else if(current.field==='metodo_pago'){
      const paymentMethod=__paymentChoice(text);
      if(!paymentMethod){
        reply='Por favor elige un método de pago: Efectivo o Transferencia.\n\n'+current.message;
      }else if(paymentMethod==='Transferencia'){
        const transferStep=steps.find(s=>s.order>current.order&&s.field==='foto_boleta');
        if(!transferStep) throw new Error('No active foto_boleta step found after payment method');
        await notionReq('PATCH','https://api.notion.com/v1/pages/'+session.id,{properties:{
          'Método de pago (temporal)':{rich_text:[{text:{content:'Transferencia'}}]},
          'Paso actual':{relation:[{id:transferStep.id}]},
          'Última actividad':{date:{start:now}}
        }});
        reply=transferStep.message;
      }else{
        const productRel=session.properties['Producto elegido']?.relation||[];
        const product=activeProduct||products.find(p=>p.id===productRel[0]?.id);
        const qty=session.properties.Cantidad?.number||1;
        const address=rich(session.properties['Dirección (temporal)']);
        const phone=session.properties['Teléfono (temporal)']?.phone_number||'';
        const total=(product?.price||0)*qty+(product?.shipping||0);
        await notionReq('PATCH','https://api.notion.com/v1/pages/'+session.id,{properties:{
          'Método de pago (temporal)':{rich_text:[{text:{content:'Efectivo'}}]},
          'Última actividad':{date:{start:now}}
        }});
        const orderProps={
          Name:{title:[{text:{content:'Pedido #'+orderNumber+(igUsername?' - @'+igUsername:'')}}]},
          'Teléfono':{phone_number:phone},
          'IGSID':{rich_text:[{text:{content:sender}}]},
          'Usuario Instagram':{rich_text:igUsername?[{text:{content:igUsername}}]:[]},
          'Nombre cliente':{rich_text:clientName?[{text:{content:clientName}}]:[]},
          'Pedido #':{number:orderNumber},
          'Dirección envío':{rich_text:address?[{text:{content:address}}]:[]},
          'Producto(s)':{relation:productRel},
          Cantidad:{number:qty},
          'Precio unitario':{number:product?.price||0},
          'Costo envío':{number:product?.shipping||0},
          Total:{number:total},
          'Método de pago':{select:{name:'Efectivo'}},
          'Estado pedido':{select:{name:'Recibido'}},
          'Estado facturación':{select:{name:'Pendiente'}},
          'Saldo cobrado':{number:0},
          'Saldo pendiente':{number:total},
          Origen:{select:{name:'Instagram'}},
          'Historial / Notas':{rich_text:[{text:{content:'Pedido creado desde Instagram el '+now+' · Pago: Efectivo'}}]}
        };
        await notionReq('POST','https://api.notion.com/v1/pages',{parent:{database_id:cfg.orders},properties:orderProps});
        await notionReq('PATCH','https://api.notion.com/v1/pages/'+session.id,{archived:true});
        reply=await getSalesMessageTemplate('Pedido registrado',{pedido:orderNumber,total,metodo_pago:'Efectivo'});
      }
    }else{
      const valid=current.expected==='imagen'?!!image:current.expected==='telefono'?/^\+?[0-9 ()-]{7,20}$/.test(text):current.expected==='numero'?/^\d+(\.\d+)?$/.test(text):!!text;`;
  code=mustReplace(code,genericValidation,paymentBranch,'active payment branch');

  code=mustReplace(
    code,
    "        const total=(product?.price||0)*qty+(product?.shipping||0);\n        const orderProps={",
    "        const total=(product?.price||0)*qty+(product?.shipping||0);\n        const paymentMethod=rich(session.properties['Método de pago (temporal)'])||(current.field==='foto_boleta'?'Transferencia':'Transferencia');\n        const orderProps={",
    'final payment method resolution'
  );

  code=mustReplace(
    code,
    "Total:{number:total},'Estado pedido':{select:{name:'Recibido'}},",
    "Total:{number:total},'Método de pago':{select:{name:paymentMethod}},'Estado pedido':{select:{name:'Recibido'}},",
    'persist transfer payment method'
  );

  node.parameters.jsCode=code;
  const payload={name:wf.name,nodes:wf.nodes,connections:wf.connections,settings:wf.settings||{}};
  await n8n('/workflows/'+WORKFLOW_ID,{method:'PUT',body:JSON.stringify(payload)});
  console.log('[IG_PAYMENT_QA] installed '+JSON.stringify({workflowId:WORKFLOW_ID,marker:MARKER}));
}

main().catch(e=>{console.error('[IG_PAYMENT_QA] failure: '+String(e?.stack||e?.message||e));process.exitCode=1;});
