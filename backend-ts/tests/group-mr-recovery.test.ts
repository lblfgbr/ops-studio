const agentResult=(text:string,sha:string)=>text+'<ops-studio-review-result>'+JSON.stringify({sha,assessments:[],findings:[]})+'</ops-studio-review-result>';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GroupMrService,type Entry} from '../src/modules/automation/group-mr.js';
import {TaskStore} from '../src/platform/store.js';

const sha='a'.repeat(40),otherSha='b'.repeat(40),repo='MAE-M/Access/Demo';
const completedAt='2026-10-25T01:00:00.000Z';
function entry():Entry{
 return {id:'attempt',repo,iid:'1',url:'https://codehub-y.huawei.com/'+repo+'/merge_requests/1',sha,previousSha:'',messageId:'1',sender:'developer',shortcut:false,humanReviewRequired:true,phase:'PI',stage:'PI',status:'Agent 正在全量检视当前提交',detail:'',createdAt:completedAt,updatedAt:completedAt,writePending:'Pi 提交检视意见',events:[],piExecution:{entryId:'attempt',sha,completedAt,author:'reviewer',discussionIds:['existing']}};
}
function discussion(id:string,author='reviewer',body='请核对空值处理',resolved=false){
 return {id,resolved,notes:[{id:id+'-note',body,resolvable:true,author:{username:author}}]};
}
interface Options {head?:string;changeDuringRead?:boolean;notes?:unknown;notesFailure?:boolean;pipelinePassed?:boolean}
function fixture(e:Entry=entry(),options:Options={}){
 const store=new TaskStore(':memory:'),calls:string[][]=[],writes:string[][]=[];
 let views=0;
 store.putRecord('group-mr-entry',e.id,e);
 const service=new GroupMrService(store,async args=>{
  calls.push([...args]);let value:unknown;
  if(args[0]!=='codehub-cli'||!['view','gate','pipeline','changes'].includes(args[2]??'')&&!(args[2]==='review'&&(args[3]==='list'||args.includes('--help')))){
   writes.push([...args]);throw Error('Recovery must not execute external writes');
  }
  if(args.includes('--help'))return {exitCode:0,output:'unsupported'};
  if(args[2]==='view')value={iid:1,state:'opened',sha:options.changeDuringRead&&++views>1?otherSha:options.head??sha};
  else if(args[2]==='review'){
   if(options.notesFailure)throw Error('Cannot read discussions');
   value=options.notes??[];
  }else if(args[2]==='gate')value={ci_state_passed:options.pipelinePassed!==false,quality_gate:{passed:true},conflict_passed:true};
  else if(args[2]==='pipeline')value=[{id:1,sha:options.head??sha,status:options.pipelinePassed===false?'running':'success'}];
  else if(args[2]==='changes')value={changes:[]};
  return {exitCode:0,output:JSON.stringify(value)};
 });
 const saved=()=>store.getRecord<Entry>('group-mr-entry',e.id)!;
 const checkpoint=()=>store.getRecord<{sha:string;review:NonNullable<Entry['piReview']>}>('group-mr-review-checkpoint',repo+':1');
 return {store,service,e,calls,writes,saved,checkpoint,close:async()=>{await service.close();store.close();}};
}

for(const route of ['readiness','workbench','background'] as const)test('completed Agent execution recovers by '+route+' after restart without replay',async()=>{
 const f=fixture();
 try{
  assert.equal(f.calls.length,0);assert.equal(f.saved().phase,'INTERRUPTED');
  if(route==='readiness')await f.service['refreshReadiness'](f.saved());
  else if(route==='workbench')assert.equal((await f.service.reviewWorkspace(f.e.id)).writePending,'');
  else {f.service.refreshRemoteStates();await Promise.allSettled(f.service['background']);}
  const saved=f.saved();
  assert.equal(saved.writePending,'');assert.equal(saved.phase,'ISSUES');
  assert.equal(saved.piReview?.source,'codehub');assert.equal(saved.piReview?.sha,sha);assert.equal(saved.piReview?.ok,true);
  assert.equal(f.checkpoint()?.sha,sha);assert.equal(saved.humanReview,undefined);
  assert.deepEqual(f.writes,[]);
 }finally{await f.close();}
});

