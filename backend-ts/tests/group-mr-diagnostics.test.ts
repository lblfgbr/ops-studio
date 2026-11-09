import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {codehubParameterErrorHint,responseDiagnostic} from '../src/modules/automation/group-mr-diagnostics.js';
import {GroupMrService} from '../src/modules/automation/group-mr.js';
import {TaskStore} from '../src/platform/store.js';
import {FileLogs} from '../src/infrastructure/file-logs.js';

test('CodeHub review errors explain the required severity without exposing CLI output',()=>{
 const output="error: categories_and_modules_enabled is true, required: --severity. Run 'codehub-cli setting review-config' to see available values";
 assert.equal(codehubParameterErrorHint(output),'缺少检视意见必填参数 --severity；请执行 codehub-cli setting review-config 查看仓库检视配置');
 const hint=codehubParameterErrorHint(output+'\nAuthorization: Bearer private-token\nbody: private-review-comment');
 assert.equal(hint,codehubParameterErrorHint(output));assert.doesNotMatch(hint!,/private-|Authorization|body/);
});

test('CodeHub review parameter hints handle only the allowed missing and invalid flags',()=>{
 for(const flag of ['severity','review-category','review-module']){
  for(const output of [`Error: required flag(s) "${flag}" not set`,`error: missing required parameter --${flag}`,`error: --${flag} is required`]){
   const hint=codehubParameterErrorHint(output);assert.ok(hint,output);assert.match(hint,/缺少检视意见必填参数/);assert.ok(hint.includes('--'+flag));
  }
  for(const output of [`error: invalid ${flag}: private-value`,`error: invalid value "private-value" for "--${flag}": invalid choice`,`error: --${flag} must be one of private-values`]){
   const hint=codehubParameterErrorHint(output);assert.ok(hint,output);assert.match(hint,/的值无效/);assert.ok(hint.includes('--'+flag));assert.doesNotMatch(hint,/private-/);
  }
 }
 const hint=codehubParameterErrorHint('error: required: --severity, --review-category, --review-module, --private-flag.');
 assert.ok(hint?.includes('--severity、--review-category、--review-module'));assert.doesNotMatch(hint!,/private-/);
});

test('CodeHub review parameter hints leave unrelated errors and response bodies unchanged',()=>{
 for(const output of ['error: permission denied','error: required: --token','error: required: --severity-secret','error: invalid value for --severity-secret: private-value',JSON.stringify({body:'error: required: --severity',token:'private-token'}),'Usage: --severity is required','error: request failed: private-comment']){
  assert.equal(codehubParameterErrorHint(output),undefined,output);
 }
});

