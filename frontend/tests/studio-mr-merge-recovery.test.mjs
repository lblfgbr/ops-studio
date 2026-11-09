import test from 'node:test';
import assert from 'node:assert/strict';
import {createStudio} from './helpers/studio-harness.mjs';

const sha='a'.repeat(40),nextSha='b'.repeat(40);
const response=value=>new Response(JSON.stringify(value));
async function setup({overrides={},onMerge,stale=false}={}){
  const record={id:'merge-recovery',repo:'Demo/Service',iid:'17',url:'https://codehub-y.huawei.com/Demo/Service/merge_requests/17',sha,phase:'ISSUES',stage:'MERGE',writePending:'合并',status:'上一次合并结果未确认，需人工核对后再处理',events:[],pipelinePassed:false,humanReviewRequired:true,...overrides};
  const writes=[];
  const s=await createStudio({route:'automation/group-mr',beforeParse(w){const fetch=w.fetch;w.fetch=async(url,options={})=>{
    const path=String(url);
    if(path.startsWith('/api/automation/group-mr')&&options.method==='POST'){
      writes.push({path,body:JSON.parse(options.body)});
      if(path.endsWith('/merge'))return response(await onMerge(record,writes.length));
      throw Error('Unexpected write: '+path);
    }
    if(['/api/automation/group-mr','/api/automation/group-mr/status'].includes(path)){
      const done=['DONE','CLOSED'].includes(record.phase);
      return response({config:{enabled:false,authorizedSender:'owner'},pending:done?[]:[record],history:done?[record]:[],monitor:{},metrics:{pending:done?0:1}});
    }
    if(path.endsWith('/merge-recovery/workspace'))return response({sha:stale?nextSha:sha,state:'opened',stale,writePending:record.writePending,files:[],threads:[],pipelinePassed:false,readiness:{sha:stale?nextSha:sha,checkedAt:'2020-01-01T00:00:00Z',ready:false,reason:'上次查询未通过'},capabilities:{create:true,reply:true}});
    return fetch(url,options);
  }}});
  return {...s,record,writes};
}
const primary='[data-group-mr-record="merge-recovery"] .nav-task-primary';
const top='.nav-review-top [data-group-mr-action="merge"]';
async function until(s,predicate){for(let i=0;i<50&&!predicate();i++)await s.wait(20);assert.ok(predicate(),'Expected UI transition');}

test('merge recovery retries only on explicit clicks and reuses the merge endpoint despite stale local gates',async t=>{
  let release;
  const s=await setup({stale:true,onMerge:async(r,n)=>{if(n===1){await new Promise(resolve=>{release=resolve});r.status='关联问题尚未修正，合入未完成';return r;}r.phase='DONE';r.writePending='';r.status='已合入';return r;}});t.after(s.close);
  assert.equal(s.find(primary).textContent,'重新合入');assert.equal(s.find(primary).disabled,false);
  assert.equal(s.d.querySelector('[data-group-mr-action="retry"]'),null);
  assert.doesNotMatch(s.find('[data-group-mr-record="merge-recovery"] .nav-task-hint').textContent,/去核对/);
  await s.click(primary);assert.match(s.find('.mr-panel-description').textContent,/修正 MR 关联.*复用已有检视与人工审核结果/);
  const submit=s.find('[data-mr-panel-submit]');submit.click();submit.click();await until(s,()=>!!release);
  assert.equal(s.writes.length,1);assert.equal(s.find('[data-mr-panel-submit]').disabled,true);
  assert.deepEqual(s.writes[0],{path:'/api/automation/group-mr/records/merge-recovery/merge',body:{sha,confirmed:true}});
  release();await until(s,()=>!!s.d.querySelector('[data-mr-panel-results]'));
  assert.match(s.find('.mr-action-drawer').textContent,/关联问题尚未修正/);
  assert.equal(s.find('[data-mr-panel-results]').textContent,'返回待处理');
  await s.click('[data-mr-panel-results]');assert.equal(s.find('[data-group-mr-tab="pending"]').getAttribute('aria-pressed'),'true');
  assert.equal(s.find(primary).textContent,'重新合入');assert.equal(s.find(primary).disabled,false);
  await s.click('.nav-enter[data-mr-open="merge-recovery"]');await until(s,()=>!s.find(top).disabled);
  assert.equal(s.find(top).textContent,'重新合入');assert.equal(s.d.querySelector('[data-group-mr-action="retry"]'),null);
  await s.click('[data-mr-records]');assert.equal(s.find('.nav-record-actions [data-group-mr-action="merge"]').textContent,'重新合入');
  assert.match(s.find('.group-mr-detail').textContent,/修正 MR 关联等问题后/);
  await s.click(top);await s.click('[data-mr-panel-submit]');await until(s,()=>!!s.d.querySelector('[data-mr-panel-results]'));
  assert.equal(s.writes.length,2);assert.ok(s.writes.every(w=>w.path.endsWith('/merge')));
  assert.match(s.find('.mr-complete-message').textContent,/1 条已合入/);
  await s.click('[data-mr-panel-results]');assert.equal(s.find('[data-group-mr-tab="history"]').getAttribute('aria-pressed'),'true');
  assert.deepEqual(s.errors,[]);
});

test('merge recovery displays a closed MR without claiming it was merged',async t=>{
  const s=await setup({onMerge:async r=>Object.assign(r,{phase:'CLOSED',status:'已确认远端 MR 已关闭'})});t.after(s.close);
  await s.click(primary);await s.click('[data-mr-panel-submit]');await until(s,()=>!!s.d.querySelector('[data-mr-panel-results]'));
  assert.match(s.find('.mr-target').textContent,/MR 已关闭，无需合入/);
  assert.match(s.find('.mr-complete-message').textContent,/0 条已合入，1 条已关闭/);
  await s.click('[data-mr-panel-results]');assert.equal(s.find('[data-group-mr-tab="history"]').getAttribute('aria-pressed'),'true');
  assert.equal(s.writes.length,1);assert.deepEqual(s.errors,[]);
});

test('merge recovery of a changed commit returns to pending with the ordinary review retry action',async t=>{
  const s=await setup({stale:true,onMerge:async r=>Object.assign(r,{writePending:'',phase:'ISSUES',status:'提交已变化，请重新检视当前提交'})});t.after(s.close);
  await s.click(primary);await s.click('[data-mr-panel-submit]');await until(s,()=>!!s.d.querySelector('[data-mr-panel-results]'));
  assert.match(s.find('.mr-action-drawer').textContent,/提交已变化，请重新检视/);
  await s.click('[data-mr-panel-results]');assert.equal(s.find('[data-group-mr-tab="pending"]').getAttribute('aria-pressed'),'true');
  assert.notEqual(s.find(primary).textContent,'重新合入');
  assert.equal(s.find('[data-group-mr-action="retry"]').textContent,'重新执行');
  assert.equal(s.writes.length,1);assert.deepEqual(s.errors,[]);
});

for(const overrides of [{running:true},{queued:true},{supersededBy:'next'},{workbenchMissing:true},{sha:''},{writePending:'审核'},{writePending:'群消息回复'}])test('merge recovery cannot bypass local operation exclusion: '+JSON.stringify(overrides),async t=>{
  const s=await setup({overrides,onMerge:async()=>{throw Error('Must not submit')}});t.after(s.close);
  assert.equal(s.w.eval("!groupMrActionReason(groupMrUi.pending[0],'merge')"),false);
  assert.equal(s.writes.length,0);assert.deepEqual(s.errors,[]);
});
