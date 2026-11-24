import http from 'node:http';
import {readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {collect,loadKeys,projectRoot} from './collect.mjs';
let stamp=0,worker,job={state:'idle'};
const port=Number(process.env.PORT||3000);
const send=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
const publicJob=()=>{const {file,...rest}=job;return rest;};
async function latestResult(){if(job.file)return job.file;const dir=path.join(projectRoot,'data');try{const files=await Promise.all((await readdir(dir)).filter(f=>/^krx-dart_.*\.json$/.test(f)).map(async f=>({f,t:(await stat(path.join(dir,f))).mtimeMs})));files.sort((a,b)=>b.t-a.t);return files[0]?path.join(dir,files[0].f):null;}catch{return null;}}
// 화면에서 '기억하기'를 선택한 키를 프로젝트 .env에 기록합니다(.gitignore 대상, 배포에 포함되지 않음).
async function saveKeys({dart,krx}){
  const file=path.join(projectRoot,'.env');let text='';try{text=await readFile(file,'utf8');}catch{}
  for(const [name,value] of [['DART_API_KEY',dart],['KRX_API_KEY',krx]]){if(!value)continue;const re=new RegExp('^\\s*'+name+'\\s*=.*$','m');text=re.test(text)?text.replace(re,name+'='+value):text.replace(/\s*$/,'')+(text.trim()?'\n':'')+name+'='+value+'\n';}
  await writeFile(file,text);
}
// 실제 데이터 수집은 키가 있는 로컬 개발 서버에서만 제공합니다.
async function collectRoute(req,res,url,body){
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return send(res,403,{error:'데이터 수집은 이 컴퓨터에서만 사용할 수 있습니다.'});
  if(url.pathname==='/api/collect/status'){const keys=loadKeys(),file=await latestResult();return send(res,200,{available:true,keys:{dart:!!keys.dart,krx:!!keys.krx},job:publicJob(),result:file?path.basename(file):null});}
  if(url.pathname==='/api/collect/result'){const file=await latestResult();if(!file)return send(res,404,{error:'수집된 데이터가 없습니다.'});res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});return res.end(await readFile(file));}
  if(url.pathname==='/api/collect/keys'&&req.method==='POST'){
    const origin=req.headers.origin;if(origin&&new URL(origin).host!==req.headers.host)return send(res,403,{error:'같은 사이트에서만 저장할 수 있습니다.'});
    let opts;try{opts=JSON.parse(body.toString()||'{}');}catch{return send(res,400,{error:'요청 형식을 확인하세요.'});}
    const given={dart:String(opts.keys?.dart||'').trim(),krx:String(opts.keys?.krx||'').trim()};
    if(!given.dart&&!given.krx)return send(res,400,{error:'저장할 키를 입력하세요.'});
    for(const v of Object.values(given))if(v&&!/^[A-Za-z0-9._~+\/=-]{10,200}$/.test(v))return send(res,400,{error:'키 형식을 확인하세요. 앞뒤 공백이나 따옴표 없이 붙여넣어 주세요.'});
    await saveKeys(given);const keys=loadKeys();
    return send(res,200,{keys:{dart:!!keys.dart,krx:!!keys.krx}});
  }
  if(url.pathname==='/api/collect'&&req.method==='POST'){
    const origin=req.headers.origin;if(origin&&new URL(origin).host!==req.headers.host)return send(res,403,{error:'같은 사이트에서만 실행할 수 있습니다.'});
    if(job.state==='running')return send(res,409,{error:'이미 수집 중입니다.'});
    let opts;try{opts=JSON.parse(body.toString()||'{}');}catch{return send(res,400,{error:'요청 형식을 확인하세요.'});}
    // 화면에서 입력한 키가 있으면 우선 사용하고, 없으면 .env·환경변수의 키를 씁니다.
    const given={dart:String(opts.keys?.dart||'').trim(),krx:String(opts.keys?.krx||'').trim()};
    for(const v of Object.values(given))if(v&&!/^[A-Za-z0-9._~+\/=-]{10,200}$/.test(v))return send(res,400,{error:'키 형식을 확인하세요. 앞뒤 공백이나 따옴표 없이 붙여넣어 주세요.'});
    const saved=loadKeys(),keys={dart:given.dart||saved.dart,krx:given.krx||saved.krx};
    if(!keys.dart)return send(res,400,{error:'OpenDART 키를 입력하세요.'});
    if(!keys.krx)return send(res,400,{error:'KRX 키를 입력하세요.'});
    if(opts.remember&&(given.dart||given.krx))await saveKeys(given);
    job={state:'running',step:'start',done:0,total:1,message:'수집을 준비하는 중'};
    collect({from:String(opts.from||''),to:String(opts.to||''),keys,onProgress:p=>Object.assign(job,p)})
      .then(({file,stats})=>{job={state:'done',file,stats,message:`수집 완료 · ${stats.stocks.toLocaleString()}개 기업 · ${stats.months}개월`};process.stdout.write(job.message+' → '+file+'\n');})
      .catch(e=>{job={state:'error',message:e.message};process.stdout.write('수집 실패: '+e.message+'\n');});
    return send(res,202,{job:publicJob()});
  }
  return send(res,404,{error:'Not found'});
}
const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/collect'))return await collectRoute(req,res,url,body);const file=path.resolve('worker/index.js');const info=await stat(file);if(info.mtimeMs!==stamp){worker=(await import(pathToFileURL(file).href+'?v='+info.mtimeMs)).default;stamp=info.mtimeMs;}const proto=req.headers['x-forwarded-proto']||'http';const host=req.headers['x-forwarded-host']||req.headers.host;const request=new Request(proto+'://'+host+req.url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body}:{} )});const response=await worker.fetch(request,{},{});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(e){res.writeHead(500,{'content-type':'text/plain'});res.end('Preview failed: '+e.message);}});
server.listen(port,'0.0.0.0',()=>process.stdout.write('Factor Lab preview ready on '+port+'\n'));
