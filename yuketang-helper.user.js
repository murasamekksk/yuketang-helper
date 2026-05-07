// ==UserScript==
// @name         YuketangHelper
// @namespace    http://tampermonkey.net/
// @version      5.0.0
// @description  雨课堂辅助工具 · AI答题 / 自动刷课 / 讨论助手 · 仅供学习研究
// @author       YuketangHelper
// @license      GPL3
// @match        *://*.yuketang.cn/*
// @match        *://*.changjiang.yuketang.cn/*
// @match        *://*.gdufemooc.cn/*
// @run-at       document-start
// @icon         https://www.yuketang.cn/favicon.ico
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.deepseek.com
// @connect      api.openai.com
// @connect      api.moonshot.cn
// @connect      dashscope.aliyuncs.com
// @connect      generativelanguage.googleapis.com
// @connect      ark.cn-beijing.volces.com
// @connect      ws-lfj7btyrgg16eler.cn-beijing.maas.aliyuncs.com
// @connect      fe-static-yuketang.yuketang.cn
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.3.2/dist/html2canvas.min.js
// ==/UserScript==

(() => {
  'use strict';

  if (window.__YKT_HELPER_LOADED__) return;
  window.__YKT_HELPER_LOADED__ = true;
  if (window.top !== window.self) return;

  // ════════════════════════════════════════════
  //  全局暂停控制
  // ════════════════════════════════════════════
  const Pause = {
    _paused: false,
    isPaused() { return this._paused; },
    pause()  { this._paused = true; },
    resume() { this._paused = false; },
    async check() {
      while (this._paused) await sleep(500);
    },
  };

  // ════════════════════════════════════════════
  //  配置
  // ════════════════════════════════════════════
  const Config = {
    version: '5.0.0',
    pptInterval: 3000,
  };

  // ════════════════════════════════════════════
  //  存储
  // ════════════════════════════════════════════
  const Store = {
    _get(k, def) { try { return GM_getValue(k, def); } catch { return def; } },
    _set(k, v)   { try { GM_setValue(k, v); } catch { localStorage.setItem(k, JSON.stringify(v)); } },
    getAI() {
      return this._get('ykt4_ai', {
        url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        key: '',
        model: 'qwen-plus',
        visionUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        visionModel: 'qwen-vl-plus',
      });
    },
    setAI(v) { this._set('ykt4_ai', v); },
    getFeature() { return this._get('ykt4_feat', { autoAI: false, autoComment: false, skipVision: false }); },
    setFeature(v) { this._set('ykt4_feat', v); },
    getProgress(url) { const a = this._get('ykt4_prog', {}); return a[url] ?? { outside: 0, inside: 0 }; },
    setProgress(url, outside, inside = 0) {
      const a = this._get('ykt4_prog', {}); a[url] = { outside, inside }; this._set('ykt4_prog', a);
    },
    clearProgress(url) { const a = this._get('ykt4_prog', {}); delete a[url]; this._set('ykt4_prog', a); },
  };

  // ════════════════════════════════════════════
  //  工具
  // ════════════════════════════════════════════
  const sleep = (ms = 1000) => new Promise(r => setTimeout(r, ms));
  const randSleep = (base = 1000, jitter = 800) => sleep(base + Math.random() * jitter);
  const readDelay = (text = '') => randSleep(Math.min(text.length * 30, 4000) + 500, 1000);

  function poll(check, { interval = 1000, timeout = 60000 } = {}) {
    return new Promise(resolve => {
      const t0 = Date.now();
      const id = setInterval(async () => {
        await Pause.check();
        if (check()) { clearInterval(id); resolve(true); }
        else if (Date.now() - t0 > timeout) { clearInterval(id); resolve(false); }
      }, interval);
    });
  }

  function isDone(text) { return text && /100%|99%|98%|已完成/.test(text); }

  async function getMediaTimeout(selector = 'video,audio') {
    const el = document.querySelector(selector);
    if (!el) return 180_000;
    let dur = el.duration;
    if (!isFinite(dur) || dur <= 0)
      await new Promise(r => el.addEventListener('loadedmetadata', r, { once: true }));
    return Math.max(el.duration * 1000 * 3, 30_000);
  }

  function setNativeValue(el, value) {
    if (!el) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const s = Object.getOwnPropertyDescriptor(
        tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'
      )?.set;
      if (s) s.call(el, value); else el.value = value;
    } else if (el.isContentEditable) { el.textContent = value; }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ════════════════════════════════════════════
  //  加密字体检测 —— 只检测是否存在加密字体，不做字符映射
  //  检测到加密字体 → 答题时用 html2canvas 截图 + 视觉 AI
  // ════════════════════════════════════════════
  const FontDecoder = (() => {
    let _hasEncrypted = false;

    function detect() {
      if (_hasEncrypted) return;
      if (document.querySelector('.xuetangx-com-encrypted-font')) {
        _hasEncrypted = true;
        console.log('[YKT] 检测到加密字体，将使用视觉模式答题');
        return;
      }
      // 也检查 CSS 中是否有加密字体引用
      try {
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of (sheet.cssRules || [])) {
              if (!(rule instanceof CSSFontFaceRule)) continue;
              if (/exam_font/i.test(rule.style.getPropertyValue('src') || '')) {
                _hasEncrypted = true;
                console.log('[YKT] 检测到加密字体 CSS，将使用视觉模式答题');
                return;
              }
            }
          } catch (e) {}
        }
      } catch (e) {}
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', detect);
      // 二次检测，应对动态加载
      setTimeout(detect, 3000);
    } else {
      detect();
    }

    return {
      hasEncryptedFont() { return _hasEncrypted; },
      isReady() { return false; },  // 不做映射，始终不可用 → extractTextSafe 会跳过加密 span
      size() { return 0; },
    };
  })();

  /**
   * 从 DOM 元素中提取真实文字，处理 xuetangx 加密字体
   * 优先用动态字体映射还原加密 span 内的真实汉字；
   * 若映射尚未建立则跳过加密 span（回退方案）
   */
  function extractTextSafe(el) {
    if (!el) return '';
    let result = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      let ancestor = node.parentElement;
      let encrypted = false;
      while (ancestor && ancestor !== el) {
        if (ancestor.classList.contains('xuetangx-com-encrypted-font')) {
          encrypted = true; break;
        }
        ancestor = ancestor.parentElement;
      }
      if (!encrypted) {
        result += node.textContent;
      } else if (FontDecoder.isReady()) {
        // 字体映射已建立：逐字还原加密字符
        let decoded = '';
        for (const ch of node.textContent) {
          decoded += FontDecoder.decode(ch);
        }
        result += decoded;
      }
      // 若映射未建立且是加密节点，直接跳过（不污染题目）
    }
    return result.replace(/\s+/g, ' ').trim();
  }

  // ════════════════════════════════════════════
  //  反检测套件
  // ════════════════════════════════════════════
  function preventScreenCheck() {
    const win = unsafeWindow;
    const blocked = new Set(['visibilitychange', 'blur', 'pagehide']);
    const wrap = orig => (...args) => blocked.has(args[0]) ? undefined : orig.apply(this, args);
    win.addEventListener      = wrap(win.addEventListener.bind(win));
    document.addEventListener = wrap(document.addEventListener.bind(document));
    Object.defineProperties(document, {
      hidden: { get: () => false },
      visibilityState: { get: () => 'visible' },
      hasFocus: { value: () => true },
    });
  }

  async function moveMouseTo(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const tx = rect.left + rect.width  * (0.2 + Math.random() * 0.6);
    const ty = rect.top  + rect.height * (0.2 + Math.random() * 0.6);
    const steps = 8 + Math.floor(Math.random() * 8);
    let cx = moveMouseTo._x ?? window.innerWidth  / 2;
    let cy = moveMouseTo._y ?? window.innerHeight / 2;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, ease = t * t * (3 - 2 * t);
      el.ownerDocument.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        clientX: cx + (tx - cx) * ease + (Math.random() - 0.5) * 4,
        clientY: cy + (ty - cy) * ease + (Math.random() - 0.5) * 4,
      }));
      await sleep(12 + Math.random() * 18);
    }
    moveMouseTo._x = tx; moveMouseTo._y = ty;
  }

  async function humanClick(el) {
    if (!el) return;
    await moveMouseTo(el);
    await randSleep(60, 80);
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await randSleep(40, 60);
    el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
    await randSleep(80, 100);
  }

  async function humanType(el, text) {
    if (!el || !text) return;
    el.focus();
    await randSleep(150, 200);

    // 优先用 Vue/React 兼容方式写入：通过原生 setter 触发框架响应式
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    // 先清空
    if (nativeSetter) nativeSetter.call(el, '');
    else if (el.isContentEditable) el.textContent = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(80);

    if (text.length > 20) {
      // 长文本：整体写入后触发完整事件链（兼容Vue双向绑定）
      if (nativeSetter) nativeSetter.call(el, text);
      else if (el.isContentEditable) el.textContent = text;
      // 必须按顺序触发这几个事件，Vue才会识别
      el.dispatchEvent(new Event('focus',  { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown',  { bubbles: true, key: 'a' }));
      el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: 'a' }));
      el.dispatchEvent(new KeyboardEvent('keyup',    { bubbles: true, key: 'a' }));
      await randSleep(400, 600);
    } else {
      // 短文本：逐字打入
      for (const char of text) {
        const cur = el.value ?? el.textContent ?? '';
        if (nativeSetter) nativeSetter.call(el, cur + char);
        else if (el.isContentEditable) el.textContent = cur + char;
        el.dispatchEvent(new KeyboardEvent('keydown',  { bubbles: true, key: char }));
        el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: char }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup',    { bubbles: true, key: char }));
        await sleep(60 + Math.random() * 80);
      }
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
    el.focus(); // 重新 focus 确保按钮状态更新
    await randSleep(300, 400);
  }

  async function humanScroll(el) {
    const t = el ?? document.documentElement;
    t.scrollBy({ top: 60 + Math.random() * 120, behavior: 'smooth' });
    await randSleep(300, 500);
    if (Math.random() < 0.3) { t.scrollBy({ top: -(20 + Math.random() * 40), behavior: 'smooth' }); await randSleep(200, 300); }
  }

  // ════════════════════════════════════════════
  //  播放器
  // ════════════════════════════════════════════
  const Player = {
    mute() { const v = document.querySelector('video'); if (v) v.volume = 0; },
    autoPlay(media) { if (!media) return; media.volume = 0; media.play().catch(() => {}); },
    observePause(video) {
      if (!video) return () => {};
      const play = () => video.play().catch(() => setTimeout(play, 3000));
      play();
      const target = document.querySelector('.play-btn-tip');
      if (!target) return () => {};
      const obs = new MutationObserver(() => { if (target.innerText === '播放') video.play().catch(() => {}); });
      obs.observe(target, { childList: true });
      return () => obs.disconnect();
    },
  };

  // ════════════════════════════════════════════
  //  AI 答题
  // ════════════════════════════════════════════
  const AI = {
    extractQuestion(container) {
      if (!container) return '';
      return extractTextSafe(container);
    },

    /** 用 html2canvas 把题目区域渲染为图片（绕过加密字体） */
    async captureQuestionImage(container) {
      if (typeof html2canvas === 'undefined') return null;
      try {
        const canvas = await html2canvas(container, {
          scale: 2, useCORS: true, allowTaint: true,
          backgroundColor: '#ffffff', logging: false,
        });
        return canvas.toDataURL('image/png');
      } catch (e) { return null; }
    },

    /** 判断文字是否因加密字体明显不完整 */
    textLooksIncomplete(text, container) {
      if (!text || text.length < 3) return true;
      if (/[-]/.test(text)) return true;
      if (!FontDecoder.isReady() && container) {
        const encs = container.querySelectorAll('.xuetangx-com-encrypted-font');
        if (encs.length > 0) return true;
      }
      return false;
    },

    ask(questionText, questionType = 'choice', imageDataUrl = null) {
      return new Promise((resolve, reject) => {
        const cfg = Store.getAI();
        if (!cfg.key || !cfg.key.trim() || cfg.key.includes('sk-xxx')) {
          reject('请在 [AI配置] 中填写有效的 API Key'); return;
        }
        let systemMsg, userMsg;
        if (questionType === 'fill') {
          systemMsg = '你是专业答题助手。填空题直接给出每空答案，多空用"|"分隔，不要解释。';
          userMsg = `填空题（多空用|分隔，只给答案）：\n${questionText}`;
        } else if (questionType === 'discuss') {
          systemMsg = '你是一位学者，正在回答课程讨论题。请以严谨、客观的学术口吻作答，200字以内，逻辑清晰，言之有物，不要列编号标题，直接成段落作答。';
          userMsg = `请回答这道讨论题：\n${questionText}`;
        } else if (questionType === 'essay') {
          systemMsg = '你是专业答题助手。简答题请给出简明扼要的回答，100-200字，不要废话。';
          userMsg = `简答题：\n${questionText}`;
        } else if (questionType === 'multi') {
          systemMsg = '你正在参加一场涵盖多学科（医学/生物/数学/人文/社会等）的大学课程测验。这是一道多选题，选项范围可能为A-G。请独立分析每个选项，得出最终答案。只输出正确选项的字母连写（如"ABD"或"ACDG"），禁止空格、禁止解释、禁止输出选项文字。';
          userMsg = `${questionText}`;
        } else if (questionType === 'judge') {
          systemMsg = '你正在参加一场涵盖多学科（医学/生物/数学/人文/社会等）的大学课程测验。这是一道判断题。请理解题干的核心命题，注意绝对化表述通常是错的，相对表述通常是对的。只输出"对"或"错"，禁止任何解释。';
          userMsg = `${questionText}`;
        } else {
          systemMsg = '你正在参加一场涵盖多学科（医学/生物/数学/人文/社会等）的大学课程测验。这是一道单选题，选项范围可能为A-G。请分析每个选项的正误，选出唯一正确答案。只输出一个字母（A-G），禁止任何解释、禁止输出选项文字。';
          userMsg = `${questionText}`;
        }

        // ── 构建文本请求（自动检测 API 格式）──
        const mkTextReq = (url, model) => {
          const isDashTxt = url.toLowerCase().includes('dashscope.aliyuncs.com') && !url.toLowerCase().includes('compatible-mode');
          const maxTok = questionType === 'discuss' ? 300 : (questionType === 'essay' ? 400 : (questionType === 'multi' ? 40 : 15));
          if (isDashTxt) {
            return {
              url, model,
              body: JSON.stringify({
                model, input: { messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }] },
                parameters: { temperature: 0, max_tokens: maxTok },
              }),
              parseFn: (json) => json?.output?.choices?.[0]?.message?.content?.trim() || '',
            };
          }
          return {
            url, model,
            body: JSON.stringify({
              model, stream: false, temperature: 0.0, max_tokens: maxTok,
              messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }],
            }),
            parseFn: (json) => json?.choices?.[0]?.message?.content?.trim() || '',
          };
        };

        if (!imageDataUrl) {
          const tr = mkTextReq(cfg.url, cfg.model);
          const timeoutMs = (questionType === 'choice' || questionType === 'judge' || questionType === 'multi') ? 8000 : 20000;
          GM_xmlhttpRequest({
            method: 'POST', url: tr.url,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
            data: tr.body, timeout: timeoutMs,
            onload(res) {
              if (res.status !== 200) { reject(`HTTP ${res.status}`); return; }
              try { resolve(tr.parseFn(JSON.parse(res.responseText))); }
              catch { reject('JSON解析失败'); }
            },
            onerror: () => reject('网络错误'),
            ontimeout: () => reject('请求超时'),
          });
          return;
        }

        // ── 视觉模式：自动检测 API 后端 ──
        const visUrl = (cfg.visionUrl || cfg.url).toLowerCase();
        let model, apiUrl, headers, body, parseFn;

        if (visUrl.includes('generativelanguage.googleapis.com')) {
          // ── Google Gemini（免费层）──
          model = cfg.visionModel || 'gemini-2.0-flash';
          apiUrl = cfg.visionUrl || cfg.url;
          // Gemini 用 URL query param 传 key，自动追加
          if (!/[?&]key=/.test(apiUrl) && cfg.key) {
            apiUrl += (apiUrl.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(cfg.key);
          }
          const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
          body = JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { text: `${systemMsg}\n\n${userMsg}` },
                { inlineData: { mimeType: 'image/png', data: base64 } },
              ],
            }],
            generationConfig: { temperature: 0, maxOutputTokens: questionType === 'multi' ? 40 : 400 },
          });
          parseFn = (json) => json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        } else {
          // ── OpenAI / 兼容接口（默认） ──
          model = cfg.visionModel || 'gpt-4o';
          apiUrl = cfg.visionUrl || cfg.url;
          const messages = [
            { role: 'system', content: systemMsg },
            { role: 'user', content: [
              { type: 'text', text: userMsg },
              { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
            ]},
          ];
          body = JSON.stringify({ model, stream: false, temperature: 0.0, max_tokens: questionType === 'discuss' ? 300 : (questionType === 'essay' ? 400 : (questionType === 'multi' ? 40 : 15)), messages });
          parseFn = (json) => json.choices?.[0]?.message?.content?.trim() || '';
        }

        const timeoutMs = 30000;
        headers = { 'Content-Type': 'application/json' };
        if (visUrl.includes('generativelanguage.googleapis.com')) {
          headers = { 'Content-Type': 'application/json' };
        } else {
          headers['Authorization'] = `Bearer ${cfg.key}`;
        }

        // 视觉失败自动回退纯文本
        let visionFailed = false;
        const fallbackToText = (reason = '') => {
          if (visionFailed) return; visionFailed = true;
          if (reason) console.log(`[YKT] 视觉模式失败(${reason})，回退文本模式`);
          const tr = mkTextReq(cfg.url, cfg.model);
          const tMs = (questionType === 'choice' || questionType === 'judge' || questionType === 'multi') ? 8000 : 20000;
          GM_xmlhttpRequest({
            method: 'POST', url: tr.url,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
            data: tr.body, timeout: tMs,
            onload(r) {
              if (r.status !== 200) { reject(`文本模式 HTTP ${r.status}`); return; }
              try { resolve(tr.parseFn(JSON.parse(r.responseText))); }
              catch { reject('JSON解析失败'); }
            },
            onerror: () => reject('网络错误'),
            ontimeout: () => reject('请求超时'),
          });
        };

        GM_xmlhttpRequest({
          method: 'POST', url: apiUrl, headers: headers,
          data: body, timeout: timeoutMs,
          onload(res) {
            if (res.status === 401 || res.status === 403) {
              fallbackToText(`视觉模型 ${model} 无权限(HTTP ${res.status})，请检查API Key是否开通视觉模型`);
              return;
            }
            if (res.status !== 200) { fallbackToText(`HTTP ${res.status}`); return; }
            try { const r = parseFn(JSON.parse(res.responseText)); if (r) resolve(r); else fallbackToText('AI返回空'); }
            catch { fallbackToText('JSON解析失败'); }
          },
          onerror: () => fallbackToText('网络错误'),
          ontimeout: () => fallbackToText('请求超时'),
        });
      });
    },

    async selectAndSubmit(aiText, container, log) {
      const judgeM = aiText.match(/[对错正确错误]/);
      if (judgeM) {
        const a = judgeM[0];
        log(`🤖 AI答案: ${a}`);
        return await this._clickOption(container, [(a === '对' || a === '正确') ? 0 : 1], log);
      }
      const letters = aiText.replace(/[^A-Ga-g]/g, '').toUpperCase();
      if (!letters) { log('⚠️ 无法解析AI答案: ' + aiText); return false; }
      log(`🤖 AI答案: ${letters}`);
      const indices = [...letters].map(c => c.charCodeAt(0) - 65).filter(i => i >= 0 && i <= 6);
      return await this._clickOption(container, indices, log);
    },

    async _clickOption(container, indices, log) {
      const listEl = container.querySelector('ul');
      if (!listEl) { log('⚠️ 未找到选项列表'); return false; }
      const items = listEl.querySelectorAll('li');
      if (!items.length) { log('⚠️ 选项为空'); return false; }
      for (const idx of indices) {
        const item = items[idx]; if (!item) continue;
        if (item.classList.contains('is-disabled') || item.querySelector('input:disabled')) {
          log(`⚠️ 选项${String.fromCharCode(65+idx)}已被禁用，跳过`);
          continue;
        }
        item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        await randSleep(200, 300);
        await humanClick(item);
        await poll(() => item.classList.contains('active'), { interval: 150, timeout: 1500 });
        const inp = item.querySelector('input[type="radio"],input[type="checkbox"]');
        if (inp && !inp.checked) { inp.checked = true; inp.dispatchEvent(new Event('change', { bubbles: true })); }
        await randSleep(200, 400);
      }
      await randSleep(400, 600);
      return await this._submit(container, log);
    },

    // 专门针对作业页面的选项点击（label.el-radio / el-checkbox 结构）
    async selectAndSubmitHomework(aiText, container, log) {
      const judgeM = aiText.match(/[对错正确错误]/);
      if (judgeM) {
        const a = judgeM[0];
        log(`🤖 AI答案: ${a}`);
        return await this._clickHomeworkOption(container, [(a === '对' || a === '正确') ? 0 : 1], log);
      }
      const letters = aiText.replace(/[^A-Ga-g]/g, '').toUpperCase();
      if (!letters) { log('⚠️ 无法解析AI答案: ' + aiText); return false; }
      log(`🤖 AI答案: ${letters}`);
      const indices = [...letters].map(c => c.charCodeAt(0) - 65).filter(i => i >= 0 && i <= 6);
      return await this._clickHomeworkOption(container, indices, log);
    },

    async _clickHomeworkOption(container, indices, log) {
      // 实测结构：ul.list-unstyled-checkbox > li > label.el-checkbox > span.el-checkbox__label > span.checkboxInput
      // 实测结构：ul.list-unstyled-radio   > li > label.el-radio    > span.el-radio__label   > span.checkboxInput
      // 真正要点的是 label.el-checkbox 或 label.el-radio

      // 优先精准选择器（作业页面实测）
      let labels = [...container.querySelectorAll(
        'ul.list-unstyled-checkbox label.el-checkbox, ul.list-unstyled-radio label.el-radio'
      )];

      // 备用：更宽松的选择器
      if (!labels.length) {
        labels = [...container.querySelectorAll(
          'label.el-checkbox, label.el-radio, label.homeworkElRadio, label.homeworkElCheckbox'
        )];
      }

      // 再备用：直接找 li
      if (!labels.length) {
        return await this._clickOption(container, indices, log);
      }

      log(`找到 ${labels.length} 个选项`);

      for (const idx of indices) {
        const label = labels[idx];
        if (!label) { log(`⚠️ 选项${idx}不存在`); continue; }
        if (label.classList.contains('is-disabled') || label.querySelector('input:disabled')) {
          log(`⚠️ 选项${String.fromCharCode(65+idx)}已被禁用，跳过`);
          continue;
        }

        label.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        await randSleep(80, 120);

        // 方式1：直接点 label
        await humanClick(label);
        await sleep(120);

        // 方式2：如果没有选中，点内部的 input
        const inp = label.querySelector('input[type="radio"], input[type="checkbox"]');
        const isChecked = () => label.classList.contains('is-checked') || (inp && inp.checked);
        if (!isChecked()) {
          if (inp) {
            const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
            if (s) s.call(inp, true);
            inp.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            inp.dispatchEvent(new Event('input',  { bubbles: true }));
            await sleep(80);
          }
        }

        // 方式3：如果还没选中，点 span.checkboxInput（那个显示字母的圆圈）
        if (!isChecked()) {
          const spanBtn = label.querySelector('.checkboxInput, .el-checkbox__input, .el-radio__input');
          if (spanBtn) { await humanClick(spanBtn); await sleep(80); }
        }

        // 等待选中状态（最多1.2秒）
        await poll(isChecked, { interval: 60, timeout: 1200 });
        log(`选项${String.fromCharCode(65 + idx)} 选中状态: ${isChecked()}`);
        await randSleep(80, 120);
      }

      await randSleep(400, 500);
      return await this._submit(container, log);
    },

    async _submit(container, log) {
      let el = container;
      for (let i = 0; i < 8; i++) {
        if (!el) break;
        for (const btn of el.querySelectorAll('button, [class*="btn"]')) {
          const txt = btn.innerText || btn.textContent || '';
          if (txt.includes('提交') && !btn.disabled && !btn.classList.contains('is-disabled')) {
            await humanClick(btn); log('✅ 已提交答案'); await randSleep(200, 300); return true;
          }
        }
        el = el.parentElement;
      }
      for (const btn of document.querySelectorAll('button')) {
        const txt = btn.innerText || '';
        if ((txt.includes('确定') || txt.includes('保存')) && !btn.disabled && !btn.classList.contains('is-disabled') && btn.offsetParent) {
          await humanClick(btn); log('✅ 已提交答案'); await randSleep(200, 300); return true;
        }
      }
      return false;
    },

    async fillBlanks(aiText, container, log) {
      const answers = aiText.split('|').map(s => s.trim());
      const inputs = container.querySelectorAll('input[type="text"], textarea:not(.comment-input)');
      for (let i = 0; i < inputs.length; i++) {
        inputs[i].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        await randSleep(200, 300);
        await humanType(inputs[i], answers[i] || answers[0] || aiText);
        await randSleep(150, 250);
      }
      return await this._submit(container, log);
    },
  };

  // ════════════════════════════════════════════
  //  评论助手
  // ════════════════════════════════════════════
  const Comment = {
    /**
     * 发表评论
     * @param {string} text 要发表的内容
     * @param {Function} log
     * @param {string} inputSel 输入框选择器（可选，默认自动查找）
     * @param {string} btnSel  发送按钮选择器（可选）
     */
    async post(text, log, inputSel = null, btnSel = null) {
      await Pause.check();

      let input = null;
      for (let retry = 0; retry < 20 && !input; retry++) {
        input = (inputSel && document.querySelector(inputSel))
          || document.querySelector('textarea.el-textarea__inner')
          || document.querySelector('textarea[placeholder*="观点"]')
          || document.querySelector('textarea[placeholder*="评论"]')
          || document.querySelector('textarea[placeholder*="回复"]')
          || document.querySelector('.el-textarea__inner');
        if (!input || input.offsetParent === null) { input = null; await sleep(500); }
      }
      if (!input) { log('⚠️ 未找到评论输入框'); return false; }

      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await randSleep(400, 600);
      await humanClick(input);
      await randSleep(300, 400);

      // 直接赋值（参考可用代码的方式），再触发Vue响应式事件链
      input.value = text;
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // 额外触发focus确保Vue更新按钮状态
      input.dispatchEvent(new Event('focus',  { bubbles: true }));
      await randSleep(600, 800);

      // 等待发送按钮可用
      let btn = null;
      for (let retry = 0; retry < 10 && !btn; retry++) {
        // 优先用指定选择器
        if (btnSel) {
          const c = document.querySelector(btnSel);
          if (c && !c.disabled && !c.classList.contains('is-disabled')) { btn = c; break; }
        }
        // forum 页面：发送按钮在 div.postbtn 内
        const postbtn = document.querySelector('.postbtn button, .postbtn [class*="btn"]');
        if (postbtn && !postbtn.disabled && !postbtn.classList.contains('is-disabled') && postbtn.offsetParent) {
          btn = postbtn; break;
        }
        const candidate = document.querySelector('button.submitComment') || document.querySelector('.submitComment');
        if (candidate && !candidate.classList.contains('is-disabled') && !candidate.disabled) {
          btn = candidate; break;
        }
        await sleep(500);
      }
      // 兜底：找文字含"发送"的可用按钮
      if (!btn) {
        for (const el of document.querySelectorAll('button')) {
          const txt = (el.innerText || '').trim();
          if (txt.includes('发送') && !el.disabled && !el.classList.contains('is-disabled') && el.offsetParent) {
            btn = el; break;
          }
        }
      }

      if (!btn) { log('⚠️ 未找到可用的发送按钮（可能输入未被识别）'); return false; }
      await humanClick(btn);
      log('✅ 已发表评论');
      await randSleep(600, 800);
      return true;
    },

    getExistingComment() {
      const sels = ['.cont_detail', '.comment-content', '.discuss-content', '[class*="comment"] p', '[class*="discuss"] p'];
      for (const sel of sels) {
        for (const n of document.querySelectorAll(sel)) {
          const t = n.innerText?.trim();
          if (t && t.length > 5) return t;
        }
      }
      return '';
    },
  };

  // ════════════════════════════════════════════
  //  讨论题处理（/forum/ 页面：专门讨论题，AI作答）
  // ════════════════════════════════════════════
  async function handleForumPage(log) {
    log('📋 检测到专门讨论题页面，准备AI作答...');
    await sleep(1500);

    // 正确判断"自己已发言"：
    // 雨课堂自己发的评论会有删除按钮，但 .wonderfuldiscuss_delete 是所有评论都有的举报区
    // 真正标志是：.new_discuss 列表里有没有属于自己的评论（暂无可靠选择器）
    // 改为：检查输入框是否还存在且可用，如果页面显示"已发表"则跳过
    const submitted = document.querySelector('.discuss-submitted, .already-discuss, [class*="alreadyPost"]');
    if (submitted) { log('✅ 本讨论题已作答，跳过'); return true; }

    // 读取题目内容：div.custom_ueditor_cn_body > p
    const bodyEl = document.querySelector('.custom_ueditor_cn_body') || document.querySelector('.word-break.custom-ueditor');
    let questionText = bodyEl ? extractTextSafe(bodyEl) : '';

    if (!questionText || questionText.length < 5) {
      const contentEl = document.querySelector('section.content') || document.querySelector('.graph-wrap .box .content');
      questionText = contentEl ? extractTextSafe(contentEl) : '';
    }

    if (!questionText || questionText.length < 5) {
      log('⚠️ 讨论题内容为空，发固定回复');
      await Comment.post('已学习，收获颇丰！', log);
      return true;
    }

    log(`📖 讨论题：${questionText.slice(0, 50)}...`);

    try {
      const answer = await AI.ask(questionText, 'discuss');
      log(`🤖 AI回答生成完毕（${answer.length}字）`);
      await Comment.post(answer, log);
    } catch (e) {
      log(`⚠️ AI失败(${e})，发固定回复`);
      await Comment.post('通过学习本章内容，我对相关知识有了更深入的理解，收获很多。', log);
    }
    return true;
  }

  // ════════════════════════════════════════════
  //  视频+讨论页面处理（/video-student/ 页面：发固定回复"已看"）
  // ════════════════════════════════════════════
  async function handleVideoDiscussPage(log) {
    log('🎬 检测到视频讨论页，先发评论再播放视频');

    // 先发评论"已看"（不等视频播完）
    await humanScroll(null);
    await randSleep(600, 800);
    const ok = await Comment.post('已看', log);
    if (ok) {
      log('✅ 评论已发送，继续播放视频');
    } else {
      log('⚠️ 评论发送失败或无输入框，继续播放视频');
    }

    // 再等待视频播放完毕
    const video = document.querySelector('video');
    if (video) {
      Player.mute();
      Player.observePause(video);
      const prog = () => document.querySelector('.progress-wrap .text')?.innerHTML || '';
      const expired = document.querySelector('.box')?.innerText?.includes('已过考核截止时间');
      if (!expired && !isDone(prog())) {
        log('⏳ 等待视频播放完成...');
        await poll(() => {
          const p = document.querySelector('.progress-wrap .text')?.innerHTML || '';
          return isDone(p) || (video.ended) || document.querySelector('.box')?.innerText?.includes('已过考核截止时间');
        }, { interval: 2000, timeout: await getMediaTimeout() });
      }
      log('✅ 视频已完成');
    }
    return true;
  }

  // ════════════════════════════════════════════
  //  作业页面处理（/exercise/ URL，逐题翻页模式）
  // ════════════════════════════════════════════
  async function handleExercisePage(log) {
    log('📝 检测到作业页面，开始逐题答题...');
    // 等待题目容器出现
    await poll(() => !!document.querySelector('.subject-item, .el-scrollbar__view, div.problem-body'), { interval: 500, timeout: 15000 });

    // 获取题目总数（左侧导航数字）
    const getNavItems = () => [...document.querySelectorAll('div.subject-item.J_order, div.subject-item')];
    let navItems = getNavItems();

    // 如果有左侧题目导航，用导航逐题切换
    if (navItems.length > 0) {
      log(`共 ${navItems.length} 道题（导航模式）`);
      for (let qi = 0; qi < navItems.length; qi++) {
        await Pause.check();
        const nav = getNavItems()[qi];
        if (!nav) break;
        nav.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        await randSleep(100, 150);
        await humanClick(nav);
        await poll(() => { const n = getNavItems()[qi]; return n && n.classList.contains('active'); }, { interval: 100, timeout: 2000 });
        await randSleep(150, 200);
        await answerCurrentQuestion(qi + 1, navItems.length, log);
        await randSleep(200, 300);
      }
    } else {
      // 无导航：用上一题/下一题按钮翻页
      log('未找到导航，使用翻页模式');
      let qi = 0;
      while (true) {
        await Pause.check();
        await randSleep(400, 500);
        await answerCurrentQuestion(qi + 1, '?', log);
        await randSleep(400, 500);

        // 找"下一题"按钮
        const nextBtn = [...document.querySelectorAll('button, .btn')].find(b => {
          const t = (b.innerText || '').trim();
          return (t === '下一题' || t.includes('下一题')) && !b.disabled && !b.classList.contains('is-disabled') && b.offsetParent;
        });
        if (!nextBtn) { log('已到最后一题'); break; }
        await humanClick(nextBtn);
        await randSleep(600, 800);
        qi++;
      }
    }

    // 提交作业
    await randSleep(800, 1000);
    const submitAll = [...document.querySelectorAll('button')].find(b => {
      const t = b.innerText || '';
      return (t.includes('交卷') || t.includes('提交作业') || t.includes('提交')) && !b.disabled && !b.classList.contains('is-disabled') && b.offsetParent;
    });
    if (submitAll) {
      log('📝 点击交卷...');
      await humanClick(submitAll);
      await randSleep(600, 800);
      await sleep(800);
      const confirmBtn = [...document.querySelectorAll('button')].find(b => {
        const t = b.innerText || '';
        return (t.includes('确定') || t.includes('确认') || t.includes('交卷')) && b.offsetParent;
      });
      if (confirmBtn) { await humanClick(confirmBtn); }
    }
    log('✅ 作业处理完成');
  }

  // 对当前显示的单道题目进行AI作答
  async function answerCurrentQuestion(qIndex, total, log) {
    // ── 实测DOM结构 ──────────────────────────────────────
    // div.subject-item
    //   └─ div.item-type         ← 题型标签（单选题/多选题/判断题）
    //   └─ div.item-body         ← 整道题的容器（必须用这个！）
    //        └─ div.problem-body ← 只有题干文字
    //        └─ ul.list-unstyled.list-unstyled-radio    ← 选项ul，与problem-body是兄弟！
    //             └─ li
    //                  └─ label.el-radio.homeworkElRadio ← 点击目标
    //                       └─ span.el-radio__input > input[type=radio]
    //                       └─ span.el-radio__label
    //                            └─ span.radioInput  ← 圆圈字母
    //                            └─ span.radioText   ← 选项文字
    // ────────────────────────────────────────────────────

    // 必须用 item-body 作为容器，ul 和 problem-body 是兄弟关系
    const itemBody = document.querySelector('.item-body');
    if (!itemBody) { log(`第 ${qIndex} 题：未找到 .item-body 容器，跳过`); return; }

    // 已答过检查：看 input 是否已经 checked
    const hasAnswer = itemBody.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked, label.el-radio.is-checked, label.el-checkbox.is-checked');
    if (hasAnswer) { log(`第 ${qIndex} 题已作答，跳过`); return; }

    // 判断题型：从 div.item-type 读取
    const typeTag = document.querySelector('.item-type')?.innerText?.trim() || '';
    let qType = 'choice';
    if (typeTag.includes('多选')) qType = 'multi';
    else if (typeTag.includes('判断')) qType = 'judge';
    else if (typeTag.includes('填空')) qType = 'fill';
    else if (typeTag.includes('主观') || typeTag.includes('简答')) qType = 'essay';

    // 提取题干：从 div.problem-body 读取（跳过加密span，只取真实文本片段）
    const problemBody = itemBody.querySelector('.problem-body');
    const stemText = extractTextSafe(problemBody || itemBody).trim();

    // 逐条提取选项（带字母编号），选项文字同样过滤加密span
    const optionsEl = itemBody.querySelector('ul.list-unstyled-radio, ul.list-unstyled-checkbox, ul.list-inline');
    let optionsText = '';
    if (optionsEl) {
      const items = optionsEl.querySelectorAll('li');
      items.forEach((li, i) => {
        const letter = String.fromCharCode(65 + i);
        // 只取 radioText / checkboxText 等内容span，跳过圆圈字母span
        const textSpan = li.querySelector('.radioText, .checkboxText, .el-radio__label, .el-checkbox__label');
        const text = extractTextSafe(textSpan || li).trim();
        if (text) optionsText += `${letter}. ${text}\n`;
      });
    }

    let questionText = '';
    const encNote = FontDecoder.isReady() ? '' : '（部分文字因字体加密可能缺失）';
    if (stemText) questionText += `题干${encNote}：${stemText}\n`;
    if (optionsText) questionText += `选项：\n${optionsText}`;

    if (!questionText || questionText.length < 3) { log(`第 ${qIndex} 题：题目内容为空，跳过`); return; }

    // 完整题目日志
    log(`━━━ 第 ${qIndex}/${total} 题 [${qType}] ━━━`);
    log(`题干：${stemText || '(空)'}`);
    if (optionsText) log(`选项：\n${optionsText.trimEnd()}`);
    log(`正在请求AI...`);

    try {
      const aiType = qType === 'judge' ? 'judge' : qType;

      // 优先视觉模式：截图发给视觉 AI，保留完整题目（公式/表格/加密字体都不丢）
      const feat = Store.getFeature();
      let imageDataUrl = null;
      if (typeof html2canvas !== 'undefined' && !feat.skipVision) {
        imageDataUrl = await AI.captureQuestionImage(itemBody);
        if (imageDataUrl) { log('已截取题目图片，视觉AI作答'); }
        else { log('截图失败，回退到纯文本模式'); }
      }

      const answer = await AI.ask(questionText, aiType, imageDataUrl);
      log(`AI回答：${answer}`);

      if (qType === 'fill') {
        await AI.fillBlanks(answer, itemBody, log);
      } else if (qType === 'essay') {
        const ta = itemBody.querySelector('textarea, [contenteditable]');
        if (ta) {
          ta.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          await randSleep(200, 300);
          await humanType(ta, answer);
          await AI._submit(itemBody, log);
        }
      } else {
        // 选择题/判断题/多选题 → 传 itemBody（包含ul）
        await AI.selectAndSubmitHomework(answer, itemBody, log);
      }
    } catch (e) { log(`第 ${qIndex} 题AI失败：${e}`); }
  }

  // ════════════════════════════════════════════
  //  原作业页面处理（handleHomeworkPage，兼容旧入口）
  // ════════════════════════════════════════════
  async function handleHomeworkPage(log) {
    // 如果是 /exercise/ URL，用新的逐题翻页逻辑
    if (/\/exercise\//.test(location.pathname)) {
      return await handleExercisePage(log);
    }
    // 否则用原有导航逻辑
    await poll(() => !!document.querySelector('div.subject-item.J_order'), { interval: 500, timeout: 15000 });

    const getNavItems = () => [...document.querySelectorAll('div.subject-item.J_order')];
    const navItems = getNavItems();
    if (!navItems.length) {
      log('⚠️ 未找到题目导航列表，尝试旧方式...');
      return await handleHomeworkPageLegacy(log);
    }

    log(`共找到 ${navItems.length} 道题`);

    for (let qi = 0; qi < navItems.length; qi++) {
      await Pause.check();
      const nav = getNavItems()[qi];
      if (!nav) break;
      nav.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      await randSleep(200, 300);
      await humanClick(nav);
      await poll(() => { const n = getNavItems()[qi]; return n && n.classList.contains('active'); }, { interval: 200, timeout: 3000 });
      await randSleep(400, 500);
      await answerCurrentQuestion(qi + 1, navItems.length, log);
      await randSleep(500, 600);
    }

    await randSleep(800, 1000);
    const submitAll = [...document.querySelectorAll('button')].find(b => {
      const t = b.innerText || '';
      return (t.includes('交卷') || t.includes('提交作业') || t.includes('提交')) && !b.disabled && !b.classList.contains('is-disabled');
    });
    if (submitAll) {
      log('📝 点击交卷...');
      await humanClick(submitAll);
      await randSleep(500, 700);
      await sleep(800);
      const confirmBtn = [...document.querySelectorAll('button')].find(b => {
        const t = b.innerText || '';
        return t.includes('确定') || t.includes('确认') || t.includes('交卷');
      });
      if (confirmBtn) { await humanClick(confirmBtn); }
    }
    log('✅ 作业处理完成');
  }

  // 旧版作业处理（无导航栏时的备用方案）
  async function handleHomeworkPageLegacy(log) {
    let qi = 0;
    while (true) {
      await Pause.check();
      const questions = document.querySelectorAll('.subject-item, [class*="question-item"], [class*="questionItem"]');
      if (qi >= questions.length) { log(`全部 ${questions.length} 题完成`); break; }
      const qEl = questions[qi];
      qEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await randSleep(300, 400);
      if (qEl.querySelector('.is-disabled, [class*="submitted"], [class*="answered"]')) { qi++; continue; }
      const typeText = qEl.querySelector('[class*="type"], [class*="tag"]')?.innerText || '';
      let qType = 'choice';
      if (typeText.includes('填空')) qType = 'fill';
      else if (typeText.includes('主观') || typeText.includes('简答')) qType = 'essay';
      const questionText = extractTextSafe(qEl);
      if (!questionText || questionText.length < 5) { qi++; continue; }
      await randSleep(300, 400);
      try {
        log(`第 ${qi + 1} 题（${qType}）请求AI...`);
        const answer = await AI.ask(questionText, qType);
        if (qType === 'fill') await AI.fillBlanks(answer, qEl, log);
        else if (qType === 'essay') {
          const ta = qEl.querySelector('textarea, [contenteditable]');
          if (ta) { ta.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); await randSleep(200, 300); await humanType(ta, answer); await AI._submit(qEl, log); }
        } else await AI.selectAndSubmitHomework(answer, qEl, log);
      } catch (e) { log(`第 ${qi + 1} 题AI失败：${e}`); }
      await randSleep(600, 500);
      qi++;
    }
    await randSleep(800, 1000);
    const submitAll = [...document.querySelectorAll('button')].find(b => b.innerText.includes('交卷') || b.innerText.includes('提交作业'));
    if (submitAll) { await humanClick(submitAll); await randSleep(500, 600); }
  }

  // ════════════════════════════════════════════
  //  自动识别当前页面并处理
  // ════════════════════════════════════════════
  async function detectAndHandleCurrentPage(log) {
    const path = location.pathname;

    // 1. 专门讨论题页面：URL 含 /forum/
    if (/\/forum\//.test(path)) {
      const feat = Store.getFeature();
      if (feat.autoComment) {
        return await handleForumPage(log);
      } else {
        log('ℹ️ 检测到讨论题页面，已关闭自动评论，跳过');
        return true;
      }
    }

    // 2. 视频+讨论页面：URL 含 /video-student/ 且页面有 video
    if (/\/video-student\//.test(path) && document.querySelector('video, .publish_discuss_unit_container')) {
      const feat = Store.getFeature();
      if (feat.autoComment) {
        return await handleVideoDiscussPage(log);
      } else {
        // 只播放视频，不发评论
        log('🎬 检测到视频页面，自动播放');
        const video = document.querySelector('video');
        if (video) { Player.mute(); Player.observePause(video); }
        return true;
      }
    }

    // 3. 作业/答题页面：URL 含 exercise / homework / zuoye / exam
    if (/exercise|homework|zuoye|exam/.test(path) || document.querySelector('.subject-item, [class*="question-item"]')) {
      const feat = Store.getFeature();
      if (feat.autoAI) {
        log('🔍 检测到作业/答题页面，自动答题');
        await handleHomeworkPage(log);
        return true;
      }
    }

    // 4. 视频页面（无讨论区）
    const video = document.querySelector('video');
    if (video && !video.ended) {
      log('🔍 检测到视频，自动播放');
      Player.mute(); Player.observePause(video);
      return true;
    }

    return false;
  }

  // ════════════════════════════════════════════
  //  V2 刷课逻辑
  // ════════════════════════════════════════════
  class V2Runner {
    constructor(log, resetBtn) {
      this.log = log; this.resetBtn = resetBtn;
      this.url = location.href;
      const p = Store.getProgress(this.url);
      this.outside = p.outside; this.inside = p.inside;
    }
    save(outside, inside = 0) {
      this.outside = outside; this.inside = inside;
      Store.setProgress(this.url, outside, inside);
    }

    async run() {
      this.log(`继续刷课，当前进度第 ${this.outside + 1} 集`);
      while (true) {
        await Pause.check();
        for (let i = 0; i < Math.floor(this.outside / 20) + 1; i++) {
          const c = document.querySelector('.viewContainer');
          if (c) c.scrollTop = c.scrollHeight;
          await sleep(800);
        }
        const list = document.querySelector('.logs-list')?.childNodes;
        if (!list?.length) { await sleep(2000); continue; }
        if (this.outside >= list.length) {
          this.log('🎉 全部课程刷完！'); this.resetBtn('刷完啦 ✓');
          Store.clearProgress(this.url); break;
        }
        const course = list[this.outside]?.querySelector('.content-box section');
        if (!course) { this.log('课程节点未找到，跳过'); this.save(this.outside + 1); continue; }

        // 检查本条课程是否已完成（列表项上的进度/状态标识）
        const listItem = list[this.outside];
        const completeText = (listItem?.innerText || '').replace(/\s+/g, '');
        const alreadyDone = /已完成|已看完|100%|99%|98%|已通过/.test(completeText)
          || listItem?.querySelector('.complete, .finished, .done, [class*="success"], [class*="complete"]');

        const useEl = course.querySelector('.tag use');
        const typeHref = (useEl?.getAttribute('href') || useEl?.getAttribute('xlink:href') || '').toLowerCase();
        const tagText = (course.querySelector('.tag')?.innerText || '').trim();
        this.log(`第 ${this.outside + 1}/${list.length}，类型标识: "${typeHref}" 文字: "${tagText}"${alreadyDone ? ' [已完成]' : ''}`);

        if (alreadyDone) {
          this.log('⏭ 已完成，跳过');
          this.save(this.outside + 1);
          continue;
        }

        if (typeHref.includes('shipin') || tagText === '视频') {
          await this.handleVideo(course);
        } else if (typeHref.includes('piliang') || tagText === '批量') {
          await this.handleBatch(course, list);
        } else if (typeHref.includes('ketang') || tagText === '课堂') {
          await this.handleClassroom(course);
        } else if (typeHref.includes('kejian') || tagText === '课件') {
          await this.handleCourseware(course);
        } else if (typeHref.includes('kaoshi') || tagText === '考试') {
          this.log('考试已跳过'); this.save(this.outside + 1);
        } else if (typeHref.includes('taolun') || typeHref.includes('tuwen') || tagText === '讨论' || tagText === '图文') {
          await this.handleDiscussionDirect(course, tagText);
        } else if (typeHref.includes('zuoye') || tagText === '作业') {
          await this.handleHomeworkDirect(course);
        } else {
          this.log(`未知类型，原始标识: "${typeHref}" / "${tagText}"，跳过`);
          this.save(this.outside + 1);
        }
      }
    }

    async handleVideo(course) {
      await Pause.check();
      await humanClick(course);
      await randSleep(2500, 1000);

      // 等待视频元素出现
      await poll(() => !!document.querySelector('video'), { interval: 500, timeout: 10000 });
      const video = document.querySelector('video');

      // 快速检查：进度已达标的直接跳过
      const quickProg = document.querySelector('.progress-wrap .text')?.innerHTML || '';
      const isExpired = () => document.querySelector('.box')?.innerText?.includes('已过考核截止时间');
      if (isDone(quickProg) || isExpired()) {
        this.log('⏭ 视频已完成，跳过');
        this.save(this.outside + 1);
        history.back();
        await randSleep(800, 500);
        return;
      }

      // 检测评论区：有输入框就先发评论"已看"，再等视频播完
      const feat = Store.getFeature();
      const hasCommentArea = document.querySelector('.publish_discuss_unit_container')
        || document.querySelector('textarea[placeholder*="观点"]')
        || document.querySelector('textarea[placeholder*="评论"]')
        || document.querySelector('.el-textarea__inner');
      if (hasCommentArea && feat.autoComment) {
        this.log('检测到评论区，先发评论再播放视频');
        await humanScroll(null);
        await randSleep(400, 500);
        const ok = await Comment.post('已看', this.log);
        if (ok) this.log('✅ 评论已发送，继续播放视频');
        else this.log('⚠️ 评论发送失败，继续播放视频');
      }

      Player.mute();
      const stop = Player.observePause(video);

      const isProgDone = () => isDone(document.querySelector('.progress-wrap .text')?.innerHTML || '');

      // 等进度条100% 或 已过截止时间；视频ended后再额外等最多10秒确保进度上报
      const timeout = await getMediaTimeout();
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };

        // 主轮询：进度条或截止时间
        const iv = setInterval(async () => {
          await Pause.check();
          if (isProgDone() || isExpired()) { clearInterval(iv); finish(); }
        }, 2000);

        // 总超时兜底
        setTimeout(() => { clearInterval(iv); finish(); }, timeout);

        // 视频结束后最多再等10秒等进度上报
        if (video) {
          const onEnded = () => setTimeout(() => { clearInterval(iv); finish(); }, 10000);
          if (video.ended) onEnded();
          else video.addEventListener('ended', onEnded, { once: true });
        }
      });

      await sleep(1500);
      stop();
      this.log('✅ 视频完成，返回列表');
      this.save(this.outside + 1);
      history.back();
      await randSleep(1200, 800);
    }

    async handleBatch(course, list) {
      await Pause.check();
      const expandBtn = course.querySelector('.sub-info .gray span');
      if (!expandBtn) { this.save(this.outside + 1); return; }
      await humanClick(expandBtn);
      await randSleep(1000, 600);
      const activities = list[this.outside]?.querySelectorAll('.activity__wrap') || [];
      let idx = this.inside;
      this.log(`批量区共 ${activities.length} 项，从第 ${idx + 1} 项开始`);
      while (idx < activities.length) {
        await Pause.check();
        const item = activities[idx]; if (!item) break;
        const useEl = item.querySelector('.tag use');
        const href = (useEl?.getAttribute('href') || useEl?.getAttribute('xlink:href') || '').toLowerCase();
        const tagText = (item.querySelector('.tag')?.innerText || '').trim();
        const title = item.querySelector('h2')?.innerText || `第${idx+1}项`;
        this.log(`  批量子项 ${idx+1}/${activities.length}：href="${href}" tag="${tagText}" 标题="${title}"`);

        if (tagText === '音频') {
          idx = await this.playMedia(item, title, idx, 'audio');
        } else if (href.includes('shipin') || tagText === '视频') {
          idx = await this.playMedia(item, title, idx, 'video');
        } else if (href.includes('tuwen') || href.includes('taolun') || tagText === '图文' || tagText === '讨论') {
          // 批量中的图文/讨论：进入后判断是否有视频
          idx = await this.handleDiscussion(item, tagText || '讨论', idx);
        } else if (href.includes('zuoye') || tagText === '作业') {
          idx = await this.handleHomework(item, idx);
        } else {
          this.log(`  跳过 ${title}（未知: href="${href}" tag="${tagText}"）`);
          idx++; this.save(this.outside, idx);
        }
        await randSleep(600, 800);
      }
      this.save(this.outside + 1); await randSleep(600, 500);
    }

    async playMedia(item, title, idx, type) {
      await Pause.check();
      this.log(`播放${type === 'audio' ? '音频' : '视频'}：${title}`);
      await humanClick(item); await randSleep(2000, 1000);

      await poll(() => !!document.querySelector(type), { interval: 500, timeout: 8000 });
      const media = document.querySelector(type);
      Player.autoPlay(media);
      if (type === 'video') { Player.mute(); }
      const stop = type === 'video' ? Player.observePause(media) : () => {};

      const isProgDone = () => isDone(document.querySelector('.progress-wrap .text')?.innerHTML || '');

      const mediaTout = await getMediaTimeout(type);
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };

        const iv = setInterval(async () => {
          await Pause.check();
          if (isProgDone()) { clearInterval(iv); finish(); }
        }, 2000);

        setTimeout(() => { clearInterval(iv); finish(); }, mediaTout);

        if (media) {
          const onEnded = () => setTimeout(() => { clearInterval(iv); finish(); }, 10000);
          if (media.ended) onEnded();
          else media.addEventListener('ended', onEnded, { once: true });
        }
      });

      await sleep(1500);
      stop();
      this.log(`✅ ${title} 完成`);
      idx++;
      this.save(this.outside, idx);
      history.back();
      await randSleep(1200, 800);
      return idx;
    }

    /**
     * 批量内的讨论/图文处理
     * 进入页面后检测：有 video → 发"已看"；无 video 且是讨论题 → AI作答
     */
    async handleDiscussion(item, typeText, idx) {
      await Pause.check();
      const feat = Store.getFeature();
      if (!feat.autoComment) {
        this.log(`已关闭自动评论，跳过 ${typeText}`);
        idx++; this.save(this.outside, idx); return idx;
      }
      const title = item.querySelector('h2')?.innerText || typeText;
      this.log(`进入${typeText}：${title}`);
      await humanClick(item); await randSleep(2000, 800);

      // 判断是视频讨论还是专门讨论题
      const hasVideo = !!document.querySelector('video');
      const isForumUrl = /\/forum\//.test(location.pathname);

      if (hasVideo) {
        // 视频讨论：先发"已看"，再播放视频
        this.log('检测到视频，先发评论再播放');
        await humanScroll(null); await randSleep(500, 600);
        const ok = await Comment.post('已看', this.log);
        if (ok) {
          this.log('✅ 评论已发送，继续播放视频');
        } else {
          this.log('⚠️ 评论发送失败或无输入框，继续播放视频');
        }
        const vid = document.querySelector('video');
        Player.mute(); Player.observePause(vid);
        const vidTout = await getMediaTimeout();
        await new Promise(resolve => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          const iv = setInterval(async () => {
            await Pause.check();
            if (isDone(document.querySelector('.progress-wrap .text')?.innerHTML || '')) { clearInterval(iv); finish(); }
          }, 2000);
          setTimeout(() => { clearInterval(iv); finish(); }, vidTout);
          if (vid) {
            const onEnded = () => setTimeout(() => { clearInterval(iv); finish(); }, 10000);
            if (vid.ended) onEnded(); else vid.addEventListener('ended', onEnded, { once: true });
          }
        });
      } else {
        // 专门讨论题：AI生成回答
        this.log('未检测到视频，按讨论题处理，AI作答');
        await humanScroll(null); await randSleep(600, 800);
        const bodyEl = document.querySelector('.custom_ueditor_cn_body') || document.querySelector('.word-break.custom-ueditor');
        let questionText = bodyEl ? extractTextSafe(bodyEl) : '';
        if (!questionText || questionText.length < 5) questionText = title;
        try {
          const answer = await AI.ask(questionText, 'discuss');
          await Comment.post(answer, this.log);
        } catch (e) {
          this.log(`AI失败(${e})，发固定回复`);
          await Comment.post('通过学习，我对这个问题有了更深入的理解，收获很多。', this.log);
        }
      }

      idx++; this.save(this.outside, idx); history.back(); await randSleep(800, 600);
      return idx;
    }

    /**
     * 顶层讨论/图文（不在批量内）
     */
    async handleDiscussionDirect(course, tagText) {
      await Pause.check();
      const feat = Store.getFeature();
      if (!feat.autoComment) { this.log('已关闭自动评论，跳过'); this.save(this.outside + 1); return; }
      await humanClick(course); await randSleep(2000, 800);

      const hasVideo = !!document.querySelector('video');
      if (hasVideo) {
        this.log('顶层视频讨论，先发评论再播放');
        await humanScroll(null); await randSleep(500, 600);
        const ok = await Comment.post('已看', this.log);
        if (ok) {
          this.log('✅ 评论已发送，继续播放视频');
        } else {
          this.log('⚠️ 评论发送失败或无输入框，继续播放视频');
        }
        const vid = document.querySelector('video');
        Player.mute(); Player.observePause(vid);
        const vidTout = await getMediaTimeout();
        await new Promise(resolve => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          const iv = setInterval(async () => {
            await Pause.check();
            if (isDone(document.querySelector('.progress-wrap .text')?.innerHTML || '')) { clearInterval(iv); finish(); }
          }, 2000);
          setTimeout(() => { clearInterval(iv); finish(); }, vidTout);
          if (vid) {
            const onEnded = () => setTimeout(() => { clearInterval(iv); finish(); }, 10000);
            if (vid.ended) onEnded(); else vid.addEventListener('ended', onEnded, { once: true });
          }
        });
      } else {
        this.log('顶层专门讨论题，AI作答');
        await humanScroll(null); await randSleep(600, 800);
        const bodyEl = document.querySelector('.custom_ueditor_cn_body') || document.querySelector('.word-break.custom-ueditor');
        let questionText = bodyEl ? extractTextSafe(bodyEl) : '';
        if (!questionText || questionText.length < 5) questionText = course.querySelector('h2')?.innerText || '本章内容讨论';
        try {
          const answer = await AI.ask(questionText, 'discuss');
          await Comment.post(answer, this.log);
        } catch (e) {
          this.log(`AI失败(${e})，发固定回复`);
          await Comment.post('通过学习，我对这个问题有了更深入的理解，收获很多。', this.log);
        }
      }

      this.save(this.outside + 1); history.back(); await randSleep(800, 600);
    }

    async handleHomework(item, idx) {
      await Pause.check();
      const feat = Store.getFeature();
      if (!feat.autoAI) { this.log('已关闭AI答题，跳过作业'); idx++; this.save(this.outside, idx); return idx; }
      this.log('进入作业，AI自动答题中...');
      await humanClick(item); await randSleep(2000, 1000);
      await handleHomeworkPage(this.log);
      idx++; this.save(this.outside, idx); history.back(); await randSleep(1500, 1000);
      return idx;
    }

    async handleHomeworkDirect(course) {
      await Pause.check();
      const feat = Store.getFeature();
      if (!feat.autoAI) { this.log('已关闭AI答题，跳过'); this.save(this.outside + 1); return; }
      await humanClick(course); await randSleep(2000, 1000);
      await handleHomeworkPage(this.log);
      this.save(this.outside + 1); history.back(); await randSleep(1500, 1000);
    }

    async handleClassroom(course) {
      await Pause.check();
      await humanClick(course); await sleep(5000);
      const iframe = document.querySelector('iframe.lesson-report-mobile');
      if (!iframe?.contentDocument) { this.save(this.outside + 1); return; }
      const video = iframe.contentDocument.querySelector('video');
      const audio = iframe.contentDocument.querySelector('audio');
      if (video) { Player.autoPlay(video); await new Promise(r => video.addEventListener('ended', r, { once: true })); }
      if (audio) { Player.autoPlay(audio); await new Promise(r => audio.addEventListener('ended', r, { once: true })); }
      this.save(this.outside + 1); history.back(); await randSleep(1200, 800);
    }

    async handleCourseware(course) {
      await Pause.check();
      await humanClick(course); await randSleep(2800, 800);
      const className = document.querySelector('.dialog-header')?.firstElementChild?.innerText || '课件';
      const slides = document.querySelector('.swiper-wrapper')?.children || [];
      if (slides.length) {
        this.log(`PPT 共 ${slides.length} 张`);
        for (let i = 0; i < slides.length; i++) { slides[i].click(); await randSleep(Config.pptInterval, 500); }
      }
      for (const vb of document.querySelectorAll('.video-box')) {
        if (vb.innerText.includes('已完成')) continue;
        vb.click(); await randSleep(2000, 500);
        const stop = Player.observePause(document.querySelector('video'));
        await poll(() => {
          const [a, b] = (document.querySelector('.xt_video_player_current_time_display')?.innerText || '').split(' / ');
          return a && b && a === b;
        }, { interval: 800, timeout: await getMediaTimeout() });
        stop();
      }
      this.log(`${className} 完成`); this.save(this.outside + 1); history.back(); await randSleep(1000, 500);
    }
  }

  // ════════════════════════════════════════════
  //  Pro/LMS 刷课逻辑
  // ════════════════════════════════════════════
  class ProRunner {
    constructor(log, resetBtn) { this.log = log; this.resetBtn = resetBtn; }
    async run() {
      preventScreenCheck(); this.log('Pro 模式启动...');
      while (true) {
        await Pause.check();
        await randSleep(1500, 800);
        const classType   = document.querySelector('.header-bar')?.firstElementChild?.firstElementChild?.className || '';
        const className   = document.querySelector('.header-bar')?.firstElementChild?.innerText || '';
        const classStatus = document.querySelector('.viewContainer section.title')?.lastElementChild?.innerText || '';
        if (classType.includes('shipin') && !isDone(classStatus)) {
          this.log(`播放：${className}`);
          await randSleep(1500, 800);
          await poll(() => !!document.querySelector('video'), { interval: 500, timeout: 10000 });
          const vid = document.querySelector('video');
          // 检测评论区
          const feat = Store.getFeature();
          const hasCommentArea = document.querySelector('.publish_discuss_unit_container')
            || document.querySelector('textarea[placeholder*="观点"]')
            || document.querySelector('textarea[placeholder*="评论"]')
            || document.querySelector('.el-textarea__inner');
          if (hasCommentArea && feat.autoComment) {
            this.log('检测到评论区，先发评论');
            const ok = await Comment.post('已看', this.log);
            if (ok) this.log('✅ 评论已发送');
          }
          if (vid) { Player.mute(); Player.observePause(vid); }
          await poll(() => isDone(document.querySelector('.viewContainer section.title')?.lastElementChild?.innerText || ''), { interval: 1000, timeout: await getMediaTimeout() });
          this.log(`${className} 完成`);
        } else { this.log(`跳过：${className}（${classStatus}）`); await randSleep(800, 500); }
        const next = document.querySelector('.btn-next');
        if (next) { await randSleep(1000, 1500); await humanClick(next); }
        else { this.log('🎉 Pro 课程全部完成！'); this.resetBtn('刷完啦 ✓'); break; }
      }
    }
  }

  // ════════════════════════════════════════════
  //  UI
  // ════════════════════════════════════════════
  function createUI() {
    const style = document.createElement('style');
    style.textContent = `
      :root {
        --vm-bg: #fefce8;
        --vm-bg2: #fffbeb;
        --vm-bg3: #f5f0e0;
        --vm-border: #e7dfc5;
        --vm-accent: #f59e0b;
        --vm-accent2: #84cc16;
        --vm-text: #1e293b;
        --vm-text2: #78716c;
        --vm-ok: #65a30d;
        --vm-warn: #d97706;
        --vm-err: #dc2626;
        --vm-radius: 18px;
      }
      #vm-panel {
        position: fixed; top: 40px; right: 24px; width: 380px;
        background: rgba(255,255,255,.88);
        backdrop-filter: blur(24px) saturate(1.6);
        -webkit-backdrop-filter: blur(24px) saturate(1.6);
        border: .5px solid rgba(0,0,0,.08);
        border-radius: var(--vm-radius);
        box-shadow: 0 2px 24px rgba(0,0,0,.06), 0 8px 40px rgba(0,0,0,.04), 0 0 0 .5px rgba(0,0,0,.04);
        z-index: 2147483647;
        font-family: -apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Microsoft YaHei",sans-serif;
        font-size: 13px; color: var(--vm-text);
        overflow: hidden; user-select: none;
        transition: opacity 0.3s cubic-bezier(0.25,0.1,0.25,1), transform 0.45s cubic-bezier(0.25,0.46,0.45,0.94), box-shadow 0.3s ease;
      }
      #vm-panel.dragging { box-shadow: 0 4px 36px rgba(0,0,0,.1), 0 16px 56px rgba(0,0,0,.06); }
      #vm-panel.minimized { opacity: 0; transform: scale(0.9); pointer-events: none; }
      #vm-panel.entering { animation: ykt-enter 0.55s cubic-bezier(0.25,0.46,0.45,0.94); }
      #vm-resize-handle {
        position: absolute; bottom: 0; right: 0;
        width: 20px; height: 20px;
        cursor: nwse-resize;
        z-index: 10;
      }
      #vm-resize-handle::after {
        content: ''; position: absolute; bottom: 4px; right: 4px;
        width: 0; height: 0;
        border-style: solid;
        border-width: 0 0 12px 12px;
        border-color: transparent transparent #d6d3c0 transparent;
        transition: border-color .2s;
      }
      #vm-resize-handle:hover::after { border-bottom-color: #f59e0b; }

      /* ── 标题栏 ── */
      #vm-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 0 16px; height: 48px;
        background: rgba(255,255,255,.6);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border-bottom: .5px solid rgba(0,0,0,.06);
        cursor: move;
      }
      #vm-header .vm-title {
        font-weight: 700; font-size: 14px; letter-spacing: -.2px;
        color: #92400e;
      }
      #vm-header .vm-sub {
        font-size: 10px; color: var(--vm-text2); margin-left: 8px;
      }
      #vm-header .vm-hbtns { display: flex; gap: 6px; align-items: center; }
      #vm-status-badge {
        font-size: 10px; font-weight: 600; padding: 3px 10px;
        border-radius: 20px; background: #fef3c7;
        border: .5px solid #fcd34d; color: #92400e;
        letter-spacing: .2px;
      }
      #vm-status-badge.running { background: #dcfce7; border-color: #86efac; color: #166534; }
      #vm-status-badge.paused  { background: #fef3c7; border-color: #fcd34d; color: #92400e; }
      .vm-icon-btn {
        width: 28px; height: 28px; border: none;
        background: rgba(0,0,0,.04); border-radius: 50%;
        color: var(--vm-text2); cursor: pointer; font-size: 12px;
        display: flex; align-items: center; justify-content: center;
        transition: background .2s, color .2s, transform .2s;
      }
      .vm-icon-btn:hover { background: rgba(0,0,0,.08); color: var(--vm-text); transform: scale(1.05); }
      .vm-icon-btn:active { transform: scale(.95); }

      /* ── 标签页 ── */
      #vm-tabs {
        display: flex; background: rgba(255,255,255,.4);
        border-bottom: .5px solid rgba(0,0,0,.05);
      }
      .vm-tab {
        flex: 1; padding: 11px 0; text-align: center;
        font-size: 12px; font-weight: 600; color: var(--vm-text2);
        cursor: pointer; transition: color .2s, border-bottom .2s;
        border-bottom: 2.5px solid transparent;
        letter-spacing: -.1px;
      }
      .vm-tab:hover { color: var(--vm-text); }
      .vm-tab.active { color: #92400e; border-bottom-color: #f59e0b; }

      /* ── 答题辅助面板 ── */
      #vm-assist {
        display: none; padding: 14px 16px; background: transparent;
        opacity: 0; transform: translateY(6px);
        transition: opacity .25s ease, transform .25s cubic-bezier(0.25,0.46,0.45,0.94);
      }
      #vm-assist.active { display: block; }
      .vm-section-label {
        font-size: 11px; font-weight: 600; color: var(--vm-text2);
        letter-spacing: .3px; margin-bottom: 8px;
      }
      #vm-question-box {
        background: #fff; border: .5px solid rgba(0,0,0,.06);
        border-radius: 14px; padding: 12px 14px; margin-bottom: 12px;
        font-size: 13px; color: var(--vm-text); line-height: 1.7;
        min-height: 48px; max-height: 120px; overflow-y: auto;
        white-space: pre-wrap;
        box-shadow: 0 1px 3px rgba(0,0,0,.02);
      }
      #vm-question-box.empty { color: var(--vm-text2); font-style: italic; }
      #vm-answer-box {
        background: linear-gradient(135deg, #fffbeb, #fefce8);
        border: .5px solid #fcd34d;
        border-radius: 14px; padding: 14px;
        text-align: center; margin-bottom: 12px;
        min-height: 48px;
      }
      #vm-answer-text {
        font-size: 24px; font-weight: 800; letter-spacing: 3px;
        color: #92400e;
      }
      #vm-answer-sub {
        font-size: 11px; color: var(--vm-text2); margin-top: 4px;
      }
      .vm-assist-btns { display: flex; gap: 8px; }
      .vm-assist-btns button {
        flex: 1; height: 36px; border: none; border-radius: 12px;
        font-size: 12px; font-weight: 600; cursor: pointer;
        transition: transform 0.15s cubic-bezier(0.25,0.46,0.45,0.94), opacity .15s, box-shadow .15s;
        letter-spacing: .2px;
      }
      .vm-assist-btns button:hover  { opacity: .9; transform: translateY(-1px); }
      .vm-assist-btns button:active { transform: scale(.97); }
      #vm-btn-ask {
        background: linear-gradient(135deg, #f59e0b, #eab308);
        color: #fff; box-shadow: 0 2px 8px rgba(245,158,11,.25);
      }
      #vm-btn-refresh {
        background: #fff; color: var(--vm-text2);
        border: .5px solid rgba(0,0,0,.08);
      }

      /* ── 日志区 ── */
      #vm-log-pane {
        display: none; background: transparent;
        opacity: 0; transform: translateY(6px);
        transition: opacity .25s ease, transform .25s cubic-bezier(0.25,0.46,0.45,0.94);
      }
      #vm-log-pane.active { display: block; }
      #vm-log {
        height: 200px; overflow-y: auto; padding: 12px 16px;
        background: rgba(255,255,255,.5); line-height: 1.6; user-select: text;
        border-radius: 12px; margin: 8px 12px;
      }
      #vm-log::-webkit-scrollbar { width: 3px; }
      #vm-log::-webkit-scrollbar-track { background: transparent; }
      #vm-log::-webkit-scrollbar-thumb { background: #d6d3c0; border-radius: 4px; }
      #vm-log .vl { padding: 2px 0; font-size: 11px; font-family: "SF Mono","Cascadia Code","Consolas",monospace; }
      #vm-log .vl.info { color: var(--vm-text2); }
      #vm-log .vl.ok   { color: var(--vm-ok); }
      #vm-log .vl.warn { color: var(--vm-warn); }
      #vm-log .vl.err  { color: var(--vm-err); }
      #vm-log .vl.sep  { color: #b8b0a0; }

      /* ── 设置区 ── */
      #vm-settings-pane {
        display: none; padding: 16px; background: transparent;
        max-height: 360px; overflow-y: auto;
        opacity: 0; transform: translateY(6px);
        transition: opacity .25s ease, transform .25s cubic-bezier(0.25,0.46,0.45,0.94);
      }
      #vm-settings-pane.active { display: block; }
      #vm-settings-pane::-webkit-scrollbar { width: 3px; }
      #vm-settings-pane::-webkit-scrollbar-thumb { background: #d6d3c0; border-radius: 4px; }
      .vm-field { margin-bottom: 12px; }
      .vm-field label { display: block; font-size: 11px; font-weight: 600; color: var(--vm-text2); margin-bottom: 5px; letter-spacing: .2px; }
      .vm-field input[type=text],
      .vm-field input[type=password] {
        width: 100%; box-sizing: border-box; padding: 9px 12px;
        background: #fff; border: .5px solid rgba(0,0,0,.08);
        border-radius: 10px; font-size: 13px; color: var(--vm-text); outline: none;
        transition: border-color .2s, box-shadow .2s;
      }
      .vm-field input:focus { border-color: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.12); }
      .vm-toggle-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 0; border-bottom: .5px solid rgba(0,0,0,.05);
      }
      .vm-toggle-row:last-of-type { border-bottom: none; }
      .vm-toggle-label { font-size: 13px; font-weight: 500; color: var(--vm-text); }
      .vm-toggle-label small { display: block; font-size: 11px; color: var(--vm-text2); margin-top: 2px; font-weight: 400; }
      .ykt-toggle { position: relative; width: 44px; height: 24px; flex-shrink: 0; }
      .ykt-toggle input { opacity: 0; width: 0; height: 0; }
      .ykt-slider { position: absolute; inset: 0; background: #d6d3c0; border-radius: 24px; cursor: pointer; transition: background .25s cubic-bezier(0.25,0.46,0.45,0.94); }
      .ykt-slider::before { content:''; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: transform .25s cubic-bezier(0.25,0.46,0.45,0.94); box-shadow: 0 1px 3px rgba(0,0,0,.12); }
      .ykt-toggle input:checked + .ykt-slider { background: #f59e0b; }
      .ykt-toggle input:checked + .ykt-slider::before { transform: translateX(20px); }
      .vm-s-footer { display: flex; gap: 8px; margin-top: 16px; }
      .vm-s-footer button { flex: 1; height: 36px; border: none; border-radius: 12px; cursor: pointer; font-size: 13px; font-weight: 600; transition: transform 0.15s cubic-bezier(0.25,0.46,0.45,0.94), opacity .15s; }
      .vm-s-footer button:hover { opacity: .88; }
      .vm-s-footer button:active { transform: scale(.97); }
      #vm-save   { background: linear-gradient(135deg,#f59e0b,#eab308); color: #fff; box-shadow: 0 2px 8px rgba(245,158,11,.2); }
      #vm-cancel { background: #fff; color: var(--vm-text2); border: .5px solid rgba(0,0,0,.08); }

      /* ── 底部操作栏 ── */
      #vm-footer {
        display: flex; gap: 8px; padding: 12px 16px;
        background: rgba(255,255,255,.6);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border-top: .5px solid rgba(0,0,0,.05);
        border-radius: 0 0 var(--vm-radius) var(--vm-radius);
      }
      #vm-footer button {
        flex: 1; height: 38px; border: none; border-radius: 12px;
        cursor: pointer; font-size: 12px; font-weight: 600;
        transition: transform 0.15s cubic-bezier(0.25,0.46,0.45,0.94), opacity .15s, box-shadow .15s;
        letter-spacing: .2px;
      }
      #vm-footer button:hover  { opacity: .88; transform: translateY(-1px); }
      #vm-footer button:active { transform: scale(.97); }
      #vm-btn-pause { background: #fef3c7; color: #92400e; border: .5px solid #fcd34d; display: none; }
      #vm-btn-now   { background: #fff; color: var(--vm-text); border: .5px solid rgba(0,0,0,.08); }
      #vm-btn-start { background: linear-gradient(135deg,#f59e0b,#eab308); color: #fff; box-shadow: 0 2px 8px rgba(245,158,11,.2); }

      /* ── 最小化气泡 ── */
      #vm-mini {
        display: flex; position: fixed; top: 40px; right: 24px;
        width: 52px; height: 52px; border-radius: 50%;
        background: linear-gradient(135deg,#f59e0b,#eab308);
        color: #fff; font-size: 18px;
        align-items: center; justify-content: center; text-align: center;
        cursor: pointer; z-index: 2147483647;
        box-shadow: 0 4px 16px rgba(245,158,11,.3), 0 1px 4px rgba(0,0,0,.06);
        opacity: 0; transform: scale(0.5); pointer-events: none;
        transition: opacity 0.3s cubic-bezier(0.25,0.1,0.25,1), transform 0.45s cubic-bezier(0.25,0.46,0.45,0.94);
      }
      #vm-mini.visible {
        opacity: 1; transform: scale(1); pointer-events: auto;
      }
      #vm-mini.visible:hover { transform: scale(1.08); }
      #vm-mini.visible:active { transform: scale(.95); }

      /* ── 作者信息 ── */
      #vm-credits {
        text-align: center; padding: 5px 0 10px;
        font-size: 10px; color: #b8b0a0; letter-spacing: .3px;
        background: transparent;
      }

      /* ── 动画 ── */
      @keyframes ykt-enter {
        0%   { opacity: 0; transform: translateY(12px) scale(.96); }
        100% { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes ykt-glow {
        0%,100% { box-shadow: 0 4px 16px rgba(245,158,11,.25), 0 1px 4px rgba(0,0,0,.06); }
        50%     { box-shadow: 0 6px 24px rgba(245,158,11,.4), 0 2px 8px rgba(0,0,0,.08); }
      }
      @keyframes ykt-pulse {
        0%,100% { opacity: 1; }
        50%     { opacity: .75; }
      }
    `;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div id="vm-mini" style="font-size: 22px;">🍋</div>
      <div id="vm-panel">
        <div id="vm-header">
          <div style="display:flex;align-items:center;gap:0">
            <span class="vm-title">🍋 YuketangHelper</span>
          </div>
          <div class="vm-hbtns">
            <span id="vm-status-badge">就绪</span>
            <button class="vm-icon-btn" id="vm-min-btn" title="最小化">—</button>
            <button class="vm-icon-btn" id="vm-close-btn" title="关闭">✕</button>
          </div>
        </div>

        <div id="vm-tabs">
          <div class="vm-tab active" data-tab="assist">🎯 答题辅助</div>
          <div class="vm-tab" data-tab="log">📋 日志</div>
          <div class="vm-tab" data-tab="settings">⚙ 设置</div>
        </div>

        <div id="vm-assist" class="active">
          <div class="vm-section-label">当前题目</div>
          <div id="vm-question-box" class="empty">等待题目加载...</div>
          <div class="vm-section-label">AI 建议答案</div>
          <div id="vm-answer-box">
            <div id="vm-answer-text">—</div>
            <div id="vm-answer-sub">点击「获取AI答案」开始</div>
          </div>
          <div class="vm-assist-btns">
            <button id="vm-btn-ask">🤖 获取AI答案</button>
            <button id="vm-btn-refresh">🔄 刷新题目</button>
          </div>
        </div>

        <div id="vm-log-pane">
          <div id="vm-log">
            <div class="vl ok">🍋 YuketangHelper 已加载</div>
          </div>
        </div>

        <div id="vm-settings-pane">
          <div id="vm-config-guide" style="background:#fffbeb;border:.5px solid #fcd34d;border-radius:14px;padding:14px 16px;margin-bottom:14px;font-size:11px;line-height:1.7;color:var(--vm-text2)">
            <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" id="vm-guide-toggle">
              <span style="font-weight:600;color:#92400e;font-size:12px">📖 配置引导</span>
              <span style="font-size:10px;color:var(--vm-text2);transition:transform .35s cubic-bezier(0.25,0.46,0.45,0.94);display:inline-block" id="vm-guide-arrow">▼</span>
            </div>
            <div id="vm-guide-body" style="margin-top:8px;max-height:600px;opacity:1;overflow:hidden;transition:max-height .45s cubic-bezier(0.25,0.46,0.45,0.94),opacity .3s ease,margin-top .35s ease">
              <div style="margin-bottom:6px"><b style="color:var(--vm-text)">① API Key</b> — 阿里云 DashScope 控制台 → <a href="https://dashscope.console.aliyun.com/apiKey" target="_blank" style="color:#d97706">创建API Key</a>，复制粘贴到此处</div>
              <div style="margin-bottom:6px"><b style="color:var(--vm-text)">② 模型选择</b> — 文本推荐 <code style="background:#f5f0e0;padding:1px 4px;border-radius:3px">qwen-plus</code>（免费额度），视觉推荐 <code style="background:#f5f0e0;padding:1px 4px;border-radius:3px">qwen-vl-plus</code></div>
              <div style="margin-bottom:6px"><b style="color:var(--vm-text)">③ API URL</b> — 保持默认即可，除非使用代理或第三方中转</div>
              <div style="background:#fef3c7;border:.5px solid #fcd34d;border-radius:8px;padding:10px 12px;margin-top:8px">
                <div style="font-weight:600;color:#92400e;margin-bottom:4px">⚠️ 收费说明</div>
                <div style="font-size:10px;color:var(--vm-text2)">
                  • <b>qwen-plus</b>：新用户免费额度（100万token），超出后 ¥4/百万token<br>
                  • <b>qwen-vl-plus</b>：¥1.5/千次调用，图片越大消耗越高（建议用 <code style="background:var(--vm-bg3);padding:1px 3px;border-radius:2px">scale:2</code> 平衡速度与质量）<br>
                  • 不想花钱？关闭下方「AI自动答题」即可纯手动<br>
                  • 视觉模式默认开启（截图发给AI），正确率更高但费用略高，不想用可在下方关闭
                </div>
              </div>
            </div>
          </div>
          <div class="vm-field"><label>API URL</label><input type="text" id="vm-ai-url" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"></div>
          <div class="vm-field"><label>API Key</label><input type="password" id="vm-ai-key" placeholder="sk-xxxxxxxx"></div>
          <div class="vm-field"><label>Model</label><input type="text" id="vm-ai-model" placeholder="qwen-plus"></div>
          <div class="vm-field"><label>Vision API URL</label><input type="text" id="vm-vision-url" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"></div>
          <div class="vm-field"><label>Vision Model</label><input type="text" id="vm-vision-model" placeholder="qwen-vl-plus (免费额度)"></div>
          <div class="vm-toggle-row">
            <div class="vm-toggle-label" style="position:relative">
              <span style="font-weight:800;font-size:13px">🤖 AI 自动答题</span>
              <span style="display:inline-block;background:#ff4757;color:#fff;font-size:9px;font-weight:800;padding:1px 6px;border-radius:3px;margin-left:6px;animation:ykt-pulse 1.5s infinite">谨慎使用！！！</span>
              <small>AI自动选中答案并提交，请先确认AI答案正确</small>
            </div>
            <label class="ykt-toggle"><input type="checkbox" id="vm-feat-ai"><span class="ykt-slider"></span></label>
          </div>
          <div class="vm-toggle-row">
            <div class="vm-toggle-label">
              💬 自动评论
              <small>视频讨论自动发送已看</small>
            </div>
            <label class="ykt-toggle"><input type="checkbox" id="vm-feat-comment"><span class="ykt-slider"></span></label>
          </div>
          <div class="vm-toggle-row">
            <div class="vm-toggle-label">
              🚫 禁用视觉模式
              <small>加密字体页面不截图发视觉AI（直接文本模式，部分文字缺失）</small>
            </div>
            <label class="ykt-toggle"><input type="checkbox" id="vm-feat-skipvision"><span class="ykt-slider"></span></label>
          </div>
          <div class="vm-s-footer">
            <button id="vm-save">保存配置</button>
            <button id="vm-cancel">取消</button>
          </div>
        </div>

        <div id="vm-footer">
          <button id="vm-btn-pause">⏸ 暂停</button>
          <button id="vm-btn-now">📍 处理当前页</button>
          <button id="vm-btn-start">▶ 开始刷课</button>
        </div>
        <div id="vm-credits">YuketangHelper v5.0.0</div>
        <div id="vm-resize-handle"></div>
      </div>
    `;
    document.body.appendChild(wrap);

    const panel    = document.getElementById('vm-panel');
    const mini     = document.getElementById('vm-mini');
    const header   = document.getElementById('vm-header');
    const logBox   = document.getElementById('vm-log');
    const statusEl = document.getElementById('vm-status-badge');
    const btnPause = document.getElementById('vm-btn-pause');
    const btnStart = document.getElementById('vm-btn-start');
    const btnNow   = document.getElementById('vm-btn-now');

    // 启动动画
    panel.classList.add('entering');
    panel.addEventListener('animationend', () => panel.classList.remove('entering'), { once: true });

    // ── 标签页切换 ──
    const tabs = document.querySelectorAll('.vm-tab');
    const panes = {
      assist:   document.getElementById('vm-assist'),
      log:      document.getElementById('vm-log-pane'),
      settings: document.getElementById('vm-settings-pane'),
    };
    let tabSwitching = false;
    tabs.forEach(tab => {
      tab.addEventListener('click', async () => {
        if (tabSwitching || tab.classList.contains('active')) return;
        tabSwitching = true;
        const oldPane = Object.values(panes).find(p => p.classList.contains('active'));
        const newPane = panes[tab.dataset.tab];

        // 淡出旧面板
        if (oldPane) { oldPane.style.opacity = '0'; oldPane.style.transform = 'translateY(6px)'; }
        await sleep(180);

        // 切换
        tabs.forEach(t => t.classList.remove('active'));
        Object.values(panes).forEach(p => { p.classList.remove('active'); p.style.opacity = ''; p.style.transform = ''; });
        tab.classList.add('active');
        newPane.classList.add('active');

        // 淡入新面板
        newPane.style.opacity = '0'; newPane.style.transform = 'translateY(6px)';
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            newPane.style.opacity = '1'; newPane.style.transform = 'translateY(0)';
          });
        });
        await sleep(300);
        tabSwitching = false;
      });
    });

    // ── 答题辅助 ──
    const questionBox  = document.getElementById('vm-question-box');
    const answerText   = document.getElementById('vm-answer-text');
    const answerSub    = document.getElementById('vm-answer-sub');

    function refreshQuestion() {
      const itemBody = document.querySelector('.item-body');
      if (!itemBody) { questionBox.textContent = '未检测到题目区域'; questionBox.classList.add('empty'); return; }
      const problemBody = itemBody.querySelector('.problem-body');
      const stem = extractTextSafe(problemBody || itemBody).trim();
      if (stem) {
        questionBox.textContent = stem;
        questionBox.classList.remove('empty');
      } else {
        questionBox.textContent = '题目文字暂时无法读取（字体加密中）';
        questionBox.classList.add('empty');
      }
    }

    document.getElementById('vm-btn-refresh').onclick = refreshQuestion;

    document.getElementById('vm-btn-ask').onclick = async () => {
      const btn = document.getElementById('vm-btn-ask');
      btn.disabled = true; btn.textContent = '思考中...';
      answerText.style.cssText = '-webkit-text-fill-color:var(--vm-text2)';
      answerText.textContent = '...';
      answerSub.textContent = 'AI 正在分析题目';
      try {
        const itemBody = document.querySelector('.item-body');
        if (!itemBody) throw new Error('未找到题目区域');
        const typeTag = document.querySelector('.item-type')?.innerText?.trim() || '';
        let qType = 'choice';
        if (typeTag.includes('多选')) qType = 'multi';
        else if (typeTag.includes('判断')) qType = 'judge';
        else if (typeTag.includes('填空')) qType = 'fill';
        else if (typeTag.includes('主观') || typeTag.includes('简答')) qType = 'essay';

        const problemBody = itemBody.querySelector('.problem-body');
        const stemText = extractTextSafe(problemBody || itemBody).trim();
        const optionsEl = itemBody.querySelector('ul.list-unstyled-radio, ul.list-unstyled-checkbox, ul.list-inline');
        let optionsText = '';
        if (optionsEl) {
          optionsEl.querySelectorAll('li').forEach((li, i) => {
            const letter = String.fromCharCode(65 + i);
            const textSpan = li.querySelector('.radioText, .checkboxText, .el-radio__label, .el-checkbox__label');
            const text = extractTextSafe(textSpan || li).trim();
            if (text) optionsText += `${letter}. ${text}\n`;
          });
        }
        const encNote = FontDecoder.isReady() ? '' : '（部分文字因字体加密可能缺失）';
        let questionText = stemText ? `题干${encNote}：${stemText}\n` : '';
        if (optionsText) questionText += `选项：\n${optionsText}`;
        if (!questionText) throw new Error('题目内容为空');

        log(`━━━ 答题辅助 [${qType}] ━━━`);
        log(`题干：${stemText || '(空)'}`);
        if (optionsText) log(`选项：\n${optionsText.trimEnd()}`);

        // 优先视觉模式：截图发给视觉 AI，保留完整题目
        const feat = Store.getFeature();
        let imageDataUrl = null;
        if (typeof html2canvas !== 'undefined' && !feat.skipVision) {
          imageDataUrl = await AI.captureQuestionImage(itemBody);
          if (imageDataUrl) log('已截取题目图片，视觉AI作答');
          else log('截图失败，回退到纯文本模式');
        }

        const answer = await AI.ask(questionText, qType === 'judge' ? 'judge' : qType, imageDataUrl);
        answerText.style.cssText = '';
        answerText.textContent = answer;
        answerSub.textContent = `题型：${qType} · 仅供参考，请自行判断`;
        log(`🤖 AI建议：${answer}`);
      } catch(e) {
        answerText.textContent = '失败';
        answerSub.textContent = e.message;
        log(`❌ 答题辅助失败：${e.message}`);
      }
      btn.disabled = false; btn.textContent = '🤖 获取AI答案';
    };

    function log(msg) {
      const cls = msg.startsWith('✅')||msg.startsWith('🎉')||msg.startsWith('⚡') ? 'ok'
        : msg.startsWith('⚠️') ? 'warn'
        : msg.startsWith('❌') ? 'err'
        : msg.startsWith('━━') ? 'sep' : 'info';
      const line = document.createElement('div');
      line.className = `vl ${cls}`;
      line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      logBox.appendChild(line);
      logBox.scrollTop = logBox.scrollHeight;
    }

    function setStatus(s, paused = false) {
      statusEl.textContent = s;
      statusEl.className = paused ? 'paused' : s === '运行中' ? 'running' : '';
    }

    function resetBtn(txt = '▶ 开始刷课') {
      btnStart.textContent = txt;
      btnPause.style.display = 'none';
      btnNow.style.display = 'flex';
      setStatus('就绪');
    }

    function onStarted() {
      btnPause.style.display = 'flex';
      btnNow.style.display = 'none';
      setStatus('运行中');
    }

    btnPause.onclick = () => {
      if (Pause.isPaused()) {
        Pause.resume();
        btnPause.textContent = '⏸ 暂停';
        setStatus('运行中');
        log('▶ 已继续');
      } else {
        Pause.pause();
        btnPause.textContent = '▶ 继续';
        setStatus('已暂停', true);
        log('⏸ 已暂停，点继续恢复');
      }
    };

    // ── 拖拽 ──
    let dragging = false, ox = 0, oy = 0;
    header.addEventListener('mousedown', e => {
      if (e.target.closest('.vm-icon-btn, .vm-hbtns')) return;
      dragging = true; ox = e.clientX - panel.offsetLeft; oy = e.clientY - panel.offsetTop;
      panel.classList.add('dragging'); e.preventDefault();
    });
    document.addEventListener('mousemove', e => { if (!dragging) return; panel.style.left = `${e.clientX - ox}px`; panel.style.top = `${e.clientY - oy}px`; panel.style.right = 'auto'; });
    document.addEventListener('mouseup', () => { dragging = false; panel.classList.remove('dragging'); });

    // ── 调整大小 ──
    let resizing = false, rsx = 0, rsy = 0, rsw = 0, rsh = 0;
    const resizeHandle = document.getElementById('vm-resize-handle');
    resizeHandle.addEventListener('mousedown', e => {
      resizing = true; rsx = e.clientX; rsy = e.clientY;
      rsw = panel.offsetWidth; rsh = panel.offsetHeight;
      e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener('mousemove', e => {
      if (!resizing) return;
      const w = Math.max(300, Math.min(800, rsw + e.clientX - rsx));
      const h = Math.max(300, Math.min(900, rsh + e.clientY - rsy));
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
    });
    document.addEventListener('mouseup', () => { resizing = false; });

    // ── 最小化 / 关闭 ──
    document.getElementById('vm-min-btn').onclick = () => {
      panel.classList.add('minimized');
      mini.classList.add('visible');
      mini.style.top = panel.style.top || '40px';
      mini.style.right = '24px';
    };
    let mDragMoved = false;
    mini.addEventListener('click', () => {
      if (mDragMoved) return;
      panel.classList.remove('minimized');
      mini.classList.remove('visible');
    });
    let mDrag = false, mox = 0, moy = 0;
    mini.addEventListener('mousedown', e => { mDrag = true; mDragMoved = false; mox = e.clientX - mini.offsetLeft; moy = e.clientY - mini.offsetTop; e.preventDefault(); });
    document.addEventListener('mousemove', e => { if (!mDrag) return; mDragMoved = true; mini.style.left = `${e.clientX - mox}px`; mini.style.top = `${e.clientY - moy}px`; mini.style.right = 'auto'; });
    document.addEventListener('mouseup', () => { mDrag = false;
      setTimeout(() => { mDragMoved = false; }, 100);
    });
    document.getElementById('vm-close-btn').onclick = () => { panel.classList.add('minimized'); mini.classList.remove('visible'); };

    // ── 设置 ──
    function loadCfg() {
      const ai = Store.getAI();
      document.getElementById('vm-ai-url').value     = ai.url;
      document.getElementById('vm-ai-key').value     = ai.key;
      document.getElementById('vm-ai-model').value   = ai.model;
      document.getElementById('vm-vision-url').value = ai.visionUrl || '';
      document.getElementById('vm-vision-model').value = ai.visionModel || '';
      const feat = Store.getFeature();
      document.getElementById('vm-feat-ai').checked      = feat.autoAI;
      document.getElementById('vm-feat-comment').checked = feat.autoComment;
      document.getElementById('vm-feat-skipvision').checked = feat.skipVision;
    }

    document.getElementById('vm-save').onclick = () => {
      Store.setAI({
        url: document.getElementById('vm-ai-url').value.trim(),
        key: document.getElementById('vm-ai-key').value.trim(),
        model: document.getElementById('vm-ai-model').value.trim(),
        visionUrl: document.getElementById('vm-vision-url').value.trim(),
        visionModel: document.getElementById('vm-vision-model').value.trim(),
      });
      Store.setFeature({ autoAI: document.getElementById('vm-feat-ai').checked, autoComment: document.getElementById('vm-feat-comment').checked, skipVision: document.getElementById('vm-feat-skipvision').checked });
      log('✅ 配置已保存');
      document.querySelector('[data-tab="log"]').click();
    };
    document.getElementById('vm-cancel').onclick = () => {
      document.querySelector('[data-tab="log"]').click();
    };

    let nowRunning = false, nowPaused = false;
    btnNow.onclick = async () => {
      if (!nowRunning) {
        nowRunning = true;
        btnNow.textContent = '⏸ 暂停'; btnNow.style.background = '#fef3c7'; btnNow.style.color = '#92400e'; btnNow.style.border = '.5px solid #fcd34d';
        log('📍 识别当前页面...');
        setStatus('运行中');
        const handled = await detectAndHandleCurrentPage(log);
        if (!handled) log('⚠️ 当前页面未识别到可处理的内容');
        nowRunning = false; nowPaused = false; Pause.resume();
        btnNow.textContent = '📍 处理当前页'; btnNow.style.background = ''; btnNow.style.color = ''; btnNow.style.border = '';
        setStatus('就绪');
      } else if (!nowPaused) {
        nowPaused = true; Pause.pause();
        btnNow.textContent = '▶ 继续'; btnNow.style.background = '#dcfce7'; btnNow.style.color = '#166534'; btnNow.style.border = '.5px solid #86efac';
        log('⏸ 已暂停');
        setStatus('已暂停', true);
      } else {
        nowPaused = false; Pause.resume();
        btnNow.textContent = '⏸ 暂停'; btnNow.style.background = '#fef3c7'; btnNow.style.color = '#92400e'; btnNow.style.border = '.5px solid #fcd34d';
        log('▶ 继续');
        setStatus('运行中');
      }
    };

    document.getElementById('vm-guide-toggle').onclick = () => {
      const body = document.getElementById('vm-guide-body');
      const arrow = document.getElementById('vm-guide-arrow');
      if (body.classList.contains('collapsed')) {
        body.classList.remove('collapsed');
        body.style.maxHeight = '600px'; body.style.opacity = '1'; body.style.marginTop = '8px';
        arrow.style.transform = 'rotate(0deg)';
      } else {
        body.classList.add('collapsed');
        body.style.maxHeight = '0'; body.style.opacity = '0'; body.style.marginTop = '0';
        arrow.style.transform = 'rotate(-90deg)';
      }
    };

    loadCfg();
    // 进答题页时自动刷新题目显示
    setTimeout(refreshQuestion, 1500);
    return { log, setStatus, resetBtn, onStarted };
  }

  // ════════════════════════════════════════════
  //  路由 & 启动
  // ════════════════════════════════════════════
  function start(log, resetBtn, onStarted) {
    const host  = location.host;
    const parts = location.pathname.split('/');
    const key   = `${host}/${parts[1]}/${parts[2]}`;
    log(`匹配: ${key}`);
    onStarted();
    if (/yuketang\.cn\/v2\/web|gdufemooc\.cn\/v2\/web/.test(key)) {
      new V2Runner(log, resetBtn).run().catch(e => { log(`❌ 运行出错：${e}`); resetBtn(); });
    } else if (/yuketang\.cn\/pro\/lms|gdufemooc\.cn\/pro\/lms/.test(key)) {
      new ProRunner(log, resetBtn).run().catch(e => { log(`❌ 运行出错：${e}`); resetBtn(); });
    } else {
      log('⚠️ 当前页面非刷课页面（应匹配 */v2/web/* 或 */pro/lms/*）');
      resetBtn();
    }
  }

  function init() {
    if (!document.body) {
      new MutationObserver((_, obs) => { if (document.body) { obs.disconnect(); init(); } })
        .observe(document.documentElement, { childList: true });
      return;
    }
    const { log, setStatus, resetBtn, onStarted } = createUI();
    document.getElementById('vm-btn-start').onclick = () => {
      document.getElementById('vm-btn-start').textContent = '刷课中...';
      log('启动中...');
      start(log, resetBtn, onStarted);
    };
  }

  init();
})();
