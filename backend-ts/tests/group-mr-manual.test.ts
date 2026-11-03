const agentResult=(text:string,sha:string)=>text+'<ops-studio-review-result>'+JSON.stringify({sha,assessments:[],findings:[]})+'</ops-studio-review-result>';
import {after,test} from 'node:test';
import {strict as assert} from 'node:assert';
import Fastify from 'fastify';
import {GroupMrService,groupMrRoutes,manualMrLink,type Entry} from '../src/modules/automation/group-mr.js';
import {TaskStore} from '../src/platform/store.js';
import type {runProcess} from '../src/infrastructure/process.js';

const sha='a'.repeat(40),url='https://codehub-y.huawei.com/MAE-M/FMEMate/Demo/merge_requests/123';
const config={enabled:false,groupId:'',authorizedSender:'Owner123',repositoryPrefix:'MAE-M/Access/',intervalSeconds:5,humanReviewEnabled:false};
const oldToken=process.env.WELINK_TOKEN;process.env.WELINK_TOKEN='test-manual-notification-token';
after(()=>{if(oldToken===undefined)delete process.env.WELINK_TOKEN;else process.env.WELINK_TOKEN=oldToken;});
async function settle(service:GroupMrService){while(service['background'].size)await Promise.allSettled(service['background']);}
function harness(){
 const store=new TaskStore(':memory:'),calls:string[][]=[],sent:Array<{receiver:string;content:string}>=[];
 const state:{pipeline:string;mr:string;issues:boolean;piFailure:boolean;notificationFailure:boolean;piBlock?:Promise<void>;piCalls:number}={pipeline:'success',mr:'opened',issues:false,piFailure:false,notificationFailure:false,piCalls:0};
 const execute:typeof runProcess=async(args,_dir,_timeout,_log,onLine,_input)=>{
  calls.push([...args]);let value:unknown={};
  if(args[0]==='welink-cli')throw Error('manual review must not invoke WeLink group CLI');
  if(args[0]==='pi'){
   state.piCalls++;await state.piBlock;
   if(state.piFailure)return {exitCode:1,output:'test failure'};
   onLine?.(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:agentResult('检视已完成',sha)}}),false);
   onLine?.(JSON.stringify({type:'agent_settled'}),false);return {exitCode:0,output:''};
  }
  if(args[1]==='user')value={username:'operator'};
  else if(args[2]==='view')value={iid:123,title:'Manual MR',state:state.mr,sha,approval_merge_request_reviewers:[{username:'operator'},{username:'owner123'}],approval_merge_request_approvers:[{username:'operator'},{username:'owner123'}],merge_request_assignee_list:[{username:'operator'},{username:'owner123'}]};
  else if(args[2]==='gate')value={ci_state_passed:state.pipeline==='success',approval_reviewers_required_passed:true,approval_approvers_required_passed:true,merge_gate_passed:true};
  else if(args[2]==='pipeline')value=state.pipeline==='missing'?[]:[{id:1,status:state.pipeline,sha}];
  else if(args[2]==='review'&&args[3]==='list')value=state.issues?[{id:'existing',resolved:false,notes:[{body:'请核对边界条件',author:{username:'developer'}}]}]:[];
  else if(args[2]==='merge')state.mr='merged';
  else throw Error('unexpected action '+args.slice(0,4).join(' '));
  return {exitCode:0,output:JSON.stringify(value)};
 };
 const notifier={send:async(receiver:string,content:string)=>{sent.push({receiver,content});if(state.notificationFailure)throw Error('unconfirmed');}};
 const service=new GroupMrService(store,execute,undefined,undefined,notifier);service.configure(config);
 return {service,store,calls,sent,state,execute,notifier,close:async()=>{await service.close();store.close();}};
}

