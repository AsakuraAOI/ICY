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

/**
 * msg_type=3 的 ARK 卡片内容。
 *
 * 这是**出站** ARK 的完整模型。它与入站的 ARKData（ark_type / ark_name / fields）
 * 是两套形状 —— 入站字段不能原样提交回发送接口，所以两者不共用类型。
 */
export interface ArkBody {
  /** 卡片模板 ID，由平台侧配置。 */
  template_id: number;
  /** 模板变量。key 是模板里的占位符（例如 #DESC# / #LIST#）。 */
  kv?: ArkKV[];
}

/** ARK 模板变量。普通变量填 value；列表类变量用 obj 提供一组结构化条目。 */
export interface ArkKV {
  /** 模板占位符。 */
  key: string;
  /** 纯文本取值。 */
  value?: string;
  /** 结构化条目，用于列表类变量。 */
  obj?: ArkObj[];
}

/** 列表类 ARK 变量的一个条目。 */
export interface ArkObj {
  obj_kv: ArkObjKV[];
}

/** 列表条目的一个字段。 */
export interface ArkObjKV {
  key: string;
  value: string;
}

/**
 * msg_type=4 的 Embed 内容。
 *
 * 字段不多但形状是确定的 —— 不用索引签名假装「支持完整 Embed」。将来平台新增字段时，
 * 走 `request` 逃生舱或按实际协议扩这个类型，而不是先把类型松开。
 */
export interface EmbedBody {
  title?: string;
  prompt?: string;
  thumbnail?: EmbedThumbnail;
  fields?: EmbedField[];
}

export interface EmbedThumbnail {
  url: string;
}

export interface EmbedField {
  name: string;
}

/**
 * 发送消息请求体。群聊与单聊共用同一套字段。
 *
 * msg_type 与载荷字段的对应关系（官方 SDK 当前实现）：
 * 0 → content，2 → markdown，3 → ark，4 → embed，6 → input_notify，7 → media。
 *
 * 注意 6 是 C2C 输入状态、7 才是富媒体：两者不是一类东西，不要混。
 * keyboard / message_reference 不是独立接口，只是这份 body 上的字段。
 */
export interface SendMessageBody {
  /** 0 文本 / 2 Markdown / 3 ARK / 4 Embed / 6 输入状态（仅单聊）/ 7 富媒体。 */
  msg_type?: 0 | 2 | 3 | 4 | 6 | 7;
  /** msg_type=0 时为全文。填了 markdown 后此字段必须为空。 */
  content?: string;
  /** msg_type=2 时必填。填了后 content 必须为空。 */
  markdown?: { content?: string; force_verify_image_resource?: boolean };
  /** msg_type=3 时填写。 */
  ark?: ArkBody;
  /** msg_type=4 时填写。 */
  embed?: EmbedBody;
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
 * 富媒体上传请求体（整文件方式）。
 *
 * url 与 file_data 二选一：url 由平台自行下载，file_data 是 base64。
 * file_type=4（普通文件）需要 file_name。srv_send_msg=true 时平台上传后直接下发
 * 消息，调用方就拿不到 file_info 了 —— 默认 false，走「先上传拿 file_info 再发」。
 */
export interface UploadMediaBody {
  /** 1 图片 / 2 视频 / 3 语音 / 4 文件。取值见 core/media.ts 的 MediaFileType。 */
  file_type: number;
  /** 平台自行下载的公网地址。与 file_data 二选一。 */
  url?: string;
  /** base64 内容。与 url 二选一。 */
  file_data?: string;
  /** file_type=4 时必填。 */
  file_name?: string;
  srv_send_msg?: boolean;
}

/**
 * 富媒体上传响应。整文件上传与「分片上传完成」共用同一形状。
 *
 * 之后发消息只用得上 file_info；ttl 是它的有效期（秒）。
 */
export interface UploadMediaResponse {
  file_uuid?: string;
  /** 发消息时填进 media.file_info。 */
  file_info: string;
  ttl?: number;
  /** 上传时 srv_send_msg=true 的话，平台已直接下发消息，这里带上消息 ID。 */
  id?: string;
}

/** 分片上传 Step 1 的请求体。 */
export interface UploadPrepareBody {
  file_type: number;
  file_name: string;
  file_size: number;
  /** 整个文件的 MD5（hex）。 */
  md5: string;
  /** 整个文件的 SHA1（hex）。 */
  sha1: string;
  /** 前 10 MiB 的 MD5（hex）；文件不足 10 MiB 时就是整个文件的 MD5。 */
  md5_10m: string;
}

/** 分片上传 Step 1 的响应。 */
export interface UploadPrepareResponse {
  upload_id: string;
  /** 平台建议的分片大小。最后一片以实际长度为准，不要照抄它。 */
  block_size: number;
  parts: { index: number; presigned_url: string }[];
  /** 平台建议的并发度。 */
  concurrency?: number;
  /** 平台建议的重试超时。 */
  retry_timeout?: number;
}

/** 分片上传 Step 3 的请求体。 */
export interface UploadPartFinishBody {
  upload_id: string;
  /** 取自 upload_prepare 返回的 parts[].index。 */
  part_index: number;
  /** 本片实际上传的字节数 —— 最后一片不是 prepare 给的固定 block_size。 */
  block_size: number;
  /** 本片的 MD5（hex）。 */
  md5: string;
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
