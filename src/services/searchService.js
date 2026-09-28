const BOCHA_API_KEYS = (process.env.BOCHA_API_KEY || '').split(',').filter(k => k.trim());
const TAVILY_API_KEYS = (process.env.TAVILY_API_KEY || '').split(',').filter(k => k.trim());
const DEMO_MODE = process.env.DEMO_MODE !== 'false';

// 官方来源白名单：6 家演示医院官网 + 卫健委/政府平台
const OFFICIAL_DOMAINS = [
  // 6 家演示医院官网
  'pkuph.cn', 'www.pkuph.cn',
  'pumch.cn', 'www.pumch.cn',
  'by3th.cn', 'www.by3th.cn', 'pkuh3.cn', 'www.pkuh3.cn',
  'bjtth.org', 'www.bjtth.org',
  'btch.edu.cn', 'www.btch.edu.cn',
  'ufh.com.cn', 'www.ufh.com.cn',
  // 政府/卫健委
  'nhc.gov.cn', 'www.nhc.gov.cn',
  'wjw.beijing.gov.cn',
  'beijing.gov.cn',
  'gov.cn',
];

// 第三方健康/挂号平台（非官方，单独标记）
const THIRD_PARTY_PLATFORMS = [
  'haodf.com', 'www.haodf.com',
  'guahao.com', 'www.guahao.com',
  'dxy.cn', 'www.dxy.cn',
  'wedoctor.com.cn', 'www.wedoctor.com.cn',
  '120ask.com', 'www.120ask.com',
  'fudankerui.com', 'www.fudankerui.com',
];

// 政府渠道域名
const GOVERNMENT_DOMAINS = [
  'nhc.gov.cn', 'wjw.beijing.gov.cn', 'beijing.gov.cn', 'gov.cn',
  '114yygh.com', 'bjguahao.gov.cn',
];

// 已知非官方来源（新闻媒体、自媒体、健康内容聚合站等，降低权重但保留）
const MEDIA_DOMAINS = [
  'sina.com.cn', 'sohu.com', '163.com', 'qq.com',
  'baidu.com', 'toutiao.com', 'ifeng.com',
  'cctv.com', 'people.com.cn', 'xinhuanet.com',
  // 健康内容聚合站（非医院官方）
  'fh21.com.cn', 'xywy.com', '39.net', 'bohe.cn',
  'familydoctor.com.cn', 'youlai.cn', 'yilianmeiti.com',
  '99.com.cn', 'myy.cn', 'med66.com', 'hospitals99.com',
];

let bochaKeyIndex = 0;
let tavilyKeyIndex = 0;
const requestLog = [];
const searchCache = new Map();
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '600000', 10); // 默认10分钟

function getNextKey(keys, type) {
  if (keys.length === 0) return null;
  const idx = type === 'bocha' ? bochaKeyIndex++ : tavilyKeyIndex++;
  return keys[idx % keys.length].trim();
}

function logRequest(provider, query, status, duration, sourceCount, cost) {
  const entry = {
    timestamp: new Date().toISOString(),
    provider,
    query: query.substring(0, 100),
    status,
    duration,
    sourceCount,
    cost,
    keyIndex: provider === 'bocha' ? bochaKeyIndex - 1 : tavilyKeyIndex - 1
  };
  requestLog.push(entry);
  if (requestLog.length > 2000) requestLog.shift();
  return entry;
}

function classifySource(url, sourceName) {
  const domain = extractDomain(url);
  const name = (sourceName || '').toLowerCase();
  
  // 政府/卫健委渠道
  if (GOVERNMENT_DOMAINS.some(d => domain.includes(d) || name.includes(d.replace('www.', '')))) {
    return 'government';
  }
  
  // 医院官网（域名匹配）
  if (OFFICIAL_DOMAINS.some(d => domain.includes(d))) {
    return 'official';
  }

  // 第三方健康/挂号平台（先于关键词匹配，避免标题含医院名被误判为官网）
  if (THIRD_PARTY_PLATFORMS.some(d => domain.includes(d))) {
    return 'platform';
  }

  // 媒体/健康内容聚合站（先于关键词匹配，避免标题含医院名被误判为官网）
  if (MEDIA_DOMAINS.some(d => domain.includes(d))) {
    return 'media';
  }

  // 通过医院名称关键词匹配官方来源
  const hospitalKeywords = ['医院', '附属', '中医', '协和', '天坛', '宣武', '同仁', '人民医院', '朝阳医院', '地坛医院', '佑安医院', '301医院', '302医院'];
  if (hospitalKeywords.some(k => name.includes(k) || domain.includes(k))) {
    return 'official';
  }

  // 域名含 edu.cn 且 snippet 含医院关键词 → 高校附属页面，视为官方相关
  if (domain.includes('edu.cn') || domain.includes('ac.cn')) {
    return 'official';
  }

  return 'uncertain';
}

