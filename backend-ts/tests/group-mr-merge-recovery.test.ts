import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {GroupMrService,groupMrRoutes,type Entry} from '../src/modules/automation/group-mr.js';
import {TaskStore} from '../src/platform/store.js';

const sha='a'.repeat(40),nextSha='b'.repeat(40),repo='MAE-M/Access/Demo';
const cfg={enabled:false,groupId:'',authorizedSender:'owner',repositoryPrefix:'MAE-M/',intervalSeconds:10};
const deferred=()=>{let release=()=>{};const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};
function entry():Entry{
 const id=randomUUID(),time='2026-11-09T01:00:00.000Z';
 return {id,repo,iid:'1',url:'https://codehub-y.huawei.com/'+repo+'/merge_requests/1',source:'manual',notificationReceiver:'owner',sha,previousSha:'',sender:'owner',messageId:'',shortcut:false,humanReviewRequired:true,rolesPrepared:true,
  phase:'ISSUES',stage:'MERGE',status:'人工审核已保存，后续合入失败',detail:'',createdAt:time,updatedAt:time,writePending:'合并',pipelinePassed:true,events:[],
  humanReview:{id:randomUUID(),entryId:id,repo,iid:'1',url:'',sha,decision:'pass',reason:'原审核结论',category:'quality',time,waitMs:0,actor:'平台人工审核',knowledgeStatus:'skipped'},
  piReview:{source:'codehub',sha,discussionKey:'[]',ok:true,findings:[],summary:'检视完成',resolvedDiscussionIds:[]}};
}
function fixture(seed=entry(),related:Entry[]=[]){
 const store=new TaskStore(':memory:'),calls:string[][]=[],writes:string[][]=[];
 const state={remote:'opened',head:sha,viewFailure:false,notesFailure:false,mergeFailure:false,mergeTimeout:false,pipelineSha:sha,pipelineStatus:'success',ci:true,quality:true,conflict:true,review:true,approval:true,mergeGate:true,notes:[] as unknown[],holdView:undefined as Promise<void>|undefined,holdMerge:undefined as Promise<void>|undefined};
 for(const e of [seed,...related])store.putRecord('group-mr-entry',e.id,e);
 store.putRecord('group-mr-config','main',cfg);
 const service=new GroupMrService(store,async args=>{
  calls.push([...args]);let value:unknown;
  if(args[0]!=='codehub-cli'){writes.push([...args]);throw Error('Must not rerun Agent or other commands');}
  if(args[1]==='user')value={username:'owner'};
  else if(args[2]==='view'){
   if(state.holdView)await state.holdView;
   if(state.viewFailure)throw Error('Cannot read MR');
   value={iid:1,state:state.remote,sha:state.head,approval_merge_request_reviewers:[{username:'owner',state:'true'}],approval_merge_request_approvers:[{username:'owner',state:'true'}],merge_request_assignee_list:[{username:'owner'}]};
  }else if(args[2]==='gate')value={ci_state_passed:state.ci,quality_gate:{passed:state.quality},conflict_passed:state.conflict,approval_reviewers_required_passed:state.review,approval_approvers_required_passed:state.approval,merge_gate_passed:state.mergeGate};
  else if(args[2]==='pipeline')value=[{id:1,sha:state.pipelineSha,status:state.pipelineStatus}];
  else if(args[2]==='review'&&args[3]==='list'){
   if(state.notesFailure)throw Error('Cannot read discussions');value=state.notes;
  }else if(args[2]==='merge'){
   writes.push([...args]);if(state.holdMerge)await state.holdMerge;
   if(state.mergeFailure||state.mergeTimeout)return {exitCode:state.mergeTimeout?124:1,output:state.mergeTimeout?'Request timed out':'MR association invalid'};
   state.remote='merged';value={state:'merged'};
  }else {writes.push([...args]);throw Error('Unexpected write '+args.slice(0,4).join(' '));}
  return {exitCode:0,output:JSON.stringify(value)};
 },undefined,undefined,{send:async()=>{}});
 const saved=()=>store.getRecord<Entry>('group-mr-entry',seed.id)!;
 return {store,service,e:seed,state,calls,writes,saved,close:async()=>{await service.close();store.close();}};
}
async function settledAttempt(f:ReturnType<typeof fixture>){
 try{await f.service.mergeRecord(f.e.id,{sha,confirmed:true});}catch{}
 return f.saved();
}

