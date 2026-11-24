// OpenDART(사업보고서) + KRX Open API(월말 시세·지수)를 받아 앱의 통합 JSON 형식으로 변환합니다.
// 사용: node scripts/collect.mjs --from 2019-01-01 --to 2026-10-28
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const KRX_BASE='https://data-dbg.krx.co.kr/svc/apis/',DART_BASE='https://opendart.fss.or.kr/api/';
// 한국표준산업분류(KSIC) 중분류 앞 두 자리 → 화면용 업종
const SECTORS=[[3,'농림어업'],[8,'광업'],[12,'식품·음료'],[15,'섬유·의류'],[18,'목재·종이·인쇄'],[19,'정유'],[20,'화학'],[21,'제약·바이오'],[22,'고무·플라스틱'],[23,'비금속광물'],[24,'철강·금속'],[25,'금속가공'],[26,'반도체·전자부품'],[27,'의료·정밀기기'],[28,'전기장비'],[29,'기계'],[30,'자동차'],[31,'조선·운송장비'],[34,'기타 제조'],[39,'에너지·환경'],[42,'건설'],[47,'유통'],[52,'운수·물류'],[56,'숙박·음식'],[58,'출판·소프트웨어'],[60,'미디어·방송'],[61,'통신'],[63,'IT서비스'],[66,'금융'],[68,'부동산'],[70,'연구개발'],[73,'전문서비스·지주'],[76,'사업지원'],[85,'교육'],[87,'보건·복지'],[91,'문화·여가'],[99,'기타']];
export const sectorOf=code=>{const c=parseInt(String(code||'').slice(0,2),10);return Number.isFinite(c)?SECTORS.find(([max])=>c<=max)[1]:'미분류';};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const num=v=>{const s=String(v??'').replace(/,/g,'').trim();return s===''||s==='-'?NaN:Number(s);};
const ymd=d=>d.toISOString().slice(0,10);
const compact=s=>s.replaceAll('-','');
const round=(v,k=2)=>Number.isFinite(v)?Math.round(v*10**k)/10**k:null;

// 키는 환경변수 → 프로젝트의 .env → (Windows) setx로 등록한 사용자 환경변수 순으로 찾습니다.
export function loadKeys(){
  const read=name=>{
    if(process.env[name])return process.env[name].trim();
    const file=path.join(projectRoot,'.env');
    if(existsSync(file)){const m=readFileSync(file,'utf8').match(new RegExp('^\\s*'+name+'\\s*=\\s*"?([^"\\r\\n]+)"?','m'));if(m)return m[1].trim();}
    if(process.platform==='win32'){const r=spawnSync('reg',['query','HKCU\\Environment','/v',name],{encoding:'utf8'});const m=r.stdout?.match(new RegExp(name+'\\s+REG_\\w+\\s+(.+)'));if(m)return m[1].trim();}
    return '';
  };
  return {dart:read('DART_API_KEY'),krx:read('KRX_API_KEY')};
}

export function unzipFirst(buf){
  let e=buf.length-22;while(e>=0&&buf.readUInt32LE(e)!==0x06054b50)e--;
  if(e<0)throw Error('OpenDART 고유번호 파일(zip)을 읽지 못했습니다.');
  const cd=buf.readUInt32LE(e+16),method=buf.readUInt16LE(cd+10),size=buf.readUInt32LE(cd+20),local=buf.readUInt32LE(cd+42);
  const start=local+30+buf.readUInt16LE(local+26)+buf.readUInt16LE(local+28),data=buf.subarray(start,start+size);
  return method===8?inflateRawSync(data):data;
}

// 월말 시세만 받으므로 액면분할·병합은 상장주식수와 주가가 반대로 함께 움직인 달을 찾아 이전 가격을 나눠 보정합니다.
export function adjustSplits(series){
  const out=series.map(p=>({...p}));let mult=1;
  for(let i=out.length-1;i>=0;i--){
    out[i].adj=series[i].close*mult;
    if(i>0){const k=series[i].shares/series[i-1].shares,pr=series[i].close/series[i-1].close;if(Number.isFinite(k)&&(k>=1.4||k<=1/1.4)&&Math.abs(Math.log(pr*k))<Math.log(1.4))mult/=k;}
  }
  return out;
}