function scoreSource(source) {
  let score = 0;
  const type = source.sourceType || classifySource(source.url, source.sourceName);
  source.sourceType = type;

  if (type === 'government') score += 100;
  else if (type === 'official') score += 80;
  else if (type === 'platform') score += 45;
  else if (type === 'media') score += 30;
  else score += 10;

  // 有发布时间加分
  if (source.publishedTime) {
    const pubDate = new Date(source.publishedTime);
    const now = new Date();
    const daysDiff = (now - pubDate) / (1000 * 60 * 60 * 24);
    if (daysDiff < 30) score += 20;
    else if (daysDiff < 90) score += 10;
    else if (daysDiff < 365) score += 5;
  }

  // snippet 中包含查询关键词加分
  if (source.snippet && source.snippet.length > 20) score += 5;

  return score;
}

function crossCheckSources(sources) {
  // 交叉核验：同名医院多个来源对比
  const hospitalMap = new Map();
  for (const s of sources) {
    const hospital = extractHospitalName(s.title, s.snippet);
    if (!hospital) continue;
    if (!hospitalMap.has(hospital)) {
      hospitalMap.set(hospital, { sources: [], types: new Set() });
    }
    hospitalMap.get(hospital).sources.push(s);
    hospitalMap.get(hospital).types.add(s.sourceType);
  }

  // 标记冲突和单一来源
  for (const [hospital, data] of hospitalMap) {
    if (data.types.size === 1 && data.types.has('media')) {
      data.sources.forEach(s => {
        s.crossCheck = 'single_media_source';
        s.crossCheckNote = '该信息仅见于公开报道，建议通过医院官方渠道进一步核实';
      });
    } else if (data.types.size >= 2) {
      data.sources.forEach(s => {
        s.crossCheck = 'multi_source_confirmed';
      });
    }
  }

  return sources;
}

const { extractKnownHospital } = require('./hospitalNames');

function extractHospitalName(title, snippet) {
  // 仅匹配已知医院名单，禁止从网页标题正则编造（如"北京治疗脑卒中三甲医院"）
  return extractKnownHospital(title, snippet);
}

function getCacheKey(query) {
  return `q:${query}`;
}

function getCached(query) {
  const key = getCacheKey(query);
  const cached = searchCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.time > CACHE_TTL) {
    searchCache.delete(key);
    return null;
  }
  return { ...cached.data, cached: true, cachedAt: new Date(cached.time).toISOString() };
}

function setCached(query, data) {
  const key = getCacheKey(query);
  searchCache.set(key, { data, time: Date.now() });
  if (searchCache.size > 500) {
    const first = searchCache.keys().next().value;
    searchCache.delete(first);
  }
}

