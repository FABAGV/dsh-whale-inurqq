/**
 * OneBot 11 协议常量。
 * 依据：https://github.com/botuniverse/onebot-11 （官方规范原文见 qq-dsh-design/onebot-11/）
 */

/** 消息段类型 → 内部归一化 kind 的映射 */
export const SEGMENT_KIND = {
  text: 'text',
  image: 'image',
  record: 'record',
  video: 'video',
  at: 'at',
  reply: 'reply',
  forward: 'forward',
}

/** 需要展开才能拿到内容的段（只带 id） */
export const OPAQUE_SEGMENTS = new Set(['forward'])

/** 事件大类 */
export const POST_TYPE = {
  MESSAGE: 'message',
  NOTICE: 'notice',
  REQUEST: 'request',
  META: 'meta_event',
}

/** 消息类型 */
export const MESSAGE_TYPE = {
  PRIVATE: 'private',
  GROUP: 'group',
}

/** 私聊子类型 */
export const PRIVATE_SUB_TYPE = {
  FRIEND: 'friend',
  GROUP: 'group',
  OTHER: 'other',
}

/** 群消息子类型 */
export const GROUP_SUB_TYPE = {
  NORMAL: 'normal',
  ANONYMOUS: 'anonymous',
  NOTICE: 'notice',
}

/** META 事件子类型 */
export const META_SUB_TYPE = {
  LIFECYCLE: 'lifecycle',
  HEARTBEAT: 'heartbeat',
}

/** 通知事件类型（部分） */
export const NOTICE_TYPE = {
  GROUP_UPLOAD: 'group_upload',
  GROUP_ADMIN: 'group_admin',
  GROUP_DECREASE: 'group_decrease',
  GROUP_INCREASE: 'group_increase',
  GROUP_BAN: 'group_ban',
  FRIEND_ADD: 'friend_add',
  GROUP_RECALL: 'group_recall',
  FRIEND_RECALL: 'friend_recall',
  NOTIFY: 'notify',
  POKE: 'poke',
  LUCKY_KING: 'lucky_king',
  HONOR: 'honor',
}

/** 本插件会用到的动作 */
export const ACTION = {
  SEND_PRIVATE_MSG: 'send_private_msg',
  SEND_GROUP_MSG: 'send_group_msg',
  SEND_MSG: 'send_msg',
  GET_MSG: 'get_msg',
  GET_FORWARD_MSG: 'get_forward_msg',
  DELETE_MSG: 'delete_msg',
  GET_LOGIN_INFO: 'get_login_info',
  GET_VERSION_INFO: 'get_version_info',
  GET_FRIEND_LIST: 'get_friend_list',
  GET_GROUP_LIST: 'get_group_list',
  GET_GROUP_INFO: 'get_group_info',
  GET_GROUP_MEMBER_INFO: 'get_group_member_info',
  GET_GROUP_MEMBER_LIST: 'get_group_member_list',
  GET_STRANGER_INFO: 'get_stranger_info',
  GET_STATUS: 'get_status',
}

/** OneBot 响应状态 */
export const STATUS = {
  OK: 'ok',
  FAILED: 'failed',
}

/**
 * 构造一个文本消息段。
 * @param {string} text
 */
export function textSegment(text) {
  return { type: 'text', data: { text: String(text) } }
}

/**
 * 把内部 Segment 数组转回 OneBot 消息段数组（用于发送）。
 * @param {import('./types.js').Segment[]} segments
 */
export function toOneBotSegments(segments) {
  const out = []
  for (const seg of segments) {
    switch (seg.kind) {
      case 'text':
        out.push({ type: 'text', data: { text: seg.text } })
        break
      case 'image':
        out.push({ type: 'image', data: { file: seg.file } })
        break
      case 'at':
        out.push({ type: 'at', data: { qq: String(seg.qq) } })
        break
      case 'reply':
        out.push({ type: 'reply', data: { id: String(seg.messageId) } })
        break
      default:
        // record/video/other 暂不回发
        break
    }
  }
  return out
}
