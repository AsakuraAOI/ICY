/**
 * QQ Bot API v2 的原始 payload 类型。
 *
 * 本文件只描述平台字段：不改名、不做加工、不丢字段。归一化后的对外结构
 * 见 core/normalize.ts 的 InboundEvent。
 *
 * 字段依据官方文档：《通用数据结构》《群@机器人消息》《群消息（全量模式）》
 * 《单聊消息事件》《发送群聊消息》。
 */

/** Gateway 上下行 payload 的统一外壳。 */
export interface GatewayPayload {
  /** 事件 id。 */
  id?: string;
  /** opcode，取值见 core/events.ts 的 Op。 */
  op: number;
  /** 事件内容，结构随 t 变化。 */
  d?: unknown;
  /** 下行消息序列号；心跳与 Resume 需要回填最新值。 */
  s?: number;
  /** 事件类型，op=0 Dispatch 时有值。 */
  t?: string;
}

/** op=10 Hello 的内容。 */
export interface HelloData {
  /** 心跳周期，单位毫秒。实测值 45000。 */
  heartbeat_interval: number;
}

/** op=0 且 t=READY 时 d 的内容。 */
export interface ReadyData {
  version: number;
  session_id: string;
  user: QQUser;
  shard: number[];
}

/**
 * 事件里的用户对象。
 *
 * 群聊场景用 member_openid，单聊场景用 user_openid。两者都不是 QQ 号，
 * 且不同 AppID 拿到的值互不相同，不能作为跨应用的永久用户主键。
 */
export interface QQUser {
  id: string;
  username?: string;
  bot?: boolean;
  /** 跨应用统一用户 OpenID，可能为空。 */
  union_openid?: string;
  /** 跨应用统一用户账号，可能为空。 */
  union_user_account?: string;
  /** 单聊场景使用的用户 OpenID。 */
  user_openid?: string;
  /** 群聊场景使用的群成员 OpenID。 */
  member_openid?: string;
  /** 群内角色：member 普通成员 / admin 管理员 / owner 群主。 */
  member_role?: string;
}

/**
 * 消息场景上下文。
 *
 * ext 是 key=value 格式的字符串数组，不是对象。已出现的键有
 * msg_idx、ref_msg_idx、auth_token。
 */
export interface MessageScene {
  /** 场景来源，default 表示默认聊天窗口。 */
  source?: string;
  ext?: string[];
}

/**
 * 消息附件。
 *
 * content_type 取值：voice 语音 / image/jpeg / image/png / image/gif /
 * video/mp4 / file 群文件。
 */
export interface MessageAttachment {
  url: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
  content_type?: string;
  /** 语音消息转码后的 WAV 文件 URL。 */
  voice_wav_url?: string;
  /** 语音消息的 ASR 参考结果。 */
  asr_refer_text?: string;
}

/** 结构化卡片数据，message_type=3 时出现。 */
export interface ARKData {
  prompt?: string;
  ark_type?: string;
  ark_name?: string;
  fields?: Record<string, unknown>;
}

/** 消息元素，可递归嵌套。 */
export interface MsgElement {
  msg_idx?: string;
  author?: QQUser;
  /** 0 普通文本 / 3 结构化卡片 / 101 并行消息 / 102 聊天记录 / 103 引用消息。 */
  message_type?: number;
  content?: string;
  attachments?: MessageAttachment[];
  ark_data?: ARKData;
  msg_elements?: MsgElement[];
}

/**
 * 群消息事件的内容。
 *
 * GROUP_AT_MESSAGE_CREATE 与 GROUP_MESSAGE_CREATE 的字段完全一致，
 * 后者只在机器人开启了「接收所有消息」后才会推送。
 */
export interface GroupMessageData {
  /** 消息 ID，用于被动回复和撤回。 */
  id: string;
  author: QQUser;
  /** 文本内容。群 @ 事件的这一字段已自动去掉 @机器人 前缀。 */
  content?: string;
  group_openid: string;
  /** 消息发送时间，RFC3339 格式。 */
  timestamp?: string;
  message_type?: number;
  message_scene?: MessageScene;
  attachments?: MessageAttachment[];
  /** 消息中 @ 的其他用户，不含 @ 机器人自身。 */
  mentions?: QQUser[];
  ark_data?: ARKData;
  msg_elements?: MsgElement[];
}

