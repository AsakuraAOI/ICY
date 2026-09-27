import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadManifest } from '../dist/host/manifest.js';
import { PluginCatalog } from '../dist/host/registry.js';
import { Supervisor } from '../dist/host/supervisor.js';

// 启动真实 app-runtime 子进程，使用隔离配置，不读取生产状态或调用 LLM。
const base = await loadManifest(resolve('plugins/app-runtime'));
let sequence = 0;
function group(content, patch = {}) {
  sequence++;
  return { kind:'group', eventType:'GROUP_MESSAGE_CREATE', eventId:`trigger-event-${sequence}`,
    messageId:`trigger-message-${sequence}`, seq:sequence, groupOpenid:'test-group',
    senderId:'test-user', senderIdSource:'member_openid', content, raw:{}, ...patch };
}
for (const [enabled, keywordsEnabled] of [[true, true], [false, true], [true, false]]) {
  const manifest = structuredClone(base);
  manifest.config = {
    groupMentionId:'test-mention', groupCommandsWithoutMention:enabled,
    modules:[
      { path:'../../dist/modules/llm/module.js', config:{} },
      { path:'../../dist/modules/agent/policy.js', config:{ allowedGroups:['test-group', 'other-allowed-group'], blockedUsers:['blocked'], allowC2c:true, enabledTools:['calculator_evaluate'] } },
      '../../dist/modules/agent/tools-module.js',
      { path:'../../dist/modules/agent/tools-basic.js', config:{ knowledge:[] } },
      '../../dist/modules/agent/engine-module.js',
      { path:'../../dist/modules/agent-runtime/runs.js', config:{ enabled:false } },
      '../../dist/modules/commands/module.js',
      { path:'../../dist/modules/utility/module.js', config:{ enabled:true } },
      '../../dist/modules/agent-chat/commands.js',
      { path:'../../dist/modules/auto-reply/module.js', config:{ enabled:keywordsEnabled, rules:[
        { id:'hello', keyword:'你好', match:'exact', reply:'你好呀', scopes:['group'], groupOpenids:['test-group'], cooldownSeconds:60 },
        { id:'weather', keyword:'天气', match:'contains', reply:'天气很好', scopes:['group'], groupOpenids:[], cooldownSeconds:0 },
        { id:'private', keyword:'私聊专用', match:'exact', reply:'私聊回复', scopes:['c2c'], groupOpenids:[], cooldownSeconds:0 },
        { id:'limited', keyword:'限定群', match:'exact', reply:'限定回复', scopes:['group'], groupOpenids:['other-allowed-group'], cooldownSeconds:0 },
        { id:'first', keyword:'先后', match:'contains', reply:'第一条', scopes:['group'], groupOpenids:[], cooldownSeconds:0 },
        { id:'second', keyword:'先后', match:'exact', reply:'第二条', scopes:['group'], groupOpenids:[], cooldownSeconds:0 },
        { id:'slash', keyword:'/calc 1+2*3', match:'exact', reply:'错误的命令接管', scopes:['group'], groupOpenids:[], cooldownSeconds:0 },
      ] } },
    ],
  };
  const catalog = new PluginCatalog([manifest]);
  const supervisor = new Supervisor(catalog, {
    catalog, bot:{ id:'test-bot' }, log:()=>{},
    onReply:async()=>({ ok:false, reason:'unused', detail:'仅检查返回值' }),
    onSend:async()=>({ ok:false, detail:'不发送真实消息' }),
    onRecall:async()=>({ ok:false, reason:'unused', detail:'不撤回真实消息' }),
  });
  try {
    await supervisor.startAll();
    assert.equal(supervisor.stateOf('app-runtime'), 'running');
    const endpoint = supervisor.endpoints()[0];
    const dispatch = event => endpoint.dispatch(event, null);
    const plain = await dispatch(group('/calc 1+2*3'));
    if (enabled) {
      assert.equal(plain.message.text, '结果：7');
      assert.equal((await dispatch(group('  /CALC 3 * 5  '))).message.text, '结果：15');
      assert.match((await dispatch(group('/calc'))).message.text, /用法/);
      assert.match((await dispatch(group('/roll 1d6'))).message.text, /^1d6/);
      assert.match((await dispatch(group('/whoami'))).message.text, /test-user/);
      assert.match((await dispatch(group('/calc 1+2', { groupOpenid:'outside-group' }))).message.text, /没有执行.*权限/);
      assert.match((await dispatch(group('/calc 1+2', { senderId:'blocked' }))).message.text, /没有执行.*权限/);
      for (const content of ['普通消息', '有人知道 /calc 1+2 吗', '/unknown', '/calculator 1+2', '/remember hi', '<@other-bot> /calc 1+2']) {
        assert.equal(await dispatch(group(content)), null, `未 @ 的非注册命令应忽略：${content}`);
      }
      assert.equal(await dispatch(group('/calc 1+2', { senderIsBot:true })), null);
    } else assert.equal(plain, null, '关闭开关后免 @ 命令应不触发');
    if (keywordsEnabled) {
      assert.equal((await dispatch(group('  你好  '))).message.text, '你好呀');
      assert.equal(await dispatch(group('你好')), null, '关键词冷却期间应保持静默');
      assert.equal((await dispatch(group('今天天气怎么样'))).message.text, '天气很好');
      assert.equal((await dispatch(group('先后'))).message.text, '第一条', '按顺序匹配第一条规则');
      assert.equal((await dispatch(group('限定群', { groupOpenid:'other-allowed-group' }))).message.text, '限定回复');
      assert.equal(await dispatch(group('限定群')), null, '规则指定群应在入站识别时生效');
      assert.equal(await dispatch(group('你好', { groupOpenid:'other-allowed-group' })), null);
      assert.equal(await dispatch(group('私聊专用')), null, '私聊规则不得在群触发');
      assert.equal(await dispatch(group('天气', { groupOpenid:'outside-group' })), null, '关键词不能越过群白名单');
      assert.equal(await dispatch(group('天气', { senderId:'blocked' })), null, '关键词不能越过封禁');
      assert.equal(await dispatch(group('天气', { senderIdSource:undefined })), null, '身份缺失不得回复');
      assert.equal((await dispatch({ ...group('私聊专用'), kind:'c2c', eventType:'C2C_MESSAGE_CREATE',
        userOpenid:'test-user', senderIdSource:'user_openid' })).message.text, '私聊回复');
      assert.equal((await dispatch(group('<@test-mention> 天气'))).message.text, '天气很好');
    } else {
      for (const content of ['你好', '天气', '先后']) assert.equal(await dispatch(group(content)), null, '停用插件后关键词不得免 @ 触发');
    }
    assert.equal(await dispatch(group('普通消息')), null);
    assert.equal(await dispatch(group('你好啊')), null, '完全匹配不得误触发');
    assert.equal(await dispatch(group('天气', { senderIsBot:true })), null, '不得回复机器人自己的消息');
    assert.equal((await dispatch(group('<@test-mention> /calc 1+2'))).message.text, '结果：3');
    assert.equal((await dispatch(group('/calc 1+2', { eventType:'GROUP_AT_MESSAGE_CREATE' }))).message.text, '结果：3');
    assert.equal((await dispatch({ ...group('/calc 1+2'), kind:'c2c', eventType:'C2C_MESSAGE_CREATE',
      userOpenid:'test-user', senderIdSource:'user_openid' })).message.text, '结果：3');
  } finally { await supervisor.stopAll(); }
}
console.log('GROUP TRIGGERS OK：真实插件入口、命令免 @、关键词匹配/范围/冷却/停用、群/用户授权、@消息和私聊');
