const IRRELEVANT_PATTERNS = [
  /天气/, /气温/, /下雨/, /晴天/, /台风/, /股票/, /基金/, /比特币/, /彩票/, /房价/,
  /电影/, /明星/, /八卦/, /游戏/, /王者荣耀/, /原神/, /足球/, /篮球/, /NBA/, /世界杯/,
  /菜谱/, /怎么做.*菜/, /好吃/, /外卖/, /快递/, /物流/, /淘宝/, /拼多多/, /京东/,
  /英语.*翻译/, /数学题/, /物理题/, /化学题/, /写作文/, /写诗/, /写小说/, /编故事/,
  /讲笑话/, /星座/, /算命/, /塔罗牌/, /风水/, /周公解梦/, /运势/
];

const EMERGENCY_PATTERNS = [
  /救命/, /急救/, /快不行了/, /不行了/, /呼吸困难/, /喘不上气/, /大出血/, /昏迷/, /昏倒/, /晕倒/, /休克/,
  /失去意识/, /没意识/, /叫不醒/, /胸痛.*(剧烈|难忍|持续)/, /中风/, /脑梗/, /心梗/, /中毒/, /服毒/,
  /自杀/, /跳楼/, /割腕/, /突发.*(疾病|症状)/, /突然(昏|晕|倒|抽搐|失去)/,
  /抽搐/, /癫痫.*发作/, /心脏骤停/, /猝死/, /昏迷不醒/, /口吐白沫/, /高热惊厥/,
  /出车祸/, /外伤.*大量.*血/, /被蛇咬/, /蛇咬伤/, /被狗咬/, /严重烧伤/, /烫伤.*严重/
];

const DIAGNOSIS_PATTERNS = [
  /我得了什么病/, /是不是.*癌/, /要不要手术/, /吃什么药/, /该吃什么药/,
  /怎么治/, /治疗方案/, /开药/, /处方/, /输液/, /打针/,
  /化疗/, /放疗方案/, /靶向药/, /免疫治疗/
];

const SYMPTOM_PATTERNS = [
  /我(最近|一直|老是)?(感觉)?(有)?(点|些|很|非常)?(头|胸|腹|腰|腿|胳膊|喉咙|鼻子|眼睛|耳朵)?(疼|痛|酸|麻|胀|痒|晕|难受|不舒服)/,
  /(头|胸|腹|腰|腿|胳膊|喉咙|鼻子|眼睛|耳朵).*(疼|痛|酸|麻|胀)/,
  /(发烧|发热|高烧).*(度|天|不退|反复)/,
  /(血压|血糖|血脂).*(高|低|多少|怎么)/,
  /我(最近|一直|老是).*(疼|痛|痒|晕|吐|发烧|咳嗽|失眠|乏力|心慌|胸闷)/
];

function validateMedicalBoundary(message) {
  const lowerMsg = message.toLowerCase();

  // 先检查是否包含医院查询相关词汇，如果是则放行
  const hospitalQueryPattern = /(医院|科室|门诊|出诊|挂号|预约|医生|主任|专家|地址|电话|官网|挂号平台)/;
  const isHospitalQuery = hospitalQueryPattern.test(message);

  for (const pattern of IRRELEVANT_PATTERNS) {
    if (pattern.test(message)) {
      return {
        blocked: true,
        message: '【服务范围说明】\n\n本系统专注于医院资源查询与便民就医信息服务，包括医院科室、医生信息、出诊安排、挂号方式等。\n\n您的问题超出本系统服务范围。如需查询医院资源，请告诉我您想了解的城市、医院或科室信息，我会为您检索权威公开信息。',
        code: 'OUT_OF_SCOPE'
      };
    }
  }

  for (const pattern of EMERGENCY_PATTERNS) {
    if (pattern.test(message)) {
      return {
        blocked: true,
        message: '【温馨提示】\n\n您描述的情况可能需要及时的医疗关注。\n\n建议您：\n  · 立即拨打急救电话 120\n  · 或尽快前往最近医院的急诊科\n  · 保持冷静，如有必要可同时联系 110 寻求帮助\n\n本系统不提供紧急医疗咨询，专业医疗救助更为及时有效。\n\n待情况稳定后，如需查询医院急诊资源或相关科室信息，欢迎继续咨询。',
        code: 'EMERGENCY'
      };
    }
  }

  for (const pattern of DIAGNOSIS_PATTERNS) {
    if (pattern.test(message)) {
      return {
        blocked: true,
        message: '【服务边界说明】\n\n本系统专注于医院资源查询与便民就医信息服务，不开展疾病诊断、治疗方案制定或用药指导。\n\n建议您：\n  · 前往医院相应科室就诊，由专业医生面诊评估\n  · 通过医院官方渠道预约挂号\n  · 如需用药指导，请咨询药师或医生\n\n我可以帮您查询相关科室的医院分布、医生信息和官方挂号渠道，请随时告诉我。',
        code: 'DIAGNOSIS_BOUNDARY'
      };
    }
  }

  // 症状边界：如果是医院查询+症状描述，放行；否则拦截
  for (const pattern of SYMPTOM_PATTERNS) {
    if (pattern.test(message)) {
      if (isHospitalQuery) {
        // 用户是在描述症状的同时查询医院，放行但会给出提示
        return { blocked: false, symptomHint: true };
      }
      return {
        blocked: true,
        message: '【温馨提示】\n\n您描述的症状建议由医生面诊评估，以便获得更准确的判断。\n\n我可以帮您查询：\n  · 相关科室的医院分布\n  · 科室医生信息\n  · 官方挂号渠道和预约方式\n\n但无法：\n  · 判断病情严重程度\n  · 推荐具体治疗方案\n  · 提供用药建议\n\n如需查询相关医院资源，请告诉我您想了解的科室或医院类型，我会尽力协助。',
        code: 'SYMPTOM_BOUNDARY'
      };
    }
  }

  return { blocked: false };
}

module.exports = { validateMedicalBoundary };
