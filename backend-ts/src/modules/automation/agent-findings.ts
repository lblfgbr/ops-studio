import {createHash} from 'node:crypto';
import {z} from 'zod';
import {reviewAssessment} from './review-closure.js';
import {reviewSeverity} from './review-severity.js';

const finding=z.object({path:z.string().min(1).max(2048).refine(s=>!/[\x00-\x1f]/.test(s)),line:z.number().int().positive(),body:z.string().trim().min(1).max(10000),severity:reviewSeverity.optional()}).strict();
const result=reviewAssessment.extend({findings:z.array(finding).max(100)}).strict();
export type AgentFinding=z.infer<typeof finding>;
export interface AgentSubmission {key:string;repo:string;iid:string;sha:string;entryId:string;author:string;finding:AgentFinding;marker:string;status:'pending'|'confirmed'|'failed'|'retry-authorized'|'not-submitted';discussionId?:string;error?:string;}
export function parseAgentResult(answer:string,sha:string){
 const matches=[...answer.matchAll(/<ops-studio-review-result>\s*([\s\S]*?)\s*<\/ops-studio-review-result>/g)];
 if(matches.length!==1)throw Error('Agent 未返回完整结构化检视结果，可重新检视；未提交任何新意见');
 let parsed:unknown;try{parsed=JSON.parse(matches[0]![1]!);}catch{throw Error('Agent 检视结果不是有效 JSON，可重新检视；未提交任何新意见');}
 const validated=result.safeParse(parsed);
 if(!validated.success||validated.data.sha!==sha||new Set(validated.data.assessments.map(a=>a.id)).size!==validated.data.assessments.length)throw Error('Agent 检视结果字段或提交 SHA 不匹配，可重新检视；未提交任何新意见');
 return validated.data;
}
export function findingIdentity(f:AgentFinding){return createHash('sha256').update(JSON.stringify([f.path,f.body.replace(/<!-- ops-studio-[\s\S]*?-->/g,'').replace(/\s+/g,' ').trim()])).digest('hex');}
