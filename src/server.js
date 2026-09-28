const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const searchService = require('./services/searchService');
const { extractConditions, buildSearchQuery, needsClarification, extractHospitalCandidate } = require('./services/conditionExtractor');
const { formatUnifiedResponse } = require('./services/responseFormatter');
const { validateMedicalBoundary } = require('./services/medicalBoundary');
const { extractKnownHospital, matchHospitalInMessage } = require('./services/hospitalNames');

const ORDINAL_NUM_MAP = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

// 「重新查询/重新开始」类指令：清空会话条件，而不是当作查询词去检索
const RESET_PATTERN = /^(重新查询|重新开始|重新查|换个问题|清空|重置|清除条件|重新来|再来一次|start over)$/i;

// 序数指代解析：「第二家有电话吗」→ 承接上一轮第 2 条结果
function resolveOrdinalReference(message, session) {
  const m = message.match(/第\s*([一二两三四五六七八九十\d]+)\s*(家|个|条|位)/);
  if (!m || !session.lastResults || session.lastResults.length === 0) return null;
  const n = ORDINAL_NUM_MAP[m[1]] || parseInt(m[1], 10);
  if (!n || n < 1 || n > session.lastResults.length) return null;
  return { index: n, source: session.lastResults[n - 1] };
}

function detectFollowupIntent(message) {
  if (/电话|联系|咨询|热线/.test(message)) return { label: '联系电话', query: '联系电话 官方' };
  if (/地址|怎么走|交通|在哪|位置|地图/.test(message)) return { label: '地址交通', query: '地址 交通 官方' };
  if (/挂号|预约|门诊|出诊/.test(message)) return { label: '预约挂号', query: '预约挂号 官方' };
  return { label: '详细信息', query: '官方网站' };
}

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '600000', 10);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const sessions = new Map();
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

// 限流配置
const RATE_LIMIT = {
  windowMs: 60 * 1000, // 1分钟
  maxRequests: 30,     // 每IP每窗口最多30次
  banMs: 5 * 60 * 1000 // 超限封禁5分钟
};
const requestCounts = new Map(); // ip -> { count, resetAt, bannedUntil }

function checkRateLimit(ip) {
  const now = Date.now();
  const record = requestCounts.get(ip);

  if (record && record.bannedUntil && now < record.bannedUntil) {
    return { allowed: false, retryAfter: Math.ceil((record.bannedUntil - now) / 1000) };
  }

  if (!record || now > record.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + RATE_LIMIT.windowMs, bannedUntil: null });
    return { allowed: true };
  }

  if (record.count >= RATE_LIMIT.maxRequests) {
    record.bannedUntil = now + RATE_LIMIT.banMs;
    return { allowed: false, retryAfter: Math.ceil(RATE_LIMIT.banMs / 1000) };
  }

  record.count++;
  return { allowed: true };
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActive > SESSION_TTL) {
      sessions.delete(id);
    }
  }
}
setInterval(cleanupSessions, 60 * 60 * 1000);

function getOrCreateSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.lastActive = Date.now();
    return { sessionId, isNew: false };
  }
  const newId = sessionId || uuidv4();
  sessions.set(newId, {
    id: newId,
    conditions: {},
    history: [],
    lastResults: [],
    createdAt: Date.now(),
    lastActive: Date.now()
  });
  return { sessionId: newId, isNew: true };
}

// 健康检查
app.get('/api/health', (req, res) => {
  const stats = searchService.getStats();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    stats: {
      totalRequests: stats.total,
      successRate: stats.total > 0 ? `${Math.round(stats.success / stats.total * 100)}%` : 'N/A',
      avgDuration: `${stats.avgDuration}ms`
    },
    demoMode: process.env.DEMO_MODE !== 'false',
    cacheEnabled: true,
    rateLimitEnabled: true
  });
});

