# 🍋 YuketangHelper

> 雨课堂，但是帮你上。

写这个东西的初衷很简单——课太多，懒得看。后来发现不只是视频烦人，作业和讨论题也烦人，索性一起收拾了。

---

## 能干什么

答题。不管是单选多选判断填空还是主观题，扔给 AI，自动选、自动填、自动提交。遇到加密字体也不怕，截图发视觉模型绕过去。

刷课。视频自动播、PPT 自动翻、课件自动翻完就跑。有评论区的地方先发句"已看"再播视频，刷完一个接下一个，直到全部绿灯。

反检测。鼠标不是你硬晃的，是模拟人手的贝塞尔曲线；打字不是瞬间填满的，是逐字敲进去的。页面失焦检测？拦掉了。

---

## 怎么装

装个 [Tampermonkey](https://www.tampermonkey.net/)，然后点[这里安装脚本](https://raw.githubusercontent.com/murasamekksk/yuketang-helper/master/yuketang-helper.user.js)。

打开雨课堂任意课程页，右上角会冒出来一个 🍋，点它就是。

---

## AI 怎么配

用的是阿里云的模型，得先去 [DashScope](https://dashscope.console.aliyun.com/apiKey) 搞个 API Key。文本用 `qwen-plus`，视觉用 `qwen-vl-plus`，新号都有免费额度，够用了。

拿到 Key 之后在脚本的设置面板里填进去，保存，完事。

> 不放心 AI 答案的话别开「AI 自动答题」，手动点「获取AI答案」自己判断。视觉模型一次几分钱，不算贵但也不是免费的，心里有数就行。

---

## 大概就这样

这玩意就是用来自用的，顺便开源给有缘人。有 bug 提 issue，想改的自己 fork。

别拿去卖，别拿去搞事情。GPL-3.0，你懂的。
