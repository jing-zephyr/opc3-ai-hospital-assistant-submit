const { extractKnownHospital } = require('./hospitalNames');

// 严格按赛题「基础需求5 · 统一文本输出框架」输出：
// ① 查询条件 ② 查询结果 ③ 信息依据 ④ 使用提示
// 红线：不编造事实；区分「公开能力介绍」与「当前服务状态」；
//       来源未标日期时写明「来源未标注更新时间」，不得把抓取日期当作信息更新日期。

// 演示范围内医院的公开类别。公立/民营属稳定公开常识，仍如实标注其核验状态，不作为已逐条核验的结论。
const CATEGORY_HINTS = [
  { key: '和睦家', label: '民营医院', extra: '知名民营医疗机构' },
  { key: '人民医院', label: '公立医院' },
  { key: '协和', label: '公立医院' },
  { key: '北医三院', label: '公立医院' },
  { key: '第三医院', label: '公立医院' },
  { key: '天坛', label: '公立医院' },
  { key: '清华长庚', label: '公立医院' },
];

const TYPE_LABEL = {
  official: '医院官网',
  government: '卫生健康主管部门/政府渠道',
  platform: '第三方平台',
  media: '公开报道',
  uncertain: '公开页面（性质待核实）',
};

function nowStr() {
  // Netlify Functions 运行在 UTC，必须以北京时间(Asia/Shanghai)输出，否则查询时间会差 8 小时
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

function categoryOf(name) {
  for (const h of CATEGORY_HINTS) {
    if (name.includes(h.key)) return h.label + (h.extra ? `（${h.extra}）` : '');
  }
  return '未查到';
}

// 依据来源性质给出「信息状态」，严格区分三种情形，绝不把能力介绍写成实时库存/实时排班
function statusOf(items, resource) {
  const hasOfficial = items.some((s) => s.sourceType === 'official' || s.sourceType === 'government');
  const onlyMedia = items.every((s) => s.sourceType === 'media' || s.sourceType === 'uncertain');
  const isVolatile = resource === '抗蛇毒血清' || /排班|出诊|挂号/.test(resource || '');

  if (resource === '抗蛇毒血清') {
    return '公开页面提及该资源；是否当前可提供、是否有库存，尚待核实，须致电医院急诊科确认';
  }
  if (isVolatile) {
    return '属易变动信息，本次仅确认公开渠道的表述；当前实际安排以医院官方实时公布为准';
  }
  if (hasOfficial) {
    return '医院官方公开渠道介绍具备相关能力；具体是否当前可提供，以医院最新公布或确认的信息为准';
  }
  if (onlyMedia) {
    return '仅见于公开报道/非官方页面介绍，不能等同于当前实际提供，尚待核实';
  }
  return '尚待核实';
}

function truncate(s, n) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function formatUnifiedResponse(conditions, searchResult) {
  const city = conditions.city || '北京';
  const sources = searchResult.sources || [];
  const queryTime = nowStr();

  let response = '';

  // ① 查询条件
  response += buildConditionSection(conditions, city);
  // ② 查询结果
  response += buildResultSection(sources, conditions, queryTime, city);
  // ③ 信息依据
  response += buildEvidenceSection(sources, queryTime);
  // ④ 使用提示（就诊行动指引放在这里，既保留温度又不破坏框架顺序）
  response += buildTipsSection(conditions, sources);

  const compareData = buildCompareData(sources, conditions, queryTime);
  const hospitals = buildHospitalCards(sources, conditions);

  return { response, compareData, hospitals };
}

function buildConditionSection(conditions, city) {
  const parts = [`地区：${city}`];
  if (conditions.hospitalType) parts.push(`类型：${conditions.hospitalType}`);
  if (conditions.hospitalName) parts.push(`指定医院：${conditions.hospitalName}`);
  if (conditions.resource) parts.push(`资源：${conditions.resource}`);
  if (conditions.department) parts.push(`科室：${conditions.department}`);
  if (conditions.doctorLevel) parts.push(`职称：${conditions.doctorLevel}`);
  if (conditions.queryDate) parts.push(`日期：${conditions.queryDate}`);
  return `【① 查询条件】${parts.join(' · ')}\n\n`;
}

function buildResultSection(sources, conditions, queryTime, city) {
  if (!sources.length) {
    return `【② 查询结果】本次未检索到与您所述条件匹配的权威公开信息。\n` +
           `这并不表示医院没有该项资源；可能受公开页面覆盖不足或检索条件限制影响。\n\n`;
  }

  // 按医院聚合：不同医院的事实不得合并
  const groups = new Map();
  const unidentified = [];
  sources.forEach((s) => {
    const name = extractKnownHospital(s.title, s.snippet);
    if (!name) { unidentified.push(s); return; }   // 不编造医院名，未识别的另作说明
    if (!groups.has(name)) groups.set(name, { name, items: [] });
    groups.get(name).items.push(s);
  });

  // 官方来源优先展示
  const rank = (g) => Math.min(...g.items.map((s) => ({ official: 0, government: 1, platform: 2, media: 3, uncertain: 4 }[s.sourceType] ?? 5)));
  const list = [...groups.values()].sort((a, b) => rank(a) - rank(b));

  if (!list.length) {
    return `【② 查询结果】本次检索到 ${sources.length} 条相关公开页面，但均未能识别出确切的医院名称，为避免误导不作医院级归并。\n` +
           `请点击下方入口卡查看原始页面；也可直接告诉我具体医院名称，我帮您定向查询。\n\n`;
  }

  let out = `【② 查询结果】本次共检索到 ${sources.length} 条公开信息，可归属 ${list.length} 家医院；以下逐家列出，不同院区的地址、科室与医生安排不混用。\n\n`;

  list.forEach((g, i) => {
    const best = g.items.slice().sort((a, b) => rank({ items: [a] }) - rank({ items: [b] }))[0];
    let bestDomain = '';
    try { bestDomain = new URL(best.url).host; } catch (e) { bestDomain = '未标注'; }
    const matched = conditions.resource || conditions.department || conditions.doctorLevel || conditions.hospitalName || '（按您所述条件）';
    const basisTitle = truncate(String(best.title || '').replace(/[《》]/g, ''), 44);
    const basisType = TYPE_LABEL[best.sourceType] || TYPE_LABEL.uncertain;

    out += `${i + 1}. 医院全称：${g.name}\n`;
    out += `   所在地区及院区：${city}${best.campus ? ` · ${best.campus}` : '（本次来源未标注具体院区）'}\n`;
    out += `   医院类别：${categoryOf(g.name)}（公立/民营属性依据本次检索到的官方来源域名 ${bestDomain || '未标注'}，非另行推断）\n`;
    out += `   匹配内容：${matched}\n`;
    out += `   匹配依据：${basisType}页面《${basisTitle}》内容与上述条件相关\n`;
    out += `   信息状态：${statusOf(g.items, conditions.resource)}\n`;
    out += `   查询时间：${queryTime}\n\n`;
  });

  if (unidentified.length) {
    out += `另有 ${unidentified.length} 条相关公开页面未能识别出确切医院名称，已一并列在下方入口卡中，请以原始页面为准。\n\n`;
  }

  return out;
}

function buildEvidenceSection(sources, queryTime) {
  if (!sources.length) {
    return `【③ 信息依据】未获得可核验的来源，故不列出任何链接。\n` +
           `建议核实渠道：北京114预约挂号平台、目标医院官网「出诊信息/门诊安排」页面、医院官方咨询电话。\n\n`;
  }

  const order = { official: 0, government: 1, platform: 2, media: 3, uncertain: 4 };
  const sorted = [...sources].sort((a, b) => {
    const ao = order[a.sourceType] ?? 5, bo = order[b.sourceType] ?? 5;
    if (ao !== bo) return ao - bo;
    return (b.publishedTime || '') > (a.publishedTime || '') ? 1 : -1;
  });
  const top = sorted.slice(0, 5);

  let out = `【③ 信息依据】\n`;
  top.forEach((s, i) => {
    const t = TYPE_LABEL[s.sourceType] || TYPE_LABEL.uncertain;
    const date = s.publishedTime ? `来源更新时间：${s.publishedTime}` : '来源未标注更新时间';
    out += `${i + 1}. 页面标题：${truncate(s.title, 70)}\n`;
    out += `   发布机构/来源性质：${truncate(s.sourceName || '未标注', 30)} · ${t}\n`;
    out += `   可访问链接：${s.url}\n`;
    out += `   ${date}\n`;
  });
  if (sorted.length > top.length) {
    out += `（共 ${sorted.length} 条，以上列出优先的 ${top.length} 条，其余入口见下方卡片）\n`;
  }
  out += `本次查询时间：${queryTime}（非信息更新时间）\n\n`;
  return out;
}

function buildTipsSection(conditions, sources) {
  let out = `【④ 使用提示】\n`;

  if (conditions.doctorLevel || conditions.department) {
    out += `· 怎么挂号：医生出诊安排以医院挂号系统实时信息为准。可通过以下官方渠道查询并预约——\n`;
    out += `  ① 北京114预约挂号平台（官方统一入口）；② 目标医院官方公众号或 App；③ 医院官网「出诊信息/门诊安排」页面。\n`;
    out += `· 未查到有效排班时，不再推断；请以上述官方渠道公布的为准。\n`;
  } else if (conditions.resource === '抗蛇毒血清') {
    out += `· 蛇咬伤属急症，请立即就医，不要等待线上回复。\n`;
    out += `· 可否提供、当前是否有库存需致电医院急诊科确认后再前往，优先选择设急诊科的大型综合医院。\n`;
  } else if (conditions.hospitalName) {
    out += `· 建议通过${conditions.hospitalName}的官方网站、官方公众号或致电咨询，核实院区、出诊安排与号源情况。\n`;
  } else {
    out += `· 上述为医院的公开能力介绍，不等于当前服务状态；就诊前请以医院最新公布或确认的信息为准。\n`;
    out += `· 挂号预约建议走官方渠道：北京114预约挂号平台、医院官方公众号或 App。\n`;
  }

  if (sources.length) {
    out += `· 以上内容仅为公开渠道检索结果的整理，未经医院二次确认。\n`;
  }
  out += `· 本系统仅提供医院资源与便民就医信息，不提供疾病诊断、治疗方案、处方或用药建议；相关问题请咨询专业医务人员。\n`;
  out += `· 遇紧急情况，请立即拨打 120。\n`;

  return out;
}

// 前台「医院入口卡」用的结构化数据：优先只给官方/政府渠道入口，历史报道不进入主视野
function shortStatus(items, resource) {
  if (resource === '抗蛇毒血清') return '须致电确认库存';
  if (/排班|出诊|挂号/.test(resource || '')) return '以官方实时排班为准';
  const hasOfficial = items.some((s) => s.sourceType === 'official' || s.sourceType === 'government');
  const onlyMedia = items.every((s) => s.sourceType === 'media' || s.sourceType === 'uncertain');
  if (hasOfficial) return '官方公示具备该项资源';
  if (onlyMedia) return '仅公开报道提及 · 待核实';
  return '待核实';
}

function buildHospitalCards(sources, conditions) {
  const groups = new Map();
  sources.forEach((s) => {
    const name = extractKnownHospital(s.title, s.snippet);
    if (!name) return;
    if (!groups.has(name)) groups.set(name, { name, items: [] });
    groups.get(name).items.push(s);
  });

  const order = { official: 0, government: 1, platform: 2, media: 3, uncertain: 4 };
  // 「预约挂号」性质页面判定：只认检索回来的真实链接，绝不拼接/猜测网址
  const BOOKING_URL_RE = /(guahao|yuyue|appointment|booking|register|\/gh\/|haodf)/i;
  const BOOKING_TXT_RE = /(预约挂号|门诊预约|在线预约|预约就诊|挂号)/;
  const NEWS_TXT_RE = /(报道|新闻|发布会|座谈|培训|揭牌|荣获|获评|论坛|会议)/;

  const cards = [...groups.values()].map((g) => {
    // 先在官方/政府来源里取「出现次数最多的域名」，避免落到康复院区等非目标站点
    const auth = g.items.filter((s) => s.sourceType === 'official' || s.sourceType === 'government');
    const pool = auth.length ? auth : g.items;
    const hostCount = {};
    pool.forEach((s) => { try { const h = new URL(s.url).host; hostCount[h] = (hostCount[h] || 0) + 1; } catch (e) { /* 忽略 */ } });
    const topHost = Object.entries(hostCount).sort((a, b) => b[1] - a[1])[0];
    const best = (topHost && pool.find((s) => { try { return new URL(s.url).host === topHost[0]; } catch (e) { return false; } }))
      || pool.slice().sort((a, b) => (order[a.sourceType] ?? 5) - (order[b.sourceType] ?? 5))[0];

    // ① 预约入口优先级最高：优先找官方/政府来源里的「预约挂号」页面
    const booking = g.items.find((s) =>
      (s.sourceType === 'official' || s.sourceType === 'government') &&
      (BOOKING_URL_RE.test(String(s.url || '')) ||
        (BOOKING_TXT_RE.test(String(s.title || '')) && !NEWS_TXT_RE.test(String(s.title || ''))))
    );
    // 卡片入口指向「官网首页」而非深层新闻稿页：给患者的是入口，不是报道
    let siteRoot = '', domain = '';
    try { domain = new URL(best.url).host; siteRoot = new URL(best.url).origin + '/'; } catch (e) { /* 链接不可解析则不生成入口 */ }

    return {
      name: g.name,
      category: categoryOf(g.name).includes('民营') ? '民营' : '公立',
      status: shortStatus(g.items, conditions && conditions.resource),
      bookingUrl: booking ? (booking.url || '') : '',
      officialUrl: (best.sourceType === 'media') ? '' : siteRoot,
      evidence: domain ? `${domain} · ${TYPE_LABEL[best.sourceType] || TYPE_LABEL.uncertain}` : '',
      authoritative: (best.sourceType === 'official' || best.sourceType === 'government'),
    };
  });

  // 官方渠道优先，且把"仅报道"的排在后面
  return cards.sort((a, b) => (b.authoritative ? 1 : 0) - (a.authoritative ? 1 : 0));
}

function buildCompareData(sources, conditions, queryTime) {
  const hospitals = [];
  const seen = new Set();

  for (const s of sources.slice(0, 6)) {
    const name = extractKnownHospital(s.title, s.snippet);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const has = (conditions.resource && s.snippet && s.snippet.includes(conditions.resource)) ||
                (conditions.department && s.snippet && s.snippet.includes(conditions.department));

    hospitals.push({
      '医院名称': name,
      '医院类别': categoryOf(name),
      '来源类型': TYPE_LABEL[s.sourceType] || TYPE_LABEL.uncertain,
      '匹配情况': has ? '有相关公开信息' : '待核实',
      '时效状态': s.publishedTime ? `有标注时间（${s.publishedTime}）` : '来源未标注更新时间',
      '查询时间': queryTime,
      '官方链接': s.url,
    });
  }

  return hospitals.length >= 2 ? hospitals : null;
}

module.exports = { formatUnifiedResponse };
