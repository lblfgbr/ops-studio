import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {JSDOM} from 'jsdom'

const html=await readFile(new URL('../index.html',import.meta.url),'utf8'),sha='a'.repeat(40)
const flush=()=>new Promise(resolve=>setTimeout(resolve,35))
const row=id=>({id,repo:'MAE-M/Access/Demo',iid:id,sha,phase:'FAILED',status:'CLI 能力未确认',writePending:'',source:'group',humanReviewRequired:true,events:[],reviewComments:[],pipelinePassed:false})
const response=(data,status=200)=>({ok:status<400,status,json:async()=>structuredClone(data)})
async function setup(t,{holdWorkspace=false}={}){
 const records=[row('1'),row('2')],calls=[],workspaceReads=[];let releaseRetry,releaseWorkspace
 const snapshot=()=>({config:{enabled:false},pending:records,history:[],monitor:{},metrics:{pending:records.length}})
 const dom=new JSDOM(html,{runScripts:'dangerously',url:'http://localhost/#/automation/group-mr',beforeParse(w){
  w.scrollTo=()=>{};const timeout=w.setTimeout.bind(w);w.setTimeout=(fn,delay,...args)=>delay>500?0:timeout(fn,delay,...args)
  w.fetch=async(url,options)=>{
   if(options?.method==='POST'){calls.push({url,body:JSON.parse(options.body)});return new Promise(resolve=>{releaseRetry=(status=202)=>{if(status>=400){resolve(response({message:'服务连接中断'},status));return;}const old=records[0];records[0]={...old,id:'retry-1',phase:'QUEUED',queued:true,status:'等待重新执行',attempts:[old]};resolve(response({entryId:'retry-1',duplicate:false},202));};});}
   if(['/api/automation/group-mr','/api/automation/group-mr/status'].includes(url))return response(snapshot())
   if(url.endsWith('/workspace')){workspaceReads.push(url);const data={sha,state:'opened',files:[],threads:[],writePending:'',capabilities:{},readiness:{sha,checkedAt:new Date().toISOString(),ready:false,reason:'待检视'}};return holdWorkspace?new Promise(resolve=>{releaseWorkspace=()=>resolve(response(data));}):response(data)}
   if(url==='/api/automation/knowledge')return response({items:[],reviews:[]})
   if(url.startsWith('/api/automation/effectiveness'))return response({total:0,stages:{},reviews:0,merged:0,anomalies:0,rejected:0})
   return response([])
  }
 }})
 t.after(async()=>{releaseWorkspace?.();releaseRetry?.(503);await flush();dom.window.close()})
 for(let i=0;i<20&&!dom.window.document.querySelector('[data-group-mr-record]');i++)await flush()
 return {dom,d:dom.window.document,records,calls,workspaceReads,accept:status=>releaseRetry(status),finishRead:()=>releaseWorkspace()}
}
const retry=(d,id='1')=>d.querySelector('[data-group-mr-action="retry"][data-record-id="'+id+'"]')
async function back(d){d.querySelector('[data-mrw-focus]').click();for(let i=0;i<20&&!d.querySelector('.nav-list');i++)await flush();assert.ok(d.querySelector('.nav-list'))}

test('manual retry is per MR, accepted asynchronously, and moves focus to the successor',async t=>{
 const {dom,d,calls,accept,records,workspaceReads}=await setup(t)
 d.querySelector('.nav-enter[data-mr-open="1"]').click();await flush()
 assert.ok(d.querySelector('.nav-review-top [data-group-mr-action="retry"]'))
 retry(d).click();retry(d).click();assert.equal(d.querySelectorAll('[data-studio-confirm]').length,1)
 d.querySelector('[data-studio-confirm]').click();await flush()
 assert.equal(calls.length,1);assert.match(calls[0].url,/\/records\/1\/retry$/);assert.deepEqual(calls[0].body,{sha})
 assert.equal(retry(d).disabled,true);assert.equal(retry(d).textContent,'提交中…');assert.equal(d.querySelector('[data-mrw-focus]').disabled,false)
 await back(d);assert.equal(retry(d,'2').disabled,false)
 d.querySelector('.nav-enter[data-mr-open="1"]').click();await flush();accept();await flush();await flush()
 assert.equal(dom.window.eval('groupMrUi.selected'),'retry-1');assert.ok(d.querySelector('[data-mr-review-id="retry-1"]'))
 assert.equal(calls.length,1);assert.equal(dom.window.history.state.groupMrReview,'retry-1')
 records[0].phase='ISSUES';records[0].queued=false;await dom.window.eval('loadGroupMr()');await flush();assert.ok(workspaceReads.some(url=>url.includes('/retry-1/workspace')))
 await back(d);assert.ok(d.querySelector('[data-group-mr-record="retry-1"]'));assert.equal(d.querySelector('.nav-enter').textContent,'查看代码')
})

test('retry cancellation and response loss do not automatically send another retry',async t=>{
 const {dom,d,calls,accept}=await setup(t)
 retry(d).click();d.querySelector('[data-studio-cancel]').click();await flush();assert.equal(calls.length,0)
 retry(d).click();d.querySelector('[data-studio-confirm]').click();await flush();accept(503);await flush();await flush()
 assert.equal(calls.length,1);assert.equal(retry(d).disabled,false)
 assert.match(d.body.textContent,/重新执行未确认/);await dom.window.eval('loadGroupMr()');assert.equal(calls.length,1)
})

test('pending detail read allows immediate exit and reentry without duplicate requests or lost drafts',async t=>{
 const {dom,d,workspaceReads,finishRead}=await setup(t,{holdWorkspace:true})
 d.querySelector('.nav-enter[data-mr-open="1"]').click();await flush()
 dom.window.eval('mrDraft("1").reply={body:"保留草稿"}')
 for(let i=0;i<2;i++){await back(d);const entry=d.querySelector('.nav-enter[data-mr-open="1"]');assert.equal(entry.disabled,false);entry.click();await flush();assert.ok(d.querySelector('[data-mr-review-id="1"]'))}
 assert.equal(workspaceReads.length,1);assert.equal(dom.window.eval('mrData("1").loading'),true)
 finishRead();await flush();assert.equal(dom.window.eval('mrData("1").loading'),false);assert.equal(dom.window.eval('mrDraft("1").reply.body'),'保留草稿')
})
