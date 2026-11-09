import {jsonValues} from '../autout/mr-codehub.js';

const diagnosticStates=new Set(['success','failed','running','pending','opened','closed','merged','error','true','approve','optional','required','approved','reviewed','passed','reject']);
const diagnosticGateFlags=new Set(['ci_state_passed','conflict_passed','approval_reviewers_required_passed','approval_approvers_required_passed','merge_gate_passed']);

const reviewParameters=['severity','review-category','review-module'] as const;

// Only classify CLI parameter diagnostics. Never return raw output: it can contain
// an echoed request body, authentication data or a server response with code.
export function codehubParameterErrorHint(output:string):string|undefined{
 for(const line of output.split(/\r?\n/)){
  const message=/^\s*error:\s*(.*)$/i.exec(line)?.[1];if(!message)continue;
  const required=/\brequired:\s*([^.;]+)/i.exec(message)?.[1]
   ??/\brequired flags?(?:\(s\))?\s+(.+?)\s+not set\b/i.exec(message)?.[1]
   ??/\bmissing(?: required)? (?:flags?|parameters?)(?:\s*:\s*|\s+)([^.;]+)/i.exec(message)?.[1]
   ??/^((?:--)?[a-z-]+)\s+(?:is\s+)?required\b/i.exec(message)?.[1];
  if(required){
   const missing=reviewParameters.filter(name=>new RegExp(`(?:^|[\\s,"'\x60])(?:--)?${name}(?=$|[\\s,"'\x60])`,'i').test(required));
   if(missing.length)return `缺少检视意见必填参数 ${missing.map(name=>'--'+name).join('、')}；请执行 codehub-cli setting review-config 查看仓库检视配置`;
  }
  const invalid=reviewParameters.filter(name=>
   new RegExp(`\\b(?:invalid|unsupported)\\s+(?:--)?${name}(?=$|[\\s:;,])`,'i').test(message)
   ||new RegExp(`\\binvalid (?:value|argument)\\b.*\\bfor\\s+["'\x60]?(?:--)?${name}["'\x60]?(?=$|[\\s:;,])`,'i').test(message)
   ||new RegExp(`^(?:--)?${name}\\s+must be\\b`,'i').test(message));
  if(invalid.length)return `检视意见参数 ${invalid.map(name=>'--'+name).join('、')} 的值无效；请执行 codehub-cli setting review-config 查看可用值`;
 }
 return;
}

// Preserve response structure, not message bodies, diffs or credentials.
export function responseDiagnostic(output:string){
 const values=jsonValues(output);
 const shape=(value:unknown,depth=0):unknown=>{
  if(value===null)return null;
  if(depth>=5)return Array.isArray(value)?{type:'array',length:value.length}:typeof value;
  if(Array.isArray(value))return {type:'array',length:value.length,items:value.slice(0,2).map(v=>shape(v,depth+1))};
  if(typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,40).map(([key,v])=>[
   /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)?key:'[non-field-key]',
   /token|secret|password|authorization|cookie|credential|private.?key/i.test(key)?'[REDACTED]':
   ['status','state'].includes(key)&&typeof v==='string'&&diagnosticStates.has(v)?v:
   diagnosticGateFlags.has(key)&&typeof v==='boolean'?v:
   ['code','statusCode','resultCode'].includes(key)&&(typeof v==='number'||typeof v==='string'&&/^\d{1,6}$/.test(v))?v:shape(v,depth+1)
  ]));
  return typeof value;
 };
 return {bytes:Buffer.byteLength(output),format:values.length?'json':!output.trim()?'empty':/<(?:!doctype|html)\b/i.test(output)?'html':'text',values:values.slice(0,3).map(v=>shape(v))};
}
