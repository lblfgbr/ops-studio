import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GroupMrService,type Entry} from '../src/modules/automation/group-mr.js';
import {TaskStore} from '../src/platform/store.js';
import {parseAgentResult,findingIdentity,type AgentFinding,type AgentSubmission} from '../src/modules/automation/agent-findings.js';

const sha='a'.repeat(40),repo='MAE-M/Access/Demo',url='https://codehub-y.huawei.com/'+repo+'/merge_requests/1';
const finding:AgentFinding={path:'src/a.ts',line:1,body:'空值会触发异常，请确认上游是否保证非空。'};
const answer=(findings:AgentFinding[]=[])=>'<ops-studio-review-result>'+JSON.stringify({sha,assessments:[],findings})+'</ops-studio-review-result>';
function row():Entry{return {id:'attempt',repo,iid:'1',url,sha,previousSha:'',messageId:'',sender:'owner',source:'manual',notificationReceiver:'owner',humanReviewRequired:true,shortcut:false,phase:'ISSUES',stage:'PI',status:'旧失败原因',detail:'',createdAt:'2026-11-03T00:00:00Z',updatedAt:'2026-11-03T00:00:00Z',writePending:'',events:[]};}
function submission(f:AgentFinding=finding,status:AgentSubmission['status']='pending'):AgentSubmission{
 const identity=findingIdentity(f);
 return {key:repo+':1:'+identity,repo,iid:'1',sha,entryId:'attempt',author:'reviewer',finding:f,marker:'<!-- ops-studio-finding:'+identity+' -->',status};
}
function harness(){
 const store=new TaskStore(':memory:'),e=row(),writes:string[][]=[];
 const state={head:sha,notes:[] as unknown[],notesFail:false,notesReads:0,notesFailAfterCreate:false,ackLost:false,deliver:true,stripMarkers:false,failCreates:new Set<number>(),piRuns:0,findings:[finding],invalidAnswer:false,changesReads:0,changesFail:false,changes:[{new_path:finding.path,diff:'@@ -0,0 +1,2 @@\n+one\n+two'}]};
 const service=new GroupMrService(store,async(args,_dir,_timeout,_log,onLine)=>{
  if(args[0]==='pi'){
   state.piRuns++;onLine?.(JSON.stringify({type:'agent_end',messages:[{role:'assistant',stopReason:'stop',content:[{type:'text',text:state.invalidAnswer?'完成':answer(state.findings)}]}]}),false);
   return {exitCode:0,output:''};
  }
  let value:unknown={};
  if(args.includes('--help'))return {exitCode:0,output:`codehub-cli mr review ${args[3]} <iid>${args[3]==='reply'?' <discussion-id>':''}\n -b, --body string\n -p, --project string\n --path string\n --line lineRange`};
  if(args[1]==='user')value={username:'reviewer'};
  else if(args[2]==='view')value={iid:1,state:'opened',sha:state.head};
  else if(args[3]==='list'){state.notesReads++;if(state.notesFail||state.notesFailAfterCreate&&writes.length)throw Error('读取失败');value=state.notes;}
  else if(args[2]==='changes'){state.changesReads++;if(state.changesFail)throw Error('差异读取失败');value={changes:state.changes};}
  else if(args[3]==='create'){
   writes.push([...args]);
   if(state.failCreates.has(writes.length))throw Error('HTTP 400: invalid position');
   const body=args[args.indexOf('--body')+1]!;
   if(state.deliver)state.notes.push({id:'note-'+writes.length,resolved:false,notes:[{id:'body-'+writes.length,body:state.stripMarkers?body.replace(/<!-- ops-studio-[\s\S]*?-->/g,'').trim():body,author:{username:'reviewer'},position:{new_path:args[args.indexOf('--path')+1],new_line:Number(args[args.indexOf('--line')+1]),head_sha:state.head}}]});
   if(state.ackLost)throw Error('response lost');
  }else if(args[2]==='gate')value={ci_state_passed:true};
  else if(args[2]==='pipeline')value=[{id:1,sha:state.head,status:'success'}];
  else throw Error('unexpected command '+args.slice(0,4).join(' '));
  return {exitCode:0,output:JSON.stringify(value)};
 },undefined,undefined,{send:async()=>{}});
 service.configure({enabled:false,groupId:'',authorizedSender:'owner',repositoryPrefix:'MAE-M/',intervalSeconds:5});
 store.putRecord('group-mr-entry',e.id,e);
 return {store,e,service,state,writes,close:async()=>{await service.close();store.close();}};
}

test('malformed, missing, duplicated, or wrong-SHA Agent results cannot authorize publishing',()=>{
 for(const input of ['完成',answer()+answer(),answer().replace(sha,'b'.repeat(40)),answer().replace('"findings":[]','"findings":[{"path":"x","line":0,"body":"bad"}]')])assert.throws(()=>parseAgentResult(input,sha));
 assert.deepEqual(parseAgentResult(answer(),sha).findings,[]);
});