test('recovery preserves unresolved opinions and restores ownership only for new marked Agent comments',async()=>{
 const e=entry(),marker=' <!-- ops-studio-review:'+e.id+' -->';
 const notes=[discussion('new','reviewer','新问题'+marker),discussion('existing','reviewer','旧问题'+marker),discussion('other-author','someone-else','其他人'+marker),discussion('unmarked'),discussion('resolved','reviewer','已解决'+marker,true)];
 const f=fixture(e,{notes});
 try{
  await f.service['refreshReadiness'](f.saved());const saved=f.saved();
  assert.equal(saved.writePending,'');assert.equal(saved.phase,'ISSUES');assert.equal(saved.piReview?.ok,false);
  assert.equal(saved.reviewComments?.length,5);assert.equal(saved.readiness?.ready,false);
  assert.ok(f.store.getRecord('group-mr-owned-discussion',repo+':1:new'));
  for(const id of ['existing','other-author','unmarked'])assert.equal(f.store.getRecord('group-mr-owned-discussion',repo+':1:'+id),undefined);
  assert.deepEqual(saved.piReview?.resolvedDiscussionIds,['resolved']);assert.deepEqual(f.writes,[]);
 }finally{await f.close();}
});

test('completed Agent result can recover while the current pipeline is still running',async()=>{
 const f=fixture(entry(),{pipelinePassed:false});
 try{
  await f.service['refreshReadiness'](f.saved());const saved=f.saved();
  assert.equal(saved.writePending,'');assert.equal(saved.phase,'ISSUES');assert.equal(saved.piReview?.ok,true);
  assert.equal(saved.pipelinePassed,false);assert.equal(saved.readiness?.ready,false);assert.deepEqual(f.writes,[]);
 }finally{await f.close();}
});

for(const mode of ['incomplete','legacy','wrong-execution-sha'] as const)test('empty remote discussions never prove an uncompleted Agent run: '+mode,async()=>{
 const e=entry();
 if(mode==='legacy')delete e.piExecution;
 else if(mode==='incomplete')delete e.piExecution!.completedAt;
 else e.piExecution!.sha=otherSha;
 const f=fixture(e);
 try{
  await f.service['refreshReadiness'](f.saved());const saved=f.saved();
  assert.equal(saved.writePending,'Pi 提交检视意见');assert.equal(saved.piReview,undefined);assert.equal(f.checkpoint(),undefined);
  assert.notEqual(saved.phase,'HUMAN');assert.deepEqual(f.writes,[]);
 }finally{await f.close();}
});

for(const mode of ['changed-head','head-changes-during-read','read-failure','partial-discussions','invalid-discussions'] as const)test('Agent recovery remains blocked without a stable complete remote snapshot: '+mode,async()=>{
 const options:Options=mode==='changed-head'?{head:otherSha}:mode==='head-changes-during-read'?{changeDuringRead:true}:mode==='read-failure'?{notesFailure:true}:mode==='partial-discussions'?{notes:{items:[],total:1}}:{notes:[{id:'missing-body'}]};
 const f=fixture(entry(),options);
 try{
  await f.service['refreshReadiness'](f.saved());const saved=f.saved();
  assert.equal(saved.writePending,'Pi 提交检视意见');assert.equal(saved.piReview,undefined);assert.equal(f.checkpoint(),undefined);
  assert.equal(saved.readiness?.ready,false);assert.deepEqual(f.writes,[]);
 }finally{await f.close();}
});

test('manual acknowledgement clears related Agent blockers and stale interruption text without replay',async()=>{
 const e=entry();delete e.piExecution!.completedAt;
 const f=fixture(e);
 const old:Entry={...e,id:'prior',supersededBy:e.id,status:'服务重启，原执行中断，请重新发送 MR 链接',phase:'INTERRUPTED'};
 const unrelated:Entry={...e,id:'another-mr',iid:'2'};
 f.store.putRecord('group-mr-entry',old.id,old);f.store.putRecord('group-mr-entry',unrelated.id,unrelated);
 try{
  f.service.acknowledgePi(e.id);
  for(const id of [e.id,old.id]){
   const saved=f.store.getRecord<Entry>('group-mr-entry',id)!;
   assert.equal(saved.writePending,'');assert.notEqual(saved.status,'服务重启，原执行中断，请重新发送 MR 链接');
   assert.equal(saved.piReview,undefined);assert.ok(saved.events.some(event=>/人工核对/.test(event.message)));
  }
  assert.equal(f.store.getRecord<Entry>('group-mr-entry',unrelated.id)!.writePending,'Pi 提交检视意见');
  assert.equal(f.calls.length,0);assert.deepEqual(f.writes,[]);
 }finally{await f.close();}
});

