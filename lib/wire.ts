// Pure client-wire adapters: no network, clock, or random state.
const text = value => typeof value === 'string' ? value : (value ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const input = value => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
};
export function openAIModelList(models) {
  return { object:'list', data:models.map(m => ({id:m.id,object:'model',created:1767225600,owned_by:m.provider})) };
}
export function anthropicModelList(models) {
  return {data:models.map(m => ({id:m.id,type:'model',display_name:m.display_name,created_at:'2026-01-01T00:00:00Z'})),has_more:false};
}
export function sseEvent(name, value) {
  return `${name === null ? '' : `event: ${name}\n`}data: ${JSON.stringify(value)}\n\n`;
}
export function anthropicToOpenAI(body, model) {
  const messages = [];
  if (body.system !== undefined) messages.push({role:'system',content:text(body.system)});
  for (const message of body.messages ?? []) {
    if (typeof message.content === 'string') {
      messages.push({role:message.role,content:message.content});
      continue;
    }
    const parts = [];
    const calls = [];
    for (const block of message.content ?? []) {
      if (block.type === 'text') parts.push({type:'text',text:block.text});
      else if (block.type === 'image') {
        const source = block.source;
        parts.push({type:'image_url',image_url:{url:source.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source.url}});
      } else if (block.type === 'tool_use') {
        calls.push({id:block.id,type:'function',function:{name:block.name,arguments:JSON.stringify(block.input)}});
      } else if (block.type === 'tool_result') {
        messages.push({role:'tool',tool_call_id:block.tool_use_id,content:typeof block.content === 'string' ? block.content : text(block.content)});
      }
    }
    if (parts.length || calls.length) messages.push({role:message.role,content:parts.length ? parts : null,...(calls.length ? {tool_calls:calls}: {})});
  }
  const out = {model,messages};
  for (const key of ['max_tokens','temperature','top_p','stream']) if (body[key] !== undefined) out[key]=body[key];
  if (body.stop_sequences !== undefined) out.stop=body.stop_sequences;
  if (body.tools !== undefined) out.tools=body.tools.map(t => ({type:'function',function:{name:t.name,...(t.description !== undefined ? {description:t.description}:{}),parameters:t.input_schema}}));
  if (body.tool_choice) {
    const choice=body.tool_choice;
    out.tool_choice=choice.type === 'tool' ? {type:'function',function:{name:choice.name}} : choice.type === 'any' ? 'required' : choice.type;
  }
  if (body.stream) out.stream_options={include_usage:true};
  return out;
}
export function openAIToAnthropic(body, model) {
  const choice=body.choices?.[0] ?? {};
  const message=choice.message ?? {};
  const content=[];
  if (message.content) content.push({type:'text',text:text(message.content)});
  for (const call of message.tool_calls ?? []) content.push({type:'tool_use',id:call.id,name:call.function.name,input:input(call.function.arguments)});
  if (!content.length) content.push({type:'text',text:''});
  const stop={length:'max_tokens',tool_calls:'tool_use',function_call:'tool_use',content_filter:'refusal'}[choice.finish_reason] ?? 'end_turn';
  return {id:`msg_${body.id ?? 'aggregate'}`,type:'message',role:'assistant',model,content,stop_reason:stop,stop_sequence:null,
    usage:{input_tokens:body.usage?.prompt_tokens ?? 0,output_tokens:body.usage?.completion_tokens ?? 0}};
}
