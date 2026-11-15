// Deterministic free-tier gateway. All inference is delegated to the trial providers.
import { createServer } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { readBrief, probeProvider, authHeaders, joinBase, meetsRequirements, capabilitiesOf, ratingOfModel } from './lib/providers.ts';
import { anthropicToOpenAI, openAIToAnthropic, openAIModelList, anthropicModelList, sseEvent } from './lib/wire.ts';

const origin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const brief = readBrief(process.env.MAKEFUN_PROMPT_FILE ?? '');
const probes = [];
const catalog = { providers: [] };
let requestIndex = 0;
const disabled = new Set();
// Probing in directory order also fixes the order of all startup traffic.
if (origin) {
  const instance = await (await fetch(`${origin}/instance`)).json();
  for (const provider of brief.directory.providers) {
    const directory = instance.providers?.find(p => p.id === provider.id);
    const probe = await probeProvider(origin, provider);
    probe.dial = directory?.base_url ?? joinBase(origin, provider.base);
    probes.push(probe);
    if (probe.ok) catalog.providers.push({ id: provider.id, base_url: provider.base, key_env: provider.key_env, wire: provider.wire,
      models: [...probe.models].sort((a,b) => a.id.localeCompare(b.id)).map(m => ({ id: m.id, free: m.free === true, context_length: m.context_length })) });
  }
}
if (process.argv.includes('--list') || !origin) {
  console.log(JSON.stringify(catalog));
  process.exit(0);
}
const freeModels = catalog.providers.flatMap(p => p.models.filter(m => m.free).map(m => ({ ...m, provider: p.id, display_name: m.id })));
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
const parseArgs = s => { try { return JSON.parse(s); } catch { return {}; } };
const oaStop = s => ({ end_turn:'stop', stop_sequence:'stop', max_tokens:'length', tool_use:'tool_calls', refusal:'content_filter', STOP:'stop', MAX_TOKENS:'length', SAFETY:'content_filter' }[s] ?? s ?? 'stop');