test('correcting an MR association allows an explicit merge retry without rerunning review or approval',async()=>{
 const e=entry();e.writePending='';e.phase='NO_PERMISSION';const f=fixture(e),original=e.humanReview;
 try{
  f.state.mergeFailure=true;await f.service.mergeRecord(e.id,{sha,confirmed:true});
  assert.equal(f.writes.length,1);assert.equal(f.saved().writePending,'合并');assert.notEqual(f.saved().phase,'DONE');
  f.state.mergeFailure=false;const result=await f.service.mergeRecord(e.id,{sha,confirmed:true});
  assert.equal(result.phase,'DONE');assert.equal(result.writePending,'');assert.deepEqual(result.humanReview,original);
  assert.equal(f.writes.length,2);assert.ok(f.writes.every(args=>args[2]==='merge'));assert.equal(f.service.knowledge.reviews().length,0);
 }finally{await f.close();}
});

for(const failure of ['nonzero','timeout'] as const)test('each explicit merge retry issues at most one merge and preserves another failure: '+failure,async()=>{
 const f=fixture();f.state.mergeFailure=failure==='nonzero';f.state.mergeTimeout=failure==='timeout';
 try{
  const result=await settledAttempt(f);assert.notEqual(result.phase,'DONE');assert.equal(result.writePending,'合并');assert.equal(f.writes.length,1);
  await Promise.allSettled(f.service['background']);assert.equal(f.writes.length,1);
  f.state.mergeFailure=false;f.state.mergeTimeout=false;
  assert.equal((await f.service.mergeRecord(f.e.id,{sha,confirmed:true})).phase,'DONE');assert.equal(f.writes.length,2);
 }finally{await f.close();}
});

for(const remote of ['merged','closed'])test('merge recovery reads terminal remote state before requiring a lost legacy review: '+remote,async()=>{
 const e=entry();delete e.humanReview;delete e.piReview;const f=fixture(e);f.state.remote=remote;
 try{
  const result=await f.service.mergeRecord(e.id,{sha,confirmed:true});
  assert.equal(result.phase,remote==='merged'?'DONE':'CLOSED');assert.deepEqual(f.writes,[]);
 }finally{await f.close();}
});

test('legacy inherited merge failure recovers prior same-SHA approval through its attempt chain',async()=>{
 const first=entry(),middle=entry(),current=entry();first.supersededBy=middle.id;middle.supersededBy=current.id;
 delete middle.humanReview;delete middle.piReview;delete current.humanReview;delete current.piReview;current.status='上一次合并结果未确认，需人工核对后再处理';
 const f=fixture(current,[middle,first]);
 try{
  const result=await f.service.mergeRecord(current.id,{sha,confirmed:true});
  assert.equal(result.phase,'DONE');assert.equal(result.humanReview?.id,first.humanReview?.id);assert.equal(f.writes.length,1);assert.equal(f.writes[0]?.[2],'merge');
  assert.equal(f.store.getRecord<Entry>('group-mr-entry',first.id)?.writePending,'');assert.equal(f.store.getRecord<Entry>('group-mr-entry',middle.id)?.writePending,'');
 }finally{await f.close();}
});

for(const mode of ['current-reject','nearer-reject','stale-approval','unrelated-pass'] as const)test('merge retry cannot borrow an invalid earlier approval: '+mode,async()=>{
 const first=entry(),middle=entry(),current=entry();first.supersededBy=middle.id;middle.supersededBy=current.id;
 delete current.humanReview;delete current.piReview;delete middle.humanReview;delete middle.piReview;
 if(mode==='current-reject'){current.humanReview=structuredClone(first.humanReview!);current.humanReview.decision='reject';}
 if(mode==='nearer-reject'){middle.humanReview=structuredClone(first.humanReview!);middle.humanReview.decision='reject';middle.humanReview.time='2026-11-09T02:00:00.000Z';}
 if(mode==='stale-approval'){first.sha=nextSha;first.humanReview!.sha=nextSha;}
 if(mode==='unrelated-pass')delete first.supersededBy;
 const f=fixture(current,[middle,first]);
 try{const result=await settledAttempt(f);assert.notEqual(result.phase,'DONE');assert.equal(result.writePending,'合并');assert.deepEqual(f.writes,[]);}
 finally{await f.close();}
});

