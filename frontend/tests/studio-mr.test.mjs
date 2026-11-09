import test from 'node:test';
import assert from 'node:assert/strict';
import {createStudio} from './helpers/studio-harness.mjs';

const writes=(s,tail)=>s.requests.filter(r=>r.method==='POST'&&r.path.endsWith(tail));
async function submit(s,selector){s.find(selector).dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await s.wait(100)}

test('production MR queue retains pagination/filter/selection and always-expanded stages',async t=>{
  const s=await createStudio({route:'automation/group-mr'});t.after(s.close);
  assert.equal(s.d.querySelectorAll('[data-group-mr-record]').length,10);
  await s.click('[data-mrw-page="1"]');assert.equal(s.find('[data-group-mr-record]').dataset.groupMrRecord,'11');
  await s.click('[data-mrw-page="-1"]');await s.input('#group-mr-search','access-core');await s.click('[data-group-mr-check="1"]');
  await s.click('.nav-enter[data-mr-open="1"]');assert.equal(s.d.querySelectorAll('[data-mrw-file]').length,4);
  assert.equal(s.d.querySelectorAll('.nav-flow-card>.group-mr-flow>li').length,8);assert.equal(s.find('.group-mr-flow').hidden,false);assert.equal(s.d.querySelector('[data-ux-flow]'),null);
  assert.match(s.find('.ux-process-current').textContent,/检视意见.*待确认/);
  await s.click('[data-mr-records]');assert.ok(s.d.querySelector('.nav-flow-records'));
  await s.click('[data-mr-records]');assert.equal(s.d.querySelector('.nav-flow-records'),null);assert.equal(s.find('.group-mr-flow').hidden,false);
  await s.click('[data-ux-focus]');assert.ok(s.d.body.classList.contains('ux-focus'));
  s.d.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await s.wait();assert.ok(!s.d.body.classList.contains('ux-focus'));
  await s.click('[data-mrw-focus]');assert.equal(s.find('#group-mr-search').value,'access-core');assert.ok(s.find('[data-group-mr-check="1"]').checked);
  assert.equal(s.requests.filter(r=>r.method!=='GET').length,0);assert.deepEqual(s.errors,[]);
});

test('production MR discussion reply/resolve and review continue the original automatic merge workflow once',async t=>{
  const s=await createStudio({route:'automation/group-mr'});t.after(s.close);
  await s.click('.nav-enter[data-mr-open="1"]');await s.click('[data-mrw-thread="thread-1"]');
  await s.input('[data-mrw-draft="thread-1"]','已补充异常路径断言');await submit(s,'[data-mrw-form]');
  assert.equal(writes(s,'/workspace').length,1);assert.equal(writes(s,'/workspace')[0].body.action,'reply');
  assert.match(s.find('.mr-inline-note').textContent,/已补充异常路径断言/);
  await s.click('[data-mrw-resolve="thread-1"]');await s.input('[data-mrw-draft="thread-1"]','已核对当前提交');await submit(s,'[data-mrw-form]');
  const resolve=writes(s,'/workspace')[1];assert.equal(resolve.body.action,'resolve');assert.equal(resolve.body.confirmed,true);assert.equal(resolve.body.sha,'a'.repeat(40));assert.ok(resolve.body.operationId);assert.ok(s.d.querySelector('.mr-inline-note.resolved'));
  await s.click('.nav-review-top [data-group-mr-action="review"]');await s.wait(100);await s.w.eval('loadGroupMr()');
  assert.equal(writes(s,'/review-jobs').length,1);assert.equal(writes(s,'/review-jobs')[0].body.decision,'pass');
  assert.equal(s.find('.nav-review-top [data-group-mr-action="merge"]').disabled,true);
  assert.match(s.find('.nav-review-top [data-group-mr-action="merge"]').textContent,/合入处理中/);
  assert.equal(s.d.querySelector('.nav-review-top [data-group-mr-action="review"]'),null);
  await s.wait(450);await s.click('[data-mr-records]');await s.click('[data-mr-refresh-records]');await s.wait(100);
  assert.equal(s.find('.nav-review-top [data-group-mr-action="merge"]').textContent,'已合入');
  assert.equal(s.find('.nav-review-top [data-group-mr-action="merge"]').disabled,true);
  assert.match(s.find('[data-mr-review-feedback]').textContent,/已合入/);
  assert.equal(writes(s,'/merge').length,0,'The existing backend workflow merges; the UI must not issue an extra merge');
  await s.click('[data-mrw-focus]');assert.equal(s.d.querySelector('[data-group-mr-record="1"]'),null);
  await s.click('[data-group-mr-tab="history"]');assert.ok(s.find('[data-group-mr-record="1"]'));
  assert.deepEqual(s.errors,[]);
});