/** 单聊消息事件 C2C_MESSAGE_CREATE 的内容。 */
export interface C2CMessageData {
  id: string;
  author: QQUser;
  content?: string;
  timestamp?: string;
  message_type?: number;
  message_scene?: MessageScene;
  attachments?: MessageAttachment[];
  ark_data?: ARKData;
  msg_elements?: MsgElement[];
}

/**
 * 群 / 好友生命周期事件的内容。
 *
 * 这类事件（GROUP_ADD_ROBOT、FRIEND_ADD 等）的字段尚未在已核实的页面中
 * 逐字确认，故保持宽松，不做臆造。
 */
export type OpaqueEventData = Record<string, unknown>;

/** 内嵌键盘按钮的渲染数据。 */
export interface KeyboardButtonRenderData {
  /** 按钮文字，最多 10 字符。 */
  label: string;
  /** 点击后文字，不传则保持不变。 */
  visited_label?: string;
  /** 0 灰色线框 / 1 蓝色线框 / 3 白色背景红色字体 / 4 蓝色背景白色字体。 */
  style?: number;
}

/** 内嵌键盘按钮的点击行为。 */
export interface KeyboardButtonAction {
  /** 0 跳转按钮 / 1 回调按钮 / 2 指令按钮。 */
  type: number;
  permission?: {
    /** 0 指定用户 / 1 管理员 / 2 所有人。 */
    type: number;
    specify_user_ids?: string[];
    /** 仅频道可用。 */
    specify_role_ids?: string[];
  };
  /** type=1 或 2 时必填。 */
  data?: string;
  /** 指令按钮可用：点击后直接自动发送 data。仅单聊可用。 */
  enter?: boolean;
  /** 指令按钮可用：指令是否带引用回复本消息。 */
  reply?: boolean;
  /** 版本过低时的提示文案。 */
  unsupport_tips?: string;
  anchor?: number;
}

/** 内嵌键盘的一个按钮。 */
export interface KeyboardButton {
  /** 同一键盘内唯一。 */
  id?: string;
  render_data?: KeyboardButtonRenderData;
  action?: KeyboardButtonAction;
  /** 同一分组内有一个按钮被操作后，其他按钮变灰。仅 action.type=1 时有效。 */
  group_id?: string;
}

/** 内嵌键盘。短形式只传 id，长形式传 content.rows。 */
export interface Keyboard {
  /** 平台预设模板 ID attachment，与 content 互斥。 */
  id?: string;
  content?: { rows: { buttons: KeyboardButton[] }[] };
}

/** 发送消息请求体。群聊与单聊共用同一套字段。 */
export interface SendMessageBody {
  /** 0 文本 / 2 Markdown / 6 输入中状态（仅单聊）/ 7 富媒体。 */
  msg_type?: number;
  /** msg_type=0 时为全文。填了 markdown 后此字段必须为空。 */
  content?: string;
  /** msg_type=2 时必填。填了后 content 必须为空。 */
  markdown?: { content?: string; force_verify_image_resource?: boolean };
  /** 被动回复的消息 ID，取自事件的 d.id。群聊 5 分钟内有效。 */
  msg_id?: string;
  /** 被动回复的事件 ID，取自 payload 最外层的 id。与 msg_id 二选一。 */
  event_id?: string;
  /** 回复序号。不填默认 1；相同 msg_id + msg_seq 重复发送会失败。 */
  msg_seq?: number;
  /** msg_type=7 时填写，file_info 来自文件上传接口。 */
  media?: { file_info: string };
  /** 引用回复。 */
  message_reference?: { message_id: string };
  /** 互动召回消息，与 msg_id / event_id 互斥。 */
  is_wakeup?: boolean;
  keyboard?: Keyboard;
  /** msg_type=6 时使用，仅单聊。 */
  input_notify?: { input_type: number; input_second?: number };
}

/** 发送消息响应。 */
export interface SendMessageResponse {
  /** 消息 ID，可用于后续撤回。 */
  id: string;
  /** 发送时间，RFC3339 东八区。 */
  timestamp: string;
  ext_info?: {
    /** 引用消息索引。 */
    ref_idx?: string;
  };
}

/**
 * 机器人自身信息。
 *
 * 这里只列出已确认存在的字段，接口的完整响应结构尚未逐字核实。
 */
export interface BotSelfInfo {
  id: string;
  username?: string;
  bot?: boolean;
}
