/**
 * 博主的子分类：在「分类」下面再分一级。
 * Notion 博主库有一列单选「子分类」，每个账号最多填一个；子分类属于哪个分类以这里为准，Notion 的单选列表不记上下级。
 * 同步脚本把它写进 creators.json 的 subcats，网页侧栏和卡片菜单按它列子分类；Worker 改子分类时也按它核对。
 *
 * 怎么改：按平台（键名同 src/platforms.mjs 的 NAMES）列出「分类名: [子分类名…]」，分类名要和 Notion「分类」单选的选项一致。
 * 没列出的分类就没有子分类，网页上也不显示子分类标签条。子分类名在一个平台内不要重名。
 * 加、改、删子分类要改这里并推送部署；Notion 里已填的行要同时改掉，再在 Notion 博主库的「子分类」单选里加上同名选项。
 * 下面是配合演示数据（scripts/demo-data.mjs）的小示例，换成你自己的分类。
 */
export const SUBCATEGORIES = {
  douyin: {
    "科技数码": ["AI 应用", "数码评测", "编程开发", "芯片硬件"],
    "历史人文": ["中国历史", "世界历史", "读书文学"],
    "美食餐饮": ["家常菜谱", "探店种草", "饮食文化", "咖啡酒饮"],
  },
};

// 某个平台某个分类下的子分类，没有就是空数组
export const subcategoriesOf = (platform, category) => SUBCATEGORIES[platform]?.[category] ?? [];
