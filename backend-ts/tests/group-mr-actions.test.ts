import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {GroupMrService,groupMrRoutes,type Entry} from '../src/modules/automation/group-mr.js';
import {TaskStore} from '../src/platform/store.js';
const sha='a'.repeat(40);
const cfg={enabled:false,groupId:'',authorizedSender:'owner',repositoryPrefix:'MAE-M/Access/',intervalSeconds:10};
function entry():Entry{return{id:randomUUID(),repo:'MAE-M/Access/Demo',iid:'1',url:'https://codehub-y.huawei.com/MAE-M/Access/Demo/merge_requests/1',sha,previousSha:'',messageId:'1',sender:'developer',shortcut:false,humanReviewRequired:true,humanReview:{id:randomUUID(),entryId:'',repo:'MAE-M/Access/Demo',iid:'1',url:'',time:new Date().toISOString(),sha,decision:'pass',reason:'',category:'',waitMs:0,actor:'平台人工审核',knowledgeStatus:'skipped'},piReview:{sha,source:'codehub',discussionKey:'[]',ok:true,summary:'通过',findings:[],resolvedDiscussionIds:[]},phase:'NO_PERMISSION',status:'之前无法合入',detail:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),writePending:'',pipelinePassed:true,events:[]};}
function fixture(mode:string){
 const store=new TaskStore(':memory:'),writes:string[][]=[];let merged=false;
 const service=new GroupMrService(store,async args=>{
  let value:unknown={};const action=args[2];
  if(args[1]==='user')value={username:'owner'};
  else if(action==='view')value={iid:1,state:mode==='closed'?'closed':mode==='already-merged'||merged?'merged':'opened',sha:mode==='changed'?'b'.repeat(40):sha,approval_merge_request_reviewers:[{username:'owner'}],approval_merge_request_approvers:[{username:'owner'}],merge_request_assignee_list:[{username:'owner'}]};
  else if(action==='gate')value={ci_state_passed:mode!=='pipeline',quality_gate:{passed:mode!=='quality'},conflict_passed:mode!=='conflict',approval_reviewers_required_passed:true,approval_approvers_required_passed:true,merge_gate_passed:!['gate','conflict'].includes(mode)};
  else if(action==='pipeline')value=[{id:1,sha,status:mode==='pipeline'?'failed':'success'}];
  else if(action==='review')value=mode==='comments'?[{id:'open',resolved:false,notes:[{body:'fix it'}]}]:[];
  else if(action==='merge'){writes.push([...args]);if(mode==='uncertain')return{exitCode:124,output:'timeout'};if(mode==='denied')return{exitCode:1,output:'HTTP 403 forbidden'};merged=true;}
  else if(action==='send-to-group')value={resultCode:0};
  else if(action==='update'||args[0]==='pi')throw Error('must not add roles or rerun Agent in this fixture');
  return{exitCode:0,output:JSON.stringify(value)};
 });
 store.putRecord('group-mr-config','main',cfg);
 const e=entry();store.putRecord('group-mr-entry',e.id,e);return {store,service,e,writes};
}
for(const mode of ['success','changed','closed','already-merged','pipeline','quality','conflict','comments','gate','denied','uncertain'])test('manual merge reuses remote gates and never automatically retries a write: '+mode,async()=>{
 const {store,service,e,writes}=fixture(mode);
 try{
  const result=await service.mergeRecord(e.id,{sha,confirmed:true});
  assert.equal(writes.length,['success','denied','uncertain'].includes(mode)?1:0);
  if(['success','already-merged'].includes(mode))assert.equal(result.phase,'DONE');else if(mode==='closed')assert.equal(result.phase,'CLOSED');else assert.notEqual(result.phase,'DONE');
  if(writes.length)assert.ok(writes[0]!.includes('-y'));
  if(['success','already-merged','closed'].includes(mode)){await assert.rejects(service.mergeRecord(e.id,{sha,confirmed:true}));assert.equal(writes.length,mode==='success'?1:0);}
  if(mode==='uncertain'){assert.equal(result.writePending,'合并');const retried=await service.mergeRecord(e.id,{sha,confirmed:true});assert.equal(retried.writePending,'合并');assert.equal(writes.length,2);}
 }finally{await service.close();store.close();}
});
for(const mode of ['human','rejected','stale-human','pending-write','superseded','hidden','wrong-sha','unconfirmed'])test('manual merge rejects unsafe or stale selections before execution: '+mode,async()=>{
 const {store,service,e,writes}=fixture('success');
 if(mode==='human')delete e.humanReview;
 if(mode==='rejected')e.humanReview!.decision='reject';
 if(mode==='stale-human')e.humanReview!.sha='b'.repeat(40);
 if(mode==='no-agent')delete e.piReview;
 if(mode==='stale-agent')e.piReview!.sha='b'.repeat(40);
 if(mode==='pending-write')e.writePending='审核';
 if(mode==='superseded')e.supersededBy=randomUUID();
 if(mode==='hidden')store.putRecord('group-mr-hidden',e.id,{id:e.id});
 store.putRecord('group-mr-entry',e.id,e);
 try{await assert.rejects(service.mergeRecord(e.id,{sha:mode==='wrong-sha'?'b'.repeat(40):sha,confirmed:mode!=='unconfirmed'}));assert.equal(writes.length,0);}
 finally{await service.close();store.close();}
});
test('merge endpoint requires explicit confirmation and blocks duplicate in-flight submissions',async()=>{
 const {store,service,e}=fixture('success'),app=Fastify();groupMrRoutes(app,service);
 let release:()=>void=()=>{};const held=new Promise<void>(resolve=>release=resolve);let executions=0;
 service['executeEntry']=async()=>{executions++;await held;};
 try{
  const invalid=await app.inject({method:'POST',url:'/api/automation/group-mr/records/'+e.id+'/merge',payload:{sha}});assert.ok(invalid.statusCode>=400);assert.equal(executions,0);
  const first=service.mergeRecord(e.id,{sha,confirmed:true});await assert.rejects(service.mergeRecord(e.id,{sha,confirmed:true}),/排队或执行|执行或排队/);for(let i=0;i<30&&!executions;i++)await new Promise<void>(r=>setImmediate(r));assert.equal(executions,1);release();await first;
 }finally{release();await service.close();store.close();await app.close();}
});

