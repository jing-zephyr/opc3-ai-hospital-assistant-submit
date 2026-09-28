const { matchHospitalInMessage, KNOWN_HOSPITAL_NAMES, HOSPITAL_ALIASES } = require('./hospitalNames');

const HOSPITAL_KEYWORDS = ['医院', '院区', '中心', '门诊', '急诊', '发热门诊', '卒中中心', '胸痛中心', '创伤中心', '耳鼻喉', '眼科', '口腔科', '骨科', '心内科', '神经内科', '神经外科', '肿瘤科', '儿科', '妇产科', '皮肤科', '中医科', '康复科', '体检中心'];
const RESOURCE_KEYWORDS = ['抗蛇毒血清', '血清', '疫苗', '透析', 'MRI', 'CT', 'PET-CT', '核磁', '放疗', '质子治疗'];
const DOCTOR_KEYWORDS = ['主任医师', '副主任医师', '主治医师', '专家', '主任', '教授', '院士'];
const LOCATION_KEYWORDS = ['北京', '上海', '广州', '深圳', '杭州', '南京', '武汉', '成都', '西安', '重庆', '天津', '苏州', '青岛', '大连', '厦门', '长沙', '郑州', '济南', '沈阳', '哈尔滨'];

// 已知医院名（全称+别名）总表，用于从科室词中剥离医院名前缀
const ALL_HOSPITAL_TOKENS = [...KNOWN_HOSPITAL_NAMES, ...Object.keys(HOSPITAL_ALIASES)].sort((a, b) => b.length - a.length);

function stripHospitalPrefix(deptText) {
  // 「协和医院神经科」→「神经科」：避免科室条件里混入医院名造成张冠李戴
  for (const token of ALL_HOSPITAL_TOKENS) {
    if (deptText.startsWith(token) && deptText.length > token.length) {
      const rest = deptText.slice(token.length);
      if (/科$/.test(rest) && rest.length >= 2) return rest;
    }
  }
  return deptText;
}

function extractConditions(message, existingConditions = {}) {
  const newConditions = {};

  const locationMatch = message.match(/(北京|上海|广州|深圳|杭州|南京|武汉|成都|西安|重庆|天津|苏州|青岛|大连|厦门|长沙|郑州|济南|沈阳|哈尔滨)/);
  if (locationMatch && !existingConditions.city) {
    newConditions.city = locationMatch[1];
  }

  const hospitalTypeMatch = message.match(/(公立|民营|私立|三甲|三级|二级|专科|综合)/);
  if (hospitalTypeMatch) {
    newConditions.hospitalType = hospitalTypeMatch[1];
  }

  const resourceMatch = message.match(/(抗蛇毒血清|卒中中心|胸痛中心|创伤中心|发热门诊|急诊科|急诊|耳鼻喉|眼科|口腔科|骨科|心内科|神经内科|神经外科|肿瘤科|儿科|妇产科|皮肤科|中医科|康复科|体检中心|MRI|CT|PET-CT|核磁|透析|放疗|质子治疗)/);
  if (resourceMatch) {
    newConditions.resource = resourceMatch[1];
  }

  const doctorMatch = message.match(/(主任医师|副主任医师|主治医师|专家)/);
  if (doctorMatch) {
    newConditions.doctorLevel = doctorMatch[1];
  }

  const deptMatch = message.match(/([\u4e00-\u9fa5]{2,8}科)/);
  if (deptMatch && !newConditions.resource) {
    newConditions.department = stripHospitalPrefix(deptMatch[1]);
  }

  const dateMatch = message.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}日|明天|后天|本周|下周|周一|周二|周三|周四|周五|周六|周日)/);
  if (dateMatch) {
    newConditions.queryDate = dateMatch[1];
  }

  // 医院识别第一优先：已知医院名单 + 别名（覆盖「和睦家」等不带「医院」后缀的叫法）
  const knownHospital = matchHospitalInMessage(message);
  let unlistedHospital = null;
  if (knownHospital) {
    newConditions.hospitalName = knownHospital;
  } else {
    const QUESTION_WORDS = /^(哪些|哪个|哪家|什么|怎么|如何|哪有|请问|有没有|有没有过|查一下|查找|搜索|找|帮我找|我想找|告诉我|介绍一下|介绍下|有没有|推荐)/;
    const GENERIC_PREFIXES = /^(北京|上海|广州|深圳|杭州|南京|武汉|成都|西安|重庆|天津|苏州|青岛|大连|厦门|长沙|郑州|济南|沈阳|哈尔滨)?(有哪些|有什么|哪里有|哪家|哪个|什么|有没有|帮我找|找|查|查一下|查询)/;

    const cleanedMsg = message
      .replace(/(帮我|我想|请|麻烦|给我|我要|我想知道|我想了解|能帮我|能不能帮我|能否|麻烦帮我)/g, '')
      .replace(/(查一下|查找|查询|搜索|找一下|找找|找找看|找|查|搜)/g, ' ')
      .replace(/(优先|最好|只要|只要|仅限|只查|仅|推荐)/g, ' ');

    const hospitalNameMatch = cleanedMsg.match(/([0-9\u4e00-\u9fa5]{2,10}(?:医院|院区|诊所|卫生服务中心))/);
    if (hospitalNameMatch) {
      const candidate = hospitalNameMatch[1];
      const isGeneric = QUESTION_WORDS.test(candidate) ||
                        GENERIC_PREFIXES.test(candidate) ||
                        /^(哪些|有什么|找|查询|搜索|有)/.test(candidate) ||
                        /^(公立|民营|私立|三甲|三级|二级|综合|专科)/.test(candidate) ||
                        /(哪些|哪家|哪个|什么|怎么|如何)/.test(candidate);
      if (!isGeneric) {
        // 名单外医院不写入 hospitalName，交由服务端按演示范围直接打住
        unlistedHospital = candidate;
      }
    }
  }

  return {
    newConditions,
    unlistedHospital,
    hasNewInfo: Object.keys(newConditions).length > 0,
    allConditions: { ...existingConditions, ...newConditions }
  };
}

