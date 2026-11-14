import {test} from 'node:test';
import assert from 'node:assert/strict';
import {piErrorSummary} from '../src/modules/automation/pi-error-diagnostics.js';

test('Pi error summaries retain actionable tool-schema, rate-limit and context errors',()=>{
 const schema="HTTP 400: Invalid schema for function 'codehub_read': tools[0].parameters must be an object";
 assert.equal(piErrorSummary(schema),schema);
 assert.equal(piErrorSummary('429 Too Many Requests: rate limit exceeded'),'429 Too Many Requests: rate limit exceeded');
 assert.equal(piErrorSummary('Maximum context length is 200000 tokens; received 210000 tokens'),'Maximum context length is 200000 tokens; received 210000 tokens');
 for(const message of ['HTTP 400 Bad Request: maximum context length exceeded','HTTP 400 Invalid request: tools[0].parameters must be an object'])assert.equal(piErrorSummary(message),message);
});

test('Pi structured errors allow diagnostic fields but discard nested requests and code',()=>{
 const error={error:{message:'Invalid tool schema',code:'invalid_request_error',param:'tools[0].parameters',body:'PRIVATE-BODY',messages:['PRIVATE-PROMPT'],tools:[{source:'PRIVATE-CODE'}]},status:400,request:{messages:[{content:'PRIVATE-REQUEST'}]},headers:{authorization:'PRIVATE-TOKEN'}};
 for(const value of [error,JSON.stringify(error),'HTTP 400: '+JSON.stringify(error)]){
  const result=piErrorSummary(value)!;assert.match(result,/Invalid tool schema/);assert.match(result,/invalid_request_error/);assert.match(result,/tools\[0\]\.parameters/);assert.match(result,/400/);assert.doesNotMatch(result,/PRIVATE-/);
 }
 assert.equal(piErrorSummary({response:{data:{error:{message:'Context length exceeded',type:'context_length_exceeded'}}}}),'Context length exceeded；type: context_length_exceeded');
});

test('Pi error text suppresses request dumps even inside an allowed message',()=>{
 for(const marker of ['Request body:','requestBody=','payload=','prompt:','messages:','arguments:','body:','input:','content:','headers:','```']){
  for(const value of ['HTTP 400: Invalid request\n'+marker+' PRIVATE-CODE',JSON.stringify({error:{message:'HTTP 400: Invalid request; '+marker+' {"messages":[{"content":"PRIVATE-CODE"}]}'}})]){
   const result=piErrorSummary(value)!;assert.match(result,/HTTP 400/);assert.doesNotMatch(result,/PRIVATE-CODE|messages|content/);
  }
 }
 assert.doesNotMatch(piErrorSummary('HTTP 502 <html>PRIVATE-PROXY-PAGE</html>')!,/PRIVATE-PROXY/);
 for(const label of ['request body','tool arguments','payload','prompt'])assert.doesNotMatch(piErrorSummary('HTTP 400: '+label+' {"message":"PRIVATE-CODE"}')!,/PRIVATE-CODE/);
});

test('Pi error summaries remove credentials without hiding ordinary error codes',()=>{
 const samples=[
  'HTTP 401 Authorization: Bearer PRIVATE-ONE\nProxy-Authorization: Basic PRIVATE-TWO\nCookie: a=PRIVATE-THREE; session=PRIVATE-FOUR',
  'HTTP 401 api_key="PRIVATE-ONE", apiKey:\'PRIVATE-TWO\', x-api-key: PRIVATE-THREE, access_token=PRIVATE-FOUR',
  'HTTP 401 password="PRIVATE-ONE with spaces", client-secret=PRIVATE-TWO; token=PRIVATE-THREE',
  'HTTP 401 Bearer PRIVATE-ONE Basic PRIVATE-TWO',
  'HTTP 401 https://PRIVATE-USER:PRIVATE-PASS@example.test/v1?api_key=PRIVATE-KEY&signature=PRIVATE-SIGNATURE#PRIVATE-FRAGMENT',
  'HTTP 401 Incorrect API key provided: sk-abcdefghijklmnop',
  'HTTP 401 api_key=\'PRIVATE-START {"message":"PRIVATE-MIDDLE"} PRIVATE-END\'',
  'HTTP 401 -----BEGIN PRIVATE KEY-----\nPRIVATE-PEM\n-----END PRIVATE KEY-----'
 ];
 for(const sample of samples){const result=piErrorSummary(sample)!;assert.match(result,/401/);assert.doesNotMatch(result,/PRIVATE-(?:ONE|TWO|THREE|FOUR|USER|PASS|KEY|SIGNATURE|FRAGMENT|PEM|START|MIDDLE|END)|sk-abcdefghijklmnop/);}
 for(const header of ['Authorization','Proxy-Authorization','Cookie','Set-Cookie'])assert.doesNotMatch(piErrorSummary('HTTP 401 '+header+': {"message":"PRIVATE-CREDENTIAL"}')!,/PRIVATE-CREDENTIAL/);
 assert.equal(piErrorSummary({code:'invalid_api_key',message:'Authentication failed',api_key:'PRIVATE-KEY'}),'Authentication failed；code: invalid_api_key');
});

test('Pi error summaries mask configured secret values and bound huge input after filtering',()=>{
 const key='OPS_STUDIO_TEST_ERROR_API_KEY',previous=process.env[key];process.env[key]='synthetic-sensitive-value';
 try{
  assert.doesNotMatch(piErrorSummary('HTTP 401: synthetic-sensitive-value was rejected')!,/synthetic-sensitive-value/);
  assert.doesNotMatch(piErrorSummary(' '.repeat(32760)+'synthetic-sensitive-value')!,/synthetic/);
  process.env[key]='synthetic-sensitive-value'.repeat(3000);
  assert.equal(piErrorSummary(process.env[key]),'[REDACTED]');
  const huge=piErrorSummary('HTTP 400 api_key="'+'PRIVATE-SECRET'.repeat(10000));assert.match(huge!,/400/);assert.doesNotMatch(huge!,/PRIVATE/);assert.ok(huge!.length<=1200);
  const long=piErrorSummary('Error: '+'x'.repeat(1000000));assert.ok(long&&long.length<=1200);
 }finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
});

test('Pi error summaries strip terminal/control characters and refuse unknown or cyclic structures',()=>{
 assert.equal(piErrorSummary('\u001b[31mHTTP 400\u001b[0m\u0000\u202e: bad schema'),'HTTP 400: bad schema');
 for(const value of [null,undefined,42,[],['PRIVATE'],{content:'PRIVATE',request:'PRIVATE',messages:['PRIVATE']},Object.defineProperty({},'message',{get(){throw Error('must not call getter');}})])assert.equal(piErrorSummary(value),undefined);
 const circular:{message:string;cause?:unknown}={message:'Network request failed'};circular.cause=circular;assert.equal(piErrorSummary(circular),'Network request failed');
 const error=new Error('Connection reset');assert.equal(piErrorSummary(error),'Connection reset');
});
