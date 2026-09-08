// redact.js — 日志/反馈/诊断文本脱敏（借鉴 dsh-desktop 的 mask-secrets 思路，纯函数、零依赖）
// 覆盖：sk- 风格 key、JWT、长 hex/base64 token、Authorization/Bearer/Basic/token 等鉴权头（含多值 Cookie）、
//      URL 内联凭据、敏感 query 值。
// 原则：宁可漏判不可误删（只匹配高置信度形态），版本号/短 hex/时间戳/普通 URL 不受影响。
'use strict'

// 匹配 sk- 开头 + 足够熵的 key（DeepSeek/OpenAI 风格；容忍 - / _ . 分隔）
const RE_SK = /(sk-[A-Za-z0-9_.-]{16,})/g
// JWT（三段 base64url；含段可短于 40 字符的标准最小 JWT）——必须在 base64 规则之前整段替换
const RE_JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}/g
// 长 hex（≥32 位：md5 以上级别，覆盖 token/指纹，不误伤 8 位色值/短 id）
const RE_HEX = /\b[0-9a-fA-F]{32,}\b/g
// 长 base64（≥32 字符 + 0-2 个 = 填充）——要求「字母+数字」混合（排除纯数字/纯字母的长串），
// 降低对普通长标识的误伤；字符类不含 - _（base64url 标识符/路径的常见形态，误伤面大）。
const RE_B64 = /(?<![:/\\])\b(?=[A-Za-z0-9+/]{32,}={0,2}\b)(?=[A-Za-z0-9+/]*[A-Za-z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{32,}={0,2}\b/g
// URL 内联凭据 user:pass@
const RE_URL_CRED = /(https?:\/\/)([^@\s/:]+):([^@\s/]+)@/g
// 鉴权头：值整段替换（含 token/bearer/basic 等 scheme 前缀）。组1 = 头部名与冒号/等号，用于 $1***
const RE_AUTH_HEADER = /((?:authorization|proxy-authorization|x-api-key|api-key|apikey)\s*[:=]\s*)(?:[A-Za-z][\w-]*\s+)?([^\s;,'"]{4,})/gi
// Cookie / Set-Cookie：整段值替换（多值 `a=b; sessionid=…` 也要一起吃掉）
const RE_COOKIE = /((?:set-)?cookie\s*[:=]\s*)([^\r\n]+)/gi
// bearer/basic/token scheme 前缀 + token（无头部名时兜底）
const RE_BEARER = /(\b(?:bearer|basic|token)\s+)([A-Za-z0-9._~+/=-]{16,})/gi
// 敏感 query 参数值（key/token/secret/password/签名等）
const RE_QUERY = /([?&](?:key|token|api[_-]?key|secret|password|passwd|access[_-]?token|auth|sig|signature|code)=)[^&\s"'<>]+/gi

/**
 * 对一段文本做脱敏。输入非字符串时原样返回（调用方保证传入字符串亦可）。
 * @param {string} text
 * @returns {string}
 */
function redact(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  let s = text
  s = s.replace(RE_URL_CRED, '$1***@')
  s = s.replace(RE_SK, 'sk-***')
  s = s.replace(RE_JWT, '***')
  s = s.replace(RE_AUTH_HEADER, '$1***')
  s = s.replace(RE_COOKIE, '$1***')
  s = s.replace(RE_BEARER, '$1***')
  s = s.replace(RE_QUERY, '$1***')
  s = s.replace(RE_B64, '***')
  s = s.replace(RE_HEX, '***')
  return s
}

module.exports = { redact }