test('manual URL validation accepts only a single supported URL and is independent of group prefix',()=>{
 assert.deepEqual(manualMrLink(url+'/?tab=changes#discussion'),{repo:'MAE-M/FMEMate/Demo',iid:'123',url});
 for(const input of [url+' '+url,'please '+url,url.replace('https:','http:'),url.replace('codehub-y.huawei.com','evil.example'),url.replace('codehub-y.huawei.com','codehub-y.huawei.com.evil.example'),url.replace('Demo','..'),url.replace('Demo','%2e%2e'),url.replace('Demo','/Demo'),url.replace('123','0'),url+'/files',url.replace('https://','https://user@')])assert.equal(manualMrLink(input),undefined,input);
});

test('manual-only configuration needs an authorized recipient but no group ID',async()=>{
 const h=harness();try{
  assert.equal(h.service.configuration().groupId,'');assert.throws(()=>h.service.configure({...config,enabled:true}),/群组 ID/);
  h.store.deleteRecord('group-mr-config','main');await assert.rejects(h.service.submitManual({url}),/配置授权账号/);
  assert.equal(h.calls.length,0);assert.equal(h.service.list().length,0);
 }finally{await h.close();}
});

test('manual API returns accepted before Pi finishes, coalesces concurrent requests and preserves mandatory human review',async()=>{
 const h=harness(),app=Fastify();let release=()=>{};h.state.piBlock=new Promise<void>(resolve=>{release=resolve;});groupMrRoutes(app,h.service);
 try{
  const response=await app.inject({method:'POST',url:'/api/automation/group-mr/submit',payload:{url:url+'/?tab=changes'}});
  assert.equal(response.statusCode,202);const body=response.json<{entryId:string;duplicate:boolean}>();assert.equal(body.duplicate,false);
  const duplicate=await h.service.submitManual({url});assert.deepEqual(duplicate,{entryId:body.entryId,duplicate:true});
  assert.equal(h.service.list().length,1);const pending=h.service.list()[0]!;assert.equal(pending.source,'manual');assert.equal(pending.humanReviewRequired,true);assert.equal(pending.notificationReceiver,'owner123');
  release();await settle(h.service);const row=h.service.list()[0]!;
  assert.equal(h.state.piCalls,1);assert.equal(row.phase,'HUMAN');assert.equal(row.notification?.status,'sent');assert.equal(row.reply,undefined);
  assert.equal(h.sent.length,1);assert.equal(h.sent[0]?.receiver,'owner123');assert.match(h.sent[0]!.content,/手动 MR 检视完成/);assert.equal(h.calls.some(c=>c[2]==='merge'||c[0]==='welink-cli'),false);
 }finally{release();await app.close();await h.close();}
});

for(const scenario of ['issues','pending','missing','failed','pi-failed'] as const)test('manual result notification covers early-return outcomes: '+scenario,async()=>{
 const h=harness();h.state.issues=scenario==='issues';h.state.piFailure=scenario==='pi-failed';if(['pending','missing','failed'].includes(scenario))h.state.pipeline=scenario;
 try{
  await h.service.submitManual({url});await settle(h.service);const row=h.service.list()[0]!;
  assert.equal(h.sent.length,1);assert.equal(h.sent[0]?.receiver,'owner123');assert.equal(row.notification?.status,'sent');assert.equal(row.reply,undefined);assert.equal(h.calls.some(c=>c[0]==='welink-cli'),false);
  assert.equal(row.phase,scenario==='pi-failed'?'FAILED':scenario==='issues'?'ISSUES':scenario==='failed'?'FAILED':'PIPELINE');
  if(scenario==='pi-failed')assert.equal(row.writePending,'');else assert.match(h.sent[0]!.content,/检视|意见/);
 }finally{await h.close();}
});

test('manual pipeline progression continues while group monitoring is disabled without rerunning Pi or renotifying',async()=>{
 const h=harness();h.state.pipeline='pending';try{
  await h.service.submitManual({url});await settle(h.service);assert.equal(h.service.list()[0]?.phase,'PIPELINE');assert.equal(h.sent.length,1);
  h.state.pipeline='success';h.service.refreshRemoteStates();await settle(h.service);
  assert.equal(h.service.list()[0]?.phase,'HUMAN');assert.equal(h.state.piCalls,1);assert.equal(h.sent.length,1);assert.equal(h.calls.some(c=>c[0]==='welink-cli'),false);
 }finally{await h.close();}
});