for(const blocked of ['view-failure','notes-failure','comments','pipeline','old-pipeline','ci','quality','conflict','review','approval','merge-gate'] as const)test('merge recovery rechecks every remote condition: '+blocked,async()=>{
 const f=fixture();
 if(blocked==='view-failure')f.state.viewFailure=true;
 if(blocked==='notes-failure')f.state.notesFailure=true;
 if(blocked==='comments')f.state.notes=[{id:'new-note',resolved:false,notes:[{id:'comment',body:'Must fix',resolvable:true}]}];
 if(blocked==='pipeline')f.state.pipelineStatus='failed';
 if(blocked==='old-pipeline')f.state.pipelineSha=nextSha;
 if(blocked==='ci')f.state.ci=false;
 if(blocked==='quality')f.state.quality=false;
 if(blocked==='conflict')f.state.conflict=false;
 if(blocked==='review')f.state.review=false;
 if(blocked==='approval')f.state.approval=false;
 if(blocked==='merge-gate')f.state.mergeGate=false;
 try{const result=await settledAttempt(f);assert.notEqual(result.phase,'DONE');assert.equal(result.writePending,'合并');assert.deepEqual(f.writes,[]);}
 finally{await f.close();}
});

test('a new remote SHA ends the old merge request and allows explicit review of the new code',async()=>{
 const current=entry(),previous=entry(),otherMr=entry();previous.supersededBy=current.id;otherMr.iid='2';
 const f=fixture(current,[previous,otherMr]);f.state.head=nextSha;f.state.pipelineSha=nextSha;
 const resumed:Entry[]=[];f.service['executeEntry']=async e=>{resumed.push(structuredClone(e));};
 try{
  const result=await f.service.mergeRecord(current.id,{sha,confirmed:true});
  assert.equal(result.phase,'ISSUES');assert.equal(result.sha,sha);assert.equal(result.writePending,'');assert.equal(result.humanReview,undefined);assert.equal(result.piReview,undefined);
  assert.match(result.status,/提交已变化.*重新执行/);assert.deepEqual(f.writes,[]);assert.equal(resumed.length,0);
  assert.equal(f.store.getRecord<Entry>('group-mr-entry',previous.id)?.writePending,'');assert.equal(f.store.getRecord<Entry>('group-mr-entry',otherMr.id)?.writePending,'合并');
  const accepted=f.service.retryRecord(current.id,{sha});
  while(f.service['background'].size)await Promise.allSettled(f.service['background']);
  assert.notEqual(accepted.entryId,current.id);assert.equal(resumed.length,1);assert.equal(resumed[0]?.sha,nextSha);assert.equal(resumed[0]?.humanReview,undefined);assert.equal(resumed[0]?.writePending,'');assert.deepEqual(f.writes,[]);
 }finally{await f.close();}
});

for(const rejected of ['current','ancestor'] as const)test('an inherited shortcut never bypasses a human rejection: '+rejected,async()=>{
 const first=entry(),middle=entry(),current=entry();first.shortcut=true;first.supersededBy=middle.id;middle.supersededBy=current.id;
 delete middle.humanReview;delete middle.piReview;delete current.humanReview;delete current.piReview;
 const rejectedEntry=rejected==='current'?current:middle;
 rejectedEntry.humanReview=structuredClone(first.humanReview!);rejectedEntry.humanReview.decision='reject';rejectedEntry.humanReview.time='2026-11-09T02:00:00.000Z';
 const f=fixture(current,[middle,first]);
 try{const result=await settledAttempt(f);assert.notEqual(result.phase,'DONE');assert.equal(result.writePending,'合并');assert.equal(result.humanReview?.decision,'reject');assert.deepEqual(f.writes,[]);}
 finally{await f.close();}
});