test('analysis failure creates no uncertain write; explicit retry can publish normally',async()=>{
 const h=harness();try{
  h.state.invalidAnswer=true;await assert.rejects(h.service['runPi'](h.e,'',[],'reviewer'),/结构化/);
  assert.equal(h.store.getRecord<Entry>('group-mr-entry',h.e.id)?.writePending,'');assert.equal(h.writes.length,0);
  h.state.invalidAnswer=false;await h.service['runPi'](h.e,'',[],'reviewer');assert.equal(h.writes.length,1);
 }finally{await h.close();}
});

for(const remote of ['missing','stripped-markers'] as const)test('CLI success completes publishing without a matching remote marker: '+remote,async()=>{
 const h=harness();try{
  h.state.deliver=remote!=='missing';h.state.stripMarkers=remote==='stripped-markers';
  await h.service['runPi'](h.e,'',[],'reviewer');assert.equal(h.writes.length,1);
  assert.equal(h.store.records<AgentSubmission>('group-mr-agent-submission')[0]?.status,'confirmed');
  assert.equal(h.e.writePending,'');assert.ok(h.e.piExecution?.completedAt);
  await h.service['runPi'](h.e,'',[],'reviewer');assert.equal(h.writes.length,1);
 }finally{await h.close();}
});

test('a batch publishes every distinct finding without reading back between creates',async()=>{
 const h=harness();try{
  h.state.notesFailAfterCreate=true;h.state.findings=[finding,{...finding,line:2,body:'另一处独立问题，请确认。'},finding];
  await h.service['runPi'](h.e,'',[],'reviewer');
  assert.equal(h.state.notesReads,1);assert.equal(h.writes.length,2);assert.equal(h.e.writePending,'');
  assert.ok(h.store.records<AgentSubmission>('group-mr-agent-submission').every(s=>s.status==='confirmed'));
 }finally{await h.close();}
});

test('a failed create reports its error, still publishes other findings, and can be retried by a new review',async()=>{
 const h=harness();try{
  h.state.findings=[finding,{...finding,line:2,body:'另一处独立问题，请确认。'}];h.state.failCreates.add(1);
  await assert.rejects(h.service['runPi'](h.e,'',[],'reviewer'),error=>error instanceof Error&&/提交失败/.test(error.message)&&/src\/a.ts:1/.test(error.message)&&/HTTP 400/.test(error.message)&&!/待核对/.test(error.message));
  const failed=h.store.getRecord<AgentSubmission>('group-mr-agent-submission',submission().key)!;
  assert.equal(failed.status,'failed');assert.match(failed.error??'',/HTTP 400/);
  assert.equal(h.store.getRecord<AgentSubmission>('group-mr-agent-submission',submission(h.state.findings[1]!).key)?.status,'confirmed');
  assert.equal(h.writes.length,2);assert.equal(h.e.writePending,'');assert.equal(h.e.piExecution?.completedAt,undefined);
  h.state.failCreates.clear();await h.service['recoverAgentAttempts'](h.e);
  await h.service['runPi'](h.e,'',[],'reviewer');
  assert.equal(h.writes.length,3);assert.equal(h.store.getRecord<AgentSubmission>('group-mr-agent-submission',failed.key)?.status,'confirmed');
  assert.equal(h.e.writePending,'');assert.ok(h.e.piExecution?.completedAt);
 }finally{await h.close();}
});

test('a lost response is reported, while the next explicit review recognizes the delivered comment without reposting',async()=>{
 const h=harness();try{
  h.state.ackLost=true;await assert.rejects(h.service['runPi'](h.e,'',[],'reviewer'),/response lost/);
  assert.equal(h.writes.length,1);assert.equal(h.e.writePending,'');
  assert.equal(h.store.records<AgentSubmission>('group-mr-agent-submission')[0]?.status,'failed');
  h.state.ackLost=false;await h.service['runPi'](h.e,'',[],'reviewer');
  assert.equal(h.writes.length,1);assert.equal(h.store.records<AgentSubmission>('group-mr-agent-submission')[0]?.status,'confirmed');
  assert.ok(h.store.getRecord('group-mr-owned-discussion',repo+':1:note-1'));
 }finally{await h.close();}
});

for(const status of ['pending','retry-authorized'] as const)test('an explicit review can submit a legacy '+status+' finding without per-comment confirmation',async()=>{
 const h=harness();try{
  const operation=submission(finding,status);h.store.putRecord('group-mr-agent-submission',operation.key,operation);
  h.e.writePending='Agent 单条意见提交';h.store.putRecord('group-mr-entry',h.e.id,h.e);
  await h.service['recoverAgentAttempts'](h.e);assert.equal(h.writes.length,0);assert.equal(h.e.writePending,'');
  await h.service['runPi'](h.e,'',[],'reviewer');
  assert.equal(h.writes.length,1);assert.equal(h.store.getRecord<AgentSubmission>('group-mr-agent-submission',operation.key)?.status,'confirmed');
 }finally{await h.close();}
});

