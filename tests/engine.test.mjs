import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{createEngine,validateEndpoint} from '../worker/index.js';
const E=createEngine();
function fixture(){return E.validate({meta:{source:'test',asOf:'2024-04-30',version:'1',pointInTime:true,priceBasis:'split-adjusted-ex-dividend',benchmarkName:'KOSPI'},stocks:[{symbol:'A',name:'Test A'}],snapshots:[{symbol:'A',asOf:'2023-04-28',availableDate:'2023-03-20',fiscalYear:2022,per:10,pbr:1,roe:15},{symbol:'A',asOf:'2023-04-28',availableDate:'2023-05-03',fiscalYear:2022,per:1,pbr:.1,roe:99}],prices:[{symbol:'A',date:'2023-04-28',close:100},{symbol:'A',date:'2023-05-02',close:100},{symbol:'A',date:'2023-12-01',close:80},{symbol:'A',date:'2024-04-30',close:120}],benchmark:[{date:'2023-04-28',close:1000},{date:'2023-05-02',close:1000},{date:'2023-12-01',close:1050},{date:'2024-04-30',close:1120}]});}
const filters={per:[0,15],pbr:[0,2],roe:[10,35]};
test('same-day future disclosures are excluded by availability',()=>{const d=fixture();assert.equal(E.snapshotAt(d,'A','2023-04-28',2022).roe,15);assert.equal(E.snapshotAt(d,'A','2023-05-04',2022).roe,99);});
test('filter boundaries use AND and reject null or nonpositive ratios',()=>{assert.equal(E.screen(fixture(),{per:[10,10],pbr:[1,1],roe:[15,15]},{asOf:'2023-04-28'}).length,1);assert.equal(E.matches({per:null,pbr:1,roe:15},filters),false);assert.equal(E.matches({per:-1,pbr:1,roe:15},filters),false);assert.throws(()=>E.checkFilters({...filters,per:[15,1]}));});
test('exact common-period profit, active return and drawdown',()=>{const r=E.backtest(fixture(),{year:2023,symbol:'A',capital:10000000,fee:0,filters});assert.ok(Math.abs(r.totalReturn-20)<1e-10);assert.ok(Math.abs(r.benchmarkReturn-12)<1e-10);assert.ok(Math.abs(r.excess-8)<1e-10);assert.ok(Math.abs(r.profit-2000000)<1e-6);assert.ok(Math.abs(r.excessProfit-800000)<1e-6);assert.ok(Math.abs(r.maxDrawdown+20)<1e-10);assert.equal(r.start,'2023-05-02');assert.equal(r.end,'2024-04-30');assert.equal(r.metrics.roe,15);});
test('buy and sell costs are both applied within starting budget',()=>{const r=E.backtest(fixture(),{year:2023,symbol:'A',capital:10000,fee:1,filters});assert.ok(Math.abs(r.finalValue-(10000/1.01*1.2*.99))<1e-9);assert.ok(Math.abs(r.transactionCost-(10000/1.01*.01+10000/1.01*1.2*.01))<1e-9);});
test('monthly investing buys on each month first trading day and compares with lump sum of the same principal',()=>{
 const r=E.backtest(fixture(),{year:2023,symbol:'A',mode:'dca',monthly:1000,fee:0,filters});
 assert.equal(r.installments,2);assert.equal(r.capital,2000);
 assert.ok(Math.abs(r.finalValue-2700)<1e-9);assert.ok(Math.abs(r.totalReturn-35)<1e-10);
 assert.ok(Math.abs(r.benchmarkFinal-(1+1000/1050)*1120)<1e-9);assert.ok(Math.abs(r.maxDrawdown+20)<1e-10);
 assert.ok(Math.abs(r.lump.finalValue-2400)<1e-9);assert.ok(Math.abs(r.dca.finalValue-r.lump.finalValue-300)<1e-9);
 assert.equal(r.points[1].invested,2000);
 const l=E.backtest(fixture(),{year:2023,symbol:'A',mode:'lump',capital:2000,fee:0,filters});
 assert.ok(Math.abs(l.dca.finalValue-r.finalValue)<1e-9);
 assert.throws(()=>E.backtest(fixture(),{year:2023,symbol:'A',mode:'dca',monthly:10,filters}),/월 납입액/);
});
test('benchmark underperformance remains negative',()=>{const d=fixture();d.prices.at(-1).close=105;const r=E.backtest(d,{year:2023,symbol:'A',fee:0,filters});assert.ok(r.excess<0);assert.ok(r.excessProfit<0);});
test('missing prices cannot silently disappear from the backtest',()=>{const d=fixture();d.prices=d.prices.filter(p=>p.date!=='2023-12-01');assert.throws(()=>E.backtest(d,{year:2023,symbol:'A',filters}),/2023-12-01/);});
test('unverified point-in-time and unadjusted price bases are blocked',()=>{const d=fixture();d.meta.pointInTime=false;assert.throws(()=>E.backtest(d,{year:2023,symbol:'A'}),/과거 시점/);d.meta.pointInTime=true;d.meta.priceBasis='raw';assert.throws(()=>E.backtest(d,{year:2023,symbol:'A'}),/분할/);});
test('incomplete holding period is rejected',()=>{const d=fixture();d.benchmark.pop();assert.throws(()=>E.period(d,2023),/전체/);});
test('malformed dates, duplicate prices and unknown tickers are rejected',()=>{const d=fixture();d.prices.push({...d.prices[0]});assert.throws(()=>E.validate(d),/중복/);const x=fixture();x.prices[0].date='2023-02-30';assert.throws(()=>E.validate(x));const y=fixture();y.prices[0].symbol='B';assert.throws(()=>E.validate(y));});
test('external URL guard rejects internal and credential-bearing endpoints',()=>{for(const u of ['http://example.com','https://127.0.0.1/','https://localhost/','https://[::1]/','https://meta.internal/','https://x.example.com/?apikey=abc','https://u:p@example.com/'])assert.throws(()=>validateEndpoint(u));assert.equal(validateEndpoint('https://api.example.com/data?from=2020-01-01').hostname,'api.example.com');});
test('server blocks cross-origin connections and rejects invalid config',async()=>{let r=await worker.fetch(new Request('https://test.example/api/connect',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'}));assert.equal(r.status,403);r=await worker.fetch(new Request('https://test.example/api/connect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:'http://localhost'})}));assert.equal(r.status,400);});
test('server validates connected provider data using mocked HTTP',async()=>{const original=globalThis.fetch;let seen;globalThis.fetch=async(u,o)=>{seen=o;return new Response(JSON.stringify(fixture()),{headers:{'content-type':'application/json'}});};try{const r=await worker.fetch(new Request('https://test.example/api/connect',{method:'POST',headers:{origin:'https://test.example','content-type':'application/json'},body:JSON.stringify({endpoint:'https://api.example.com/data',key:'test-key',auth:'bearer'})}));assert.equal(r.status,200);assert.equal(seen.headers.Authorization,'Bearer test-key');assert.equal((await r.json()).stocks.length,1);}finally{globalThis.fetch=original;}});
test('demo is repeatable, clearly synthetic and supports each offered complete year',()=>{const a=E.demo(),b=E.demo();assert.equal(a.meta.demo,true);assert.equal(a.stocks.length,24);assert.deepEqual(a.prices.slice(0,30),b.prices.slice(0,30));let count=0;for(let year=2020;year<=2025;year++){const p=E.period(a,year);const rows=E.screen(a,filters,{asOf:p.cutoff,fiscalYear:year-1});assert.ok(rows.length>0);const r=E.backtest(a,{year,symbol:rows[0].symbol,filters});assert.ok(Number.isFinite(r.excess));count++;}assert.equal(count,6);});

test('custom three-year period uses prior disclosures and requires matching filters',()=>{
 const e=createEngine(),d=e.demo(),filters={per:[0,100],pbr:[0,100],roe:[-100,100]};
 const p=e.datePeriod(d,'2023-05-01','2026-04-30');
 assert.equal(p.cutoff,'2023-04-28');
 const candidate=e.screen(d,filters,{asOf:p.cutoff})[0];
 const r=e.backtest(d,{start:'2023-05-01',end:'2026-04-30',symbol:candidate.symbol,filters});
 assert.equal(r.end,'2026-04-30');assert.ok(r.metrics.availableDate<r.start);assert.ok(r.points.length>700);
 assert.throws(()=>e.backtest(d,{start:'2023-05-01',end:'2026-04-30',symbol:candidate.symbol,filters:{per:[999,1000],pbr:[0,100],roe:[-100,100]}}));
 assert.throws(()=>e.datePeriod(d,'2023-02-30','2026-04-30'));
});