test('manual notification failure does not corrupt review state, replay on refresh, or replay after restart',async()=>{
 const h=harness();h.state.notificationFailure=true;try{
  await h.service.submitManual({url});await settle(h.service);let row=h.service.list()[0]!;
  assert.equal(row.phase,'HUMAN');assert.equal(row.writePending,'');assert.equal(row.notification?.status,'unconfirmed');assert.equal(h.sent.length,1);
  h.service.refreshRemoteStates();await settle(h.service);assert.equal(h.sent.length,1);
  await h.service.close();const restarted=new GroupMrService(h.store,h.execute,undefined,undefined,h.notifier);
  try{restarted.refreshRemoteStates();await settle(restarted);row=restarted.list()[0]!;assert.equal(row.phase,'HUMAN');assert.equal(row.notification?.status,'unconfirmed');assert.equal(h.sent.length,1);}finally{await restarted.close();}
 }finally{await h.close();}
});

test('manual task pins its recipient and never falls back to group replies when human approval merges it',async()=>{
 const h=harness();let release=()=>{};h.state.piBlock=new Promise<void>(resolve=>{release=resolve;});try{
  const {entryId}=await h.service.submitManual({url});h.service.configure({...config,authorizedSender:'another123',groupId:'123456789'});release();await settle(h.service);
  assert.equal(h.sent[0]?.receiver,'owner123');
  await h.service.submitReview(entryId,{sha,decision:'pass',reason:'',category:''});await settle(h.service);
  const row=h.service.list()[0]!;assert.equal(row.phase,'DONE');assert.equal(h.calls.filter(c=>c[2]==='merge').length,1);assert.equal(h.calls.some(c=>c[0]==='welink-cli'),false);
  assert.equal(h.sent.length,2);assert.ok(h.sent.every(s=>s.receiver==='owner123'));assert.match(h.sent[1]!.content,/已合入/);
  assert.equal(h.store.getRecord('group-mr-merge-reply',row.repo+':'+row.iid),undefined);
 }finally{release();await h.close();}
});

test('manual submission cannot bypass uncertain writes in hidden or superseded attempts',async()=>{
 const h=harness();h.state.piFailure=true;try{
  const {entryId}=await h.service.submitManual({url});await settle(h.service);const row=h.service.list()[0]!;
  h.store.putRecord('group-mr-entry',entryId,{...row,writePending:'审核',supersededBy:'another-entry'});h.store.putRecord('group-mr-hidden',entryId,{id:entryId});
  await assert.rejects(h.service.submitManual({url}),/结果待核对/);assert.equal(h.state.piCalls,1);assert.equal(h.service.list().length,1);
 }finally{await h.close();}
});

test('manual submission does not convert an active group task to a private task',async()=>{
 const h=harness();const entry:Entry={id:'group-task',repo:'MAE-M/FMEMate/Demo',iid:'123',url,sha,previousSha:'',messageId:'1',sender:'developer',shortcut:false,phase:'PI',status:'处理中',detail:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),writePending:'',events:[]};
 try{
  h.store.putRecord('group-mr-entry',entry.id,entry);h.service['reserved'].add(entry.repo+':'+entry.iid);
  await assert.rejects(h.service.submitManual({url}),/群组任务正在执行/);assert.equal(h.service.list().length,1);assert.equal(h.service.list()[0]?.source,undefined);assert.equal(h.calls.length,0);
 }finally{h.service['reserved'].clear();await h.close();}
});

test('a manual request reuses completed same-SHA review but gets its own notification after a group attempt',async()=>{
 const h=harness();try{
  const first=await h.service.submitManual({url});await settle(h.service);const row=h.service.list()[0]!;
  h.store.putRecord('group-mr-entry',first.entryId,{...row,source:'group'});
  const second=await h.service.submitManual({url});await settle(h.service);
  assert.notEqual(first.entryId,second.entryId);assert.equal(h.state.piCalls,1);assert.equal(h.sent.length,2);assert.equal(h.service.summary().pending[0]?.source,'manual');
 }finally{await h.close();}
});