test('a new analysis retires failed findings that no longer apply',async()=>{
 const h=harness();try{
  const operation={...submission(finding,'failed'),error:'HTTP 400: invalid position'};h.store.putRecord('group-mr-agent-submission',operation.key,operation);
  h.state.findings=[];await h.service['runPi'](h.e,'',[],'reviewer');
  assert.equal(h.writes.length,0);assert.equal(h.store.getRecord<AgentSubmission>('group-mr-agent-submission',operation.key)?.status,'not-submitted');
  assert.equal(h.e.writePending,'');assert.ok(h.e.piExecution?.completedAt);
 }finally{await h.close();}
});

test('successful comments can gain ownership later without making success depend on marker readback',async()=>{
 const h=harness();try{
  h.state.deliver=false;await h.service['runPi'](h.e,'',[],'reviewer');
  const operation=h.store.records<AgentSubmission>('group-mr-agent-submission')[0]!;
  assert.equal(operation.status,'confirmed');assert.equal(operation.discussionId,undefined);
  h.state.notes=[{id:'late-note',resolved:false,notes:[{body:finding.body+'\n\n'+operation.marker,author:{username:'reviewer'},position:{new_path:finding.path,new_line:1,head_sha:sha}}]}];
  await h.service['refreshReadiness'](h.e);
  assert.equal(h.store.getRecord<AgentSubmission>('group-mr-agent-submission',operation.key)?.discussionId,'late-note');
  assert.ok(h.store.getRecord('group-mr-owned-discussion',repo+':1:late-note'));assert.equal(h.writes.length,1);
 }finally{await h.close();}
});

test('legacy submission bookkeeping does not block review, but unresolved remote comments still do',async()=>{
 const h=harness();try{
  const operation=submission();h.store.putRecord('group-mr-agent-submission',operation.key,operation);
  h.e.writePending='Agent 单条意见提交';h.store.putRecord('group-mr-entry',h.e.id,h.e);
  await h.service['verifyManualReview'](h.e,sha);assert.equal(h.e.writePending,'');assert.equal(h.writes.length,0);
  h.state.notes=[{id:'open',resolved:false,notes:[{body:'请处理当前问题',author:{username:'reviewer'},position:{new_path:finding.path,new_line:1,head_sha:sha}}]}];
  await assert.rejects(h.service['verifyManualReview'](h.e,sha),/未关闭|未闭环/);assert.equal(h.writes.length,0);
 }finally{await h.close();}
});

test('closed remote opinion with shifted line is not posted again',async()=>{
 const h=harness();try{
  h.state.notes=[{id:'old',resolved:true,notes:[{body:finding.body,author:{username:'other'},position:{new_path:finding.path,new_line:99}}]}];
  await h.service['runPi'](h.e,'',[],'reviewer');assert.equal(h.writes.length,0);
 }finally{await h.close();}
});

test('context-line findings retain their positions and do not block other findings',async()=>{
 const h=harness();try{
  const path='recipes/sample.yaml';
  h.state.changes=[{new_path:path,diff:'@@ -43,3 +52,6 @@\n+    outputs:\n+      rewritten: ${api_response}\n       output_parser:\n         show_title: true\n         show_content: true\n+    next:'}];
  h.state.findings=[{path,line:54,body:'请确认解析器在新增节点中的归属。'},{path,line:53,body:'请确认新增输出是否需要处理空响应。'}];
  await h.service['runPi'](h.e,'',[],'reviewer');
  assert.deepEqual(h.writes.map(args=>({path:args[args.indexOf('--path')+1],line:Number(args[args.indexOf('--line')+1])})),[{path,line:54},{path,line:53}]);
  for(const [index,args] of h.writes.entries())assert.ok(args[args.indexOf('--body')+1]?.startsWith(h.state.findings[index]!.body+'\n\n'));
  assert.deepEqual(h.store.records<AgentSubmission>('group-mr-agent-submission').map(s=>({line:s.finding.line,status:s.status})).sort((a,b)=>a.line-b.line),[{line:53,status:'confirmed'},{line:54,status:'confirmed'}]);
 }finally{await h.close();}
});

test('publishing Agent findings does not depend on retrieving a diff',async()=>{
 const h=harness();try{
  h.state.changesFail=true;h.state.findings=[{...finding,path:'src/related.ts',line:100}];
  await h.service['runPi'](h.e,'',[],'reviewer');
  assert.equal(h.state.changesReads,0);assert.equal(h.writes.length,1);
  const args=h.writes[0]!;assert.equal(args[args.indexOf('--path')+1],'src/related.ts');assert.equal(args[args.indexOf('--line')+1],'100');
  assert.equal(h.store.records<AgentSubmission>('group-mr-agent-submission')[0]?.status,'confirmed');
 }finally{await h.close();}
});

