import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {JSDOM,VirtualConsole} from 'jsdom';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const response=(data,ok=true)=>({ok,status:ok?200:409,json:async()=>data,text:async()=>JSON.stringify(data)});
const flush=()=>new Promise(resolve=>setTimeout(resolve,30));
const url='https://codehub-y.huawei.com/MAE-M/FMEMate/FMEMateService/merge_requests/1756';
async function fixture(t,{config:overrides={},submit,records=[]}={}){
 const config={enabled:false,groupId:'',authorizedSender:'w00789509',repositoryPrefix:'MAE-M/Access/',intervalSeconds:10,humanReviewEnabled:false,...overrides},writes=[],errors=[];
 const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(html,{runScripts:'dangerously',url:'http://localhost/#/automation/group-mr',virtualConsole,beforeParse(w){
  w.scrollTo=()=>{};const timeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>ms>500?0:timeout(fn,ms,...args);
  w.fetch=async(path,options)=>{
   if(path==='/api/automation/group-mr/submit'){
    const body=JSON.parse(options.body);writes.push({path,body});if(submit)return submit(body);
    const entry={id:'manual-1',source:'manual',notificationReceiver:config.authorizedSender,repo:'MAE-M/FMEMate/FMEMateService',iid:'1756',url,phase:'PI',running:true,events:[],status:'Agent 正在检视'};records.push(entry);return response({entryId:entry.id,duplicate:false});
   }
   if(path==='/api/automation/group-mr/config'&&options?.method==='PUT'){const body=JSON.parse(options.body);writes.push({path,body});Object.assign(config,body);return response({...config});}
   if(['/api/automation/group-mr','/api/automation/group-mr/status'].includes(path))return response({config:{...config},pending:records,history:[],metrics:{pending:records.length,issues:0,mergedToday:0},monitor:{}});
   if(path==='/api/automation/knowledge')return response({items:[],reviews:[]});
   if(path.startsWith('/api/automation/effectiveness'))return response({total:0,stages:{},reviews:0,merged:0,anomalies:0,rejected:0});
   return response([]);
  };
 }});
 t.after(()=>dom.window.close());await flush();return {dom,w:dom.window,d:dom.window.document,writes,config,errors};
}
function input(s,value){const field=s.d.querySelector('#manual-mr-url');field.value=value;field.dispatchEvent(new s.w.Event('input',{bubbles:true}));return field;}
function submit(s){s.d.querySelector('[data-group-mr-submit-form]').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));}

test('manual MR submits without group configuration or enabled listener, outside group prefix, then opens its record',async t=>{
 const s=await fixture(t);assert.equal(s.d.querySelector('[data-group-mr-submit-form] button[type=submit]').disabled,false);
 assert.match(s.d.querySelector('[data-group-mr-submit-form]').textContent,/不自动合入/);
 const copied=url+'/?tab=files#discussion';input(s,' '+copied+' ');submit(s);await flush();
 assert.deepEqual(s.writes,[{path:'/api/automation/group-mr/submit',body:{url:copied}}]);
 assert.equal(s.d.querySelector('[data-mr-review-id]').dataset.mrReviewId,'manual-1');
 assert.match(s.d.querySelector('.group-mr-detail').textContent,/手动输入 MR 链接/);
 assert.match(s.d.querySelector('.group-mr-reply').textContent,/授权账号通知 · w00789509/);
 assert.doesNotMatch(s.d.querySelector('.group-mr-reply').textContent,/群消息回复|暂无已记录的回复/);
 assert.equal(s.d.querySelector('.group-mr-flow li b').textContent,'手动提交');assert.deepEqual(s.errors,[]);
});

test('pending submit blocks duplicate posts; failed response retains input and never retries automatically',async t=>{
 let complete;const s=await fixture(t,{submit:()=>new Promise(resolve=>complete=resolve)});
 input(s,url);submit(s);submit(s);await s.w.eval('submitManualGroupMr()');
 assert.equal(s.writes.length,1);assert.equal(s.d.querySelector('[data-group-mr-submit-form] button[type=submit]').disabled,true);
 await s.w.eval('loadGroupMr()');assert.equal(s.writes.length,1);
 complete(response({message:'同一 MR 群组任务正在执行'},false));await flush();
 assert.equal(s.d.querySelector('#manual-mr-url').value,url);assert.match(s.d.querySelector('#manual-mr-error').textContent,/同一 MR 群组任务正在执行/);
 await s.w.eval('loadGroupMr()');await flush();assert.equal(s.writes.length,1);assert.deepEqual(s.errors,[]);
});

