import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TaskStore} from '../src/platform/store.js';
import {GroupMrService,type Entry} from '../src/modules/automation/group-mr.js';
import {reviewThreads,reviewFiles,reviewFileText,fullReviewDiff,recoveredReviewDiff,addedLines,supportsReviewCommand} from '../src/modules/automation/group-mr-workbench.js';
const sha='a'.repeat(40),other='b'.repeat(40),diff='@@ -1,2 +1,3 @@\n old\n+new\n tail';
const help=(kind:string)=>`Usage: codehub-cli mr review ${kind} <iid>${kind==='reply'?' <discussion-id>':''} [options]\nOptions:\n  -p, --project <project>\n  --body <body>\n  --path <path>\n  --line <line>`;
const cobraHelp=(kind:string)=>`Usage:
  codehub-cli mr review ${kind} <mr-iid>${kind==='reply'?' <discussion-id>':''} [flags]
Flags:
  -b, --body string              Review comment content
  -F, --body-file string         Read body from file
      --path string              File path for line-level review
      --line lineRange           Line number in new version (N) or range (N-M)
      --severity string          Severity (suggestion/minor/major/fatal)
  -p, --project string           Project ID or path`;
function fixture(mode='ok'){
 const store=new TaskStore(':memory:');let resolved=false,reply='',extra=false,head=sha,views=0;
 const writes:string[][]=[],reads:string[][]=[];
 const notes=()=>[{id:'thread',resolved,notes:[{id:'1',body:'Please fix',resolvable:true,author:{username:'reviewer'},position:{new_path:'src/a.ts',new_line:2,head_sha:sha}},...(reply?[{id:'2',body:reply,author:{username:'owner'}}]:[]),...(extra?[{id:'3',body:'changed concurrently',author:{username:'developer'}}]:[])]}];
 const service=new GroupMrService(store,async args=>{
  let value:unknown={};
  if(args.includes('--help'))return {exitCode:0,output:mode==='unsupported'?'unknown command':cobraHelp(args[3]!)};
  if(args[2]==='view'){views++;value={iid:1,diff_refs:mode==='missing-base'?undefined:{base_sha:other},state:mode==='closed'?'closed':'opened',sha:mode==='changed-read'&&views>1?other:head};}
  else if(args[2]==='changes'){
   if(mode==='capture'&&!args.includes('--jq'))return {exitCode:0,output:'partial',outputTruncated:true};
   value={changes:[{new_path:'src/a.ts',old_path:mode==='renamed'?'old/a.ts':'src/a.ts',diff:['capture','large','renamed','missing-base','binary','added','deleted'].includes(mode)?undefined:diff,too_large:mode==='large',binary:mode==='binary',new_file:mode==='added',deleted_file:mode==='deleted'}]};
  }
  else if(args[1]==='repo'&&args[2]==='file'&&args[3]==='get'){reads.push([...args]);assert.equal(args[args.indexOf('--columns')+1],'content,file_path,path,encoding,size,truncated,is_limited');if(mode==='file-fail')return {exitCode:1,output:'unknown option: secret-token'};value={[mode==='path-field'||mode==='large'?'path':'file_path']:args.find(a=>a.startsWith('--file-path='))!.slice('--file-path='.length),encoding:'base64',content:Buffer.from(args[args.indexOf('--ref')+1]===other?'old\ntail\n':'old\nnew\ntail\n').toString('base64')};}
  else if(args[3]==='list')value=notes();
  else if(args[2]==='review'){
   writes.push([...args]);
   if(['create','reply'].includes(args[3]!)&&!args.includes('--severity'))return {exitCode:1,output:"error: categories_and_modules_enabled is true, required: --severity. Run 'codehub-cli setting review-config' to see available values"};
   if(mode==='denied')return {exitCode:1,output:'HTTP 403 Forbidden'};
   if(mode==='timeout')return {exitCode:124,output:'timeout'};
   if(args[3]==='resolve')resolved=true;
   else reply=args[args.indexOf('--body')+1]!;
   if(mode==='accepted-timeout')return {exitCode:124,output:'timeout'};
  }else throw Error('Unexpected command: '+args.slice(0,4).join(' '));
  return {exitCode:0,output:JSON.stringify(value)};
 });
 const e:Entry={id:randomUUID(),repo:'MAE-M/Access/Demo',iid:'1',url:'https://codehub-y.huawei.com/MAE-M/Access/Demo/merge_requests/1',sha,previousSha:'',messageId:'1',sender:'developer',shortcut:false,phase:'ISSUES',status:'待修改',detail:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),writePending:'',events:[]};
 store.putRecord('group-mr-entry',e.id,e);
 return {service,store,e,writes,reads,notes,setHead:()=>{head=other;},changeThread:()=>{extra=true;},shutdown:async()=>{await service.close();store.close();}};
}
test('full diff reconstructs gaps and shifted old line numbers, including empty, renamed and deleted files',()=>{
 const file={path:'new.ts',oldPath:'old.ts',status:'renamed',unavailable:false,diff:'@@ -2,2 +2,3 @@\n-old\n+new\n+extra\n same\n@@ -6 +7 @@\n-last\n+changed'};
 assert.equal(fullReviewDiff(file,'first\nnew\nextra\nsame\ngap1\ngap2\nchanged\ntail\n'),'@@ -1,7 +1,8 @@\n first\n-old\n+new\n+extra\n same\n gap1\n gap2\n-last\n+changed\n tail');
 assert.equal(fullReviewDiff({...file,diff:'@@ -0,0 +1,1 @@\n+new'},'new'),'@@ -0,0 +1,1 @@\n+new');
 assert.equal(fullReviewDiff({...file,status:'deleted',diff:'@@ -1,2 +0,0 @@\n-a\n-b'},''),'@@ -1,2 +0,0 @@\n-a\n-b');
 assert.equal(fullReviewDiff({...file,diff:''},'same\n'),'@@ -1,1 +1,1 @@\n same');
 assert.equal(fullReviewDiff({...file,diff:''},''),'@@ -0,0 +0,0 @@\n');
 assert.equal(fullReviewDiff({...file,diff:'@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file'},'b'),'@@ -1,1 +1,1 @@\n-a\n+b');
 assert.throws(()=>fullReviewDiff(file,'wrong content'),/不一致/);
 assert.throws(()=>fullReviewDiff({...file,diff:'@@ -1,2 +1,1 @@\n same'},'same'),/不一致/);
 assert.throws(()=>fullReviewDiff({...file,unavailable:true},''),/不完整/);
});
test('file decoding rejects wrong path, binary, invalid encoding and truncated output without logging source',()=>{
 const encode=(content:string)=>({file_path:'a.ts',encoding:'base64',content:Buffer.from(content).toString('base64')});
 assert.equal(reviewFileText(JSON.stringify(encode('你好\r\n<script>')),'a.ts'),'你好\r\n<script>');
 assert.equal(reviewFileText(JSON.stringify(encode('')),'a.ts'),'');
 for(const data of [{...encode('x'),file_path:'other'},{...encode('x'),truncated:true},{...encode('x'),size:99},{...encode('x'),content:'?'},encode('a\0b'),{...encode('x'),content:'/w=='}])assert.throws(()=>reviewFileText(JSON.stringify(data),'a.ts'));
});
test('file context is a read pinned to the head and restricted to the current MR files',async()=>{
 const f=fixture();try{
  const result=await f.service.reviewFileContext(f.e.id,{sha,path:'src/a.ts'});
  assert.equal(result.sha,sha);assert.equal(result.originalDiff,diff);assert.match(result.diff,/\+new/);assert.equal(f.reads.length,1);
  assert.ok(f.reads[0]!.includes('--file-path=src/a.ts'));assert.equal(f.reads[0]![f.reads[0]!.indexOf('--ref')+1],sha);assert.equal(f.writes.length,0);
  await assert.rejects(f.service.reviewFileContext(f.e.id,{sha,path:'../other'}),/不在当前变更/);assert.equal(f.reads.length,1);
  f.setHead();await assert.rejects(f.service.reviewFileContext(f.e.id,{sha,path:'src/a.ts'}),/提交已变化/);assert.equal(f.reads.length,1);
 }finally{await f.shutdown();}
 const changed=fixture('changed-read');try{await assert.rejects(changed.service.reviewFileContext(changed.e.id,{sha,path:'src/a.ts'}),/提交已变化/);assert.equal(changed.writes.length,0);}finally{await changed.shutdown();}
});
test('workbench parsers preserve threads/positions, reject incomplete data, and map only added lines',()=>{
 const f=fixture();try{const threads=reviewThreads(JSON.stringify(f.notes()));assert.equal(threads[0]!.line,2);assert.equal(threads[0]!.notes[0]!.author,'reviewer');assert.equal(threads[0]!.resolvable,true);assert.equal(threads[0]!.fingerprint.length,64);
 assert.deepEqual([...addedLines(diff)],[2]);assert.equal(reviewFiles(JSON.stringify({changes:[{new_path:'x',binary:true}]}))[0]!.unavailable,true);
 for(const output of ['null','{}','{"data":[],"has_more":true}','{"data":[],"total":2}','{"data":[{"id":"1"}]}'])assert.throws(()=>reviewThreads(output));
 assert.equal(supportsReviewCommand(help('reply'),'reply'),true);assert.equal(supportsReviewCommand(help('create'),'create'),true);assert.equal(supportsReviewCommand('reply exists; try --body','reply'),false);
 }finally{void f.shutdown();}
});
test('workspace reads actual diff and complete discussions, checks head twice, and never writes',async()=>{
 const f=fixture();try{const result=await f.service.reviewWorkspace(f.e.id);assert.equal(result?.sha,sha);assert.equal(result?.files[0]!.path,'src/a.ts');assert.equal(result?.threads.length,1);assert.equal(result?.capabilities.reply,true);assert.equal(f.writes.length,0);}finally{await f.shutdown();}
 const changed=fixture('changed-read');try{await assert.rejects(changed.service.reviewWorkspace(changed.e.id),/提交已变化/);}finally{await changed.shutdown();}
});
for(const action of ['resolve','reply','create'] as const)test('manual '+action+' uses one write and confirms remotely without merging',async()=>{
 const f=fixture();try{const fingerprint=reviewThreads(JSON.stringify(f.notes()))[0]!.fingerprint;
 const data=action==='create'?{action,sha,operationId:randomUUID(),path:'src/a.ts',line:2,body:'Check this'}:action==='reply'?{action,sha,operationId:randomUUID(),discussionId:'thread',fingerprint,body:'Fixed now'}:{action,sha,operationId:randomUUID(),discussionId:'thread',fingerprint,confirmed:true,reason:'已核对修复'};
 await f.service.reviewWorkspaceAction(f.e.id,data);await f.service.reviewWorkspaceAction(f.e.id,data);assert.equal(f.writes.length,1);assert.equal(f.writes[0]![3],action);const saved=f.store.getRecord<Entry>('group-mr-entry',f.e.id)!;assert.equal(saved.writePending,'');assert.equal(saved.phase,'ISSUES');assert.equal(saved.manualReviewPending,undefined);assert.ok(saved.events.length>0);
 if(action==='resolve')assert.equal(f.writes[0]!.includes('--severity'),false);else assert.equal(f.writes[0]![f.writes[0]!.indexOf('--severity')+1],'suggestion');
 }finally{await f.shutdown();}
});
test('manual create and reply preserve each explicitly selected severity',async()=>{
 for(const action of ['create','reply'] as const)for(const severity of ['suggestion','minor','major','fatal']){
  const f=fixture();try{
   const common={action,sha,operationId:randomUUID(),body:'Original review content',severity};
   const input=action==='create'?{...common,path:'src/a.ts',line:2}:{...common,discussionId:'thread',fingerprint:reviewThreads(JSON.stringify(f.notes()))[0]!.fingerprint};
   await f.service.reviewWorkspaceAction(f.e.id,input);
   assert.equal(f.writes.length,1);assert.equal(f.writes[0]![f.writes[0]!.indexOf('--severity')+1],severity);
  }finally{await f.shutdown();}
 }
});
test('invalid manual severity rejects create and reply before any write',async()=>{
 for(const action of ['create','reply'] as const)for(const severity of ['critical','--token',null,1]){
  const f=fixture();try{
   const common={action,sha,operationId:randomUUID(),body:'Original review content',severity};
   const input=action==='create'?{...common,path:'src/a.ts',line:2}:{...common,discussionId:'thread',fingerprint:reviewThreads(JSON.stringify(f.notes()))[0]!.fingerprint};
   await assert.rejects(f.service.reviewWorkspaceAction(f.e.id,input));
   assert.equal(f.writes.length,0);assert.equal(f.store.getRecord<Entry>('group-mr-entry',f.e.id)?.writePending,'');
  }finally{await f.shutdown();}
 }
});
for(const mode of ['timeout','accepted-timeout','denied'])test('uncertain '+mode+' is persisted, blocked from replay, and refresh is read-only',async()=>{
 const f=fixture(mode);try{const input={action:'resolve',sha,operationId:randomUUID(),discussionId:'thread',fingerprint:reviewThreads(JSON.stringify(f.notes()))[0]!.fingerprint,confirmed:true,reason:'checked'};
 await assert.rejects(f.service.reviewWorkspaceAction(f.e.id,input));assert.equal(f.writes.length,1);assert.ok(f.store.getRecord<Entry>('group-mr-entry',f.e.id)!.writePending);
 await assert.rejects(f.service.reviewWorkspaceAction(f.e.id,input),/待核对/);const result=await f.service.reviewWorkspace(f.e.id);assert.equal(f.writes.length,1);assert.equal(!!result?.writePending,mode!=='accepted-timeout');
 }finally{await f.shutdown();}
});
for(const mode of ['stale','discussion','closed','hidden','superseded','unconfirmed','invalid-line','unsupported'])test('reject unsafe workbench write before any mutation: '+mode,async()=>{
 const f=fixture(mode);try{const input:Record<string,unknown>={action:'resolve',sha,operationId:randomUUID(),discussionId:'thread',fingerprint:reviewThreads(JSON.stringify(f.notes()))[0]!.fingerprint,confirmed:true,reason:'checked'};
 if(mode==='stale')f.setHead();if(mode==='discussion')f.changeThread();if(mode==='hidden')f.store.putRecord('group-mr-hidden',f.e.id,{id:f.e.id});if(mode==='superseded'){f.e.supersededBy=randomUUID();f.store.putRecord('group-mr-entry',f.e.id,f.e);}if(mode==='unconfirmed')input.confirmed=false;
 const request=mode==='invalid-line'?{action:'create',sha,operationId:randomUUID(),path:'src/a.ts',line:1,body:'test'}:mode==='unsupported'?{action:'reply',sha,operationId:randomUUID(),discussionId:'thread',fingerprint:input.fingerprint,body:'test'}:input;
 await assert.rejects(f.service.reviewWorkspaceAction(f.e.id,request));assert.equal(f.writes.length,0);
 }finally{await f.shutdown();}
});
test('MR reservation rejects a concurrent close',async()=>{
 const f=fixture();try{let finish:()=>void=()=>{};const wait=new Promise<void>(r=>finish=r);f.service['workbenchHead']=async()=>{await wait;return {iid:'1',state:'opened',sha};};
 const input={action:'resolve',sha,operationId:randomUUID(),discussionId:'thread',fingerprint:reviewThreads(JSON.stringify(f.notes()))[0]!.fingerprint,confirmed:true,reason:'checked'};
 const first=f.service.reviewWorkspaceAction(f.e.id,input);await assert.rejects(f.service.reviewWorkspaceAction(f.e.id,input),/执行或排队/);finish();await first;assert.equal(f.writes.length,1);
 }finally{await f.shutdown();}
});
test('CodeHub null is not proof of closure, missing resolvability metadata does not hide review issues',()=>{
 const notes=reviewThreads(JSON.stringify([{id:'closed',resolved:null,notes:[{body:'closed'}]},{id:'open',resolved:false,notes:[{body:'open'}]},{id:'general',resolved:false,notes:[{body:'report',resolvable:false}]}]));
 assert.equal(notes[0]!.resolved,false);assert.equal(notes[1]!.resolved,false);assert.equal(notes[1]!.resolvable,true);assert.equal(notes[2]!.resolvable,false);
});
test('manual pending operation survives service restart and is never replayed',async()=>{
 const f=fixture('timeout');try{const input={action:'resolve',sha,operationId:randomUUID(),discussionId:'thread',fingerprint:reviewThreads(JSON.stringify(f.notes()))[0]!.fingerprint,confirmed:true,reason:'checked'};
 await assert.rejects(f.service.reviewWorkspaceAction(f.e.id,input));await f.service.close();let executed=0;
 const restarted=new GroupMrService(f.store,async()=>{executed++;return {exitCode:0,output:'[]'};});
 try{await assert.rejects(restarted.reviewWorkspaceAction(f.e.id,input),/待核对/);assert.equal(executed,0);assert.ok(f.store.getRecord<Entry>('group-mr-entry',f.e.id)!.manualReviewPending);}finally{await restarted.close();}
 }finally{f.store.close();}
});