// 主聊天接口
app.post('/api/chat', async (req, res) => {
  const startTime = Date.now();
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // 限流检查
  const rateCheck = checkRateLimit(clientIp);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: `请求过于频繁，请 ${rateCheck.retryAfter} 秒后再试`,
      code: 'RATE_LIMITED',
      retryAfter: rateCheck.retryAfter
    });
  }

  try {
    const { message, sessionId: clientSessionId } = req.body;
    const { sessionId, isNew } = getOrCreateSession(clientSessionId);
    const session = sessions.get(sessionId);

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        error: '请输入有效问题',
        sessionId,
        code: 'EMPTY_INPUT'
      });
    }

    if (message.length > 2000) {
      return res.status(400).json({
        error: '问题过长，请精简至2000字以内',
        sessionId,
        code: 'INPUT_TOO_LONG'
      });
    }

    const boundaryCheck = validateMedicalBoundary(message);
    if (boundaryCheck.blocked) {
      return res.json({
        sessionId,
        response: boundaryCheck.message,
        sources: [],
        conditions: session.conditions,
        code: 'MEDICAL_BOUNDARY'
      });
    }

    // 重置指令：清空条件与结果，开始新一轮查询（不触发检索）
    if (RESET_PATTERN.test(message.trim())) {
      session.conditions = {};
      session.lastResults = [];
      const resetResponse = '好的，已为您清空上一轮的查询条件。请告诉我您想查询的医院、科室或资源，我们开始新的查询。';
      session.history.push({ role: 'user', content: message, timestamp: Date.now() });
      session.history.push({ role: 'assistant', content: resetResponse, timestamp: Date.now() });
      return res.json({
        sessionId,
        response: resetResponse,
        sources: [],
        conditions: {},
        code: 'SESSION_RESET'
      });
    }

    // 序数指代承接：「第二家有电话吗」→ 解析为上一轮第 2 条结果对应医院
    const ordinalRef = resolveOrdinalReference(message, session);
    if (ordinalRef) {
      const refHospital = extractKnownHospital(ordinalRef.source.title);
      const intent = detectFollowupIntent(message);

      if (!refHospital) {
        return res.json({
          sessionId,
          response: `您指的是上一轮结果中的第 ${ordinalRef.index} 条，但该条目并非特定医院的页面，无法据此定位医院。\n\n建议您直接告诉我医院名称，我帮您查询其${intent.label}等官方信息。`,
          sources: [],
          conditions: session.conditions,
          code: 'ORDINAL_NO_HOSPITAL'
        });
      }

      session.conditions = { hospitalName: refHospital };
      delete session.conditions.city;

      const followQuery = `${refHospital} ${intent.query}`;
      console.log(`[Ordinal] "第${ordinalRef.index}家" -> ${refHospital}, query="${followQuery}"`);
      const refResult = await searchService.search(followQuery);

      let refResponse = `【承接上轮查询】\n`;
      refResponse += `  您询问的是上一轮结果中的第 ${ordinalRef.index} 家：${refHospital}。\n`;
      refResponse += `  以下为您检索该医院的${intent.label}相关信息。\n\n`;

      if (refResult.success && refResult.sources.length > 0) {
        refResponse += `【参考来源】\n`;
        refResult.sources.slice(0, 3).forEach((s, i) => {
          const typeLabel = s.sourceType === 'official' ? '医院官网' : s.sourceType === 'government' ? '政府渠道' : s.sourceType === 'platform' ? '第三方平台' : s.sourceType === 'media' ? '公开报道' : '待核验';
          refResponse += `  ${i + 1}. ${s.title}\n     来源：${s.sourceName || ''}（${typeLabel}）\n     链接：${s.url}\n`;
        });
        refResponse += `\n【使用提示】\n`;
        refResponse += `  · ${intent.label}等信息以医院官方渠道实时公布为准，建议通过上述官方链接核实。\n`;
        refResponse += `  · 也可通过北京114预约挂号平台（https://www.114yygh.com）查询。\n`;
        session.lastResults = refResult.sources;
        session.history.push({ role: 'user', content: message, timestamp: Date.now() });
        session.history.push({ role: 'assistant', content: refResponse, timestamp: Date.now() });
        return res.json({
          sessionId,
          response: refResponse,
          sources: refResult.sources,
          conditions: session.conditions,
          code: 'SUCCESS'
        });
      }

      refResponse += `  暂未检索到该医院${intent.label}的权威公开信息，建议访问其官方网站或直接致电咨询。\n`;
      session.history.push({ role: 'user', content: message, timestamp: Date.now() });
      session.history.push({ role: 'assistant', content: refResponse, timestamp: Date.now() });
      return res.json({
        sessionId,
        response: refResponse,
        sources: [],
        conditions: session.conditions,
        code: 'SUCCESS'
      });
    }

    const extracted = extractConditions(message, session.conditions);

    // 用户明确提到名单外医院（如「宣武医院」「同仁医院」）：直接说明演示范围，不消耗检索额度
    if (extracted.unlistedHospital) {
      const name = extracted.unlistedHospital;
      const outOfScopeResponse =
        `【查询条件】您询问的机构：${name}\n\n` +
        `【查询结果】\n「${name}」不在本系统演示范围内，暂未收录其信息。\n\n` +
        `【演示范围说明】\n本系统目前仅演示北京市 6 家医院的检索能力：\n` +
        `· 公立医院：北京大学人民医院、北京协和医院、北京大学第三医院、北京天坛医院、北京清华长庚医院\n` +
        `· 民营医院：北京和睦家医院\n\n` +
        `【建议核实渠道】\n` +
        `· 可通过北京市卫生健康委官方网站查询医疗机构执业登记信息；\n` +
        `· 或通过该机构官方网站、官方公众号核实就诊安排。\n\n` +
        `· 本系统仅提供医院资源查询，不提供疾病诊断与用药建议；紧急情况请立即拨打 120。\n`;
      session.history.push({ role: 'user', content: message, timestamp: Date.now() });
      session.history.push({ role: 'assistant', content: outOfScopeResponse, timestamp: Date.now() });
      return res.json({
        sessionId,
        response: outOfScopeResponse,
        sources: [],
        conditions: session.conditions,
        code: 'OUT_OF_DEMO_SCOPE'
      });
    }

    session.conditions = { ...session.conditions, ...extracted.newConditions };

    // 如果提取到医院名称，说明用户在查询特定医院，清除城市条件避免干扰
    if (extracted.newConditions.hospitalName) {
      delete session.conditions.city;
      // 条件卫生：换了目标医院，上一轮残留的科室/资源/职称/日期一并清除（本轮新提取到的除外）
      // 避免「协和的神经科」被拼到「和睦家」头上造成张冠李戴
      if (!extracted.newConditions.department) delete session.conditions.department;
      if (!extracted.newConditions.resource) delete session.conditions.resource;
      if (!extracted.newConditions.doctorLevel) delete session.conditions.doctorLevel;
      if (!extracted.newConditions.queryDate) delete session.conditions.queryDate;
    }

    // 演示范围控制：仅覆盖 README 列出的 6 家北京医院。用户问及名单外机构时，直接说明范围并引导官方渠道，不消耗检索额度
    // 保护：如果已提取到科室/职称/资源/日期，说明是科室查询而非医院查询，不打住
    const isDeptQuery = !!(extracted.newConditions.department || extracted.newConditions.doctorLevel || extracted.newConditions.resource || extracted.newConditions.queryDate);
    if (!session.conditions.hospitalName && !isDeptQuery) {
      const candidate = extractHospitalCandidate(message);
      if (candidate) {
        const outOfScopeResponse =
          `【查询条件】您询问的机构：${candidate}\n\n` +
          `【查询结果】\n「${candidate}」不在本系统演示范围内，暂未收录其信息。\n\n` +
          `【演示范围说明】\n本系统目前仅演示北京市 6 家医院的检索能力：\n` +
          `· 公立医院：北京大学人民医院、北京协和医院、北京大学第三医院、北京天坛医院、北京清华长庚医院\n` +
          `· 民营医院：北京和睦家医院\n\n` +
          `【建议核实渠道】\n` +
          `· 可通过北京市卫生健康委官方网站查询医疗机构执业登记信息；\n` +
          `· 或通过该机构官方网站、官方公众号核实就诊安排。\n\n` +
          `· 本系统仅提供医院资源查询，不提供疾病诊断与用药建议；紧急情况请立即拨打 120。\n`;
        session.history.push({ role: 'user', content: message, timestamp: Date.now() });
        session.history.push({ role: 'assistant', content: outOfScopeResponse, timestamp: Date.now() });
        return res.json({
          sessionId,
          response: outOfScopeResponse,
          sources: [],
          conditions: {},
          code: 'OUT_OF_DEMO_SCOPE'
        });
      }
    }

    if (needsClarification(session.conditions, extracted)) {
      return res.json({
        sessionId,
        response: extracted.clarificationPrompt,
        sources: [],
        conditions: session.conditions,
        needsClarification: true,
        code: 'NEEDS_CLARIFICATION'
      });
    }

    // 构建搜索查询：基于原始消息 + 提取条件
    const searchQuery = buildSearchQuery(session.conditions, message);
    console.log(`[Search] query="${searchQuery}" from message="${message}"`);
    const searchResult = await searchService.search(searchQuery);

    if (!searchResult.success) {
      return res.json({
        sessionId,
        response: `检索过程中遇到一些问题。建议您通过医院官网或官方挂号平台查询最新信息，我也可以帮您查找相关医院的官方联系方式。`,
        sources: [],
        conditions: session.conditions,
        error: searchResult.error,
        code: 'SEARCH_FAILED'
      });
    }

    const formatted = formatUnifiedResponse(session.conditions, searchResult);
    session.lastResults = searchResult.sources;
    session.history.push({ role: 'user', content: message, timestamp: Date.now() });
    session.history.push({ role: 'assistant', content: formatted.response, timestamp: Date.now() });

    const duration = Date.now() - startTime;

    res.json({
      sessionId,
      response: formatted.response,
      sources: searchResult.sources,
      conditions: session.conditions,
      searchLog: searchResult.log,
      compareData: formatted.compareData,
      hospitals: formatted.hospitals,
      costInfo: {
        duration,
        sourceCount: searchResult.sources.length,
        provider: searchResult.provider,
        officialCount: searchResult.officialCount || 0,
        cached: searchResult.cached || false
      },
      code: 'SUCCESS'
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: '服务暂时不可用，请稍后重试。您也可以直接访问医院官网了解相关信息。',
      sessionId: req.body.sessionId,
      code: 'SERVER_ERROR'
    });
  }
});