for(const failure of ['read','changed-sha'] as const)test('no posting without a valid stable complete snapshot: '+failure,async()=>{
 const h=harness();try{
  if(failure==='read')h.state.notesFail=true;
  if(failure==='changed-sha')h.state.head='b'.repeat(40);
  await assert.rejects(h.service['runPi'](h.e,'',[],'reviewer'));assert.equal(h.writes.length,0);
 }finally{await h.close();}
});

test('explicit retry reads remote before clearing legacy blocker and keeps original failure reason',async()=>{
 const h=harness();try{
  h.e.writePending='Pi 提交检视意见';h.e.piExecution={entryId:h.e.id,sha,author:'reviewer',discussionIds:[]};h.store.putRecord('group-mr-entry',h.e.id,h.e);
  h.state.notesFail=true;await assert.rejects(h.service['recoverAgentAttempts'](h.e));assert.equal(h.e.writePending,'Pi 提交检视意见');assert.equal(h.state.piRuns,0);
  h.state.notesFail=false;await h.service['recoverAgentAttempts'](h.e);
  assert.equal(h.e.writePending,'');assert.equal(h.store.getRecord<Entry>('group-mr-entry',h.e.id)?.status,'旧失败原因');
  assert.equal(h.store.getRecord('group-mr-review-checkpoint',repo+':1'),undefined);
  assert.equal(h.state.piRuns,0);assert.equal(h.writes.length,0);
 }finally{await h.close();}
});

test('restart releases a legacy submission blocker without replaying comments, including hidden attempts',async()=>{
 const h=harness();try{
  const operation=submission();h.store.putRecord('group-mr-agent-submission',operation.key,operation);
  h.e.writePending='Agent 单条意见提交';h.store.putRecord('group-mr-entry',h.e.id,h.e);
  h.store.putRecord('group-mr-hidden',h.e.id,{id:h.e.id});await h.service.close();let calls=0;
  const restarted=new GroupMrService(h.store,async()=>{calls++;throw Error('no replay');});
  try{assert.equal(calls,0);assert.notEqual(restarted['agentSubmissions'](h.e)[0]?.status,'confirmed');assert.equal(h.store.getRecord<Entry>('group-mr-entry',h.e.id)?.writePending,'');}
  finally{await restarted.close();}
 }finally{await h.close();}
});

import reviewGuard,{reviewToolAllowed,reviewArgsAllowed} from '../src/infrastructure/pi-review-guard.js';
test('review guard exposes only an argv-based read adapter, independently of the prompt',()=>{
 for(const args of [['mr','view','1','-p',repo,'--format','json'],['mr','review','list','1','-p',repo],['repo','file','get','-p',repo,'--file-path=src/a.ts','--ref',sha],['mr','changes','--help']])assert.equal(reviewArgsAllowed(args),true);
 for(const args of [['mr','review','create','1','--body','hi'],['mr','merge','1'],['mr','view','1','--output','file'],['mr','view','1\nwhoami'],['repo','clone',repo],['mr','view','1','--config','evil']])assert.equal(reviewArgsAllowed(args),false);
 for(const toolName of ['bash','write','edit','mcp_codehub_write','unknown'])assert.equal(reviewToolAllowed({toolName,input:{}}),false);
 let handler:((event:{toolName:string;input:Record<string,unknown>})=>{block:true;reason:string}|undefined)|undefined;
 let registered='';reviewGuard({registerTool:tool=>{registered=tool.name;},on:(_event,fn)=>{handler=fn;}});
 assert.equal(registered,'codehub_read');assert.equal(handler?.({toolName:'write',input:{}})?.block,true);
});

test('the legacy confirmation endpoint remains compatible and never submits a comment itself',async()=>{
 const h=harness();try{
  const operation=submission();h.store.putRecord('group-mr-agent-submission',operation.key,operation);
  await assert.rejects(h.service.confirmAgentFindingNotSubmitted(h.e.id,{sha,marker:operation.marker,confirmedNotSubmitted:false}));
  await h.service.confirmAgentFindingNotSubmitted(h.e.id,{sha,marker:operation.marker,confirmedNotSubmitted:true});
  assert.equal(h.writes.length,0);await h.service['verifyManualReview'](h.e,sha);
  await h.service['runPi'](h.e,'',[],'reviewer');assert.equal(h.writes.length,1);
  assert.equal(h.store.records<AgentSubmission>('group-mr-agent-submission')[0]?.status,'confirmed');
 }finally{await h.close();}
});
