# 🍋 YuketangHelper

雨课堂辅助工具 · AI 答题 / 自动刷课 / 讨论助手

[![License](https://img.shields.io/badge/license-GPL3-blue)](LICENSE)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-5.0-orange)](https://www.tampermonkey.net/)

## 功能

- **AI 自动答题** — 选择题 / 多选题 / 判断题 / 填空题 / 主观题
- **自动刷课** — 视频 / 课件 / 讨论 / 作业
- **加密字体绕过** — 截图 + 视觉 AI 识别
- **反检测** — 模拟人类操作（鼠标轨迹、打字节奏）
- **评论区检测** — 视频页自动识别评论区并发送

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. [点击安装脚本](https://raw.githubusercontent.com/你的用户名/yuketang-helper/main/yuketang-helper.user.js)
3. 打开 [雨课堂](https://www.yuketang.cn/) 任意课程页，右上角出现 🍋 悬浮球

## AI 配置

1. 打开 [阿里云 DashScope 控制台](https://dashscope.console.aliyun.com/apiKey)
2. 创建 API Key，开通 `qwen-plus` 和 `qwen-vl-plus` 模型
3. 在脚本设置面板填入 API Key，保存

> **费用**：`qwen-plus` 新用户有免费额度，`qwen-vl-plus` 按调用计费。关闭「AI 自动答题」可纯手动使用。

## 使用

| 按钮 | 功能 |
|------|------|
| ▶ 开始刷课 | 自动遍历课程列表完成所有内容 |
| 📍 处理当前页 | 识别当前页面类型并自动处理 |
| ⏸ 暂停 | 暂停/继续当前任务 |

答题页面会自动识别题型并请求 AI 生成答案。

## 免责声明

本工具仅供学习研究使用，请勿用于违反平台规定的用途。

## License

GPL-3.0
