import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GroupMrService,manualMrLink,mrLinkFromMessage,mrLinksFromMessage} from '../src/modules/automation/group-mr.js';
import {TaskStore} from '../src/platform/store.js';

const repo='MAE-M/Common/OSSFileService',iid='1598',url=`https://codehub-y.huawei.com/${repo}/merge_requests/${iid}`;
const expected={repo,iid,url};

test('MR diffs links normalize to the MR page in group and manual review entry points',()=>{
 for(const suffix of ['/diffs','/diffs/','/diffs?diff_id=42','/diffs#note_123','/diffs/?diff_id=42#note_123']){
  const link=url+suffix;
  assert.deepEqual(manualMrLink(link),expected,link);
  assert.deepEqual(mrLinkFromMessage(link,'MAE-M/'),expected,link);
  assert.deepEqual(mrLinksFromMessage(`请检视 [${link}](${link})`,'MAE-M/'),[expected],link);
 }
 for(const content of [`请检视 ${url}.`,`请检视 <${url}/diffs>`,`请检视 ${url}/diffs。谢谢`])assert.deepEqual(mrLinksFromMessage(content,'MAE-M/'),[expected],content);
});

test('MR page and diffs URLs deduplicate while distinct MR references remain ambiguous',()=>{
 const content=`${url} ${url}/diffs?diff_id=42 ${url}/diffs/#note_123`;
 assert.deepEqual(mrLinksFromMessage(content,'MAE-M/'),[expected]);
 assert.deepEqual(mrLinkFromMessage(content,'MAE-M/'),expected);
 const second=url.replace('/1598','/1599');
 assert.equal(mrLinkFromMessage(`${url}/diffs ${second}/diffs`,'MAE-M/'),undefined);
 assert.deepEqual(mrLinksFromMessage(`${url}/diffs ${second}/diffs`,'MAE-M/'),[expected,{repo,iid:'1599',url:second}]);
 assert.equal(manualMrLink(content),undefined);
});

test('MR diffs parsing preserves host, repository scope and path validation',()=>{
 assert.deepEqual(mrLinksFromMessage(url+'/diffs','MAE-M/Access/'),[]);
 assert.equal(mrLinkFromMessage(url+'/diffs','MAE-M/Access/'),undefined);
 for(const invalid of [
  ...['/files','/diffs-extra','/diffs.json','/diffs_other','/diffs/other','/diffs//','/diffs%2fother','/diffs/@other','/diffs/+other','/diffs;other','/@other'].map(suffix=>url+suffix),
  url.replace('codehub-y.huawei.com','evil.example')+'/diffs',
  url.replace('codehub-y.huawei.com','codehub-y.huawei.com.evil.example')+'/diffs',
  url.replace('/Common/','/Common/../')+'/diffs',
  url.replace('/Common/','/Common//')+'/diffs'
 ]){
  assert.equal(manualMrLink(invalid),undefined,invalid);
  assert.equal(mrLinkFromMessage(invalid,'MAE-M/'),undefined,invalid);
  assert.deepEqual(mrLinksFromMessage(invalid,'MAE-M/'),[],invalid);
 }
});

test('quoted diffs links identify one MR for an authorized merge request',async()=>{
 const store=new TaskStore(':memory:'),service=new GroupMrService(store);
 const cfg={enabled:true,groupId:'123456789',authorizedSender:'owner',repositoryPrefix:'MAE-M/',intervalSeconds:5};
 try{
  const message={id:'merge',sender:'owner',content:'合入',quoteId:'original',quotedContent:url+'/diffs#note_123'};
  const link=service['trigger'](message,cfg);
  assert.deepEqual(link?.links,[expected]);assert.equal(link?.shortcut,true);
  assert.equal(service['trigger']({...message,sender:'someoneElse'},cfg),undefined);
 }finally{await service.close();store.close();}
});