function getDemoSources(query) {
  const city = query.includes('北京') ? '北京' : '北京';
  const isStroke = query.includes('卒中');
  const isSnake = query.includes('蛇毒');
  const isENT = query.includes('耳鼻喉');
  const isFever = query.includes('发热');
  const isEmergency = query.includes('急诊');
  const isDoctor = /(主任医师|副主任医师|专家|主任|医生)/.test(query);

  const makeDemo = (title, url, snippet, sourceName) => ({
    title, url, snippet, sourceName,
    publishedTime: null, provider: 'demo',
    sourceType: classifySource(url, sourceName),
    crossCheck: 'demo_data',
    crossCheckNote: '演示数据，仅供界面功能展示'
  });

  if (isStroke) {
    return [
      makeDemo(`${city}天坛医院卒中中心`, 'https://www.bjtth.org', '首都医科大学附属北京天坛医院，国家神经系统疾病临床医学研究中心，建有国家级卒中中心，开设卒中绿色通道', 'bjtth.org'),
      makeDemo(`${city}协和医院神经科`, 'https://www.pumch.cn', '北京协和医院神经科，国家重点学科，开设脑血管病专业门诊', 'pumch.cn'),
      makeDemo(`北京大学人民医院神经内科`, 'https://www.pkuph.cn', '北京大学人民医院神经内科，开设脑血管病门诊，具备卒中救治能力', 'pkuph.cn')
    ];
  }
  if (isSnake) {
    return [
      makeDemo(`${city}协和医院急诊科`, 'https://www.pumch.cn', '北京协和医院急诊科，24小时接诊，具备蛇咬伤救治能力，建议就诊前电话确认抗蛇毒血清库存', 'pumch.cn'),
      makeDemo(`北京大学人民医院急诊科`, 'https://www.pkuph.cn', '北京大学人民医院急诊科，24小时开诊，可处理蛇咬伤等急症，建议提前电话确认血清备货', 'pkuph.cn'),
      makeDemo(`${city}天坛医院急诊科`, 'https://www.bjtth.org', '北京天坛医院急诊科，24小时接诊各类急危重症，特殊药品库存建议电话确认', 'bjtth.org')
    ];
  }
  if (isENT) {
    return [
      makeDemo(`${city}协和医院耳鼻喉科`, 'https://www.pumch.cn', '北京协和医院耳鼻喉科，协和医院传统优势科室，开设各类耳鼻咽喉疾病诊疗', 'pumch.cn'),
      makeDemo(`北京大学第三医院耳鼻喉科`, 'https://www.by3th.cn', '北医三院耳鼻喉科，集医疗教学科研为一体的现代化科室', 'by3th.cn'),
      makeDemo(`北京大学人民医院耳鼻喉科`, 'https://www.pkuph.cn', '北京大学人民医院耳鼻喉科，开设耳科、鼻科、咽喉科等专业门诊', 'pkuph.cn')
    ];
  }
  if (isFever) {
    return [
      makeDemo(`${city}协和医院发热门诊`, 'https://www.pumch.cn', '北京协和医院发热门诊，24小时接诊，感染性疾病诊治能力完备', 'pumch.cn'),
      makeDemo(`北京大学人民医院发热门诊`, 'https://www.pkuph.cn', '北京大学人民医院发热门诊，全天候接诊，就诊前建议通过官方渠道确认', 'pkuph.cn'),
      makeDemo(`${city}清华长庚医院发热门诊`, 'https://www.btch.edu.cn', '北京清华长庚医院发热门诊，设有感染性疾病诊疗单元，接诊发热患者', 'btch.edu.cn')
    ];
  }
  if (isEmergency) {
    return [
      makeDemo(`${city}协和医院急诊科`, 'https://www.pumch.cn', '北京协和医院急诊科，24小时接诊各类急危重症患者', 'pumch.cn'),
      makeDemo(`北京大学人民医院急诊科`, 'https://www.pkuph.cn', '北京大学人民医院急诊科，国家级临床重点专科，24小时开诊', 'pkuph.cn'),
      makeDemo(`${city}和睦家医院急诊科`, 'https://www.ufh.com.cn', '北京和睦家医院急诊科，24小时接诊，提供中英双语服务，国际标准急诊流程', 'ufh.com.cn')
    ];
  }
  if (isDoctor) {
    return [
      makeDemo(`${city}协和医院专家门诊`, 'https://www.pumch.cn', '北京协和医院主任医师、副主任医师出诊信息，可通过官方App、114预约挂号', 'pumch.cn'),
      makeDemo(`北京大学人民医院的专家门诊预约`, 'https://www.pkuph.cn', '北京大学人民医院知名专家门诊、特需门诊预约指南', 'pkuph.cn'),
      makeDemo(`北京大学第三医院专家门诊`, 'https://www.by3th.cn', '北医三院专家门诊出诊安排，可通过医院官方公众号、114平台预约', 'by3th.cn')
    ];
  }

  return [
    makeDemo(`${city}协和医院`, 'https://www.pumch.cn', '北京协和医院，中国医学科学院北京协和医院，集医疗、教学、科研于一体的大型综合医院', 'pumch.cn'),
    makeDemo(`北京大学人民医院`, 'https://www.pkuph.cn', '北京大学人民医院，创建于1918年，三级甲等综合医院', 'pkuph.cn'),
    makeDemo(`${city}和睦家医院`, 'https://www.ufh.com.cn', '北京和睦家医院，国际标准综合医院，提供中英双语诊疗服务', 'ufh.com.cn')
  ];
}

