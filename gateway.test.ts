import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { anthropicToOpenAI, openAIToAnthropic, sseEvent } from './lib/wire.ts';

test('outside a trial the entry prints an empty catalog and exits successfully', () => {
  const env={...process.env};delete env.MAKEFUN_ENV_URL;delete env.MAKEFUN_PROMPT_FILE;
  for (const args of [[],['--list']]) {
    const result=spawnSync(process.execPath,['main.ts',...args],{env,encoding:'utf8'});
    assert.equal(result.status,0);assert.equal(result.stdout,'{"providers":[]}\n');
  }
});
test('Anthropic conversion preserves images, tools, history, stops and output cap', () => {
  const request={system:[{type:'text',text:'system one'},{type:'text',text:'system two'}],max_tokens:73,stop_sequences:['END'],stream:true,
    tools:[{name:'lookup',description:'Find an item',input_schema:{type:'object',properties:{id:{type:'string'}}}}],
    tool_choice:{type:'tool',name:'lookup'},messages:[
      {role:'assistant',content:[{type:'tool_use',id:'call_a',name:'lookup',input:{id:'a'}}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:'call_a',content:'found'}]},
      {role:'user',content:[{type:'text',text:'inspect this'},{type:'image',source:{type:'base64',media_type:'image/png',data:'YWJj'}}]}
    ]};
  const converted=anthropicToOpenAI(request,'free-model');
  assert.equal(converted.model,'free-model');assert.equal(converted.max_tokens,73);
  assert.deepEqual(converted.stop,['END']);assert.equal(converted.messages[0].content,'system one\nsystem two');
  assert.equal(converted.messages[1].tool_calls[0].function.arguments,'{"id":"a"}');
  assert.equal(converted.messages[2].tool_call_id,'call_a');
  assert.equal(converted.messages[3].content[1].image_url.url,'data:image/png;base64,YWJj');
  assert.deepEqual(converted.tools[0].function.parameters,request.tools[0].input_schema);
  assert.equal(converted.tool_choice.function.name,'lookup');assert.equal(converted.stream_options.include_usage,true);
});
test('completion conversion preserves usage, tool arguments and stop reasons', () => {
  for (const [finish,stop] of [['stop','end_turn'],['length','max_tokens'],['tool_calls','tool_use'],['content_filter','refusal']]) {
    const answer=openAIToAnthropic({id:'fixed',usage:{prompt_tokens:17,completion_tokens:9},choices:[{finish_reason:finish,message:{content:'whole answer',tool_calls:[{id:'a',function:{name:'lookup',arguments:'{"id":"a"}'}}]}}]},'free-model');
    assert.equal(answer.stop_reason,stop);assert.equal(answer.content[0].text,'whole answer');
    assert.deepEqual(answer.content[1].input,{id:'a'});assert.deepEqual(answer.usage,{input_tokens:17,output_tokens:9});
  }
});
test('SSE frames have named events and escaped newlines', () => {
  assert.equal(sseEvent('message_stop',{type:'message_stop'}),'event: message_stop\ndata: {"type":"message_stop"}\n\n');
  assert.equal(sseEvent(null,{text:'a\nb'}),'data: {"text":"a\\nb"}\n\n');
});
