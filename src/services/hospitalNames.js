// 演示范围：北京市 6 家医院（公立 5 + 民营 1），做深闭环
// 赛题说明：此数量用于展示能力，不要求建设全国医院数据库
// 公立：北京大学人民医院、北京协和医院、北京大学第三医院、北京天坛医院、北京清华长庚医院
// 民营：北京和睦家医院
const KNOWN_HOSPITAL_NAMES = [
  '北京大学人民医院',
  '北京协和医院',
  '中国医学科学院北京协和医院',
  '北京大学第三医院',
  '北京天坛医院',
  '首都医科大学附属北京天坛医院',
  '北京清华长庚医院',
  '北京和睦家医院',
];

// 常用别名/简称 -> 规范全称（仅覆盖 6 家演示医院的日常叫法）
const HOSPITAL_ALIASES = {
  '协和': '北京协和医院',
  '协和医院': '北京协和医院',
  '北大人民': '北京大学人民医院',
  '人民医院': '北京大学人民医院',
  '北医三院': '北京大学第三医院',
  '三院': '北京大学第三医院',
  '天坛': '北京天坛医院',
  '天坛医院': '北京天坛医院',
  '清华长庚': '北京清华长庚医院',
  '长庚': '北京清华长庚医院',
  '和睦家': '北京和睦家医院',
  '和睦家医院': '北京和睦家医院',
};

// 6 家演示医院的官网域名白名单（用于过滤非演示范围的医院官网结果）
const DEMO_HOSPITAL_DOMAINS = {
  'pkuph.cn': '北京大学人民医院',
  'pumch.cn': '北京协和医院',
  'by3th.cn': '北京大学第三医院',
  'pkuh3.cn': '北京大学第三医院',
  'bjtth.org': '北京天坛医院',
  'btch.edu.cn': '北京清华长庚医院',
  'ufh.com.cn': '北京和睦家医院',
};

// 按长度降序，保证全称优先于简称命中
const SORTED_NAMES = [...KNOWN_HOSPITAL_NAMES].sort((a, b) => b.length - a.length);
const SORTED_ALIAS_KEYS = Object.keys(HOSPITAL_ALIASES).sort((a, b) => b.length - a.length);

function extractKnownHospital(title) {
  // 仅从标题匹配：标题中的医院名才是该条目主体；snippet 常顺带提及其他医院，易造成误标
  const t = title || '';
  for (const name of SORTED_NAMES) {
    if (t.includes(name)) return name;
  }
  for (const key of SORTED_ALIAS_KEYS) {
    if (t.includes(key)) return HOSPITAL_ALIASES[key];
  }
  return null;
}

// 从用户消息中识别医院：先全称名单，后别名表。返回规范全称或 null
function matchHospitalInMessage(message) {
  const m = message || '';
  for (const name of SORTED_NAMES) {
    if (m.includes(name)) return name;
  }
  for (const key of SORTED_ALIAS_KEYS) {
    if (m.includes(key)) return HOSPITAL_ALIASES[key];
  }
  return null;
}

module.exports = { KNOWN_HOSPITAL_NAMES, HOSPITAL_ALIASES, DEMO_HOSPITAL_DOMAINS, extractKnownHospital, matchHospitalInMessage };