test('hidden failed analysis can be explicitly retried without manual acknowledgement',async()=>{
 const h=harness();h.state.piFailure=true;try{
  const {entryId}=await h.service.submitManual({url});await settle(h.service);h.service.removeHistory(entryId);
  h.state.piFailure=false;const next=await h.service.submitManual({url});await settle(h.service);
  assert.notEqual(next.entryId,entryId);assert.equal(h.state.piCalls,2);assert.equal(h.service.summary().pending[0]?.phase,'HUMAN');
 }finally{await h.close();}
});

test('confirmed recovery in a same-execution successor does not leave manual submission blocked by its historical copy',async()=>{
 const h=harness();try{
  const {entryId}=await h.service.submitManual({url});await settle(h.service);const row=h.service.list()[0]!;
  const original:Entry={...row,source:'group',phase:'ISSUES',writePending:'Pi 提交检视意见',supersededBy:'successor'};
  const successor:Entry={...original,id:'successor'};delete successor.supersededBy;delete successor.piReview;
  h.store.putRecord('group-mr-entry',entryId,original);h.store.putRecord('group-mr-entry',successor.id,successor);
  h.service.refreshRemoteStates();await settle(h.service);
  assert.equal(h.store.getRecord<Entry>('group-mr-entry',successor.id)?.writePending,'');assert.equal(h.store.getRecord<Entry>('group-mr-entry',entryId)?.writePending,'Pi 提交检视意见');
  const accepted=await h.service.submitManual({url});await settle(h.service);assert.notEqual(accepted.entryId,entryId);assert.equal(h.state.piCalls,1);assert.equal(h.service.summary().pending[0]?.phase,'HUMAN');
 }finally{await h.close();}
});

test('legacy Pi uncertainty is reconciled on explicit retry even with a different successor',async()=>{
 const h=harness();try{
  const {entryId}=await h.service.submitManual({url});await settle(h.service);const row=h.service.list()[0]!;
  const original:Entry={...row,source:'group',phase:'ISSUES',writePending:'Pi 提交检视意见',supersededBy:'successor'};
  const successor:Entry={...row,id:'successor',piExecution:{...row.piExecution!,entryId:'unrelated-execution'}};
  h.store.putRecord('group-mr-entry',entryId,original);h.store.putRecord('group-mr-entry',successor.id,successor);
  await h.service.submitManual({url});await settle(h.service);assert.equal(h.state.piCalls,1);assert.equal(h.store.getRecord<Entry>('group-mr-entry',entryId)?.writePending,'');
 }finally{await h.close();}
});

test('confirmed manual-comment operation hash releases only its own stale pending copy',async()=>{
 const h=harness();try{
  const {entryId}=await h.service.submitManual({url});await settle(h.service);const row=h.service.list()[0]!;
  const pending={operationId:'manual-operation',operationHash:'expected-hash',action:'reply' as const,sha,discussionId:'thread',marker:'marker',reason:''};
  const original:Entry={...row,source:'group',phase:'ISSUES',writePending:'人工检视意见回复',manualReviewPending:pending,supersededBy:'successor'};
  const successor:Entry={...row,id:'successor',manualReviewLastOperation:pending.operationId};
  h.store.putRecord('group-mr-entry',entryId,original);h.store.putRecord('group-mr-entry',successor.id,successor);
  const operationKey=row.repo+':'+row.iid+':'+pending.operationId;
  h.store.putRecord('group-mr-review-operation',operationKey,{hash:'other-hash',status:'confirmed'});
  await assert.rejects(h.service.submitManual({url}),/结果待核对/);
  h.store.putRecord('group-mr-review-operation',operationKey,{hash:pending.operationHash,status:'confirmed'});
  await h.service.submitManual({url});await settle(h.service);assert.equal(h.state.piCalls,1);
 }finally{await h.close();}
});