test('omitted patches recover from immutable MR base/head, including rename/add/delete and capture overflow',async()=>{
 for(const mode of ['large','capture','renamed','added','deleted']){
  const f=fixture(mode);try{
   const result=await f.service.reviewFileContext(f.e.id,{sha,path:'src/a.ts'});
   assert.match(result.diff,mode==='deleted'?/-old/:/\+new/);assert.equal(f.writes.length,0);
   assert.equal(f.reads.length,mode==='added'||mode==='deleted'?1:2);
   if(mode==='renamed')assert.ok(f.reads[1]!.includes('--file-path=old/a.ts'));
   if(mode!=='added')assert.ok(f.reads.at(-1)!.includes(other));
  }finally{await f.shutdown();}
 }
 for(const mode of ['binary','missing-base']){const f=fixture(mode);try{await assert.rejects(f.service.reviewFileContext(f.e.id,{sha,path:'src/a.ts'}),mode==='binary'?/二进制/:/基线 SHA/);assert.equal(f.writes.length,0);}finally{await f.shutdown();}}
});
test('recovery preserves middle edits in large text, empty and newline-only changes',async()=>{
 const before=Array.from({length:25000},(_,i)=>'line'+i).join('\n')+'\n',after=before.replace('line12345\n','changed\n');
 const result=await recoveredReviewDiff(before,after);assert.match(result,/-line12345\n\+changed/);assert.ok(result.endsWith(' line24999'));
 assert.equal(reviewFileText(JSON.stringify({file_path:'x',content:Buffer.from(after).toString('base64')}),'x'),after);
 assert.match(await recoveredReviewDiff('a','a\n'),/-a\n\+a/);
 assert.equal(await recoveredReviewDiff('',''),'@@ -0,0 +0,0 @@\n');
});

