const base=(process.env.N8N_URL||'https://n8n-community-8ttv.onrender.com').replace(/\/$/,'');
const now=Date.now();
const body={
  object:'instagram',
  entry:[{
    id:'17841441308562806',
    time:now,
    messaging:[{
      sender:{id:'1644231633938346'},
      recipient:{id:'17841441308562806'},
      timestamp:now,
      message:{mid:`synthetic-native-test-${now}`,text:'Prueba técnica native'}
    }]
  }]
};
try{
  const r=await fetch(`${base}/webhook/instagram-sales`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  });
  const text=await r.text();
  console.log('[IG_NATIVE_TEST] webhook '+JSON.stringify({status:r.status,ok:r.ok,body:text.slice(0,500)}));
  await new Promise(resolve=>setTimeout(resolve,3000));
}catch(e){
  console.log('[IG_NATIVE_TEST] non-fatal failure '+String(e?.message||e));
}
