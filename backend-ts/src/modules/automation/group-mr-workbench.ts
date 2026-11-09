import {execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {stripVTControlCharacters} from 'node:util';
import {z} from 'zod';
import {jsonValues} from '../autout/mr-codehub.js';
import {reviewSeverity} from './review-severity.js';
const obj=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
const str=(v:unknown)=>typeof v==='string'?v:typeof v==='number'?String(v):'';
const line=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?v:null;
export const reviewSha=z.string().regex(/^[a-f0-9]{40}$/i);
const path=z.string().min(1).max(2048).refine(v=>!/[\x00-\x1f]/.test(v));
export const reviewAction=z.discriminatedUnion('action',[
 z.object({action:z.literal('resolve'),sha:reviewSha,operationId:z.uuid(),discussionId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string().trim().min(1).max(4000),confirmed:z.literal(true)}).strict(),
 z.object({action:z.literal('reply'),sha:reviewSha,operationId:z.uuid(),discussionId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),body:z.string().trim().min(1).max(10000),severity:reviewSeverity.optional()}).strict(),
 z.object({action:z.literal('create'),sha:reviewSha,operationId:z.uuid(),path,line:z.number().int().positive(),body:z.string().trim().min(1).max(10000),severity:reviewSeverity.optional()}).strict()
]);
export interface ReviewNote {id:string;body:string;author:string;time:string;system:boolean;bot:boolean;}
export interface ReviewThread {id:string;body:string;author:string;resolved:boolean;resolvable:boolean;path:string;oldPath:string;line:number|null;oldLine:number|null;headSha:string;outdated?:boolean;notes:ReviewNote[];fingerprint:string;}
export interface ReviewFile {path:string;oldPath:string;diff:string;status:string;unavailable:boolean;binary?:boolean;}
export const reviewFileRequest=z.object({sha:reviewSha,path}).strict();
export class ReviewFileError extends Error { readonly statusCode=422; }
// The CLI file endpoint returns base64; never treat logs or a partial response as source.
export function reviewFileText(output:string,expectedPath:string):string {
 const schema=z.object({content:z.string(),file_path:z.literal(expectedPath).optional(),path:z.literal(expectedPath).optional(),is_limited:z.boolean().optional(),encoding:z.literal('base64').optional(),size:z.number().int().nonnegative().optional(),truncated:z.boolean().optional()});
 for(const value of jsonValues(output)){
  const result=schema.safeParse(value);if(!result.success)continue;
  if(result.data.file_path===undefined&&result.data.path===undefined)continue;
  const file=result.data,encoded=file.content.replace(/\s/g,'');
  if(file.truncated||file.is_limited||encoded.length>6*1024*1024)throw new ReviewFileError('文件过大或内容被截断，无法展开完整文件');
  if(encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new ReviewFileError('文件内容编码无效');
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.toString('base64')!==encoded)throw new ReviewFileError('文件内容编码无效');
  if(bytes.length>4*1024*1024||(file.size!==undefined&&file.size!==bytes.length))throw new ReviewFileError('文件过大或内容不完整，无法展开完整文件');
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new ReviewFileError('文件不是 UTF-8 文本，无法展开');}
  if(text.includes('\0'))throw new ReviewFileError('二进制文件无法展开');
  if(text.split('\n').length>50001)throw new ReviewFileError('文件超过 50000 行，请在 CodeHub 查看');
  return text;
 }
 throw new ReviewFileError('CodeHub 未返回完整文件内容，请检查 repo file get 的输出');
}
// Fill only unchanged gaps from the pinned head. Deleted lines remain from the MR diff.
// Validate every hunk against the fetched source before displaying any expanded rows.
export function fullReviewDiff(file:ReviewFile,content:string):string {
 if(file.unavailable)throw new ReviewFileError('该文件的差异不完整，无法展开');
 const source=content?content.replace(/\r\n/g,'\n').split('\n'):[];if(content.endsWith('\n'))source.pop();
 const output:string[]=[];let oldNext=1,newNext=1,index=0;
 const patch=file.diff.replace(/\r\n/g,'\n').split('\n');
 const mismatch=()=>new ReviewFileError('文件内容与当前差异不一致，请刷新代码后重试');
 while(index<patch.length){
  const text=patch[index++]!;if(!text&&index===patch.length)break;
  const h=text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);if(!h)throw mismatch();
  const oldCount=Number(h[2]??1),newCount=Number(h[4]??1),oldStart=Number(h[1])+(oldCount===0?1:0),newStart=Number(h[3])+(newCount===0?1:0);
  const gap=newStart-newNext;if(gap<0||oldStart-oldNext!==gap||newStart>source.length+1)throw mismatch();
  for(let n=0;n<gap;n++)output.push(' '+source[newNext++-1]);oldNext+=gap;
  let oldRead=0,newRead=0;
  while(index<patch.length&&!patch[index]!.startsWith('@@ ')){
   const row=patch[index++]!;
   if(row.startsWith('\\'))continue;
   if(!row&&index===patch.length)break;
   const kind=row[0];if(kind!==' '&&kind!=='+'&&kind!=='-')throw mismatch();
   if(kind!=='-'){if(source[newNext-1]!==row.slice(1))throw mismatch();newNext++;newRead++;}
   if(kind!=='+'){oldNext++;oldRead++;}output.push(row);
  }
  if(oldRead!==oldCount||newRead!==newCount)throw mismatch();
 }
 while(newNext<=source.length){output.push(' '+source[newNext++-1]);oldNext++;}
 if(output.length>50000)throw new ReviewFileError('展开内容超过 50000 行，请在 CodeHub 查看');
 return `@@ -${oldNext>1?1:0},${oldNext-1} +${source.length?1:0},${source.length} @@\n${output.join('\n')}`;
}
// Compare only pinned file contents in a private temporary directory, never repository paths.
export async function recoveredReviewDiff(before:string,after:string):Promise<string>{
 const dir=await mkdtemp(join(tmpdir(),'ops-mr-diff-'));
 try{
  await writeFile(join(dir,'before'),before,{mode:0o600});await writeFile(join(dir,'after'),after,{mode:0o600});
  const patch=await new Promise<string>((resolve,reject)=>{
   execFile('git',['-c','core.autocrlf=false','diff','--no-index','--no-ext-diff','--no-textconv','--text','--unified=3','--','before','after'],{cwd:dir,encoding:'utf8',timeout:30000,maxBuffer:12*1024*1024},(error,stdout)=>{
    if(error&&error.code!==1){reject(new ReviewFileError('文件差异计算失败或超时，请在 CodeHub 查看'));return;}resolve(stdout);
   });
  });
  const start=patch.indexOf('@@ '),diff=start<0?'':patch.slice(start);
  return fullReviewDiff({path:'',oldPath:'',status:'modified',unavailable:false,diff},after);
 }finally{await rm(dir,{recursive:true,force:true});}
}
// A partial list must never be treated as proof that a comment is absent or resolved.
function rows(output:string,keys:string[]):unknown[]{
 const values=jsonValues(output);
 const visit=(value:unknown,depth=0):unknown[]|undefined=>{
  if(Array.isArray(value))return value;
  const o=obj(value);if(!o||depth>4)return;
  if(o.truncated===true||o.overflow===true||o.has_more===true||o.hasMore===true||o.next_page||o.nextPage)throw Error('CodeHub 返回分页或截断结果，无法确认完整数据；请检查 CLI 版本');
  if(o.resultCode!==undefined&&o.resultCode!==0&&o.resultCode!=='0')throw Error('CodeHub 返回业务失败');
  for(const key of keys)if(key in o){const found=visit(o[key],depth+1);if(found){if(typeof o.total==='number'&&o.total>found.length)throw Error('CodeHub 列表不完整');return found;}}
 };
 for(const value of values){const result=visit(value);if(result)return result;}
 throw Error('CodeHub 返回格式不完整，未更新检视数据');
}
export function reviewThreads(output:string):ReviewThread[]{
 return rows(output,['discussions','items','data','result']).map(value=>{
  const o=obj(value),id=str(o?.discussion_id??o?.discussionId??o?.id);
  if(!id||!Array.isArray(o?.notes)||!o.notes.length)throw Error('检视意见缺少 ID 或讨论内容');
  const notes=o.notes.map(value=>{const n=obj(value);if(!n||typeof n.body!=='string')throw Error('讨论内容格式不完整');return {id:str(n.id),body:n.body,author:str(obj(n.author)?.username??obj(n.author)?.name??n.author),time:str(n.created_at??n.updated_at),system:n.system===true||n.type==='system',bot:obj(n.author)?.bot===true||obj(n.author)?.is_bot===true||obj(n.author)?.state==='bot'};});
  const first=obj(o.notes[0])!,position=obj(first.position??o.position??first.original_position??o.original_position),resolvable=o.resolvable!==false&&!o.notes.every(n=>obj(n)?.resolvable===false);
  const item={id,body:notes[0]!.body,author:notes[0]!.author,resolved:o.resolved===true||(o.resolved===undefined&&first.resolved===true),resolvable,path:str(position?.new_path??first.path??o.path),oldPath:str(position?.old_path),line:line(position?.new_line??first.line),oldLine:line(position?.old_line),headSha:str(position?.head_sha),outdated:first.is_outdated===true||o.is_outdated===true,notes};
  return {...item,fingerprint:createHash('sha256').update(JSON.stringify(item)).digest('hex')};
 });
}
export function reviewFiles(output:string):ReviewFile[]{
 return rows(output,['changes','diffs','items','data','result']).map(value=>{
  const o=obj(value),name=str(o?.new_path??o?.path??o?.old_path);if(!name)throw Error('变更缺少文件路径');
  return {path:name,oldPath:str(o?.old_path),diff:str(o?.diff??o?.patch),status:o?.deleted_file?'deleted':o?.new_file?'added':o?.renamed_file?'renamed':'modified',binary:o?.binary===true,unavailable:!str(o?.diff??o?.patch)||typeof (o?.diff??o?.patch)!=='string'||o?.too_large===true||o?.collapsed===true||o?.binary===true};
 });
}
export function addedLines(diff:string):Set<number>{
 let next=0,inHunk=false;const result=new Set<number>();
 for(const text of diff.split('\n')){const h=text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);if(h){next=Number(h[1]);inHunk=true;continue;}if(!inHunk)continue;if(text.startsWith('+'))result.add(next++);else if(text.startsWith(' '))next++;else if(!text.startsWith('-')&&!text.startsWith('\\'))inHunk=false;}
 return result;
}
export interface ReviewReadiness {sha:string;checkedAt:string;ready:boolean;reason:string;}
export interface ReviewWorkspace {pipelinePassed?:boolean;readiness?:ReviewReadiness;title?:string;sha:string;state:string|undefined;files:ReviewFile[];threads:ReviewThread[];capabilities:ReviewCapabilities;writePending:string;stale:boolean;readAt:string;confirmedOperationId:string;}
export interface ReviewCapabilities {reply:boolean;create:boolean;reason:string;}
// Only allow a known adapter when local help confirms BOTH positional arguments and flags.
// Unknown CLI versions fail closed; help text never supplies executable tokens.
export function supportsReviewCommand(help:string,kind:'reply'|'create'):boolean{
 help=stripVTControlCharacters(help);
 const usage=help.match(new RegExp('(?:codehub-cli\\s+)?mr\\s+review\\s+'+kind+'\\s+([^\\n]+)','i'))?.[1]??'';
 const args=[...usage.matchAll(/<([^>]+)>/g)].map(m=>m[1]!.toLowerCase().replaceAll('_','-'));
 // Read option declarations only: descriptions/examples must not advertise capabilities.
 // Cobra uses bare types (string, lineRange); older help uses <value> or [value].
 const flags=new Map<string,string>();
 for(const line of help.split('\n')){
  const match=/^\s*(?:-[a-z],?\s*)?--([a-z][a-z-]*)[ \t]+(<[^>\r\n]+>|\[[^\]\r\n]+\]|string|lineRange)(?=\s|$)/i.exec(line);
  if(match)flags.set(match[1]!,match[2]!);
 }
 return ['iid','mr-iid','mr-id','mr'].includes(args[0]??'')&&args.length===(kind==='reply'?2:1)&&(kind!=='reply'||['discussion-id','discussion'].includes(args[1]??''))&&flags.has('body')&&['project','repo','repository'].some(flag=>flags.has(flag))&&(kind!=='create'||flags.has('path')&&flags.has('line'));
}
