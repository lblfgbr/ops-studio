import test from 'node:test';
import assert from 'node:assert/strict';
import {GroupMrService,parseDiscussions,type Entry} from '../src/modules/automation/group-mr.js';
import {parseReviewAssessment,developerReplied,type ReviewAssessment} from '../src/modules/automation/review-closure.js';
import {TaskStore} from '../src/platform/store.js';
import type {runProcess} from '../src/infrastructure/process.js';
const sha='a'.repeat(40),repo='MAE-M/Access/Demo';
const cfg={enabled:true,groupId:'123456789',authorizedSender:'owner',repositoryPrefix:'MAE-M/Access/',intervalSeconds:5};
const entry=(id='run'):Entry=>({id,repo,iid:'1',url:`https://codehub-y.huawei.com/${repo}/merge_requests/1`,sha,previousSha:'',messageId:id,sender:'developer',shortcut:false,phase:'PI',status:'',detail:'',createdAt:new Date().toISOString(),updatedAt:'',writePending:'',events:[]});
const thread=(id:string,replies:Record<string,unknown>[]=[])=>({id,resolved:false,notes:[{id:'root',body:'缺少判空',author:{username:'owner'},resolvable:true},...replies]});
const reply=(author='developer',body='收到')=>({id:'reply',body,author:{username:author}});
test('完整讨论保留回复，任意内容触发但系统、机器人及工具自身回复不触发',()=>{
 for(const body of ['收到','稍后处理','无需修改',''])assert.equal(developerReplied(parseDiscussions(JSON.stringify([thread('mine',[reply('developer',body)])]))[0]!,'owner'),true);
 for(const r of [reply('owner'),{...reply(),system:true},{...reply(),author:{username:'robot',bot:true}},{id:'empty',body:'hi'}])assert.equal(developerReplied(parseDiscussions(JSON.stringify([thread('mine',[r])]))[0]!,'owner'),false);
});
test('Agent 结构化判断拒绝缺失、重复 ID、多个结果、无依据与错误格式',()=>{
 const wrap=(v:unknown)=>'<ops-studio-review-result>'+JSON.stringify(v)+'</ops-studio-review-result>';
 const value={sha,assessments:[{id:'mine',status:'FIXED',reason:'新增空值返回分支'}]};
 assert.deepEqual(parseReviewAssessment(wrap(value)),value);
 for(const answer of ['已修复',wrap({...value,sha:'bad'}),wrap({...value,assessments:[value.assessments[0],value.assessments[0]]}),wrap(value)+wrap(value),wrap({...value,assessments:[{id:'mine',status:'FIXED',reason:''}]})])assert.equal(parseReviewAssessment(answer),undefined);
});
for(const scenario of ['reply','fixed','unfixed','uncertain','foreign','self','system','bot','wrong-sha','changed-sha','changed-note','unconfirmed','missing'] as const)test('意见闭环校验：'+scenario,async()=>{
 const store=new TaskStore(':memory:');let resolves=0;const e=entry();
 const rows=[thread('mine',scenario==='reply'||scenario==='foreign'||scenario==='changed-sha'||scenario==='changed-note'||scenario==='unconfirmed'||scenario==='missing'?[reply()]:scenario==='self'?[reply('owner')]:scenario==='system'?[{...reply(),system:true}]:scenario==='bot'?[{...reply(),author:{username:'bot',bot:true}}]:[])];
 const before=parseDiscussions(JSON.stringify(rows));
 if(scenario!=='foreign')store.putRecord('group-mr-owned-discussion',repo+':1:mine',{id:'mine',body:before[0]!.body,author:'owner',entryId:'first'});
 const execute:typeof runProcess=async args=>{
  let value:unknown={};
  if(args[2]==='view')value={iid:1,state:'opened',sha:scenario==='changed-sha'?'b'.repeat(40):sha};
  if(args[3]==='list'){value=scenario==='missing'&&resolves?[]:rows;if(scenario==='changed-note')rows[0]!.notes.push(reply('other','补充问题'));}
  if(args[3]==='resolve'){resolves++;if(scenario!=='unconfirmed')rows[0]!.resolved=true;}
  return{exitCode:0,output:JSON.stringify(value)};
 };
 const service=new GroupMrService(store,execute);
 const assessment:ReviewAssessment={sha:scenario==='wrong-sha'?'b'.repeat(40):sha,assessments:[{id:'mine',status:scenario==='unfixed'?'UNFIXED':scenario==='uncertain'?'UNCERTAIN':'FIXED',reason:'当前代码增加判空'}]};
 try{
  const run=()=>service['closeReviewed'](e,cfg,before,['fixed','unfixed','uncertain','wrong-sha'].includes(scenario)?assessment:undefined);
  if(['changed-sha','unconfirmed','missing'].includes(scenario))await assert.rejects(run());else await run();
  assert.equal(resolves,['reply','fixed','unconfirmed','missing'].includes(scenario)?1:0);
  if(['unconfirmed','missing'].includes(scenario)){assert.match(e.writePending,/闭环检视意见/);if(scenario==='unconfirmed')await assert.rejects(run());else await run();assert.equal(resolves,1);}
 }finally{await service.close();store.close();}
});
for(const mode of ['reply','FIXED','UNFIXED','UNCERTAIN'] as const)test('跨轮次归属与闭环：'+mode,async()=>{
 const store=new TaskStore(':memory:');let piRuns=0,currentSha=sha;const resolved:string[]=[];let rows:ReturnType<typeof thread>[]=[];
 const execute:typeof runProcess=async(args,_dir,_timeout,_log,onLine,_input)=>{
  let value:unknown={};
  if(args[0]==='pi'){
   piRuns++;
   onLine?.(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'<ops-studio-review-result>'+JSON.stringify({sha:currentSha,assessments:piRuns===1?[]:[{id:'mine',status:mode,reason:'已检查当前代码'}],findings:piRuns===1?[{path:'a.ts',line:1,body:'缺少判空'}]:[]})+'</ops-studio-review-result>'}}),false);onLine?.(JSON.stringify({type:'agent_end'}),false);
  }else if(args[1]==='user')value={username:'owner'};
  else if(args[2]==='view')value={iid:1,state:'opened',sha:currentSha};
  else if(args[2]==='review'&&args[3]==='list')value=rows;
  else if(args[2]==='changes')value={changes:[{new_path:'a.ts',diff:'@@ -0,0 +1 @@\n+new'}]};
  else if(args[3]==='create'&&!args.includes('--help')){rows=[thread('mine'),thread('human')];rows[0]!.notes[0]!.body=args[args.indexOf('--body')+1]!;Object.assign(rows[0]!.notes[0]!,{position:{new_path:'a.ts',new_line:1}});}
  else if(args[2]==='review'&&args[3]==='resolve'){resolved.push(args[5]!);rows.find(r=>r.id===args[5])!.resolved=true;}
  else if(args.includes('--help'))return{exitCode:0,output:args[2]==='review'?`mr review ${args[3]} <iid>${args[3]==='reply'?' <discussion-id>':''}\n --body <body>\n --project <repo>\n --path <path>\n --line <line>`:'--quote-message-id'};
  else if(args[2]==='send-to-group')value={resultCode:0};
  return{exitCode:0,output:JSON.stringify(value)};
 };
 const service=new GroupMrService(store,execute);
 try{
  const first=entry('first');await service['processEntry'](first,cfg);assert.equal(first.phase,'ISSUES');assert.ok(store.getRecord('group-mr-owned-discussion',repo+':1:mine'));assert.equal(store.getRecord('group-mr-owned-discussion',repo+':1:human'),undefined);
  if(mode==='reply')rows.forEach(r=>r.notes.push(reply()));else currentSha='b'.repeat(40);
  const second={...entry('second'),sha:currentSha};await service['processEntry'](second,cfg);assert.equal(piRuns,mode==='reply'?1:2);assert.deepEqual(resolved,mode==='reply'||mode==='FIXED'?['mine']:[]);assert.equal(second.phase,'ISSUES');assert.equal(second.reviewComments?.find(n=>n.id==='human')?.resolved,false);
 }finally{await service.close();store.close();}
});
test('关闭结果待确认时只读核对，不重发命令，确认闭环后解除阻塞',async()=>{
 const store=new TaskStore(':memory:'),e=entry();e.writePending='闭环检视意见 mine';store.putRecord('group-mr-entry',e.id,e);
 const note=thread('mine');store.putRecord('group-mr-owned-discussion',repo+':1:mine',{id:'mine',author:'owner',body:'缺少判空',entryId:'old'});let reads=0;
 const service=new GroupMrService(store,async args=>{assert.equal(args[3],'list');reads++;return{exitCode:0,output:JSON.stringify([note])};});
 try{await service['reconcileClosure'](e);assert.ok(e.writePending);note.resolved=true;await service['reconcileClosure'](e);assert.equal(e.writePending,'');assert.equal(store.getRecord<Entry>('group-mr-entry',e.id)?.writePending,'');assert.equal(reads,2);}finally{await service.close();store.close();}
});