test('MR comment parameter failures show a safe reason, log it and never retry the write',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mr-parameter-error-')),store=new TaskStore(':memory:');let calls=0;
 const output="error: categories_and_modules_enabled is true, required: --severity. Run 'codehub-cli setting review-config' to see available values\nAuthorization: Bearer private-token\nbody: private-review-comment login failed";
 const service=new GroupMrService(store,async()=>{calls++;return{exitCode:1,output};},new FileLogs(root));
 try{
  await assert.rejects(service['command'](['codehub-cli','mr','review','create','643','--body','private-review-comment','--token','private-token']),error=>{
   assert.ok(error instanceof Error);assert.match(error.message,/退出码 1；缺少检视意见必填参数 --severity/);assert.doesNotMatch(error.message,/private-|Bearer|login failed/);return true;
  });
  assert.equal(calls,1);
  const content=readFileSync(join(root,'automation','group-mr-errors.jsonl'),'utf8');
  assert.match(content,/缺少检视意见必填参数 --severity/);assert.doesNotMatch(content,/private-|Bearer|login failed/);
  assert.match(content,/"parameterError":"缺少检视意见必填参数 --severity/);
 }finally{await service.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('successful MR command output is never treated as a parameter error',async()=>{
 const store=new TaskStore(':memory:');const output='error: required: --severity';let calls=0;
 const service=new GroupMrService(store,async()=>{calls++;return{exitCode:0,output};});
 try{assert.equal(await service['command'](['codehub-cli','mr','review','create','643']),output);assert.equal(calls,1);}
 finally{await service.close();store.close();}
});

test('MR response diagnostics keep nested shapes and statuses without credentials or contents',()=>{
 const value=responseDiagnostic(JSON.stringify({result:{discussions:[{id:17,status:'failed',body:'private comment',author:{username:'private-user'},token:'private-token',diff:'private-code'}]},resultCode:401}));
 const text=JSON.stringify(value);assert.match(text,/discussions/);assert.match(text,/failed/);assert.match(text,/401/);assert.doesNotMatch(text,/private-/);
 assert.equal(responseDiagnostic('<html>private-password</html>').format,'html');assert.doesNotMatch(JSON.stringify(responseDiagnostic('Authorization: Bearer private-token')),/private-token|Bearer/);
});

test('MR response diagnostics retain only fixed reviewer status values',()=>{
 for(const state of ['true','approve','optional','required','approved','reviewed','passed','reject']){
  assert.deepEqual(responseDiagnostic(JSON.stringify({state,status:state})).values,[{state,status:state}]);
 }
 const value=responseDiagnostic(JSON.stringify({state:'private-review-status',status:'private-user-status',username:'approved',body:'optional',token:'true',authorization:{state:'approve'},credentials:{status:'reviewed'},private_key:'passed'}));
 assert.deepEqual(value.values,[{state:'string',status:'string',username:'string',body:'string',token:'[REDACTED]',authorization:'[REDACTED]',credentials:'[REDACTED]',private_key:'[REDACTED]'}]);
 assert.doesNotMatch(JSON.stringify(value),/private-review-status|private-user-status/);
});

test('MR response diagnostics retain only allowlisted boolean gate results',()=>{
 const flags=['ci_state_passed','conflict_passed','approval_reviewers_required_passed','approval_approvers_required_passed','merge_gate_passed'];
 for(const passed of [true,false]){
  const gate=Object.fromEntries(flags.map(key=>[key,passed]));
  assert.deepEqual(responseDiagnostic(JSON.stringify({gate})).values,[{gate}]);
 }
 const value=responseDiagnostic(JSON.stringify({ci_state_passed:'true',merge_gate_passed:'private-gate-value',approved:true,reviewed:false,passed:true,password:true,secret:false,token:{merge_gate_passed:true}}));
 assert.deepEqual(value.values,[{ci_state_passed:'string',merge_gate_passed:'string',approved:'boolean',reviewed:'boolean',passed:'boolean',password:'[REDACTED]',secret:'[REDACTED]',token:'[REDACTED]'}]);
 assert.doesNotMatch(JSON.stringify(value),/private-gate-value/);
});

test('list parse failure writes a dedicated error file with MR context and precise command',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mr-errors-')),store=new TaskStore(':memory:');const service=new GroupMrService(store,async args=>{
  let value:unknown={};if(args[1]==='mr'&&args[2]==='view')value={iid:444,state:'opened',sha:'a'.repeat(40)};
  if(args[1]==='user')value={username:'reviewer'};
  if(args[2]==='review')value={result:{discussions:[{id:1,body:'sensitive-comment',token:'sensitive-token'}]}};
  if(args[2]==='send-to-group')value={resultCode:0};return{exitCode:0,output:JSON.stringify(value)};
 },new FileLogs(root));
 try{
  await service['accept']({id:'1',sender:'other',content:'https://codehub-y.huawei.com/MAE-M/Access/Demo/merge_requests/444',quoteId:''},{enabled:true,groupId:'123456789',authorizedSender:'owner',repositoryPrefix:'MAE-M/Access/',intervalSeconds:5});
  const content=readFileSync(join(root,'automation','group-mr-errors.jsonl'),'utf8');assert.match(content,/codehub-cli mr review list/);assert.match(content,/discussions/);assert.match(content,/检视意见缺少/);assert.match(content,/aaaaaaaa/);assert.doesNotMatch(content,/sensitive-/);assert.match(service.list()[0]!.status,/codehub-cli mr review list/);
  const records=content.trim().split('\n').map(line=>JSON.parse(line));const failure=records.find(r=>r.source==='mr-processing');assert.ok(failure);assert.ok(failure.stack.some((frame:string)=>frame.includes('reviewThreads')));assert.ok(failure.trace.some((event:{diagnostic:{command:string}})=>event.diagnostic.command==='codehub-cli mr view'));assert.equal(failure.diagnostic.attempt,1);assert.equal(failure.diagnostic.timeoutMs,120000);assert.equal(typeof failure.diagnostic.elapsedMs,'number');assert.equal(failure.platform,process.platform);
 }finally{await service.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('MR commands request larger capture and reject truncated JSON even when its prefix parses',async()=>{
 const store=new TaskStore(':memory:');let limit:number|undefined;
 const service=new GroupMrService(store,async (_args,_cwd,_timeout,_log,_line,_input,_signal,maxCaptureChars)=>{
  limit=maxCaptureChars;return {exitCode:0,output:'[]',outputTruncated:true,outputChars:9000000};
 });
 try{
  await assert.rejects(service['command'](['codehub-cli','mr','review','list','--format','json']),/输出超过.*已截断/);
  assert.equal(limit,8*1024*1024);
 }finally{await service.close();store.close();}
});
