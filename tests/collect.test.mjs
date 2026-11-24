import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {collect,adjustSplits,sectorOf,unzipFirst} from '../scripts/collect.mjs';
import {createEngine} from '../worker/index.js';

function zip(name,text){
  const data=Buffer.from(text),packed=deflateRawSync(data),n=Buffer.from(name);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(8,8);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(n.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(8,10);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(0,42);
  const cdOffset=30+n.length+packed.length,end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(46+n.length,12);end.writeUInt32LE(cdOffset,16);
  return Buffer.concat([local,n,packed,central,n,end]);
}
const trade=(code,close,shares)=>({ISU_CD:code,ISU_NM:'종목'+code,TDD_CLSPRC:close.toLocaleString('en-US'),MKTCAP:String(close*shares),LIST_SHRS:String(shares)});
const days={
  '20230131':{stk:[trade('000001',50000,100),trade('000005',30000,10)],ksq:[trade('100002',2000,1000)]},
  '20230227':{stk:[trade('000001',10200,500),trade('000005',30000,10)],ksq:[trade('100002',2100,1000)]},
  '20230331':{stk:[trade('000001',11000,500),trade('000005',30000,10)],ksq:[trade('100002',2200,1000)]},
};
const acct=(stock,fs,rcept,ni,eq)=>[{stock_code:stock,fs_div:fs,rcept_no:rcept,sj_div:'IS',account_nm:'당기순이익',thstrm_amount:ni.toLocaleString('en-US')},{stock_code:stock,fs_div:fs,rcept_no:rcept,sj_div:'BS',account_nm:'자본총계',thstrm_amount:eq.toLocaleString('en-US')}];
const fin={
  2021:[...acct('000001','CFS','20220321000111',500000,4000000),...acct('000001','OFS','20220321000111',1,1),...acct('100002','OFS','20220330000222',-100000,1000000)],
  2022:[...acct('000001','CFS','20230315000333',1000000,5000000),...acct('100002','OFS','20230331000444',200000,1100000)],
};
const seen={krxKey:new Set(),dartKey:new Set()};
async function fakeFetch(url,{headers}={}){
  const u=new URL(url),json=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
  if(u.hostname==='data-dbg.krx.co.kr'){
    seen.krxKey.add(headers.AUTH_KEY);const api=u.pathname.split('/apis/')[1],day=days[u.searchParams.get('basDd')];
    if(api==='idx/kospi_dd_trd')return json({OutBlock_1:day?[{IDX_NM:'코스피 200',CLSPRC_IDX:'320.00'},{IDX_NM:'코스피',CLSPRC_IDX:'2,400.00'}]:[]});
    return json({OutBlock_1:day?(api==='sto/stk_bydd_trd'?day.stk:day.ksq):[]});
  }
  seen.dartKey.add(u.searchParams.get('crtfc_key'));
  if(u.pathname.endsWith('corpCode.xml'))return new Response(zip('CORPCODE.xml','<result><list><corp_code>00000001</corp_code><corp_name>A</corp_name><stock_code>000001</stock_code></list><list><corp_code>00000002</corp_code><corp_name>B</corp_name><stock_code>100002</stock_code></list><list><corp_code>00000009</corp_code><corp_name>비상장</corp_name><stock_code> </stock_code></list></result>'));
  if(u.pathname.endsWith('fnlttMultiAcnt.json')){const list=fin[u.searchParams.get('bsns_year')];return json(list?{status:'000',list}:{status:'013',message:'조회된 데이타가 없습니다.'});}
  if(u.pathname.endsWith('alotMatter.json')){const c=u.searchParams.get('corp_code'),y=u.searchParams.get('bsns_year'),rc=u.searchParams.get('reprt_code');const row=(th,fr,lw)=>({se:'주당 현금배당금(원)',stock_knd:'보통주',thstrm:th,frmtrm:fr,lwfr:lw});if(c==='00000001'&&y==='2022'&&rc==='11011')return json({status:'000',list:[{se:'현금배당수익률(%)',stock_knd:'보통주',thstrm:'2.0'},row('1,000','800','-')]});if(c==='00000001'&&y==='2022'&&rc==='11013')return json({status:'000',list:[row('250','800','-')]});return json({status:'013',message:'조회된 데이타가 없습니다.'});}
  if(u.pathname.endsWith('company.json'))return json({status:'000',induty_code:u.searchParams.get('corp_code')==='00000001'?'264':'58221'});
  return new Response('',{status:404});
}

test('helpers: sector mapping, zip reading and split adjustment',()=>{
  assert.equal(sectorOf('264'),'반도체·전자부품');assert.equal(sectorOf('21102'),'제약·바이오');assert.equal(sectorOf(''),'미분류');
  assert.equal(unzipFirst(zip('a.xml','hello')).toString(),'hello');
  const adj=adjustSplits([{close:50000,shares:100},{close:10200,shares:500},{close:11000,shares:600}]);
  assert.deepEqual(adj.map(x=>x.adj),[10000,10200,11000]);
});

test('collector builds a valid monthly point-in-time dataset from OpenDART and KRX responses',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'degul-'));
  try{
    const {dataset:d,stats}=await collect({from:'2023-01-01',to:'2023-03-31',today:'2023-04-30',keys:{dart:'dart-key',krx:'krx-key'},cacheDir:path.join(dir,'cache'),outDir:dir,fetchImpl:fakeFetch,paceMs:0});
    assert.deepEqual([...seen.krxKey],['krx-key']);assert.deepEqual([...seen.dartKey],['dart-key']);
    assert.deepEqual(d.stocks.map(s=>[s.symbol,s.market,s.sector]),[['000001','KOSPI','반도체·전자부품'],['100002','KOSDAQ','출판·소프트웨어']]);
    assert.deepEqual(d.benchmark,[{date:'2023-01-31',close:2400},{date:'2023-02-27',close:2400},{date:'2023-03-31',close:2400}]);
    assert.deepEqual(d.prices.filter(p=>p.symbol==='000001').map(p=>p.close),[10000,10200,11000]);
    const snap=(s,date)=>d.snapshots.find(x=>x.symbol===s&&x.asOf===date);
    assert.deepEqual(['fiscalYear','per','pbr','roe'].map(k=>snap('000001','2023-01-31')[k]),[2021,10,1.25,12.5]);
    assert.deepEqual(['fiscalYear','per','pbr','roe'].map(k=>snap('000001','2023-03-31')[k]),[2022,5.5,1.1,20]);
    assert.deepEqual(['fiscalYear','per','roe'].map(k=>snap('100002','2023-03-31')[k]),[2021,-22,-10]);
    assert.equal(stats.months,3);
    assert.deepEqual(d.stocks.map(s=>s.divFreq),[4,0]);
    assert.deepEqual(d.dividends.map(x=>[x.symbol,x.fiscalYear,x.recordDate,x.payDate,x.dpsRaw]),[['000001',2022,'2022-03-31','2022-05-20',250],['000001',2022,'2022-06-30','2022-08-19',250],['000001',2022,'2022-09-30','2022-11-19',250],['000001',2022,'2022-12-31','2023-04-20',250]]);
    const E=createEngine(),v=E.validate(d);
    assert.equal(v.meta.frequency,'monthly');
    assert.deepEqual(E.screen(v,{per:[0,15],pbr:[0,5],roe:[0,50]},{asOf:'2023-03-31'}).map(s=>s.symbol),['000001']);
    const r=E.backtest(v,{start:'2023-02-01',end:'2023-03-31',symbol:'000001',fee:0,filters:{per:[0,100],pbr:[0,10],roe:[0,100]}});
    assert.equal(r.cutoff,'2023-01-31');assert.equal(r.start,'2023-02-27');
    assert.ok(Math.abs(r.totalReturn-(11000/10200-1)*100)<1e-9);
    // 두 번째 실행은 아직 마감 전인 2023 사업연도만 다시 묻고 나머지는 저장된 응답을 씁니다.
    const calls=[];
    await collect({from:'2023-01-01',to:'2023-03-31',today:'2023-04-30',keys:{dart:'dart-key',krx:'krx-key'},cacheDir:path.join(dir,'cache'),outDir:dir,fetchImpl:(u,o)=>{calls.push(new URL(u));return fakeFetch(u,o);},paceMs:0});
    assert.deepEqual(calls.map(u=>u.pathname.split('/').pop()+':'+(u.searchParams.get('bsns_year')||'')),['fnlttMultiAcnt.json:2023']);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('collector rejects missing keys and periods before OpenDART coverage',async()=>{
  await assert.rejects(collect({from:'2023-01-01',to:'2023-03-31',keys:{dart:'',krx:'k'}}),/DART_API_KEY/);
  await assert.rejects(collect({from:'2014-01-01',to:'2015-03-31',keys:{dart:'d',krx:'k'}}),/2016-01-01/);
});