test('production MR rejected discussion write keeps the draft and never replays it',async t=>{
  let attempts=0;
  const s=await createStudio({route:'automation/group-mr',beforeParse(w){const fetch=w.fetch;w.fetch=(url,options={})=>{
    if(String(url).endsWith('/workspace')&&options.method==='POST'){attempts++;return Promise.resolve(new Response(JSON.stringify({message:'写入结果未确认，请先核对远端'}),{status:503}))}
    return fetch(url,options);
  }}});t.after(s.close);
  await s.click('.nav-enter[data-mr-open="1"]');await s.click('[data-mrw-thread="thread-1"]');await s.input('[data-mrw-draft="thread-1"]','保留未确认草稿');await submit(s,'[data-mrw-form]');
  assert.equal(attempts,1);assert.equal(s.find('[data-mrw-draft="thread-1"]').value,'保留未确认草稿');assert.match(s.d.body.textContent,/写入结果未确认/);
  await s.click('[data-ux-density]');await s.click('[data-ux-focus]');await s.wait(150);assert.equal(attempts,1);assert.deepEqual(s.errors,[]);
});

test('production MR batch merge stops after an uncertain response and preserves confirmation',async t=>{
  const attempts=[];
  const s=await createStudio({route:'automation/group-mr',beforeParse(w){const fetch=w.fetch;w.fetch=(url,options={})=>{
    if(String(url).endsWith('/merge')&&options.method==='POST'){attempts.push(String(url));return Promise.resolve(new Response(JSON.stringify({message:'合入结果未知，请人工核对'}),{status:503}))}
    return fetch(url,options);
  }}});t.after(s.close);
  await s.click('[data-group-mr-check="3"]');await s.click('[data-group-mr-check="9"]');await s.click('.mr-batch-bar [data-group-mr-action="merge"]');assert.equal(attempts.length,0);
  await s.click('[data-mr-panel-submit]');await s.wait(100);assert.equal(attempts.length,1);assert.match(s.find('.mr-action-drawer').textContent,/尚未执行/);
  await s.click('[data-ux-density]');await s.wait(150);assert.equal(attempts.length,1);assert.deepEqual(s.errors,[]);
});

test('production MR remote SHA change prevents stale drafts from being submitted',async t=>{
  let changed=false,attempts=0;
  const s=await createStudio({route:'automation/group-mr',beforeParse(w){const fetch=w.fetch;w.fetch=async(url,options={})=>{
    if(String(url).endsWith('/workspace')&&options.method==='POST')attempts++;
    const response=await fetch(url,options);
    if(changed&&['/api/automation/group-mr','/api/automation/group-mr/status'].includes(String(url))){
      const data=await response.json();data.pending.find(r=>r.id==='1').sha='b'.repeat(40);return new Response(JSON.stringify(data));
    }
    return response;
  }}});t.after(s.close);
  await s.click('.nav-enter[data-mr-open="1"]');await s.click('[data-mrw-resolve="thread-1"]');await s.input('[data-mrw-draft="thread-1"]','旧提交核对结论');
  changed=true;await s.click('[data-mr-records]');await s.click('.nav-flow-records [data-mr-refresh-records]');await s.wait(100);
  assert.equal(s.d.querySelector('[data-mrw-form]'),null);assert.equal(s.find('[data-mrw-resolve="thread-1"]').disabled,true);assert.match(s.d.body.textContent,/提交已变化/);assert.equal(attempts,0);assert.deepEqual(s.errors,[]);
});