function toAnthropic(body, model) {
  const system = [];
  const messages = [];
  for (const m of body.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') { system.push(textOf(m.content)); continue; }
    if (m.role === 'tool') { messages.push({role:'user',content:[{type:'tool_result',tool_use_id:m.tool_call_id,content:m.content}]}); continue; }
    let content = typeof m.content === 'string' ? [{type:'text',text:m.content}] : (m.content ?? []).map(b => {
      if (b.type !== 'image_url') return b;
      const url = b.image_url.url;
      const data = /^data:([^;]+);base64,(.*)$/s.exec(url);
      return {type:'image',source:data ? {type:'base64',media_type:data[1],data:data[2]} : {type:'url',url}};
    });
    for (const c of m.tool_calls ?? []) content.push({type:'tool_use',id:c.id,name:c.function.name,input:parseArgs(c.function.arguments)});
    messages.push({role:m.role,content});
  }
  return {model,messages,system:system.join('\n'),max_tokens:body.max_tokens ?? body.max_completion_tokens,
    stream:body.stream === true, ...(body.stop !== undefined ? {stop_sequences:typeof body.stop === 'string' ? [body.stop] : body.stop} : {}),
    ...(body.temperature !== undefined ? {temperature:body.temperature} : {}), ...(body.top_p !== undefined ? {top_p:body.top_p} : {}),
    ...(body.tools ? {tools:body.tools.map(t => ({name:t.function.name,description:t.function.description ?? '',input_schema:t.function.parameters}))} : {}),
    ...(body.tool_choice ? {tool_choice:typeof body.tool_choice === 'string' ? {type:body.tool_choice === 'required' ? 'any' : body.tool_choice} : {type:'tool',name:body.tool_choice.function.name}} : {})};
}
function toGemini(body) {
  const system = [];
  const contents = [];
  for (const m of body.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') {system.push({text:textOf(m.content)});continue;}
    const parts = typeof m.content === 'string' ? [{text:m.content}] : (m.content ?? []).map(b => {
      if (b.type === 'text') return {text:b.text};
      const url = b.image_url?.url ?? '';
      const data = /^data:([^;]+);base64,(.*)$/s.exec(url);
      return data ? {inlineData:{mimeType:data[1],data:data[2]}} : {fileData:{fileUri:url}};
    });
    for (const c of m.tool_calls ?? []) parts.push({functionCall:{id:c.id,name:c.function.name,args:parseArgs(c.function.arguments)}});
    if (m.role === 'tool') parts.splice(0,parts.length,{functionResponse:{id:m.tool_call_id,name:m.name ?? m.tool_call_id,response:{result:m.content}}});
    contents.push({role:m.role === 'assistant' ? 'model':'user',parts});
  }
  return {contents,systemInstruction:{parts:system},generationConfig:{maxOutputTokens:body.max_tokens ?? body.max_completion_tokens,
    ...(body.stop !== undefined ? {stopSequences:typeof body.stop === 'string' ? [body.stop]:body.stop} : {}),
    ...(body.temperature !== undefined ? {temperature:body.temperature}:{}),...(body.top_p !== undefined ? {topP:body.top_p}:{})},
    ...(body.tools ? {tools:[{functionDeclarations:body.tools.map(t=>t.function)}]}:{})};
}
function completion(model, text, calls, finish, input, output) {
  return {id:'chatcmpl-aggregate',object:'chat.completion',created:1767225600,model,
    choices:[{index:0,message:{role:'assistant',content:text,...(calls.length ? {tool_calls:calls}: {})},finish_reason:oaStop(finish)}],
    usage:{prompt_tokens:input,completion_tokens:output,total_tokens:input+output}};
}
function normalize(wire, values, model, streaming) {
  if (wire === 'openai' && !streaming) return values[0];
  let text = '', finish = 'stop', input = 0, output = 0;
  const calls = [];
  for (const v of values) {
    if (wire === 'openai') {
      const c = v.choices?.[0];
      text += c?.delta?.content ?? '';
      if (c?.finish_reason) finish = c.finish_reason;
      if (v.usage) {input=v.usage.prompt_tokens;output=v.usage.completion_tokens;}
      for (const t of c?.delta?.tool_calls ?? []) {
        const i=t.index ?? 0;
        calls[i] ??= {id:t.id,type:'function',function:{name:t.function?.name ?? '',arguments:''}};
        calls[i].function.arguments += t.function?.arguments ?? '';
      }
    } else if (wire === 'anthropic') {
      const msg = v.message ?? v;
      if (msg.usage) {input=msg.usage.input_tokens ?? input;output=msg.usage.output_tokens ?? output;}
      for (const b of msg.content ?? []) {
        if (b.type==='text') text+=b.text;
        if (b.type==='tool_use') calls.push({id:b.id,type:'function',function:{name:b.name,arguments:JSON.stringify(b.input)}});
      }
      if (v.type==='content_block_start' && v.content_block?.type==='tool_use') {
        const b=v.content_block;
        calls[v.index]={id:b.id,type:'function',function:{name:b.name,arguments:''}};
      }
      if (v.type==='content_block_delta' && v.delta.type==='input_json_delta' && calls[v.index]) calls[v.index].function.arguments+=v.delta.partial_json;
      if (v.type==='content_block_delta' && v.delta.type==='text_delta') text+=v.delta.text;
      if (msg.stop_reason) finish=msg.stop_reason;
      if (v.delta?.stop_reason) finish=v.delta.stop_reason;
    } else {
      const c=v.candidates?.[0];
      for (const p of c?.content?.parts ?? []) {
        text+=p.text ?? '';
        if (p.functionCall) calls.push({id:p.functionCall.id ?? `call_${calls.length}`,type:'function',function:{name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args)}});
      }
      if(c?.finishReason) finish=c.finishReason;
      if(v.usageMetadata) {input=v.usageMetadata.promptTokenCount;output=v.usageMetadata.candidatesTokenCount;}
    }
  }
  return completion(model,text,calls.filter(Boolean),finish,input,output);
}
async function call(probe, model, oa, original, api, req) {
  const wire=probe.provider.wire;
  const stream=original.stream === true;
  const body=wire==='openai' ? {...oa,model, ...(stream ? {stream_options:{include_usage:true}}:{})} : wire==='anthropic' ? (api==='anthropic' ? {...original,model}:toAnthropic(oa,model)) : toGemini(oa);
  const path=wire==='openai' ? '/v1/chat/completions' : wire==='anthropic' ? '/v1/messages' : `/v1beta/models/${encodeURIComponent(model)}:${stream?'streamGenerateContent?alt=sse':'generateContent'}`;
  const res=await fetch(`${probe.dial}${path}`,{method:'POST',headers:{'content-type':'application/json',...authHeaders(probe.provider.auth,probe.provider.key),...(wire==='anthropic'?{'anthropic-version':req.headers['anthropic-version'] ?? '2023-06-01'}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const raw=await res.text();
  if(!res.ok) return {status:res.status,error:raw};
  const values=stream ? raw.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).filter(l=>l && l!=='[DONE]').map(l=>JSON.parse(l)) : [JSON.parse(raw)];
  return {answer:normalize(wire,values,model,stream)};
}
function json(res,status,body) {res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
function sendAnswer(res,answer,api,stream) {
  const result=api==='anthropic' ? openAIToAnthropic(answer,answer.model):answer;
  if(!stream) return json(res,200,result);
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  if(api==='openai') {
    const chunk=(delta,finish)=>({id:answer.id,object:'chat.completion.chunk',created:answer.created,model:answer.model,choices:[{index:0,delta,finish_reason:finish}]});
    res.write(sseEvent(null,chunk({role:'assistant'},null)));
    const msg=answer.choices[0].message;
    if(msg.content) res.write(sseEvent(null,chunk({content:msg.content},null)));
    if(msg.tool_calls) res.write(sseEvent(null,chunk({tool_calls:msg.tool_calls.map((c,i)=>({...c,index:i}))},null)));
    res.write(sseEvent(null,chunk({},answer.choices[0].finish_reason)));
    res.write(sseEvent(null,{id:answer.id,object:'chat.completion.chunk',created:answer.created,model:answer.model,choices:[],usage:answer.usage}));
    res.end('data: [DONE]\n\n');
  } else {
    const event=(type,data)=>res.write(sseEvent(type,{type,...data}));
    event('message_start',{message:{...result,content:[],stop_reason:null,usage:{input_tokens:result.usage.input_tokens,output_tokens:0}}});
    result.content.forEach((b,index)=>{
      event('content_block_start',{index,content_block:b.type==='text'?{type:'text',text:''}:{...b,input:{}}});
      event('content_block_delta',{index,delta:b.type==='text'?{type:'text_delta',text:b.text}:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}});
      event('content_block_stop',{index});
    });
    event('message_delta',{delta:{stop_reason:result.stop_reason,stop_sequence:result.stop_sequence},usage:{output_tokens:result.usage.output_tokens}});
    event('message_stop',{});res.end();
  }
}
async function handle(req,res) {
  if(req.method==='GET' && req.url==='/v1/models') return json(res,200,req.headers['x-api-key'] ? anthropicModelList(freeModels):openAIModelList(freeModels));
  if(req.method!=='POST' || !['/v1/messages','/v1/chat/completions'].includes(req.url)) return json(res,404,{error:{message:'Unknown route'}});
  let raw='';for await(const chunk of req) {raw+=chunk;if(raw.length>32*1024*1024) throw new Error('Body too large');}
  const original=JSON.parse(raw), api=req.url==='/v1/messages'?'anthropic':'openai';
  const requirements=brief.workload?.manifest[requestIndex++]?.requires ?? {};
  const oa=api==='anthropic'?anthropicToOpenAI(original,'auto'):original;
  const candidates=[];
  for(const probe of probes) for(const model of probe.models) {
    const rating=ratingOfModel(brief.ratings,probe.provider.id,model.id);
    if(model.free !== true || !rating || !meetsRequirements(requirements,capabilitiesOf(model,rating))) continue;
    if((requirements.json || oa.response_format) && probe.provider.wire!=='openai') continue;
    candidates.push({probe,model,rating:rating.rating_milli});
  }
  candidates.sort((a,b)=>b.rating-a.rating || a.probe.provider.id.localeCompare(b.probe.provider.id) || a.model.id.localeCompare(b.model.id));
  const tried=new Set();
  for(const {probe,model} of candidates) {
    const id=probe.provider.id;if(disabled.has(id)||tried.has(id)) continue;tried.add(id);
    try {
      const result=await call(probe,model.id,oa,original,api,req);
      if(result.answer) return sendAnswer(res,result.answer,api,original.stream===true);
      // A refusal is not a completion. Distinguish permanent exhaustion from scheduled failure.
      if(/budget|spent|exhaust|is out/i.test(result.error)) disabled.add(id);
      process.stderr.write(`provider ${id}: HTTP ${result.status}\n`);
    } catch(e) {process.stderr.write(`provider ${id}: ${e.message}\n`);}
  }
  json(res,503,api==='anthropic'?{type:'error',error:{type:'overloaded_error',message:'No eligible provider available'}}:{error:{type:'unavailable',message:'No eligible provider available'}});
}
const server=createServer((req,res)=>{handle(req,res).catch(e=>{process.stderr.write(`${e.stack}\n`);if(!res.headersSent)json(res,500,{error:{message:'Gateway error'}});else res.end();});});
await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
await fetch(`${origin}/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({protocol_version:1,port:server.address().port,catalog})});
for (;;) {
  await pause(100);
  const work=await (await fetch(`${origin}/work`)).json();
  if(work.done) {server.close();process.exit(0);}
}
