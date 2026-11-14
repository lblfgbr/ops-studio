import {stripVTControlCharacters} from 'node:util';

const maxInput=32768,maxSummary=1200;
const detailFields=['message','errorMessage','description','reason'] as const;
const metadataFields=['status','statusCode','code','type','param','model','provider','requestId','request_id'] as const;
const errorFields=['error','cause','errors','response','data'] as const;
const secretName='(?:api[_ -]?key|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|_authToken|_auth|client[_-]?secret|password|passwd|pwd|secret|token|credentials?|private[_ -]?key|signature)';
const secretAssignment=new RegExp(`(\\b${secretName}["']?\\s*(?:provided\\s*)?[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"?|'(?:\\\\.|[^'\\\\])*'?|[^\\s,;}]+)`,'gi');
// An error can contain the entire failing request. Never keep that suffix, even
// when it is nested inside the provider's otherwise allowed message field.
const payloadStart=/(?:\b(?:request(?:[ _-]*(?:body|payload|data|headers))?|requestBody|payload|prompt|messages|tool[_ -]?(?:calls?|arguments)|arguments|headers|proxy-authorization|authorization|set-cookie|cookie|input|body|content)\b["']?\s*(?:[:=]|(?=[{\[]))|```|<(?:!doctype|html|head|body|script)\b)/gi;

function own(value:object,key:string):unknown{const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&'value'in descriptor?descriptor.value:undefined;}

/** A bounded, credential-safe error excerpt, never a dump of an RPC event. */
export function piErrorSummary(value:unknown):string|undefined{
 try{
  const secrets=Object.entries(process.env).filter(([key,item])=>/(?:TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE_KEY|API_KEY|CREDENTIAL)/i.test(key)&&item&&item.length>=4).map(([,item])=>item!);
  let nodes=0;const seen=new WeakSet<object>();
  const maskCredentials=(input:string)=>{
   let text=input;for(const secret of secrets)text=text.split(secret).join('[REDACTED]');
   return text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g,'[REDACTED]')
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi,url=>{
     try{const parsed=new URL(url),credentials=!!(parsed.username||parsed.password),query=!!parsed.search;parsed.username='';parsed.password='';parsed.search='';parsed.hash='';return parsed.protocol+'//'+(credentials?'[REDACTED]@':'')+parsed.host+parsed.pathname+(query?'?[REDACTED]':'');}
     catch{return '[URL REDACTED]';}
    })
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_.~-]+/gi,'[REDACTED]')
    .replace(secretAssignment,(match:string,prefix:string)=>{const quote=match[prefix.length];return prefix+(quote==='"'||quote==="'"?quote+'[REDACTED]'+quote:'[REDACTED]');})
    .replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}/g,'[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED]');
  };
  const redact=(input:string)=>maskCredentials(input).replace(/\b(?:proxy-authorization|authorization|set-cookie|cookie)\b["']?\s*[:=][^\r\n]*/gi,'[AUTH REDACTED]').replace(/\s+/g,' ').trim();
  const collect=(current:unknown,depth:number):string[]=>{
   if(depth>5||++nodes>64)return [];
   if(typeof current==='string')return summarizeText(current,depth);
   if(!current||typeof current!=='object'||seen.has(current))return [];
   seen.add(current);
   if(Array.isArray(current))return [];
   const parts:string[]=[];
   for(const key of detailFields)if(typeof own(current,key)==='string')parts.push(...collect(own(current,key),depth+1));
   for(const key of metadataFields){const item=own(current,key);if(typeof item==='string'){const safe=summarizeText(item,depth+1).join(' ');if(safe)parts.push(`${key}: ${safe}`);}else if(typeof item==='number'&&Number.isFinite(item))parts.push(`${key}: ${item}`);}
   for(const key of errorFields){const item=own(current,key);if(key==='errors'&&Array.isArray(item)){for(const error of item.slice(0,3))parts.push(...collect(error,depth+1));}else parts.push(...collect(item,depth+1));}
   return parts;
  };
  const summarizeText=(input:string,depth:number):string[]=>{
   if(depth>5)return [];
   // Mask configured values before normalization/truncation: a long secret or
   // leading whitespace must not leave a visible credential prefix at the cap.
   let prepared=input;for(const secret of secrets)prepared=prepared.split(secret).join('[REDACTED]');
   let text=stripVTControlCharacters(prepared).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,'').trimStart().slice(0,maxInput).trim();
   if(!text)return [];
   // Parse a whole error object before checking text labels: JSON request keys
   // are excluded structurally, without discarding safe sibling error fields.
   if(text[0]==='{'||text[0]==='['){try{const parsed:unknown=JSON.parse(text);return collect(parsed,depth+1);}catch{/* incomplete JSON is handled below */}}
   text=maskCredentials(text);
   const parts:string[]=[];let start=0;
   const plain=(fragment:string,lookahead='')=>{
    let cut:number|undefined;
    for(const match of (fragment+lookahead).matchAll(payloadStart)){
     if(match.index>=fragment.length)continue;
     // "Bad Request: ..." and "Invalid request: ..." are error explanations.
     if(/^request["']?\s*:/i.test(match[0])&&/\b(?:bad|invalid|malformed|failed|rejected)\s+$/i.test(fragment.slice(0,match.index)))continue;
     cut=match.index;break;
    }
    const safe=redact(cut===undefined?fragment:fragment.slice(0,cut));if(safe)parts.push(safe);return cut!==undefined;
   };
   for(let index=0;index<text.length;index++){
    const opening=text[index];
    // tools[0].parameters is an error location, not a serialized request.
    if(opening!=='{'&&!(opening==='['&&/\s*[\[{"]/.test(text.slice(index+1,index+12))))continue;
    if(plain(text.slice(start,index),opening)){start=text.length;break;}
    let level=0,quoted=false,escaped=false,end=-1;
    for(let cursor=index;cursor<text.length;cursor++){
     const character=text[cursor];
     if(quoted){if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character==='"')quoted=false;continue;}
     if(character==='"'){quoted=true;continue;}
     if(character==='{'||character==='[')level++;else if(character==='}'||character===']'){level--;if(level===0){end=cursor+1;break;}}
    }
    if(end<0){parts.push('[结构化详情已省略]');start=text.length;break;}
    try{const parsed:unknown=JSON.parse(text.slice(index,end));const safe=collect(parsed,depth+1);parts.push(...(safe.length?safe:['[结构化详情已省略]']));}
    catch{parts.push('[结构化详情已省略]');}
    index=end-1;start=end;
   }
   plain(text.slice(start));
   return parts;
  };
  const summary=[...new Set(collect(value,0))].join('；').trim();
  return summary?summary.slice(0,maxSummary):undefined;
 }catch{return undefined;}
}