test('production MR list replaces one-click review with processing and moves automatic completion into history',async t=>{
  const s=await createStudio({route:'automation/group-mr',beforeParse(w){
    const timeout=w.setTimeout.bind(w);w.setTimeout=(fn,delay,...args)=>timeout(fn,[3000,10000].includes(delay)?100:delay,...args);
  }});t.after(s.close);
  const review=s.find('[data-group-mr-record="2"] [data-group-mr-action="review"]');review.click();review.click();await s.wait(130);await s.w.eval('loadGroupMr()');
  assert.equal(writes(s,'/review-jobs').length,1);
  assert.equal(s.d.querySelector('[data-group-mr-record="2"] [data-group-mr-action="review"]'),null);
  assert.match(s.find('[data-group-mr-record="2"]').textContent,/后台继续核对门禁与合入/);
  await s.wait(550);
  assert.equal(s.d.querySelector('[data-group-mr-record="2"]'),null);
  assert.match(s.find('[data-mr-review-feedback]').textContent,/已合入/);
  await s.click('[data-group-mr-tab="history"]');assert.match(s.find('[data-group-mr-record="2"]').textContent,/检视、审核与合并已完成/);
  assert.equal(writes(s,'/merge').length,0);assert.deepEqual(s.errors,[]);
});

test('production MR already reviewed list and detail expose confirmed merge without opening processing records',async t=>{
  const s=await createStudio({route:'automation/group-mr'});t.after(s.close);
  assert.equal(s.find('[data-group-mr-record="3"] .nav-task-primary').dataset.groupMrAction,'merge');
  await s.click('[data-group-mr-record="3"] .nav-task-primary');assert.equal(writes(s,'/merge').length,0);
  await s.click('[data-mr-panel-close]');await s.click('.nav-enter[data-mr-open="3"]');
  assert.equal(s.d.querySelector('.nav-review-top [data-group-mr-action="review"]'),null);
  const merge=s.find('.nav-review-top [data-group-mr-action="merge"]');assert.equal(merge.disabled,false);assert.equal(merge.textContent,'合入');
  await s.click('.nav-review-top [data-group-mr-action="merge"]');assert.equal(writes(s,'/merge').length,0);
  const confirm=s.find('[data-mr-panel-submit]');confirm.click();confirm.click();await s.wait(100);
  assert.equal(writes(s,'/merge').length,1);assert.deepEqual(JSON.parse(JSON.stringify(writes(s,'/merge')[0].body)),{sha:'a'.repeat(40),confirmed:true});
  await s.click('[data-mr-panel-results]');assert.ok(s.find('[data-group-mr-record="3"]'));assert.equal(s.find('[data-group-mr-tab="history"]').getAttribute('aria-pressed'),'true');
  assert.equal(writes(s,'/review-jobs').length,0);assert.deepEqual(s.errors,[]);
});

test('production MR accepted review job stays non-repeatable when the following status read fails',async t=>{
  let reviewed=false;
  const s=await createStudio({route:'automation/group-mr',beforeParse(w){const fetch=w.fetch;w.fetch=async(url,options={})=>{
    if(reviewed&&['/api/automation/group-mr','/api/automation/group-mr/status'].includes(String(url)))return new Response(JSON.stringify({message:'状态服务暂不可用'}),{status:503});
    const response=await fetch(url,options);
    if(String(url).endsWith('/review-jobs')&&options.method==='POST'&&response.ok)reviewed=true;
    return response;
  }}});t.after(s.close);
  await s.click('.nav-enter[data-mr-open="2"]');await s.click('.nav-review-top [data-group-mr-action="review"]');await s.wait(120);
  assert.equal(writes(s,'/review-jobs').length,1);assert.match(s.d.body.textContent,/状态服务暂不可用/);
  assert.equal(s.find('.nav-review-top [data-group-mr-action="review"]').disabled,true);
  assert.equal(s.d.querySelector('.nav-review-top [data-group-mr-action="merge"]'),null);
  assert.match(s.find('[data-mr-review-feedback]').textContent,/已提交|已受理/);
  await s.click('[data-mrw-focus]');assert.equal(s.d.querySelector('[data-group-mr-record="2"] [data-group-mr-action="review"]:not(:disabled)'),null);
  await s.wait(450);assert.equal(writes(s,'/review-jobs').length,1);assert.equal(writes(s,'/merge').length,0);assert.deepEqual(s.errors,[]);
});