// 从「有X吗 / 有没有X / X怎么样」类问句中提取疑似院名候选（名单未收录时用于如实打住）
function extractHospitalCandidate(message) {
  const m = (message || '').replace(/[？?！!，。,\s]/g, '');
  const patterns = [
    /(?:有没有|有)([\u4e00-\u9fa5]{2,8})(?:吗|嘛|么|呢)?$/,
    /(?:有没有|有)([\u4e00-\u9fa5]{2,8})(?:这家|那家|的)?医院/,
    /^([\u4e00-\u9fa5]{2,8})(?:医院)?(?:怎么样|好不好|如何|好吗)/,
    /(?:想去|去|在)([\u4e00-\u9fa5]{2,8})(?:看病|就诊|挂号)/,
  ];
  // 包含以下任一词汇的候选不是医院名，直接排除
  const STOP_WORDS = /(哪些|哪个|哪家|什么|卒中中心|胸痛中心|发热门诊|抗蛇毒血清|医院|公立|民营|私立|三甲|专家|主任|医师|出诊|排班|挂号|预约|明天|今天|后天|本周|下周|号源|床位|医保|保险|宠物|牙科|口腔|眼科|体检|疫苗|血清|急诊|门诊|住院|手术|检查|核酸|神经科|心内科|骨科|儿科|妇产科|皮肤科|中医科|康复科|耳鼻喉科)/;
  for (const p of patterns) {
    const hit = m.match(p);
    if (hit && hit[1] && !STOP_WORDS.test(hit[1]) && !/^(北京|上海|广州|深圳|杭州|南京|武汉|成都|西安|重庆|天津)$/.test(hit[1])) {
      return hit[1];
    }
  }
  return null;
}

function needsClarification(allConditions, extracted) {
  if (extracted.clarificationPrompt) return true;

  if (!allConditions.city && !extracted.newConditions.city) {
    if (extracted.newConditions.resource || extracted.newConditions.department || extracted.newConditions.doctorLevel) {
      extracted.clarificationPrompt = '请问您想查询哪个城市或地区的医院？（如：北京、上海）';
      return true;
    }
  }

  if (extracted.newConditions.resource === '抗蛇毒血清' && !allConditions.hospitalType) {
    extracted.clarificationPrompt = '请问您倾向查询公立医院还是民营医院？（可选：公立优先/均可）';
    return true;
  }

  return false;
}

function buildSearchQuery(conditions, originalMessage) {
  // 如果提取到医院名称，优先用医院名作为核心查询
  if (conditions.hospitalName) {
    const parts = [conditions.hospitalName];
    if (conditions.department) parts.push(conditions.department);
    if (conditions.resource) parts.push(conditions.resource);
    if (conditions.doctorLevel) parts.push(conditions.doctorLevel);
    if (conditions.queryDate) parts.push('出诊 排班');
    return parts.join(' ');
  }

  // 否则用原始消息作为查询主体，附加提取的条件
  const parts = [];
  const city = conditions.city || '北京';

  // 如果原始消息很短且包含医院相关词，直接用原始消息
  if (originalMessage && originalMessage.length < 50) {
    const msg = originalMessage.trim();
    // 避免把城市名重复加入
    if (!msg.includes(city)) {
      parts.push(city);
    }
    parts.push(msg);
    if (conditions.queryDate) parts.push('出诊 排班');
    return parts.join(' ');
  }

  parts.push(city);

  if (conditions.resource) {
    parts.push(conditions.resource);
  } else if (conditions.department) {
    parts.push(conditions.department);
  }

  if (conditions.doctorLevel) {
    parts.push(conditions.doctorLevel);
  }

  if (conditions.hospitalType === '公立') {
    parts.push('公立医院');
  } else if (conditions.hospitalType === '民营' || conditions.hospitalType === '私立') {
    parts.push('民营医院');
  }

  if (conditions.queryDate) {
    parts.push('出诊 排班');
  }

  const query = parts.join(' ');
  return query || `${city} 医院`;
}

module.exports = {
  extractConditions,
  needsClarification,
  buildSearchQuery,
  extractHospitalCandidate,
  HOSPITAL_KEYWORDS,
  RESOURCE_KEYWORDS,
  DOCTOR_KEYWORDS
};
