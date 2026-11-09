import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {GroupMrService,groupMrRoutes,type Entry} from '../src/modules/automation/group-mr.js';
import {findingIdentity,type AgentSubmission} from '../src/modules/automation/agent-findings.js';
import {TaskStore} from '../src/platform/store.js';
const sha='a'.repeat(40),nextSha='b'.repeat(40);
const deferred=()=>{let release=()=>{};const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};
async function settle(service:GroupMrService){while(service['background'].size)await Promise.allSettled(service['background']);await Promise.resolve();}
function fixture(){
 const store=new TaskStore(':memory:'),calls:string[][]=[];
 const state={head:sha,remote:'opened',hold:undefined as Promise<void>|undefined,holdView:undefined as Promise<void>|undefined,pi:0,approvalPassed:false,notes:[] as unknown[]};
 const e:Entry={id:randomUUID(),repo:'MAE-M/Access/Demo',iid:'1',url:'https://codehub-y.huawei.com/MAE-M/Access/Demo/merge_requests/1',source:'manual',notificationReceiver:'original',sender:'original',messageId:'',shortcut:false,humanReviewRequired:true,sha,previousSha:'',phase:'FAILED',stage:'PI',status:'旧 CLI 检测失败',detail:'原失败详情',events:[{time:'2026-11-01T00:00:00Z',phase:'FAILED',message:'原失败事件'}],writePending:'',createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z'};
 const service=new GroupMrService(store,async(args,_dir,_timeout,_log,onLine)=>{
  calls.push([...args]);if(state.hold)await state.hold;
  if(args[2]==='view'&&state.holdView)await state.holdView;
  if(args[0]==='pi'){state.pi++;onLine?.(JSON.stringify({type:'agent_end',messages:[{role:'assistant',stopReason:'stop',content:[{type:'text',text:'<ops-studio-review-result>'+JSON.stringify({sha:state.head,assessments:[],findings:[]})+'</ops-studio-review-result>'}]}]}),false);return {exitCode:0,output:''};}
  if(args.includes('--help'))return {exitCode:0,output:`codehub-cli mr review ${args[3]} <mr-iid>${args[3]==='reply'?' <discussion-id>':''}\n --body string\n --project string\n --path string\n --line lineRange`};
  let result:unknown;
  if(args[0]==='welink-cli')result={resultCode:0};
  else if(args[1]==='user')result={username:'original'};
  else if(args[2]==='view')result={iid:1,sha:state.head,state:state.remote,title:'MR'};
  else if(args[2]==='gate')result={ci_state_passed:true,approval_reviewers_required_passed:state.approvalPassed,approval_approvers_required_passed:state.approvalPassed};
  else if(args[2]==='pipeline')result=[{id:1,status:'success',sha:state.head}];
  else if(args[3]==='list')result=state.notes;
  else if(args[2]==='changes')result={changes:[]};
  else throw Error('Unexpected write '+args.slice(0,4).join(' '));
  return {exitCode:0,output:JSON.stringify(result)};
 },undefined,undefined,{send:async()=>{}});
 service.configure({enabled:false,groupId:'',authorizedSender:'changed',repositoryPrefix:'MAE-M/',intervalSeconds:5,humanReviewEnabled:false});
 store.putRecord('group-mr-entry',e.id,e);
 return {service,store,e,state,calls,close:async()=>{await service.close();store.close();}};
}
test('retry is accepted before remote work, coalesces repeats, and preserves source/policy/history',async()=>{
 const f=fixture(),hold=deferred(),app=Fastify();groupMrRoutes(app,f.service);f.state.hold=hold.promise;
 try{
  const response=await app.inject({method:'POST',url:'/api/automation/group-mr/records/'+f.e.id+'/retry',payload:{sha}});
  assert.equal(response.statusCode,202);const accepted=response.json<{entryId:string;duplicate:boolean}>();assert.equal(accepted.duplicate,false);assert.notEqual(accepted.entryId,f.e.id);
  assert.deepEqual(f.service.retryRecord(f.e.id,{sha}),{entryId:accepted.entryId,duplicate:true});
  assert.deepEqual(f.service.retryRecord(accepted.entryId,{sha}),{entryId:accepted.entryId,duplicate:true});
  hold.release();await settle(f.service);
  const result=f.store.getRecord<Entry>('group-mr-entry',accepted.entryId)!,old=f.store.getRecord<Entry>('group-mr-entry',f.e.id)!;
  assert.equal(result.phase,'HUMAN');assert.equal(result.source,'manual');assert.equal(result.notificationReceiver,'original');assert.equal(result.humanReviewRequired,true);assert.equal(f.state.pi,1);
  assert.equal(old.status,'旧 CLI 检测失败');assert.equal(old.detail,'原失败详情');assert.equal(old.events[0]!.message,'原失败事件');assert.equal(old.supersededBy,result.id);
  assert.throws(()=>f.service.retryRecord(f.e.id,{sha}),/替代/);assert.equal(f.calls.some(c=>c[0]==='welink-cli'),false);
 }finally{hold.release();await app.close();await f.close();}
});
test('retry reads the newest SHA and does not apply an old approval to new code',async()=>{
 const f=fixture();f.state.head=nextSha;f.e.humanReview={id:'old-review',entryId:f.e.id,repo:f.e.repo,iid:'1',url:f.e.url,sha,decision:'pass',reason:'旧版本通过',category:'quality',time:'2026-11-01T00:00:00Z',waitMs:0,actor:'平台人工审核',knowledgeStatus:'skipped'};f.store.putRecord('group-mr-entry',f.e.id,f.e);
 try{const accepted=f.service.retryRecord(f.e.id,{sha});await settle(f.service);const result=f.store.getRecord<Entry>('group-mr-entry',accepted.entryId)!;assert.equal(result.sha,nextSha);assert.equal(result.previousSha,sha);assert.equal(result.humanReview,undefined);assert.equal(result.phase,'HUMAN');assert.equal(f.state.pi,1);}finally{await f.close();}
});
test('retry accepts records that failed before SHA discovery',async()=>{
 const f=fixture();f.e.sha='';f.store.putRecord('group-mr-entry',f.e.id,f.e);
 try{const accepted=f.service.retryRecord(f.e.id,{sha:''});await settle(f.service);assert.equal(f.store.getRecord<Entry>('group-mr-entry',accepted.entryId)?.sha,sha);assert.equal(f.state.pi,1);}finally{await f.close();}
});
for(const remote of ['merged','closed'])test('retry archives remote '+remote+' without executing Pi or writes',async()=>{
 const f=fixture();f.state.remote=remote;
 try{const accepted=f.service.retryRecord(f.e.id,{sha});await settle(f.service);assert.equal(f.store.getRecord<Entry>('group-mr-entry',accepted.entryId)?.phase,remote==='merged'?'DONE':'CLOSED');assert.equal(f.state.pi,0);assert.ok(f.calls.every(c=>c[2]==='view'));}finally{await f.close();}
});
for(const pending of ['合并','群消息回复','审核'])test('retry does not bypass unresolved '+pending,async()=>{
 const f=fixture();f.e.writePending=pending;f.store.putRecord('group-mr-entry',f.e.id,f.e);
 try{const accepted=f.service.retryRecord(f.e.id,{sha});await settle(f.service);const result=f.store.getRecord<Entry>('group-mr-entry',accepted.entryId)!;assert.equal(result.phase,'ISSUES');assert.equal(result.writePending,pending);assert.match(result.status,/仍待核对/);assert.equal(f.state.pi,0);assert.equal(f.calls.some(c=>c[2]==='approve'||c[2]==='merge'||c[0]==='welink-cli'),false);}finally{await f.close();}
});
test('retry clears a legacy individual Agent comment marker without manual confirmation',async()=>{
 const f=fixture();f.e.writePending='Agent 单条意见提交';f.store.putRecord('group-mr-entry',f.e.id,f.e);
 try{
  const accepted=f.service.retryRecord(f.e.id,{sha});await settle(f.service);
  const result=f.store.getRecord<Entry>('group-mr-entry',accepted.entryId)!;
  assert.equal(result.phase,'HUMAN');assert.equal(result.writePending,'');assert.equal(f.state.pi,1);
  assert.equal(f.store.getRecord<Entry>('group-mr-entry',f.e.id)?.writePending,'');
  assert.equal(f.calls.some(c=>c[2]==='approve'||c[2]==='merge'||c[0]==='welink-cli'),false);
 }finally{await f.close();}
});
test('retry reconciles a confirmed approval without replaying it',async()=>{
 const f=fixture();f.e.writePending='审核';f.state.approvalPassed=true;f.store.putRecord('group-mr-entry',f.e.id,f.e);
 try{const accepted=f.service.retryRecord(f.e.id,{sha});await settle(f.service);assert.equal(f.store.getRecord<Entry>('group-mr-entry',accepted.entryId)?.phase,'HUMAN');assert.equal(f.store.getRecord<Entry>('group-mr-entry',f.e.id)?.writePending,'');assert.equal(f.calls.some(c=>c[2]==='approve'),false);}finally{await f.close();}
});
test('detail reads are shared and do not mark the workflow running; retry waits without resurrecting the old attempt',async()=>{
 const f=fixture(),hold=deferred();f.state.holdView=hold.promise;
 try{
  const first=f.service.reviewWorkspace(f.e.id),second=f.service.reviewWorkspace(f.e.id);
  assert.equal(first,second);assert.equal(f.service.summary().pending[0]!.running,false);assert.equal(f.service.summary().monitor.activeCount,0);assert.equal(f.service.summary().monitor.running,false);assert.equal(f.calls.filter(c=>c[2]==='view').length,1);
  const accepted=f.service.retryRecord(f.e.id,{sha});assert.equal(f.service.summary().pending[0]!.queued,true);
  hold.release();await first;await settle(f.service);
  assert.equal(f.service.summary().pending.length,1);assert.equal(f.service.summary().pending[0]!.id,accepted.entryId);assert.equal(f.store.getRecord<Entry>('group-mr-entry',f.e.id)?.supersededBy,accepted.entryId);assert.equal(f.state.pi,1);
 }finally{hold.release();await f.close();}
});

test('manual retry cannot overtake a queued detail read when the worker pool is saturated',async()=>{
 const f=fixture(),workers=deferred(),read=deferred();f.state.holdView=read.promise;
 try{
  const jobs=Array.from({length:f.service.concurrency},(_,i)=>f.service['enqueue']({...f.e,id:randomUUID(),iid:String(i+10)},()=>workers.promise));
  const workspace=f.service.reviewWorkspace(f.e.id),accepted=f.service.retryRecord(f.e.id,{sha});
  assert.equal(f.calls.length,0);assert.equal(f.service.summary().pending.find(e=>e.id===accepted.entryId)?.queued,true);
  workers.release();await Promise.all(jobs);
  assert.equal(f.calls.filter(c=>c[2]==='view').length,1);assert.equal(f.service.summary().pending.find(e=>e.id===accepted.entryId)?.running,false);
  read.release();await workspace;await settle(f.service);
  const current=f.store.getRecord<Entry>('group-mr-entry',accepted.entryId)!;
  assert.equal(current.phase,'HUMAN');assert.equal(f.service.summary().pending.find(e=>e.id===accepted.entryId)?.running,false);assert.equal(f.state.pi,1);
 }finally{workers.release();read.release();await f.close();}
});

test('retry reuses a confirmed review on the same SHA without another Agent invocation',async()=>{
 const f=fixture();try{
  const first=f.service.retryRecord(f.e.id,{sha});await settle(f.service);
  const stopped=f.store.getRecord<Entry>('group-mr-entry',first.entryId)!;stopped.phase='FAILED';stopped.status='后续操作失败';f.store.putRecord('group-mr-entry',stopped.id,stopped);
  const second=f.service.retryRecord(stopped.id,{sha});await settle(f.service);
  assert.equal(f.state.pi,1);assert.equal(f.store.getRecord<Entry>('group-mr-entry',second.entryId)?.phase,'HUMAN');
 }finally{await f.close();}
});
for(const status of ['failed','pending'] as const)test('same-SHA checkpoint cannot hide an Agent comment '+status+'; a fresh empty review retires it',async()=>{
 const f=fixture();try{
  const first=f.service.retryRecord(f.e.id,{sha});await settle(f.service);
  const stopped=f.store.getRecord<Entry>('group-mr-entry',first.entryId)!;
  assert.equal(f.state.pi,1);assert.ok(f.store.getRecord('group-mr-review-checkpoint',f.e.repo+':1'));
  const finding={path:'src/example.ts',line:54,body:'请确认该问题在当前提交中是否仍然成立。'},identity=findingIdentity(finding);
  const submission:AgentSubmission={key:f.e.repo+':1:'+identity,repo:f.e.repo,iid:'1',sha,entryId:stopped.id,author:'original',finding,marker:'<!-- ops-studio-finding:'+identity+' -->',status,error:'上一次提交未完成'};
  f.store.putRecord('group-mr-agent-submission',submission.key,submission);
  stopped.phase='FAILED';stopped.status='Agent 意见提交未完成';f.store.putRecord('group-mr-entry',stopped.id,stopped);
  const second=f.service.retryRecord(stopped.id,{sha});await settle(f.service);
  const reviewed=f.store.getRecord<Entry>('group-mr-entry',second.entryId)!;
  assert.equal(f.state.pi,2);assert.equal(reviewed.phase,'HUMAN');assert.equal(reviewed.writePending,'');
  assert.equal(f.store.getRecord<AgentSubmission>('group-mr-agent-submission',submission.key)?.status,'not-submitted');
  reviewed.phase='FAILED';reviewed.status='后续操作失败';f.store.putRecord('group-mr-entry',reviewed.id,reviewed);
  const third=f.service.retryRecord(reviewed.id,{sha});await settle(f.service);
  assert.equal(f.state.pi,2);assert.equal(f.store.getRecord<Entry>('group-mr-entry',third.entryId)?.phase,'HUMAN');
  assert.equal(f.calls.some(c=>c[3]==='create'),false);
 }finally{await f.close();}
});
test('retry preserves a group task human-review policy even when current configuration differs',async()=>{
 const f=fixture();f.e.source='group';f.e.messageId='original-message';f.store.putRecord('group-mr-entry',f.e.id,f.e);
 try{const accepted=f.service.retryRecord(f.e.id,{sha});await settle(f.service);const current=f.store.getRecord<Entry>('group-mr-entry',accepted.entryId)!;assert.equal(current.source,'group');assert.equal(current.messageId,'original-message');assert.equal(current.humanReviewRequired,true);assert.equal(current.phase,'HUMAN');assert.equal(f.calls.some(c=>c[0]==='welink-cli'),false);}finally{await f.close();}
});

test('retry queued behind a background pipeline check prevents the old attempt from continuing',async()=>{
 const f=fixture(),hold=deferred();f.e.phase='PIPELINE';f.e.pipelineWaiting=true;f.store.putRecord('group-mr-entry',f.e.id,f.e);f.state.holdView=hold.promise;
 try{
  f.service.refreshRemoteStates();assert.equal(f.service['stateJobs'].size,1);
  const accepted=f.service.retryRecord(f.e.id,{sha});hold.release();await settle(f.service);
  assert.equal(f.state.pi,1);assert.equal(f.store.getRecord<Entry>('group-mr-entry',f.e.id)?.phase,'PIPELINE');assert.equal(f.store.getRecord<Entry>('group-mr-entry',accepted.entryId)?.phase,'HUMAN');
 }finally{hold.release();await f.close();}
});

test('retry does not supersede an approval already queued behind a detail read',async()=>{
 const f=fixture(),hold=deferred();f.e.phase='ISSUES';f.store.putRecord('group-mr-entry',f.e.id,f.e);f.state.holdView=hold.promise;let approvals=0;
 f.service['runHumanReview']=async(_entry,_input,accepted)=>{approvals++;accepted();};
 try{
  const workspace=f.service.reviewWorkspace(f.e.id);
  f.service.submitReviewJob(f.e.id,{sha,decision:'pass',reason:''});
  assert.deepEqual(f.service.retryRecord(f.e.id,{sha}),{entryId:f.e.id,duplicate:true});
  assert.equal(f.service.list().length,1);assert.equal(f.store.getRecord<Entry>('group-mr-entry',f.e.id)?.supersededBy,undefined);
  hold.release();await workspace;await settle(f.service);assert.equal(approvals,1);assert.equal(f.state.pi,0);
 }finally{hold.release();await f.close();}
});
