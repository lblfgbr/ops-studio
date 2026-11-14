import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GroupMrService,piReplyStream,type Entry} from '../src/modules/automation/group-mr.js';
import {TaskStore} from '../src/platform/store.js';
import {FileLogs} from '../src/infrastructure/file-logs.js';

const sha='a'.repeat(40),repo='MAE-M/Access/Demo';
function entry():Entry{return {id:'pi-error-attempt',repo,iid:'1',url:'https://codehub-y.huawei.com/'+repo+'/merge_requests/1',sha,previousSha:'',messageId:'',sender:'owner',source:'manual',notificationReceiver:'owner',humanReviewRequired:true,shortcut:false,phase:'PI',stage:'PI',status:'Agent 正在检视',detail:'',createdAt:'2026-11-14T00:00:00.000Z',updatedAt:'2026-11-14T00:00:00.000Z',writePending:'',events:[]};}
const message=(errorMessage:string)=>({role:'assistant',stopReason:'error',errorMessage,content:[]});
const successfulMessage={role:'assistant',stopReason:'stop',content:[{type:'text',text:'<ops-studio-review-result>'+JSON.stringify({sha,assessments:[],findings:[]})+'</ops-studio-review-result>'}]};

test('Pi retry diagnostics preserve final error and retry outcome after terminal event',()=>{
 const stream=piReplyStream(),emit=(value:unknown)=>stream.line(JSON.stringify(value));
 for(const attempt of [1,2]){
  emit({type:'message_start',message:{role:'assistant'}});
  emit({type:'message_end',message:message('HTTP 503: model temporarily unavailable')});
  assert.equal(emit({type:'agent_end',willRetry:true}),false);
  emit({type:'auto_retry_start',attempt,maxAttempts:2,delayMs:attempt*1000,lastError:'HTTP 503: model temporarily unavailable'});
 }
 emit({type:'message_start',message:{role:'assistant'}});
 emit({type:'message_end',message:message('HTTP 400: Invalid schema for tools.0.parameters')});
 assert.equal(emit({type:'agent_end'}),true);
 emit({type:'auto_retry_end',attempt:2,success:false,error:'HTTP 400: Invalid schema for tools.0.parameters'});
 const diagnostic=stream.diagnostic();
 assert.equal(stream.failed(),true);assert.equal(stream.completed(),true);assert.equal(stream.answer(),'');
 assert.match(stream.errorDetail()??'',/400.*tools\.0\.parameters/);
 assert.equal(diagnostic.retryCount,2);assert.equal(diagnostic.retryEvents.length,3);
 assert.deepEqual(diagnostic.retryEvents.slice(0,2).map(event=>({type:event.type,attempt:event.attempt,maxAttempts:event.maxAttempts,delayMs:event.delayMs})),[
  {type:'auto_retry_start',attempt:1,maxAttempts:2,delayMs:1000},
  {type:'auto_retry_start',attempt:2,maxAttempts:2,delayMs:2000}
 ]);
 assert.equal(diagnostic.retryEvents.at(-1)?.success,false);assert.match(diagnostic.retryEvents.at(-1)?.error??'',/400/);
 emit({type:'message_start',message:{role:'assistant'}});emit({type:'message_end',message:successfulMessage});
 assert.equal(stream.failed(),true);assert.match(stream.errorDetail()??'',/400/);
});

test('successful Pi retry clears active error details while retaining bounded retry history',()=>{
 const stream=piReplyStream(),emit=(value:unknown)=>stream.line(JSON.stringify(value));
 emit({type:'message_start',message:{role:'assistant'}});
 emit({type:'message_end',message:message('HTTP 429: rate limit exceeded')});
 emit({type:'agent_end',willRetry:true});emit({type:'auto_retry_start',attempt:1,delayMs:1000,lastError:'HTTP 429: rate limit exceeded'});
 emit({type:'message_start',message:{role:'assistant'}});
 assert.equal(stream.errorDetail(),undefined);
 emit({type:'message_end',message:successfulMessage});emit({type:'agent_settled'});
 emit({type:'auto_retry_end',success:true});
 assert.equal(stream.failed(),false);assert.equal(stream.completed(),true);assert.equal(stream.errorDetail(),undefined);
 assert.equal(stream.diagnostic().errorMessage,undefined);assert.equal(stream.diagnostic().retryCount,1);
 assert.equal(stream.diagnostic().retryEvents.at(-1)?.success,true);
});

test('a terminal assistant snapshot without an error field does not erase an unresolved failure',()=>{
 const stream=piReplyStream();
 stream.line(JSON.stringify({type:'message_end',message:message('HTTP 400: unsupported model parameter')}));
 stream.line(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[]}]}));
 assert.equal(stream.failed(),true);assert.equal(stream.completed(),true);
 assert.match(stream.errorDetail()??'',/unsupported model parameter/);
});