test('file read failures expose an actionable safe client error',async()=>{
 const f=fixture('file-fail');try{await assert.rejects(f.service.reviewFileContext(f.e.id,{sha,path:'src/a.ts'}),error=>{assert.ok(error instanceof Error);assert.equal(Reflect.get(error,'statusCode'),422);assert.match(error.message,/CLI 不支持/);assert.doesNotMatch(error.message,/secret-token/);return true;});}finally{await f.shutdown();}
});
test('invalid or oversized source returns an actionable client error',()=>{
 for(const data of [{file_path:'a.ts',content:'',truncated:true},{file_path:'a.ts',content:'?'}])assert.throws(()=>reviewFileText(JSON.stringify(data),'a.ts'),error=>{assert.ok(error instanceof Error);assert.equal(Reflect.get(error,'statusCode'),422);return true;});
});

test('CodeHub 1.3.7 path metadata is accepted without weakening path or truncation checks',()=>{
 const content='x'.repeat(36644)+'\n'.repeat(900),file={path:'src/a.ts',encoding:'base64',size:37544,is_limited:false,content:Buffer.from(content).toString('base64')};
 assert.equal(file.content.length,50060);
 assert.equal(reviewFileText(JSON.stringify(file),'src/a.ts'),content);
 assert.equal(reviewFileText(JSON.stringify({...file,file_path:file.path}),'src/a.ts'),content);
 for(const data of [{...file,path:'other'},{...file,file_path:'other'},{...file,is_limited:true},{...file,path:undefined}])assert.throws(()=>reviewFileText(JSON.stringify(data),'src/a.ts'));
});
test('context expansion accepts the CLI path field end to end',async()=>{
 const f=fixture('path-field');try{const result=await f.service.reviewFileContext(f.e.id,{sha,path:'src/a.ts'});assert.match(result.diff,/\+new/);assert.equal(f.writes.length,0);}finally{await f.shutdown();}
});
test('expired position is retained and unresolved history can close against refreshed head without renewing review',async()=>{
 const parsed=reviewThreads(JSON.stringify([{id:'old',resolved:false,notes:[{body:'fix',resolvable:true,is_outdated:true,original_position:{new_path:'src/a.ts',new_line:319,head_sha:sha}}]}]));
 assert.equal(parsed[0]!.outdated,true);assert.equal(parsed[0]!.line,319);assert.equal(parsed[0]!.resolvable,true);
 const f=fixture();try{
  f.setHead();const fingerprint=reviewThreads(JSON.stringify(f.notes()))[0]!.fingerprint;
  await f.service.reviewWorkspaceAction(f.e.id,{action:'resolve',sha:other,operationId:randomUUID(),discussionId:'thread',fingerprint,confirmed:true,reason:'已核对当前代码修复'});
  assert.equal(f.writes.length,1);assert.equal(f.writes[0]![3],'resolve');assert.equal(f.store.getRecord<Entry>('group-mr-entry',f.e.id)!.sha,sha);
  await assert.rejects(f.service.reviewWorkspaceAction(f.e.id,{action:'create',sha:other,operationId:randomUUID(),path:'src/a.ts',line:2,body:'new'}),/提交已变化/);
 }finally{await f.shutdown();}
});