export async function collect({from,to,keys=loadKeys(),cacheDir=path.join(projectRoot,'data','cache'),outDir=path.join(projectRoot,'data'),fetchImpl=globalThis.fetch,paceMs=120,today=ymd(new Date()),onProgress=()=>{}}={}){
  if(!keys.dart)throw Error('OpenDART 키가 없습니다. 화면의 「API 및 데이터 → 2번」에 키를 넣거나 .env에 DART_API_KEY=키 를 적어주세요.');
  if(!keys.krx)throw Error('KRX 키가 없습니다. 화면의 「API 및 데이터 → 2번」에 키를 넣거나 .env에 KRX_API_KEY=키 를 적어주세요.');
  const iso=/^\d{4}-\d{2}-\d{2}$/;
  if(!iso.test(from||'')||!iso.test(to||'')||from>=to)throw Error('수집 기간을 확인하세요. 시작일이 종료일보다 앞서야 합니다.');
  if(from<'2016-01-01')throw Error('OpenDART 재무제표 API는 2015 사업연도부터 제공하므로 시작일은 2016-01-01 이후로 입력하세요.');
  if(to>today)to=today;
  const report=(step,done,total,message)=>onProgress({step,done,total,message});
  let last=0;
  async function request(url,headers,label){
    for(let attempt=0;;attempt++){
      const wait=last+paceMs-Date.now();if(wait>0)await sleep(wait);last=Date.now();
      let r;
      try{r=await fetchImpl(url,{headers});}catch(e){if(attempt>=3)throw Error(label+' 연결에 실패했습니다: '+e.message);await sleep(1000*2**attempt);continue;}
      if(r.status===401||r.status===403){const t=await r.text().catch(()=>'');if(/Unauthorized API Call/i.test(t))throw Error(label+': KRX 키는 맞지만 이 서비스의 이용 승인이 없습니다. openapi.krx.co.kr → 서비스 이용 → 해당 API 이용 신청 후 승인(보통 1일 내외)을 기다려 주세요.');if(/Unauthorized Key/i.test(t))throw Error(label+': 키가 틀렸거나 만료되었습니다. 발급받은 인증키를 다시 복사해 넣어주세요.');throw Error(label+' 인증이 거부되었습니다(HTTP '+r.status+'). 키와 서비스 이용 승인 여부를 확인하세요.');}
      if(r.status===429||r.status>=500){if(attempt>=3)throw Error(label+' 서버 오류(HTTP '+r.status+')입니다. 잠시 후 다시 실행하세요.');await sleep(1500*2**attempt);continue;}
      if(!r.ok)throw Error(label+' 요청이 실패했습니다(HTTP '+r.status+').');
      return r;
    }
  }
  async function cached(name,make,keep=()=>true){
    const file=path.join(cacheDir,name+'.json');
    try{return JSON.parse(await readFile(file,'utf8'));}catch{}
    const v=await make();
    if(keep(v)){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(v));}
    return v;
  }
  const recent=ymd(new Date(Date.parse(today)-7*864e5));
  const krx=(api,date)=>cached('krx/'+api.replace('/','_')+'_'+compact(date),async()=>{
    const r=await request(KRX_BASE+api+'?basDd='+compact(date),{AUTH_KEY:keys.krx,Accept:'application/json'},'KRX '+api);
    const j=await r.json();
    if(!Array.isArray(j.OutBlock_1))throw Error('KRX '+api+' 응답이 예상과 다릅니다. 서비스 이용 승인 여부를 확인하세요: '+JSON.stringify(j).slice(0,160));
    return j.OutBlock_1;
  },rows=>rows.length>0||date<recent);
  async function dart(api,params,label){
    const r=await request(DART_BASE+api+'?'+new URLSearchParams({crtfc_key:keys.dart,...params}),{},label);
    const j=await r.json();
    if(j.status==='013')return null;
    if(j.status==='020')throw Error('OpenDART 하루 호출 한도를 넘었습니다. 내일 다시 실행하면 저장된 부분부터 이어서 수집합니다.');
    if(j.status!=='000')throw Error('OpenDART 오류('+j.status+'): '+j.message);
    return j;
  }

  // 1) 매월 마지막 거래일의 KOSPI·KOSDAQ 전 종목 시세와 코스피 지수
  const months=[];for(let y=+from.slice(0,4),m=+from.slice(5,7);`${y}-${String(m).padStart(2,'0')}`<=to.slice(0,7);m===12?(y++,m=1):m++)months.push([y,m]);
  const dates=[],markets={};let kosdaqOff=false;
  for(const [i,[y,m]] of months.entries()){
    report('prices',i,months.length,`${y}년 ${m}월 마지막 거래일 시세`);
    const first=`${y}-${String(m).padStart(2,'0')}-01`,floor=first<from?from:first;
    for(let day=new Date(Math.min(Date.UTC(y,m,0),Date.parse(to+'T00:00:00Z')));ymd(day)>=floor;day.setUTCDate(day.getUTCDate()-1)){
      if([0,6].includes(day.getUTCDay()))continue;
      const date=ymd(day),kospi=await krx('sto/stk_bydd_trd',date);
      if(!kospi.length)continue;
      let kosdaq=[];if(!kosdaqOff){try{kosdaq=await krx('sto/ksq_bydd_trd',date);}catch(e){if(!/이용 승인이 없습니다/.test(e.message))throw e;kosdaqOff=true;process.stdout.write('코스닥 일별매매정보 승인이 없어 KOSPI 종목만 수집합니다.\n');}}const index=(await krx('idx/kospi_dd_trd',date)).find(x=>String(x.IDX_NM).trim()==='코스피');
      if(!index)throw Error(date+' 코스피 지수 값이 KRX 응답에 없습니다.');
      dates.push(date);markets[date]={kospi,kosdaq,index:num(index.CLSPRC_IDX)};
      break;
    }
  }
  if(dates.length<2)throw Error('수집 기간 안에 거래일이 있는 달이 2개 이상 필요합니다.');
  const rows=new Map();
  for(const date of dates)for(const [market,list] of [['KOSPI',markets[date].kospi],['KOSDAQ',markets[date].kosdaq]])for(const x of list){
    let code=String(x.ISU_CD??x.ISU_SRT_CD??'').trim();if(/^KR\w{10}$/.test(code))code=code.slice(3,9);
    const close=num(x.TDD_CLSPRC),mcap=num(x.MKTCAP),shares=num(x.LIST_SHRS),volume=num(x.ACC_TRDVOL);
    if(!/^[0-9A-Z]{6}$/.test(code)||!(close>0)||!(mcap>0))continue;
    if(!rows.has(code))rows.set(code,{symbol:code,name:code,market,series:[]});
    const s=rows.get(code);s.name=String(x.ISU_NM||code).trim();s.market=market;s.series.push({date,close,mcap,shares,volume:Number.isFinite(volume)?volume:null});
  }

  // 2) 종목코드 → OpenDART 고유번호
  report('corp',0,1,'OpenDART 기업 고유번호 목록');
  const corpMap=await cached('dart/corpcode_'+compact(today),async()=>{
    const r=await request(DART_BASE+'corpCode.xml?crtfc_key='+encodeURIComponent(keys.dart),{},'OpenDART 고유번호');
    const buf=Buffer.from(await r.arrayBuffer());
    if(buf.subarray(0,2).toString()!=='PK'){const t=buf.toString('utf8');throw Error('OpenDART 고유번호 조회 실패: '+(t.match(/<message>(.*?)<\/message>/)?.[1]||t.match(/"message"\s*:\s*"([^"]+)"/)?.[1]||t.slice(0,120)));}
    const map={};
    for(const m of unzipFirst(buf).toString('utf8').matchAll(/<list>([\s\S]*?)<\/list>/g)){const get=t=>(m[1].match(new RegExp('<'+t+'>([^<]*)</'+t+'>'))?.[1]||'').trim();const stock=get('stock_code');if(stock)map[stock]=get('corp_code');}
    return map;
  });

  // 3) 사업보고서 주요계정(당기순이익·자본총계) — 연결 우선, 없으면 별도
  const corps=[...new Set([...rows.keys()].map(c=>corpMap[c]).filter(Boolean))].sort(),chunks=[];
  for(let i=0;i<corps.length;i+=100)chunks.push(corps.slice(i,i+100));
  const firstYear=Math.max(2015,+from.slice(0,4)-2),lastYear=+to.slice(0,4),fin=new Map();
  let step=0;const steps=chunks.length*(lastYear-firstYear+1);
  for(let fy=firstYear;fy<=lastYear;fy++)for(const chunk of chunks){
    report('financials',step++,steps,fy+' 사업연도 사업보고서');
    const id=createHash('sha1').update(chunk.join(',')).digest('hex').slice(0,12);
    const list=await cached(`dart/fin_${fy}_${id}`,async()=>(await dart('fnlttMultiAcnt.json',{corp_code:chunk.join(','),bsns_year:String(fy),reprt_code:'11011'},'OpenDART 재무제표'))?.list||[],()=>today>=`${fy+1}-04-15`);
    const by=new Map();
    for(const x of list){
      const code=String(x.stock_code||'').trim();if(!code)continue;
      const k=code+'|'+x.fs_div;if(!by.has(k))by.set(k,{code,fs:x.fs_div,rcept:String(x.rcept_no||'')});
      const o=by.get(k),name=String(x.account_nm||'').replace(/\s/g,''),v=num(x.thstrm_amount);
      if(name==='자본총계'&&(!x.sj_div||x.sj_div==='BS'))o.eq=v;
      if(/^당기순이익/.test(name)&&(!x.sj_div||['IS','CIS'].includes(x.sj_div))&&o.ni===undefined)o.ni=v;
    }
    const usable=o=>o&&Number.isFinite(o.eq)&&Number.isFinite(o.ni)&&/^\d{8}/.test(o.rcept);
    for(const o of by.values()){
      if(!usable(o)||o.fs==='OFS'&&usable(by.get(o.code+'|CFS')))continue;
      const filed=`${o.rcept.slice(0,4)}-${o.rcept.slice(4,6)}-${o.rcept.slice(6,8)}`;
      if(!fin.has(o.code))fin.set(o.code,[]);
      fin.get(o.code).push({fy,ni:o.ni,eq:o.eq,available:ymd(new Date(Date.parse(filed+'T00:00:00Z')+864e5)),filingId:o.rcept});
    }
  }

  // 4) 월말 시가총액과 그 시점까지 공시된 최신 사업보고서로 PER·PBR·ROE 계산
  const built=[];
  for(const s of rows.values()){
    const reports=(fin.get(s.symbol)||[]).sort((a,b)=>a.available.localeCompare(b.available)||a.fy-b.fy),snaps=[];
    for(const p of s.series){
      let f=null;for(const x of reports)if(x.available<=p.date&&(!f||x.fy>=f.fy))f=x;
      if(!f)continue;
      snaps.push({symbol:s.symbol,asOf:p.date,availableDate:p.date,fiscalYear:f.fy,per:f.ni!==0?round(p.mcap/f.ni):null,pbr:f.eq>0?round(p.mcap/f.eq):null,roe:f.eq>0?round(f.ni/f.eq*100):null,mcap:p.mcap,volume:p.volume,filingId:f.filingId});
    }
    if(snaps.length)built.push({s,snaps});
  }
  const sectors={};
  for(const [i,{s}] of built.entries()){
    report('companies',i,built.length,s.name+' 업종 정보');
    const corp=corpMap[s.symbol];
    sectors[s.symbol]=sectorOf((await cached('dart/company_'+corp,async()=>({induty:(await dart('company.json',{corp_code:corp},'OpenDART 기업개황'))?.induty_code||''}))).induty);
  }

  // 5) 배당: 사업보고서(3개년씩) + 1분기·반기 보고서로 지급 횟수와 지급 일정 추정
  const nowY=+today.slice(0,4),lastFy=today>=nowY+'-04-15'?nowY-1:nowY-2,divFrom=+from.slice(0,4)-1,dividends=[],divFreq={};
  const pickDps=j=>{const rows=(j?.list||[]).filter(x=>String(x.se||'').replace(/\s/g,'')==='주당현금배당금(원)');const r=rows.find(x=>x.stock_knd==='보통주')||rows[0];if(!r)return null;const v=x=>{const n=num(x);return Number.isFinite(n)&&n>0?n:0;};return {th:v(r.thstrm),fr:v(r.frmtrm),lw:v(r.lwfr)};};
  const alot=(corp,y,rc)=>cached(`dart/div_${corp}_${y}_${rc}`,async()=>pickDps(await dart('alotMatter.json',{corp_code:corp,bsns_year:String(y),reprt_code:rc},'OpenDART 배당')),()=>rc!=='11011'||today>=`${y+1}-04-15`);
  const fileBy=(y,rc)=>today>=(rc==='11013'?y+'-05-20':rc==='11012'?y+'-08-20':(y+1)+'-04-15');
  for(const [i,{s}] of built.entries()){
    report('dividends',i,built.length,s.name+' 배당 내역');
    const corp=corpMap[s.symbol];if(!corp)continue;
    const annual={};
    for(let y=lastFy;y>=divFrom;y-=3){const r=await alot(corp,y,'11011');if(!r)continue;for(const [k,fy] of [['th',y],['fr',y-1],['lw',y-2]])if(annual[fy]===undefined||k==='th')annual[fy]=r[k];}
    const q1=fileBy(lastFy,'11013')?await alot(corp,lastFy,'11013'):null,h1=fileBy(lastFy,'11012')?await alot(corp,lastFy,'11012'):null;
    const freq=q1?.th>0?4:h1?.th>0?2:annual[lastFy]>0?1:0;divFreq[s.symbol]=freq;
    const adj=adjustSplits(s.series),factor=date=>{let p=adj[0];for(const x of adj)if(x.date<=date)p=x;return p?p.adj/p.close:1;};
    const push=(fy,recordDate,payDate,dpsRaw)=>{if(dpsRaw>0)dividends.push({symbol:s.symbol,fiscalYear:fy,recordDate,payDate,dpsRaw:round(dpsRaw,2),dps:round(dpsRaw*factor(recordDate),4)});};
    const plus=(date,days)=>ymd(new Date(Date.parse(date+'T00:00:00Z')+days*864e5));
    const ends={4:['03-31','06-30','09-30','12-31'],2:['06-30','12-31'],1:['12-31']}[freq||1];
    for(const [fyS,total] of Object.entries(annual)){const fy=+fyS;if(fy<divFrom||!(total>0))continue;ends.forEach((md,j)=>{const rec=fy+'-'+md,last=j===ends.length-1;push(fy,rec,last?(fy+1)+'-04-20':plus(rec,50),total/ends.length);});}
    // 올해 이미 공시된 중간·분기배당
    const cy=lastFy+1;if(freq>=2){const c1=freq===4&&fileBy(cy,'11013')?await alot(corp,cy,'11013'):null,c2=fileBy(cy,'11012')?await alot(corp,cy,'11012'):null;
      if(c1?.th>0)push(cy,cy+'-03-31',plus(cy+'-03-31',50),c1.th);
      if(c2?.th>0)push(cy,cy+'-06-30',plus(cy+'-06-30',50),freq===4?Math.max(0,c2.th-(c1?.th||0)):c2.th);}
  }

  report('build',0,1,'데이터 파일 정리');
  const stocks=[],snapshots=[],prices=[];
  for(const {s,snaps} of built){
    stocks.push({symbol:s.symbol,name:s.name,sector:sectors[s.symbol],market:s.market,divFreq:divFreq[s.symbol]??null});
    snapshots.push(...snaps);
    for(const p of adjustSplits(s.series))prices.push({symbol:s.symbol,date:p.date,close:round(p.adj,4)});
  }
  const dataset={meta:{source:'OpenDART 사업보고서 · KRX Open API',asOf:dates.at(-1),version:'krx-dart-'+from+'_'+dates.at(-1)+'-'+compact(today),pointInTime:true,priceBasis:'split-adjusted-ex-dividend',frequency:'monthly',benchmarkName:'KOSPI',universePolicy:'매월 마지막 거래일의 '+(kosdaqOff?'KOSPI':'KOSPI·KOSDAQ')+' 상장 기업(이후 상장폐지 포함) · 사업보고서 공시 다음 날부터 사용 · 월말 종가'},stocks,snapshots,prices,dividends,benchmark:dates.map(date=>({date,close:markets[date].index}))};
  await mkdir(outDir,{recursive:true});
  const file=path.join(outDir,`krx-dart_${from}_${to}.json`);
  await writeFile(file,JSON.stringify(dataset));
  const stats={stocks:stocks.length,months:dates.length,snapshots:snapshots.length,prices:prices.length};
  report('build',1,1,`완료 · ${stats.stocks.toLocaleString()}개 기업 · ${stats.months}개월${kosdaqOff?' (코스닥 미승인: KOSPI만)':''}`);
  return {file,dataset,stats};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const arg=name=>{const i=process.argv.indexOf('--'+name);return i>0?process.argv[i+1]:undefined;};
  let shown='';
  collect({from:arg('from')||'2019-01-01',to:arg('to')||ymd(new Date()),onProgress:({done,total,message})=>{const line=`[${done+1}/${total}] ${message}`;if(line!==shown)console.log(shown=line);}})
    .then(({file,stats})=>console.log(`\n저장했습니다: ${file}\n기업 ${stats.stocks} · ${stats.months}개월 · 재무 스냅샷 ${stats.snapshots} · 가격 ${stats.prices}`))
    .catch(e=>{console.error('수집 실패: '+e.message);process.exitCode=1;});
}