test('legacy recovery retains the original skipped review when CodeHub permits merging',async()=>{
 const original=entry(),current=entry();original.reviewSkipped=true;original.supersededBy=current.id;delete current.humanReview;delete current.piReview;
 const f=fixture(current,[original]);f.state.review=false;
 try{const result=await f.service.mergeRecord(current.id,{sha,confirmed:true});assert.equal(result.phase,'DONE');assert.equal(result.reviewSkipped,true);assert.equal(f.writes.length,1);assert.equal(f.writes[0]?.[2],'merge');}
 finally{await f.close();}
});

for(const mode of ['unconfirmed','wrong-sha','hidden','superseded','other-pending'] as const)test('merge recovery rejects stale or unauthorized user actions: '+mode,async()=>{
 const f=fixture(),app=Fastify();groupMrRoutes(app,f.service);
 if(mode==='hidden')f.store.putRecord('group-mr-hidden',f.e.id,{id:f.e.id});
 if(mode==='superseded'){f.e.supersededBy=randomUUID();f.store.putRecord('group-mr-entry',f.e.id,f.e);}
 if(mode==='other-pending'){f.e.writePending='审核';f.store.putRecord('group-mr-entry',f.e.id,f.e);}
 try{
  const result=await app.inject({method:'POST',url:'/api/automation/group-mr/records/'+f.e.id+'/merge',payload:{sha:mode==='wrong-sha'?nextSha:sha,confirmed:mode!=='unconfirmed'}});
  assert.ok(result.statusCode>=400);assert.deepEqual(f.writes,[]);assert.equal(f.calls.length,0);
 }finally{await app.close();await f.close();}
});

test('two merge retry clicks cannot submit concurrently',async()=>{
 const f=fixture(),hold=deferred();f.state.holdMerge=hold.promise;
 try{
  const first=f.service.mergeRecord(f.e.id,{sha,confirmed:true});
  await assert.rejects(f.service.mergeRecord(f.e.id,{sha,confirmed:true}),/排队或执行|执行或排队/);
  for(let i=0;i<100&&!f.writes.length;i++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.writes.length,1);hold.release();assert.equal((await first).phase,'DONE');assert.equal(f.writes.length,1);
 }finally{hold.release();await f.close();}
});

test('restart and background reads never replay a pending merge',async()=>{
 const e=entry();e.phase='MERGE';const f=fixture(e);
 try{
  assert.equal(f.saved().phase,'INTERRUPTED');assert.equal(f.saved().writePending,'合并');assert.equal(f.calls.length,0);
  f.service.refreshRemoteStates();await Promise.allSettled(f.service['background']);
  assert.equal(f.saved().writePending,'合并');assert.deepEqual(f.writes,[]);
  assert.equal((await f.service.mergeRecord(e.id,{sha,confirmed:true})).phase,'DONE');assert.equal(f.writes.length,1);
 }finally{await f.close();}
});

test('merge retry clears only its own same-SHA merge markers',async()=>{
 const current=entry(),previous=entry(),olderSha=entry(),otherMr=entry(),otherOperation=entry();
 previous.supersededBy=current.id;olderSha.sha=nextSha;olderSha.supersededBy=previous.id;otherMr.iid='2';otherOperation.writePending='审核';
 const f=fixture(current,[previous,olderSha,otherMr,otherOperation]);
 try{
  assert.equal((await f.service.mergeRecord(current.id,{sha,confirmed:true})).phase,'DONE');
  assert.equal(f.store.getRecord<Entry>('group-mr-entry',previous.id)?.writePending,'');
  assert.equal(f.store.getRecord<Entry>('group-mr-entry',olderSha.id)?.writePending,'合并');
  assert.equal(f.store.getRecord<Entry>('group-mr-entry',otherMr.id)?.writePending,'合并');
  assert.equal(f.store.getRecord<Entry>('group-mr-entry',otherOperation.id)?.writePending,'审核');
 }finally{await f.close();}
});
