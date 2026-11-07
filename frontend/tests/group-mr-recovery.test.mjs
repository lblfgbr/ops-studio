import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {JSDOM} from 'jsdom'

const html=await readFile(new URL('../index.html',import.meta.url),'utf8')
const sha='a'.repeat(40),flush=()=>new Promise(resolve=>setTimeout(resolve,30))
async function setup(t,{running=false,failRefresh=false}={}){
 const record={id:'restart',repo:'Demo/Service',iid:'1',sha,phase:running?'PI':'INTERRUPTED',stage:'PI',running,writePending:'Pi 提交检视意见',status:running?'Agent 正在全量检视当前提交':'服务重启，原执行中断，请重新发送 MR 链接',events:[],readiness:{sha,checkedAt:'2026-10-25T01:00:00Z',ready:false,reason:'仍有未关闭的检视意见'},pipelinePassed:true}
 const threads=[{id:'note',body:'核对异常路径',path:'src/a.ts',line:1,resolved:false,resolvable:true,notes:[]}]
 const writes=[],reads=[]
 const response=(data,ok=true)=>({ok,status:ok?200:409,json:async()=>structuredClone(data)})
 const dom=new JSDOM(html,{runScripts:'dangerously',url:'http://localhost/#/automation/group-mr',beforeParse(w){
  w.scrollTo=()=>{};const timeout=w.setTimeout.bind(w);w.setTimeout=(fn,delay,...args)=>delay>500?0:timeout(fn,delay,...args)
  w.fetch=async(url,options)=>{
   if(options?.method==='POST'){
    writes.push({url,body:JSON.parse(options.body)})
    if(url.endsWith('/acknowledge-pi')){record.writePending='';record.status='已人工核对 Agent 提交结果，拦截已解除；请重新发送 MR 链接继续检视';return response({ok:true})}
    return response({message:'不应自动继续或重复提交'},false)
   }
   if(url.endsWith('/workspace')){reads.push(url);if(failRefresh&&reads.length>1)return response({message:'远端读取失败'},false);return response({sha,state:'opened',files:[{path:'src/a.ts',diff:'@@ -1 +1 @@\n-before\n+after',status:'modified'}],threads,capabilities:{reply:true,create:true},writePending:record.workspaceWritePending??record.writePending,readiness:record.readiness,pipelinePassed:true,readAt:'2026-10-25T01:00:00Z'})}
   if(['/api/automation/group-mr','/api/automation/group-mr/status'].includes(url))return response({config:{enabled:false},pending:[record],history:[],monitor:{},metrics:{pending:1}})
   if(url==='/api/automation/knowledge')return response({items:[],reviews:[]})
   if(url.startsWith('/api/automation/effectiveness'))return response({total:0,stages:{},reviews:0,merged:0,anomalies:0,rejected:0})
   return response([])
  }
 }})
 t.after(async()=>{for(let i=0;i<30&&dom.window.eval('groupMrUi.actionBusy||Object.values(mrWorkbench.cache).some(v=>v.loading)');i++)await flush();dom.window.close()})
 await flush();const d=dom.window.document;d.querySelector('.nav-enter[data-mr-open="restart"]').click();await flush();return {dom,d,record,writes,reads}
}
async function acknowledge(d){d.querySelector('[data-mr-records]').click();d.querySelector('[data-group-mr-action="ack-pi"]').click();d.querySelector('[data-studio-confirm]').click();await flush();await flush()}

test('acknowledging Agent results reloads cached workspace and restores discussion actions without replay',async t=>{
 const {dom,d,writes,reads}=await setup(t)
 assert.equal(d.querySelector('[data-mrw-resolve="note"]').disabled,true)
 await acknowledge(d)
 assert.equal(reads.length,2)
 assert.equal(writes.length,1);assert.match(writes[0].url,/\/acknowledge-pi$/);assert.deepEqual(writes[0].body,{confirmed:true})
 assert.equal(dom.window.eval('mrData("restart").data.writePending'),'')
 assert.equal(d.querySelector('[data-group-mr-action="ack-pi"]'),null)
 assert.doesNotMatch(d.querySelector('.group-mr-detail').textContent,/服务重启，原执行中断|结果待核对/)
 assert.equal(d.querySelector('[data-mrw-resolve="note"]').disabled,false)
 assert.equal(d.querySelector('[data-mrw-thread="note"]').disabled,false)
 d.querySelector('[data-mr-view="notes"]').click();assert.ok(d.querySelector('[data-group-mr-action=retry]'))
 assert.equal(writes.length,1)
})

test('authoritative workspace refresh clears a stale record write marker without waiting for list polling',async t=>{
 const {dom,d,record,writes}=await setup(t)
 assert.equal(dom.window.eval('mrSelected().writePending'),'Pi 提交检视意见')
 record.writePending=''
 await dom.window.eval('mrLoad("restart")')
 assert.equal(dom.window.eval('mrSelected().writePending'),'')
 assert.equal(d.querySelector('[data-mrw-resolve="note"]').disabled,false)
 assert.doesNotMatch(d.querySelector('.mr-code-section').textContent,/结果待核对/)
 assert.equal(writes.length,0)
})

test('failed workspace refresh after acknowledgement keeps discussion writes blocked until verified',async t=>{
 const {d,writes}=await setup(t,{failRefresh:true})
 await acknowledge(d)
 assert.match(d.querySelector('.mr-code-section').textContent,/远端读取失败/)
 assert.equal(d.querySelector('[data-mrw-resolve="note"]').disabled,true)
 assert.equal(writes.length,1)
})

test('active Agent review retains its progress and never presents interruption or acknowledgement controls',async t=>{
 const {d,writes,reads}=await setup(t,{running:true})
 d.querySelector('[data-mr-records]').click()
 assert.match(d.querySelector('.group-mr-detail').textContent,/Agent 正在全量检视当前提交/)
 assert.doesNotMatch(d.querySelector('.group-mr-detail').textContent,/执行中断|结果待核对/)
 assert.equal(d.querySelector('[data-group-mr-action="ack-pi"]'),null)
 assert.equal(reads.length,0);assert.equal(writes.length,0)
})


test('workspace refresh cannot clear an unrelated uncertain write reported by the MR record',async t=>{
 const {dom,d,record,writes}=await setup(t)
 record.writePending='合并';record.workspaceWritePending=''
 await dom.window.eval('loadGroupMr()')
 await dom.window.eval('mrLoad("restart")')
 assert.equal(dom.window.eval('mrSelected().writePending'),'合并')
 assert.match(dom.window.eval('groupMrActionReason(mrSelected(),"merge")'),/核对/)
 assert.equal(d.querySelector('[data-mrw-resolve="note"]').disabled,true)
 assert.equal(writes.length,0)
})