test('manual MR accepts a copied diffs tab URL and submits it once',async t=>{
 const s=await fixture(t),copied=url+'/diffs/?diff_id=42#note_123';
 input(s,copied);submit(s);submit(s);await flush();
 assert.deepEqual(s.writes,[{path:'/api/automation/group-mr/submit',body:{url:copied}}]);
 assert.equal(s.d.querySelector('[data-mr-review-id]').dataset.mrReviewId,'manual-1');
 assert.deepEqual(s.errors,[]);
});

test('manual form rejects unrelated domains, multiple URLs and invalid repository paths before creating tasks',async t=>{
 const s=await fixture(t);
 for(const value of ['https://example.com/a/b/merge_requests/1',url+' '+url,'https://codehub-y.huawei.com/a/../b/merge_requests/1','https://codehub-y.huawei.com/a//b/merge_requests/1','https://codehub-y.huawei.com/a/b/merge_requests/0',url+'/diffs-extra',url+'/diffs/other',url+'/files']){
  input(s,value);submit(s);await flush();assert.match(s.d.querySelector('#manual-mr-error').textContent,/完整的 CodeHub MR 链接/);
 }
 assert.equal(s.writes.length,0);assert.deepEqual(s.errors,[]);
});

test('polling preserves the focused manual input, selection and draft; other renders also retain the draft',async t=>{
 const s=await fixture(t),field=input(s,url);field.focus();field.setSelectionRange(10,22);
 await s.w.eval('loadGroupMr()');assert.equal(s.d.querySelector('#manual-mr-url'),field);assert.equal(s.d.activeElement,field);assert.equal(field.selectionStart,10);assert.equal(field.selectionEnd,22);
 field.blur();await s.w.eval('loadGroupMr()');assert.equal(s.d.querySelector('#manual-mr-url').value,url);
 s.d.querySelector('[data-group-mr-config]').click();s.d.querySelector('[data-group-mr-config-back]').click();assert.equal(s.d.querySelector('#manual-mr-url').value,url);assert.deepEqual(s.errors,[]);
});

test('authorization account can be configured without a group; group ID is required only while monitoring is enabled',async t=>{
 const s=await fixture(t,{config:{authorizedSender:''}});
 assert.equal(s.d.querySelector('[data-group-mr-submit-form] button[type=submit]').disabled,true);assert.match(s.d.querySelector('[data-group-mr-submit-form]').textContent,/先配置/);
 s.d.querySelector('[data-group-mr-submit-form] [data-group-mr-config]').click();assert.equal(s.d.querySelector('[name=groupId]').required,false);
 const account=s.d.querySelector('[name=authorizedSender]');account.value='w12345';account.dispatchEvent(new s.w.Event('input',{bubbles:true}));
 s.d.querySelector('#group-mr-form').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await flush();
 assert.equal(s.writes[0].body.groupId,'');assert.equal(s.writes[0].body.authorizedSender,'w12345');assert.equal(s.d.querySelector('[data-group-mr-submit-form] button[type=submit]').disabled,false);
 s.w.eval('groupMrUi.config.enabled=true;openGroupMrConfig()');assert.equal(s.d.querySelector('[name=groupId]').required,true);assert.deepEqual(s.errors,[]);
});

test('duplicate accepted submission opens the existing task; private notification failures stay visible without group recovery controls',async t=>{
 const row={id:'existing',repo:'MAE-M/FMEMate/FMEMateService',iid:'1756',url,source:'manual',phase:'ISSUES',events:[],notificationReceiver:'w12345',notification:{receiver:'w12345',status:'unconfirmed'}};
 const s=await fixture(t,{records:[row],submit:()=>response({entryId:'existing',duplicate:true})});
 input(s,url);submit(s);await flush();assert.equal(s.writes.length,1);assert.equal(s.d.querySelector('[data-mr-review-id]').dataset.mrReviewId,'existing');
 assert.match(s.d.querySelector('.group-mr-reply').textContent,/私聊通知结果待核对/);assert.match(s.d.querySelector('.group-mr-reply').textContent,/w12345/);assert.equal(s.d.querySelector('[data-group-mr-action="ack"]'),null);assert.deepEqual(s.errors,[]);
});