test('resending a blocked MR preserves completion evidence and original ownership marker',async()=>{
 const e=entry(),f=fixture(e,{notes:[discussion('new','reviewer','请核对 <!-- ops-studio-review:'+e.id+' -->')]});
 const cfg={enabled:false,groupId:'123456789',authorizedSender:'owner',repositoryPrefix:'MAE-M/Access/',intervalSeconds:10};
 try{
  f.service['executeEntry']=async next=>{await f.service['recoverAgentAttempts']({...next,sha});};
  await f.service['accept']({id:'second-message',content:e.url,sender:'developer',quoteId:''},cfg);
  const successor=f.service.list().find(row=>row.id!==e.id)!;
  assert.ok(successor);assert.ok(f.calls.length>0);
  assert.equal(f.saved().supersededBy,successor.id);
  await f.service['refreshReadiness'](f.saved());
  assert.equal(f.store.getRecord<Entry>('group-mr-entry',successor.id)!.writePending,'');
  assert.equal(f.checkpoint()?.review.ok,false);
  const owned=f.store.getRecord<{entryId:string}>('group-mr-owned-discussion',repo+':1:new');
  assert.equal(owned?.entryId,e.id);assert.deepEqual(f.writes,[]);
 }finally{await f.close();}
});

test('legacy COMMENTS stage proves successful Agent return and permits read-only reconciliation',async()=>{
 const e=entry();delete e.piExecution;e.phase='COMMENTS';e.stage='COMMENTS';
 const f=fixture(e);
 try{
  await f.service['refreshReadiness'](f.saved());const saved=f.saved();
  assert.equal(saved.writePending,'');assert.equal(saved.piReview?.ok,true);assert.equal(saved.piReview?.sha,sha);
  assert.equal(saved.phase,'ISSUES');assert.equal(f.checkpoint()?.sha,sha);assert.deepEqual(f.writes,[]);
 }finally{await f.close();}
});

test('COMMENTS stage cannot override explicit evidence that the Agent execution is incomplete',async()=>{
 const e=entry();e.phase='COMMENTS';e.stage='COMMENTS';delete e.piExecution!.completedAt;
 const f=fixture(e);
 try{
  await f.service['refreshReadiness'](f.saved());
  assert.equal(f.saved().writePending,'Pi 提交检视意见');assert.equal(f.saved().piReview,undefined);assert.equal(f.checkpoint(),undefined);
  assert.deepEqual(f.writes,[]);
 }finally{await f.close();}
});

for(const phase of ['HUMAN','ISSUES'] as const)test('queued read-only refresh preserves waiting '+phase+' across shutdown and restart',async()=>{
 const e=entry();e.phase=phase;e.writePending='';const f=fixture(e);
 let release:()=>void=()=>{};const held=new Promise<void>(resolve=>release=resolve);
 const jobs:Array<Promise<void>>=[];
 try{
  for(let i=0;i<f.service.concurrency;i++){
   const blocker={...e,id:'blocker-'+i,iid:'blocker-'+i};
   jobs.push(f.service['enqueue'](blocker,()=>held,false));
  }
  jobs.push(f.service['enqueue'](f.saved(),async()=>{throw Error('queued refresh must not run during shutdown');},false));
  assert.equal(f.service['queue'].length,1);assert.ok(!f.saved().queued);assert.equal(f.saved().phase,phase);
  const restartedStore=new TaskStore(':memory:');restartedStore.putRecord('group-mr-entry',e.id,f.saved());
  const restarted=new GroupMrService(restartedStore,async()=>{throw Error('restart must not replay');});
  try{assert.equal(restarted.list()[0]!.phase,phase);assert.ok(!restarted.list()[0]!.queued);}
  finally{await restarted.close();restartedStore.close();}
  const settled=Promise.allSettled(jobs),closing=f.service.close();
  assert.equal(f.saved().phase,phase);assert.ok(!f.saved().queued);release();await closing;await settled;
  assert.equal(f.calls.length,0);
 }finally{release();await Promise.allSettled(jobs);await f.close();}
});

