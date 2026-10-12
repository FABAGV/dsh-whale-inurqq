/**
 * @typedef {object} TextSegment
 * @property {'text'} kind
 * @property {string} text
 *
 * @typedef {object} MediaSegment
 * @property {'image'|'record'|'video'} kind
 * @property {string} file
 * @property {string} [url]
 *
 * @typedef {object} AtSegment
 * @property {'at'} kind
 * @property {string} qq
 *
 * @typedef {object} ReplySegment
 * @property {'reply'} kind
 * @property {string} messageId
 *
 * @typedef {object} ForwardSegment
 * @property {'forward'} kind
 * @property {string} id
 *
 * @typedef {object} OtherSegment
 * @property {'other'} kind
 * @property {string} type
 * @property {unknown} data
 *
 * @typedef {TextSegment|MediaSegment|AtSegment|ReplySegment|ForwardSegment|OtherSegment} Segment
 *
 * @typedef {object} QQMessage
 * @property {'qq'} platform
 * @property {string} selfId
 * @property {'private'|'group'} chatType
 * @property {string} chatId
 * @property {string} [chatName]
 * @property {string} messageId
 * @property {string} senderId
 * @property {string} senderName
 * @property {'owner'|'admin'|'member'} [senderRole]
 * @property {string} [subType]
 * @property {{id: string, name: string}} [anonymous]
 * @property {number} ts
 * @property {Segment[]} segments
 * @property {boolean} atBot
 * @property {unknown} [raw]
 *
 * @typedef {object} ForwardNode
 * @property {string} senderName
 * @property {string} [senderId]
 * @property {number} [ts]
 * @property {Segment[]} segments
 *
 * @typedef {object} ForwardRecord
 * @property {string} id
 * @property {ForwardNode[]} nodes
 */

export {}