// 常见医院名称中英文映射（用于补充英文查询）：仅覆盖 6 家演示医院
const HOSPITAL_NAME_MAP = {
  '协和': 'Peking Union Medical College Hospital PUMCH',
  '天坛': 'Beijing Tiantan Hospital',
  '人民医院': 'Peking University People\'s Hospital',
  '北医三院': 'Peking University Third Hospital',
  '清华长庚': 'Beijing Tsinghua Changgung Hospital',
  '和睦家': 'Beijing United Family Hospital',
};

function enrichQueryForEnglishSearch(query) {
  let enriched = query;
  for (const [cn, en] of Object.entries(HOSPITAL_NAME_MAP)) {
    if (query.includes(cn)) {
      enriched = `${query} ${en}`;
      break;
    }
  }
  return enriched;
}

async function bochaSearch(query) {
  const errors = [];
  for (let i = 0; i < BOCHA_API_KEYS.length; i++) {
    const key = BOCHA_API_KEYS[(bochaKeyIndex + i) % BOCHA_API_KEYS.length].trim();
    if (!key) continue;
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch('https://api.bochaai.com/v1/web-search', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: query,
          summary: true,
          freshness: 'noLimit',
          count: 10
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);
      const duration = Date.now() - start;

      if (!response.ok) {
        logRequest('bocha', query, `HTTP_${response.status}`, duration, 0, 0);
        errors.push(`key${i}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      const sources = (data.data?.webPages?.value || []).map(item => {
        let snippet = item.snippet || '';
        // 检测并修复UTF-8乱码
        if (/[àáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ]/.test(snippet) || /\uFFFD/.test(snippet)) {
          try {
            snippet = Buffer.from(snippet, 'latin1').toString('utf8');
          } catch (e) { /* ignore */ }
        }
        return {
          title: item.name || '',
          url: item.url || '',
          snippet: snippet,
          sourceName: item.siteName || extractDomain(item.url),
          publishedTime: item.datePublished || null,
          provider: 'bocha'
        };
      });

      bochaKeyIndex = (bochaKeyIndex + i) % BOCHA_API_KEYS.length;
      logRequest('bocha', query, 'SUCCESS', duration, sources.length, 0);
      return { success: true, sources, provider: 'bocha' };

    } catch (error) {
      clearTimeout(timeout);
      const duration = Date.now() - start;
      logRequest('bocha', query, `ERROR: ${error.message}`, duration, 0, 0);
      errors.push(`key${i}: ${error.message}`);
    }
  }
  bochaKeyIndex = (bochaKeyIndex + 1) % Math.max(BOCHA_API_KEYS.length, 1);
  throw new Error(`博查搜索失败: ${errors.join('; ') || '所有密钥均失败'}`);
}

async function tavilySearch(query) {
  const errors = [];
  for (let i = 0; i < TAVILY_API_KEYS.length; i++) {
    const key = TAVILY_API_KEYS[(tavilyKeyIndex + i) % TAVILY_API_KEYS.length].trim();
    if (!key) continue;
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
          query: query,
          search_depth: 'basic',
          include_answer: false,
          include_raw_content: false,
          max_results: 10,
          include_domains: [],
          exclude_domains: []
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);
      const duration = Date.now() - start;

      if (!response.ok) {
        logRequest('tavily', query, `HTTP_${response.status}`, duration, 0, 0);
        errors.push(`key${i}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      const sources = (data.results || []).map(item => ({
        title: item.title || '',
        url: item.url || '',
        snippet: item.content || '',
        sourceName: extractDomain(item.url),
        publishedTime: null,
        provider: 'tavily'
      }));

      tavilyKeyIndex = (tavilyKeyIndex + i) % TAVILY_API_KEYS.length;
      logRequest('tavily', query, 'SUCCESS', duration, sources.length, 0);
      return { success: true, sources, provider: 'tavily' };

    } catch (error) {
      clearTimeout(timeout);
      const duration = Date.now() - start;
      logRequest('tavily', query, `ERROR: ${error.message}`, duration, 0, 0);
      errors.push(`key${i}: ${error.message}`);
    }
  }
  tavilyKeyIndex = (tavilyKeyIndex + 1) % Math.max(TAVILY_API_KEYS.length, 1);
  throw new Error(`Tavily搜索失败: ${errors.join('; ') || '所有密钥均失败'}`);
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return '';
  }
}