test('prompt rejection and final retry errors expose safe diagnostics without changing completion',()=>{
 const rejected=piReplyStream();
 rejected.line(JSON.stringify({type:'response',command:'prompt',success:false,error:'HTTP 400: unsupported reasoning effort; Authorization: Bearer private-prompt-token'}));
 assert.equal(rejected.failed(),true);assert.equal(rejected.completed(),false);
 assert.equal(rejected.diagnostic().failureKind,'prompt-rejected');
 assert.match(rejected.errorDetail()??'',/unsupported reasoning effort/);assert.doesNotMatch(JSON.stringify(rejected.diagnostic()),/private-prompt-token/);
 const final=piReplyStream();
 final.line(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',content:[]}}));
 final.line(JSON.stringify({type:'agent_end'}));
 final.line(JSON.stringify({type:'auto_retry_end',success:false,lastError:'HTTP 429: rate limit exceeded'}));
 assert.equal(final.failed(),true);assert.equal(final.completed(),true);assert.match(final.errorDetail()??'',/429/);
});

test('Pi stderr retains only a bounded safe error tail rather than progress or payload output',()=>{
 const stream=piReplyStream();
 stream.line('ordinary private-progress-content',true);
 for(let i=1;i<=5;i++)stream.line('Error: ECONNRESET attempt '+i+'; Authorization: Bearer private-stderr-token',true);
 const diagnostic=stream.diagnostic();
 assert.equal(diagnostic.stderrLines,6);assert.equal(diagnostic.stderrErrors.length,3);
 assert.match(diagnostic.stderrErrors.at(-1)??'',/attempt 5/);assert.match(stream.errorDetail()??'',/ECONNRESET/);
 assert.doesNotMatch(JSON.stringify(diagnostic),/private-progress-content|private-stderr-token/);
});

test('failed MR analysis reports provider details in the exception and logs without publishing opinions',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-review-error-')),store=new TaskStore(':memory:'),e=entry(),commands:string[][]=[];
 const providerError=JSON.stringify({status:400,error:{message:'Invalid schema for tools.0.parameters',type:'invalid_request_error',param:'tools.0.parameters'},request:{messages:[{role:'user',content:'private-request-content'}]},authorization:'Bearer private-provider-token'});
 const event={type:'message_end',message:message(providerError)};
 const service=new GroupMrService(store,async(args,_directory,_timeout,_log,onLine)=>{
  commands.push([...args]);assert.equal(args[0],'pi');
  onLine?.(JSON.stringify(event),false);onLine?.(JSON.stringify({type:'agent_end'}),false);
  return {exitCode:0,output:JSON.stringify(event)+'\n',terminationReason:'completion-event'};
 },new FileLogs(root));
 store.putRecord('group-mr-entry',e.id,e);
 try{
  await assert.rejects(service['runPi'](e,'',[],'reviewer'),error=>{
   assert.ok(error instanceof Error);assert.match(error.message,/assistant-error/);assert.match(error.message,/400/);assert.match(error.message,/tools\.0\.parameters/);
   assert.doesNotMatch(error.message,/private-request-content|private-provider-token/);return true;
  });
  assert.equal(commands.length,1);assert.equal(store.records('group-mr-agent-submission').length,0);
  assert.equal(store.getRecord<Entry>('group-mr-entry',e.id)?.piExecution?.completedAt,undefined);
  const log=readFileSync(join(root,'automation','group-mr-errors.jsonl'),'utf8');
  assert.match(log,/Invalid schema/);assert.match(log,/tools\.0\.parameters/);assert.doesNotMatch(log,/private-request-content|private-provider-token/);
 }finally{await service.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('nonzero Pi exit falls back to safe stderr diagnostics and never submits comments',async()=>{
 const store=new TaskStore(':memory:'),e=entry();let calls=0;
 const service=new GroupMrService(store,async(args,_directory,_timeout,_log,onLine)=>{
  calls++;assert.equal(args[0],'pi');
  onLine?.('Error: ECONNRESET contacting model; api_key=private-network-key',true);
  return {exitCode:1,output:''};
 });
 store.putRecord('group-mr-entry',e.id,e);
 try{
  await assert.rejects(service['runPi'](e,'',[],'reviewer'),error=>{
   assert.ok(error instanceof Error);assert.match(error.message,/进程退出码 1/);assert.match(error.message,/ECONNRESET/);assert.doesNotMatch(error.message,/private-network-key/);return true;
  });
  assert.equal(calls,1);assert.equal(store.records('group-mr-agent-submission').length,0);
 }finally{await service.close();store.close();}
});

test('successful analysis after an internal retry completes once without creating a failure',async()=>{
 const store=new TaskStore(':memory:'),e=entry();let calls=0;
 const service=new GroupMrService(store,async(args,_directory,_timeout,_log,onLine)=>{
  calls++;assert.equal(args[0],'pi');
  for(const event of [
   {type:'message_start',message:{role:'assistant'}},
   {type:'message_end',message:message('HTTP 429: rate limit exceeded')},
   {type:'agent_end',willRetry:true},
   {type:'auto_retry_start',attempt:1,lastError:'HTTP 429: rate limit exceeded'},
   {type:'message_start',message:{role:'assistant'}},
   {type:'message_end',message:successfulMessage},
   {type:'agent_end'},
   {type:'auto_retry_end',success:true}
  ])onLine?.(JSON.stringify(event),false);
  return {exitCode:0,output:'',terminationReason:'completion-event'};
 });
 store.putRecord('group-mr-entry',e.id,e);
 try{
  await service['runPi'](e,'',[],'reviewer');assert.equal(calls,1);
  assert.ok(store.getRecord<Entry>('group-mr-entry',e.id)?.piExecution?.completedAt);
  assert.equal(store.records('group-mr-agent-submission').length,0);
 }finally{await service.close();store.close();}
});
