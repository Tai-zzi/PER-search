// 개발자 PC에서 수집한 최신 data/krx-dart_*.json을 배포 사이트의 기본 데이터로 게시합니다.
// 방문자는 API 키 없이 실제 종목을 보게 됩니다. (키는 이 PC의 .env에만 있고 배포되지 않음)
// 사용: npm run publish-data            (가장 최근 수집 파일)
//       npm run publish-data -- 파일경로  (특정 파일)
import {readdir,stat,readFile,mkdir,copyFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {projectRoot} from './collect.mjs';
import {createEngine} from '../worker/index.js';

async function latest(){
  const dir=path.join(projectRoot,'data');
  const files=await Promise.all((await readdir(dir)).filter(f=>/^krx-dart_.*\.json$/.test(f)).map(async f=>({f:path.join(dir,f),t:(await stat(path.join(dir,f))).mtimeMs})));
  files.sort((a,b)=>b.t-a.t);
  if(!files.length)throw Error('data 폴더에 수집 파일이 없습니다. 먼저 npm run collect를 실행하세요.');
  return files[0].f;
}
const file=process.argv[2]?path.resolve(process.argv[2]):await latest();
const data=createEngine().validate(JSON.parse(await readFile(file,'utf8')));
const size=(await stat(file)).size;
console.log(`검증 완료: ${path.basename(file)} · ${data.stocks.length}개 기업 · ${data.meta.asOf} 기준 · ${(size/1024/1024).toFixed(1)}MB`);
if(size>25*1024*1024)throw Error('Cloudflare 정적 파일 한도(25MB)를 넘습니다. 수집 기간을 줄이세요.');
const out=path.join(projectRoot,'published','_data');
await mkdir(out,{recursive:true});
await copyFile(file,path.join(out,'dataset.json'));
const r=spawnSync('npx',['--yes','wrangler@4','deploy'],{stdio:'inherit',shell:process.platform==='win32',cwd:projectRoot});
if(r.status!==0){console.error('배포에 실패했습니다.');process.exit(r.status||1);}
console.log('게시 완료: 배포 사이트를 새로고침하면 실제 데이터가 기본으로 표시됩니다.');