async function search(query) {
  // 缓存检查
  const cached = getCached(query);
  if (cached) {
    return { ...cached, log: `缓存命中，返回${cached.sources.length}条结果`, errors: [] };
  }

  // 如果包含中文医院名称，自动补充英文关键词提升搜索质量
  const enrichedQuery = enrichQueryForEnglishSearch(query);
  if (enrichedQuery !== query) {
    console.log(`[Search] enriched: "${query}" -> "${enrichedQuery}"`);
  }

  const errors = [];
  let allSources = [];
  let provider = '';
  let totalDuration = 0;

  // 双通道搜索（用富化后的查询词）
  try {
    const result = await bochaSearch(enrichedQuery);
    allSources = allSources.concat(result.sources);
    provider = result.provider;
    totalDuration += result.duration || 0;
  } catch (e) {
    errors.push(`博查: ${e.message}`);
  }

  try {
    const result = await tavilySearch(enrichedQuery);
    allSources = allSources.concat(result.sources);
    if (!provider) provider = result.provider;
    totalDuration += result.duration || 0;
  } catch (e) {
    errors.push(`Tavily: ${e.message}`);
  }

  // 去重
  const seenUrls = new Set();
  allSources = allSources.filter(s => {
    if (seenUrls.has(s.url)) return false;
    seenUrls.add(s.url);
    return true;
  });

  // 来源分类和评分
  allSources.forEach(s => { scoreSource(s); });

  // 按类型分组排序：official > government > platform > media > uncertain
  // 同类型内按时间倒序（最新在前）
  const typeOrder = { official: 0, government: 1, platform: 2, media: 3, uncertain: 4 };
  allSources.sort((a, b) => {
    const aOrder = typeOrder[a.sourceType] ?? 5;
    const bOrder = typeOrder[b.sourceType] ?? 5;
    if (aOrder !== bOrder) return aOrder - bOrder;
    // 同类型内按时间倒序
    return (b.publishedTime || '') > (a.publishedTime || '') ? 1 : -1;
  });

  // 交叉核验
  allSources = crossCheckSources(allSources);

  // 赛题要求：区分医院公开能力与实时状态，不将历史报道表述为实时事实
  // → 报道类（media）来源全部过滤，回复聚焦就医引导，不出现新闻
  allSources = allSources.filter(s => s.sourceType !== 'media');

  // 演示范围 6 家医院：非演示医院的官网结果过滤（政府/平台等通用渠道保留）
  const { DEMO_HOSPITAL_DOMAINS } = require('./hospitalNames');
  allSources = allSources.filter((s) => {
    if (s.sourceType !== 'official') return true;
    const domain = extractDomain(s.url);
    // 域名在演示医院白名单内 → 保留；是其他医院官网 → 过滤
    const isHospitalDomain = Object.keys(DEMO_HOSPITAL_DOMAINS).some((d) => domain.includes(d));
    if (isHospitalDomain) return true;
    // 关键词匹配出的 official（标题含医院名但域名不在名单）：仅当标题提及演示医院时保留
    const mentioned = extractHospitalName(s.title, s.snippet);
    return !!mentioned;
  });

  // 过滤掉纯媒体来源中低质量的
  const officialCount = allSources.filter(s => s.sourceType === 'official' || s.sourceType === 'government').length;

  if (allSources.length > 0) {
    const result = {
      success: true,
      sources: allSources.slice(0, 10),
      provider: provider || 'multi',
      log: `检索完成，返回${allSources.length}条结果（官方${officialCount}条）`,
      errors: errors.length > 0 ? errors : [],
      duration: totalDuration,
      officialCount
    };
    setCached(query, result);
    return result;
  }

  // 所有API都失败时，回退到演示数据
  if (DEMO_MODE) {
    const demoSources = getDemoSources(query);
    const demoResult = {
      success: true,
      sources: demoSources,
      provider: 'demo',
      log: `检索服务暂不可用，已切换至演示模式。配置有效API密钥后可启用真实检索。`,
      errors,
      duration: 0,
      officialCount: 0
    };
    setCached(query, demoResult);
    return demoResult;
  }

  return {
    success: false,
    sources: [],
    error: errors.join('; ') || '所有搜索服务均不可用',
    log: `搜索失败: ${errors.join('; ')}`,
    errors,
    duration: totalDuration,
    officialCount: 0
  };
}

function getRequestLog() {
  return [...requestLog];
}

function getStats() {
  const total = requestLog.length;
  const success = requestLog.filter(r => r.status === 'SUCCESS').length;
  const failed = total - success;
  const avgDuration = total > 0 ? Math.round(requestLog.reduce((s, r) => s + r.duration, 0) / total) : 0;
  return { total, success, failed, avgDuration };
}

module.exports = { search, getRequestLog, getStats, classifySource };
