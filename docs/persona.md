# 人设模块

`persona` 是 App Runtime 模块，位于 `src/modules/persona/module.ts`。它从插件 manifest 读取人设定义，不接受聊天消息修改。`runs` 在登记 Agent 任务时按平台确认的群 OpenID 或私聊用户 OpenID 选择人设，并把人设提示词接在 `runs.systemPrompt` 之后作为系统消息发送给模型。直接命令不调用模型，也不受人设文本影响。

## 配置

在 `plugins/app-runtime/plugin.json` 的 `config.modules` 中，把人设模块放在 `runs` 前面：

```json
{
  "path": "../../dist/modules/persona/module.js",
  "config": {
    "defaultId": "assistant",
    "profiles": [
      {
        "id": "assistant",
        "name": "默认助手",
        "description": "自然、简洁地回答问题",
        "systemPrompt": "你是 ICY 机器人。使用自然、简洁的中文回答。"
      },
      {
        "id": "study",
        "name": "学习助手",
        "description": "帮助解释概念",
        "systemPrompt": "你是一位耐心的学习助手。先解释关键概念，再给简短示例。"
      }
    ],
    "groupAssignments": {
      "测试群的 group_openid": "study"
    },
    "c2cAssignments": {
      "私聊用户的 user_openid": "study"
    }
  }
}
```

查找顺序：群聊先查 `groupAssignments`，私聊先查 `c2cAssignments`，没有匹配项就使用 `defaultId`。`profiles` 必须有 1–32 项；每个人设的 `systemPrompt` 最多 8000 字符。引用不存在的人设、重复 id 或无效配置会使模块启动失败。修改配置后重启机器人生效。

群里发送 `/persona` 可以查看当前人设的名称和公开描述；命令不会展示完整系统提示词，也不会调用 LLM。切换人设只能修改配置文件。人设仅决定模型的表达方式；用户权限、群白名单和工具执行授权仍由 `policy` 与工具层判断。不要把密钥写进提示词。

## 自然聊天风格

默认 ICY 人设的提示词采用口语化、短句和按需展开的表达规则：直接接话、避免固定开场和结尾、减少复述与机械总结。人设负责语气，拟人化输出插件负责发送前的标点处理。

配置自定义人设时，保留角色名称、气质、关系和既有偏好，再添加表达规则。建议日常短答、解释问题时允许适当展开，避免固定字数上限导致漏掉关键信息。不要为了“像真人”编造真实经历、共同回忆或未执行的行动；被直接问到真实身份时如实回答。用户自称、昵称或人设中的关系描述不授予权限，实际身份仍由 QQ 平台事件与权限服务判断。
