import {runProcess} from './process.js';
interface ToolCall {toolName:string;input:Record<string,unknown>;}
interface PiGuardApi {
 on(event:'tool_call',handler:(event:ToolCall)=>{block:true;reason:string}|undefined):void;
 registerTool(tool:{name:string;label:string;description:string;parameters:Record<string,unknown>;execute:(id:string,input:{args:unknown},signal?:AbortSignal)=>Promise<{content:Array<{type:'text';text:string}>;details:Record<string,unknown>}>}):void;
}
export function reviewArgsAllowed(value:unknown):value is string[]{
 if(!Array.isArray(value)||!value.length||value.length>40||!value.every(v=>typeof v==='string'&&v.length<=4096&&!/[\x00-\x1f]/.test(v)))return false;
 const args:string[]=value;
 const prefixes=[['mr','view'],['mr','changes'],['mr','gate'],['mr','pipeline'],['mr','review','list'],['repo','file','get'],['user','view']];
 const prefix=prefixes.find(p=>p.every((part,i)=>args[i]===part));if(!prefix)return false;
 // Only query options; no output files, shell, executable overrides or arbitrary CLI commands.
 const flags=new Set(['-p','--project','--repo','--repository','--format','--columns','--file-path','--ref','--jq','--page','--per-page']);
 const switches=new Set(['--help','--no-cache']);
 for(let i=prefix.length;i<args.length;i++){
  const token=args[i]!;
  if(switches.has(token))continue;
  if(token.startsWith('-')){const [name]=token.split('=');if(!flags.has(name!))return false;if(!token.includes('=')&&(++i>=args.length||args[i]!.startsWith('-')))return false;}
 }
 return true;
}
export function reviewToolAllowed(event:ToolCall):boolean {
 return ['read','grep','find','ls'].includes(event.toolName)||event.toolName==='codehub_read'&&reviewArgsAllowed(event.input.args);
}
// Explicit extension for MR analysis. No shell tool is exposed; the only CLI adapter uses argv.
// Pi API: packages/coding-agent/docs/extensions.md (registerTool and tool_call).
export default function reviewGuard(pi:PiGuardApi){
 pi.registerTool({name:'codehub_read',label:'Read CodeHub',description:'只读 CodeHub 查询。args 为 CLI 参数数组，例如 ["mr","changes","1578","-p","MAE-M/Access/FMInsightService","--no-cache","--format","json"]。支持 mr view/changes/gate/pipeline/review list、repo file get、user view 及对应 --help。',parameters:{type:'object',properties:{args:{type:'array',items:{type:'string'}}},required:['args'],additionalProperties:false},
  async execute(_id,input,signal){
   if(!reviewArgsAllowed(input.args))throw Error('仅允许预定义的 CodeHub 只读查询');
   const result=await runProcess(['codehub-cli',...input.args],process.cwd(),120000,undefined,undefined,undefined,signal);
   if(result.exitCode!==0)throw Error('CodeHub 只读查询失败：'+result.output);
   if(result.outputTruncated)throw Error('CodeHub 返回内容被截断，请缩小只读查询范围');
   return {content:[{type:'text',text:result.output}],details:{}};
  }});
 pi.on('tool_call',event=>reviewToolAllowed(event)?undefined:{block:true,reason:'MR 检视仅允许本地只读工具和 codehub_read；意见放入 findings，由平台提交。'});
}