// 会话管理
app.post('/api/session/new', (req, res) => {
  const { sessionId, isNew } = getOrCreateSession(null);
  res.json({ sessionId, isNew });
});

app.post('/api/session/clear', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && sessions.has(sessionId)) {
    sessions.delete(sessionId);
  }
  const { sessionId: newId } = getOrCreateSession(null);
  res.json({ sessionId: newId, cleared: true });
});

app.get('/api/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: '会话不存在或已过期' });
  }
  res.json({
    sessionId: session.id,
    conditions: session.conditions,
    historyCount: session.history.length,
    createdAt: new Date(session.createdAt).toISOString(),
    lastActive: new Date(session.lastActive).toISOString()
  });
});

// 检索统计
app.get('/api/stats', (req, res) => {
  const stats = searchService.getStats();
  res.json({
    ...stats,
    activeSessions: sessions.size,
    uptime: process.uptime()
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`AI便民查询就诊助手服务已启动，端口：${PORT}`);
  console.log(`演示城市：北京`);
  console.log(`环境：${process.env.NODE_ENV || 'development'}`);
  console.log(`限流：每IP每分钟 ${RATE_LIMIT.maxRequests} 次请求`);
  console.log(`缓存：${CACHE_TTL / 1000} 秒`);
});

module.exports = app;