test('review capabilities accept Cobra types and legacy help but reject missing or incompatible arguments',()=>{
 for(const kind of ['reply','create'] as const){
  for(const text of [cobraHelp(kind),help(kind),help(kind).replaceAll(/<([^>]+)>/g,'[$1]').replace('[iid]','<iid>').replace('[discussion-id]','<discussion-id>'), '\x1b[32m'+cobraHelp(kind).replaceAll('\n','\r\n')+'\x1b[0m'])assert.equal(supportsReviewCommand(text,kind),true);
  for(const flag of ['body','project',...(kind==='create'?['path','line']:[])]){
   const missing=cobraHelp(kind).split('\n').filter(line=>!line.includes('--'+flag+' ')).join('\n');
   assert.equal(supportsReviewCommand(missing,kind),false,flag);
   assert.equal(supportsReviewCommand(missing+'\nExamples: use --'+flag+' string',kind),false);
  }
  assert.equal(supportsReviewCommand(cobraHelp(kind).replace('<mr-iid>','<other>'),kind),false);
  assert.equal(supportsReviewCommand(cobraHelp(kind).replace('--body string','--body bool'),kind),false);
  assert.equal(supportsReviewCommand(cobraHelp(kind).replace('--body string','--body        Submit content'),kind),false);
 }
 assert.equal(supportsReviewCommand(cobraHelp('reply').replace('<discussion-id>','<note-id>'),'reply'),false);
});
test('capability diagnostics distinguish help failures from unmatched help',async()=>{
 const f=fixture('unsupported');try{
  const result=await f.service.reviewWorkspace(f.e.id);
  assert.match(result!.capabilities.reason,/回复评论：CLI 帮助中的命令参数未匹配/);
  assert.match(result!.capabilities.reason,/新增行评论：CLI 帮助中的命令参数未匹配/);
 }finally{await f.shutdown();}
 const store=new TaskStore(':memory:');
 const service=new GroupMrService(store,async()=>({exitCode:124,output:'timeout'}));
 try{const capabilities=await service['reviewCapabilities']();assert.equal(capabilities.create,false);assert.match(capabilities.reason,/CLI 帮助命令执行失败/);assert.doesNotMatch(capabilities.reason,/参数未匹配/);}finally{await service.close();store.close();}
});