for(const mode of ['success','comments','pipeline','changed','closed','quality','conflict'])test('explicit review reconciles pending Agent results only after live checks: '+mode,async()=>{
 const {store,service,e,writes}=fixture(mode);delete e.piReview;delete e.humanReview;e.phase='ISSUES';e.writePending='Pi 提交检视意见';store.putRecord('group-mr-entry',e.id,e);
 try{
  if(mode==='success'){
   await service.submitReview(e.id,{sha,decision:'pass',reason:''});await Promise.allSettled(service['background']);
   const saved=store.getRecord<Entry>('group-mr-entry',e.id)!;assert.equal(saved.phase,'DONE');assert.equal(saved.writePending,'');assert.equal(saved.piReview,undefined);assert.equal(writes.length,1);
  }else{
   await assert.rejects(service.submitReview(e.id,{sha,decision:'pass',reason:''}));assert.equal(writes.length,0);assert.equal(store.getRecord<Entry>('group-mr-entry',e.id)!.writePending,'Pi 提交检视意见');assert.equal(service.knowledge.reviews().length,0);
  }
 }finally{await service.close();store.close();}
});
for(const mode of ['no-agent','stale-agent'])test('human-approved merge does not require an Agent checkpoint: '+mode,async()=>{
 const {store,service,e,writes}=fixture('success');if(mode==='no-agent')delete e.piReview;else e.piReview!.sha='b'.repeat(40);store.putRecord('group-mr-entry',e.id,e);
 try{assert.equal((await service.mergeRecord(e.id,{sha,confirmed:true})).phase,'DONE');assert.equal(writes.length,1);}finally{await service.close();store.close();}
});

for(const mode of ['null','partial','malformed','read-failure'])test('manual review and merge fail closed with unconfirmed discussions: '+mode,async()=>{
 for(const action of ['review','merge']){
  const {store,service,e,writes}=fixture('success');e.shortcut=true;e.phase='ISSUES';delete e.humanReview;store.putRecord('group-mr-entry',e.id,e);
  const code=service['code'].bind(service);
  service['code']=async(args,columns)=>{
   if(args[1]==='review'&&args[2]==='list'){
    if(mode==='read-failure')throw Error('network unavailable');
    return JSON.stringify(mode==='null'?[{id:'n',resolved:null,notes:[{body:'must fix',resolvable:true}]}]:mode==='partial'?{items:[],total:1}:[{id:'n'}]);
   }return code(args,columns);
  };
  try{
   if(action==='review')await assert.rejects(service.submitReview(e.id,{sha,decision:'pass',reason:'',category:''}));
   else assert.notEqual((await service.mergeRecord(e.id,{sha,confirmed:true})).phase,'DONE');
   assert.equal(writes.length,0);const saved=store.getRecord<Entry>('group-mr-entry',e.id)!;assert.equal(saved.readiness?.ready,false);assert.equal(saved.humanReview,undefined);
   if(mode==='null')assert.equal(saved.reviewComments?.[0]?.resolved,false);
  }finally{await service.close();store.close();}
 }
});
test('readiness refresh saves current remote opinions even when they block review',async()=>{
 const {store,service,e}=fixture('comments');
 try{const state=await service['refreshReadiness'](e);assert.equal(state.ready,false);assert.match(state.reason,/检视意见/);assert.equal(store.getRecord<Entry>('group-mr-entry',e.id)!.reviewComments?.[0]?.body,'fix it');}
 finally{await service.close();store.close();}
});

test('manual shortcut merge never resolves a newly arrived discussion',async()=>{
 const {store,service,e,writes}=fixture('success');e.shortcut=true;store.putRecord('group-mr-entry',e.id,e);
 const code=service['code'].bind(service);let lists=0,resolves=0;
 service['code']=async(args,columns)=>{
  if(args[1]==='review'&&args[2]==='resolve')resolves++;
  if(args[1]==='review'&&args[2]==='list'&&++lists>1)return JSON.stringify([{id:'late',resolved:false,notes:[{body:'new issue'}]}]);
  return code(args,columns);
 };
 try{const result=await service.mergeRecord(e.id,{sha,confirmed:true});assert.equal(result.phase,'ISSUES');assert.equal(resolves,0);assert.equal(writes.length,0);assert.equal(result.reviewComments?.[0]?.id,'late');}
 finally{await service.close();store.close();}
});
