import http from 'node:http';
let mode='ok';
http.createServer((req,res)=>{
  const H={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST, OPTIONS, GET'};
  if(req.method==='OPTIONS'){res.writeHead(204,H);return res.end();}
  if(req.url.startsWith('/mode/')){mode=req.url.split('/')[2];res.writeHead(200,H);return res.end(mode);}
  let b='';req.on('data',c=>b+=c);req.on('end',()=>{
    const J={...H,'Content-Type':'application/json'};
    if(mode==='429'){res.writeHead(429,J);return res.end(JSON.stringify({error:'Слишком много запросов'}));}
    if(mode==='500'){res.writeHead(500,J);return res.end(JSON.stringify({error:'Модель недоступна'}));}
    if(mode==='refusal'){res.writeHead(200,J);return res.end(JSON.stringify({content:[],stop_reason:'refusal'}));}
    if(mode==='garbage'){res.writeHead(200,J);return res.end('это не json');}
    if(mode==='empty'){res.writeHead(200,J);return res.end(JSON.stringify({content:[],stop_reason:'end_turn'}));}
    res.writeHead(200,J);res.end(JSON.stringify({content:[{type:'text',text:'В 6 месяцев ВБ 2:15–2:45, три сна 💛'}],stop_reason:'end_turn'}));
  });
}).listen(8788);
