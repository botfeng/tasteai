export type Recipe = {
  id: string
  name: string
  kicker: string
  description: string
  minutes: number
  difficulty: string
  tastes: string[]
  categories: string[]
  image: string
  photoAlt: string
  reason: string
  ingredients: { name: string; amount: string }[]
  steps: { title: string; body: string }[]
  allergens: string
  tip: string
  credit: { author: string; sourceUrl: string; license: string; licenseUrl: string }
}

export const recipes: Recipe[] = [
  {
    id: 'salmon-bowl',
    name: '三文鱼毛豆波奇碗',
    kicker: '把清新，装进一只碗里',
    description: '软糯米饭、脆嫩毛豆与清爽黄瓜，搭上三文鱼和一点海苔。一碗颜色，一餐好心情。',
    minutes: 15,
    difficulty: '简单好做',
    tastes: ['清爽', '原味'],
    categories: ['鱼虾', '蔬菜', '蛋奶'],
    image: '/images/salmon-bowl.webp',
    photoAlt: '白碗里的三文鱼、毛豆、黄瓜、海藻与米饭，置于浅粉色桌面',
    reason: '清爽的鱼肉遇上脆嫩毛豆，15 分钟就能开饭。',
    ingredients: [
      { name: '熟米饭', amount: '150 克' },
      { name: '即食三文鱼', amount: '80 克，按包装标签选用' },
      { name: '去壳毛豆', amount: '50 克' },
      { name: '黄瓜', amount: '半根' },
      { name: '即食海藻沙拉', amount: '30 克' },
      { name: '海苔丝', amount: '少许' },
      { name: '蛋黄酱', amount: '1 茶匙' },
      { name: '酱油', amount: '半茶匙' },
    ],
    steps: [
      { title: '准备米饭和毛豆', body: '将已熟米饭按包装要求充分加热，盛入碗中。毛豆放入沸水煮约 5–8 分钟至完全熟透，沥干；具体时间以包装说明为准。' },
      { title: '处理三文鱼与配菜', body: '选用标签明确标注可直接食用、冷链完好的即食三文鱼，并严格按标签保存和处理；普通鲜鱼不可直接生吃。黄瓜洗净切片，切鱼和切蔬菜使用分开的刀板。' },
      { title: '把喜欢的食材摆进碗里', body: '在米饭上分别铺好毛豆、黄瓜、三文鱼和即食海藻沙拉。蛋黄酱与酱油拌匀，少量淋在表面，再撒上海苔丝。' },
      { title: '现做现吃，或换成熟食版', body: '摆好后及时食用，不在室温下久放。若不确定鱼肉是否适合即食，请先将鱼肉充分加热至中心 63°C，再组装；熟食版另预留约 10 分钟。' },
    ],
    allergens: '含鱼、大豆、鸡蛋；酱油可能含小麦，海藻沙拉可能含芝麻。',
    tip: '照片为生食鱼肉的摆盘参考。生食鱼类存在额外食品安全风险，孕期、幼儿、老年人及免疫力较弱者应选择充分加热的熟食版；“刺身级”等营销称谓不能替代安全保证。',
    credit: { author: 'David Foodphototasty', sourceUrl: 'https://unsplash.com/photos/green-and-orange-vegetable-on-white-ceramic-bowl-Sekm9_nC2BM', license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license' },
  },
  {
    id: 'lemon-chicken',
    name: '柠檬香草鸡排',
    kicker: '一口鲜嫩，一点柠檬香',
    description: '鸡排煎得微微焦香，挤一点柠檬汁，再配上暖乎乎的时蔬。把简单的食材，做成认真吃的一餐。',
    minutes: 30,
    difficulty: '简单好做',
    tastes: ['咸鲜', '清爽'],
    categories: ['鸡肉', '蔬菜'],
    image: '/images/lemon-chicken.webp',
    photoAlt: '木质圆盘上的柠檬香草鸡排，搭配胡萝卜、四季豆、彩椒与西葫芦',
    reason: '柠檬提鲜、时蔬作伴，一只平底锅也能做出满足感。',
    ingredients: [
      { name: '鸡胸肉', amount: '150 克' },
      { name: '胡萝卜', amount: '半根' },
      { name: '四季豆', amount: '60 克' },
      { name: '西葫芦', amount: '半根' },
      { name: '彩椒', amount: '四分之一个' },
      { name: '柠檬', amount: '半个' },
      { name: '迷迭香', amount: '1 小枝' },
      { name: '橄榄油', amount: '2 茶匙' },
      { name: '盐、黑胡椒', amount: '少许，按口味添加' },
    ],
    steps: [
      { title: '切配好这一餐', body: '鸡胸肉横切成约 1.5 厘米厚的鸡排，拭干后抹少许盐、黑胡椒与半茶匙橄榄油。蔬菜洗净切条，迷迭香洗净。生鸡肉与蔬菜使用不同的刀板。' },
      { title: '先把蔬菜煮熟', body: '四季豆去筋后放入沸水，煮约 8–10 分钟至完全熟透、无生味；根据大小延长时间。最后几分钟加入胡萝卜同煮，沥干。西葫芦和彩椒用少量油煎熟后盛出。' },
      { title: '煎出鸡排的香气', body: '锅中加入余下橄榄油，中火放入鸡排和迷迭香，每面先煎约 4–5 分钟，再转小火加盖焖熟。时间随厚度调整，以中心温度达到 74°C 为准，不能只看表面颜色。' },
      { title: '挤上柠檬，趁热开饭', body: '鸡排充分熟透后静置约 3 分钟，搭配熟蔬菜装盘。挤少量柠檬汁，再按口味撒黑胡椒。用干净餐具盛出，不复用接触过生鸡肉的盘子。' },
    ],
    allergens: '请特别核对腌料及混合调味料是否含有你需要避开的成分。',
    tip: '把厚薄调整均匀，比把火开大更有用。四季豆一定要完全煮熟；鸡排是否熟透，优先用食品温度计判断。',
    credit: { author: 'Mark DeYoung', sourceUrl: 'https://unsplash.com/photos/cooked-dish-mjcJ0FFgdWI', license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license' },
  },
  {
    id: 'tomato-fusilli',
    name: '番茄罗勒螺旋面',
    kicker: '让番茄的酸甜，抱住每一口',
    description: '煮软的番茄裹住螺旋面，最后放上新鲜罗勒。不需要复杂调味，也能有一盘踏实的好味道。',
    minutes: 25,
    difficulty: '新手友好',
    tastes: ['浓郁', '酸甜'],
    categories: ['面食', '蔬菜'],
    image: '/images/tomato-fusilli.webp',
    photoAlt: '白盘里的番茄酱螺旋面，点缀圣女果与罗勒，旁边放着面包',
    reason: '酸甜番茄裹满每一道纹路，给忙碌的一天一点安慰。',
    ingredients: [
      { name: '干螺旋面', amount: '80 克' },
      { name: '圣女果', amount: '120 克' },
      { name: '番茄膏', amount: '1 汤匙' },
      { name: '大蒜', amount: '1 瓣' },
      { name: '新鲜罗勒', amount: '4–6 片' },
      { name: '橄榄油', amount: '2 茶匙' },
      { name: '盐、黑胡椒', amount: '少许，按口味添加' },
    ],
    steps: [
      { title: '让面条先下锅', body: '烧一锅水，加少许盐，放入螺旋面。按包装标注的时间煮至熟，捞起前保留约半杯煮面水。同步将圣女果洗净对半切，大蒜切末。' },
      { title: '慢慢炒出番茄香', body: '平底锅加入橄榄油，小火炒香蒜末，倒入大部分圣女果，中火炒约 5 分钟至软。加入番茄膏，再炒约 1 分钟，避免糊底。' },
      { title: '让酱汁裹住螺旋面', body: '加入少量煮面水，将酱汁调至能流动的浓度。倒入熟螺旋面翻拌约 2 分钟，让酱汁挂满面条纹路；过干时再少量加水。' },
      { title: '最后放罗勒，趁热享用', body: '关火后加入撕碎的罗勒和余下圣女果，按口味加盐、黑胡椒，轻轻翻匀后装盘。照片旁的面包是摆盘配食，不计入本菜谱用量。' },
    ],
    allergens: '含小麦；部分意面产品含鸡蛋，需查看包装。',
    tip: '煮面水一次少加一点，酱汁更容易裹住面条。罗勒在关火后放，能保留清新的香气。',
    credit: { author: 'Aleksandra Tanasiienko', sourceUrl: 'https://unsplash.com/photos/pasta-with-sauce-on-white-ceramic-plate-0y6eMd8vevA', license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license' },
  },
]