for(const outcome of ['complete','missing-terminal','assistant-error','nonzero-exit','execution-rejected'] as const)test('Agent completion proof is persisted only after validated RPC success: '+outcome,async()=>{
 const store=new TaskStore(':memory:'),e=entry();e.writePending='';delete e.piExecution;
 const service=new GroupMrService(store,async(args,_directory,_timeout,_log,onLine)=>{
  assert.equal(args[0],'pi');
  const started=store.getRecord<Entry>('group-mr-entry',e.id)!;
  assert.equal(started.piExecution?.sha,sha);assert.equal(started.piExecution?.completedAt,undefined);
  if(outcome==='execution-rejected')throw Error('Process interrupted');
  onLine?.(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:outcome==='assistant-error'?'error':'stop',content:[{type:'text',text:agentResult('已读取本次变更。',sha)}]}}),false);
  if(outcome!=='missing-terminal')onLine?.(JSON.stringify({type:'agent_end'}),false);
  return {exitCode:outcome==='nonzero-exit'?124:0,output:''};
 });
 const notes=[{id:'old-note',body:'已有问题',author:'reviewer',resolved:false,replies:[]}];
 try{
  if(outcome==='complete')await service['runPi'](e,'',notes,'reviewer');
  else await assert.rejects(service['runPi'](e,'',notes,'reviewer'));
  const saved=store.getRecord<Entry>('group-mr-entry',e.id)!;
  assert.equal(saved.writePending,outcome==='complete'?'Pi 提交检视意见':'');assert.equal(saved.piExecution?.entryId,e.id);
  assert.equal(saved.piExecution?.author,'reviewer');assert.deepEqual(saved.piExecution?.discussionIds,['old-note']);
  assert.equal(!!saved.piExecution?.completedAt,outcome==='complete');assert.equal(saved.piReview,undefined);
 }finally{await service.close();store.close();}
});

test('successful Agent followed by transient discussion-read failure recovers without rerunning Agent',async()=>{
 const store=new TaskStore(':memory:'),e=entry();delete e.piExecution;e.writePending='';
 let piRuns=0,notesUnavailable=true;const writes:string[][]=[];
 const service=new GroupMrService(store,async(args,_directory,_timeout,_log,onLine)=>{
  let value:unknown={};
  if(args[0]==='pi'){
   piRuns++;
   onLine?.(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:agentResult('检视完成，无新增问题。',sha)}]}}),false);
   onLine?.(JSON.stringify({type:'agent_end'}),false);return {exitCode:0,output:''};
  }
  if(args[0]!=='codehub-cli'){writes.push([...args]);throw Error('Unexpected external write');}
  if(args[1]==='user')value={username:'reviewer'};
  else if(args[2]==='view')value={iid:1,state:'opened',sha};
  else if(args[2]==='review'&&args[3]==='list'){
   if(piRuns&&notesUnavailable)throw Error('temporary discussion-read failure');
   value=[];
  }else if(args[2]==='gate')value={ci_state_passed:true,quality_gate:{passed:true},conflict_passed:true};
  else if(args[2]==='pipeline')value=[{id:1,sha,status:'success'}];
  else {writes.push([...args]);throw Error('Unexpected write during recovery');}
  return {exitCode:0,output:JSON.stringify(value)};
 });
 const cfg={enabled:false,groupId:'',authorizedSender:'owner',repositoryPrefix:'MAE-M/Access/',intervalSeconds:10};
 try{
  store.putRecord('group-mr-entry',e.id,e);
  await service['executeEntry'](e,cfg,false);
  const interrupted=store.getRecord<Entry>('group-mr-entry',e.id)!;
  assert.equal(piRuns,1);assert.equal(interrupted.writePending,'Pi 提交检视意见');assert.ok(interrupted.piExecution?.completedAt);
  assert.equal(interrupted.phase,'ISSUES');assert.equal(interrupted.piReview,undefined);
  notesUnavailable=false;await service['refreshReadiness'](interrupted);
  const recovered=store.getRecord<Entry>('group-mr-entry',e.id)!;
  assert.equal(piRuns,1);assert.equal(recovered.writePending,'');assert.equal(recovered.piReview?.ok,true);
  assert.equal(recovered.phase,'ISSUES');assert.deepEqual(writes,[]);
 }finally{await service.close();store.close();}
});