test('production MR unconfirmed review does not claim approval or automatically submit another write',async t=>{
  let attempts=0;
  const s=await createStudio({route:'automation/group-mr',beforeParse(w){const fetch=w.fetch;w.fetch=async(url,options={})=>{
    if(String(url).endsWith('/review-jobs')&&options.method==='POST'){attempts++;return new Response(JSON.stringify({message:'审核写入结果未确认，请人工核对'}),{status:503});}
    return fetch(url,options);
  }}});t.after(s.close);
  await s.click('.nav-enter[data-mr-open="2"]');await s.click('.nav-review-top [data-group-mr-action="review"]');await s.wait(120);
  assert.equal(attempts,1);assert.match(s.find('[data-mr-review-feedback]').textContent,/结果未确认|结果待核对|结果不明/);
  assert.equal(s.d.querySelector('.nav-review-top [data-group-mr-action="merge"]'),null);
  await s.click('[data-mrw-focus]');assert.equal(s.find('[data-group-mr-record="2"] .nav-task-primary').dataset.groupMrAction,'review');
  await s.wait(450);assert.equal(attempts,1);assert.equal(writes(s,'/merge').length,0);assert.deepEqual(s.errors,[]);
});

test('production MR blocks stale normal merges and other writes but permits explicit merge recovery',async t=>{
  for(const scenario of ['pipeline','merge-pending','approval-pending','sha']){
    const s=await createStudio({route:'automation/group-mr',beforeParse(w){const fetch=w.fetch;w.fetch=async(url,options={})=>{
      const response=await fetch(url,options);const path=String(url);
      if(['/api/automation/group-mr','/api/automation/group-mr/status'].includes(path)){
        const data=await response.json(),r=data.pending.find(r=>r.id==='3');
        if(scenario==='pipeline'){r.pipelinePassed=false;r.readiness.ready=false;r.readiness.reason='当前提交流水线尚未通过';}
        if(scenario==='merge-pending')r.writePending='合并';
        if(scenario==='approval-pending')r.writePending='审核';
        if(scenario==='sha')r.sha='b'.repeat(40);
        return new Response(JSON.stringify(data));
      }
      if(path.endsWith('/3/workspace')&&scenario==='pipeline'){
        const data=await response.json();data.pipelinePassed=false;data.readiness.ready=false;data.readiness.reason='当前提交流水线尚未通过';return new Response(JSON.stringify(data));
      }
      return response;
    }}});t.after(s.close);
    const listMerge=s.d.querySelector('[data-group-mr-record="3"] [data-group-mr-action="merge"]:not(:disabled)');
    if(scenario==='merge-pending'){assert.ok(listMerge);assert.equal(listMerge.textContent,'重新合入');}else assert.equal(listMerge,null,scenario);
    await s.click('.nav-enter[data-mr-open="3"]');
    const detailAction=s.d.querySelector('.nav-review-top [data-group-mr-action]:not(:disabled)');
    if(scenario==='merge-pending'){assert.ok(detailAction);assert.equal(detailAction.dataset.groupMrAction,'merge');assert.equal(detailAction.textContent,'重新合入');assert.equal(s.w.eval('mrSelected().writePending'),'合并');}
    else assert.equal(detailAction,null,scenario);
    assert.equal(s.requests.filter(r=>r.method!=='GET').length,0);assert.deepEqual(s.errors,[]);
    s.close();
  }
});
