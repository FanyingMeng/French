// ═══════════════════════════════════════════════════════════════
//  法语单词/动词/句子练习 — 核心逻辑
//
//  模式说明：
//   'word'     普通单词：显示中文 → 输入法语拼写
//   'verb'     动词变位：显示中文 → 输入法语拼写
//   'sentence' 背诵句子（TCF 口语）：显示中文 → Enter 揭示答案 → 自评
//
//  Bug 修复清单（相比原始版本）：
//   Fix 1. forceCorrect 订正成功后 mainAnsweredCount++
//   Fix 2. killBtn 的 disabled 同帧解锁无防护；改为立即 display:none
//   Fix 3. fallbackTTS getVoices() 首次为空，改用 onvoiceschanged 事件
//   Fix 4. recentWords.push 时机错误，移到 pickNextWord 之前
//   Fix 5. 改为按每个词单独记账的真间隔重复（SRS），新词按 id 升序依次学
//   Fix 6. 句子模式发音直接使用本地语音（现已被 Fix 13 的 mp3 取代，作兜底）
//   Fix 8. 维护跨 session 持久化的"今天已过关词"名单，候选池硬性排除
//   Fix 9. 当天第一次生成的题库固化下来，同一天重开页面直接复用
//
//  2026-11 按扇贝逻辑重构：
//   Fix 10. 删除原 Fix 7（词库学完一轮就清空全部 SRS 记录）。它会把已经
//           推到 90/180 天间隔的熟词全部打回原形。现在学完新词后每天就
//           只剩到期复习，量自然变少——这正是间隔重复的目的。
//   Fix 11. 设置项改为"每日新词数"；到期复习词全部出现，不再封顶
//           （原来固定 50 新 + 50 复习，复习词一多就越积越多）。删除用
//           "还没到期的词"填坑的逻辑（会打乱间隔）。
//   Fix 12. 答错不再一律退回 level 0：降两级、明天再见（扇贝/Anki 做法）。
//   Fix 13. 发音优先播放 audio/ 下预生成的 mp3（edge-tts 神经语音，免费），
//           没有的才退回词典音频 / 系统语音。
//   Fix 14. 输入容错：统一弯/直撇号、多余空格、末尾标点；只错重音时单独提示。
//   Fix 15. 句子改为一句一卡，按 ouitcf 的话题分组；新句按话题顺序出，
//           卡片上显示所属话题。
//   Fix 16. 设置里加"导出/导入进度"，进度不再只能活在一个浏览器里。
//   Fix 17. 单词/动词的新词第一次就拼对 → 直接约 7 天后复习（说明本来就会），
//           答错订正的才明天见。句子是第一次学，仍从 1 天开始。
//   Fix 18. 设置改为"每日总题数"：复习优先（最早到期的先出），剩下的名额给
//           新词，至少保留 10% 给新词；当天没排上的复习顺延到明天最先出。
//           间隔 ≥ 7 天的复习在 ±15% 范围内挑最空的一天，把每天的量摊平。
// ═══════════════════════════════════════════════════════════════

let currentData = [];
let queue       = [];
let wrongBuffer = [];
let recentWords = [];
let answeredIds = new Set();

let currentMode        = null;
let currentWord        = null;
let forceCorrectWordId = null;
let mainPool           = new Set();
let mainAnsweredCount  = 0;

// 句子模式专用：当前句子是否已翻开答案
let sentenceRevealed = false;

let nextTimer = null;

let todayProgressInfo = null; // { newIds: [...], reviewIds: [...] }

const TOTAL_DEFAULT       = { word: 100, verb: 100, sentence: 30 };
const MIN_NEW_RATIO       = 0.1;  // 每日总题数里至少留给新词的比例
const FIRST_CORRECT_LEVEL = 3;    // 新词一次拼对直接跳到这一档（SRS_INTERVALS[3] = 7 天）
const NEXT_DELAY          = 1200;
const NEW_WORD_INTERVAL   = 3;
const WRONG_BACKLOG_LIMIT = 2;

const dom = {
    cn:                 document.getElementById('display-cn'),
    singleInp:          document.getElementById('single-input'),
    wordArea:           document.getElementById('word-area'),
    feedback:           document.getElementById('feedback'),
    count:              document.getElementById('count'),
    modal:              document.getElementById('modal'),
    limitInp:           document.getElementById('limit-input'),
    finishArea:         document.getElementById('finish-area'),
    modeOverlay:        document.getElementById('mode-overlay'),
    sentenceRevealArea: document.getElementById('sentence-reveal-area'),
    sentenceHint:       document.getElementById('sentence-hint'),
    sentenceAnswer:     document.getElementById('sentence-answer'),
    sentenceJudgeRow:   document.getElementById('sentence-judge-row'),
    progressInfo:       document.getElementById('progress-info'),
    importFile:         document.getElementById('import-file'),
};

function isSentenceMode() {
    return currentMode === 'sentence';
}

// ─── Fix 14: 输入比较 ──────────────────────────────────────────
function normalizeAnswer(s) {
    return (s || '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/[’‘`´ʼ]/g, "'")
        .replace(/\s*'\s*/g, "'")
        .replace(/[.!?。！？]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripAccents(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/g, 'oe').replace(/æ/g, 'ae');
}

// 返回 'ok' | 'accent'（只有重音不对）| 'wrong'
function compareAnswer(input, correct) {
    const a = normalizeAnswer(input);
    const b = normalizeAnswer(correct);
    if (a === b) return 'ok';
    if (stripAccents(a) === stripAccents(b)) return 'accent';
    return 'wrong';
}

// ─── Fix 13: 预生成 mp3 ────────────────────────────────────────
//  文件名 = 法语文本的 FNV-1a 32 位哈希（tools/gen_audio.py 用同一算法），
//  所以文本一改就会自动生成新音频，同样的文本只存一份。
let audioIndex = new Set();
let audioVersion = {}; // 发音修正过的条目：key -> 版本，用来绕过旧缓存

function normalizeForAudio(text) {
    return (text || '').normalize('NFC').replace(/’/g, "'").replace(/\s+/g, ' ').trim();
}

function audioKey(text) {
    const bytes = new TextEncoder().encode(normalizeForAudio(text));
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

async function loadAudioIndex() {
    try {
        const res = await fetch('audio/index.json', { cache: 'no-cache' });
        if (!res.ok) return;
        const list = await res.json();
        if (Array.isArray(list)) audioIndex = new Set(list);
        const lockRes = await fetch('audio/overrides.lock.json', { cache: 'no-cache' });
        if (lockRes.ok) {
            const lock = await lockRes.json();
            Object.keys(lock).forEach(function(k) { audioVersion[k] = audioKey(lock[k]); });
        }
    } catch (e) {
        // 还没生成音频时这里会失败，直接用兜底发音
    }
}

function playMp3(text) {
    const key = audioKey(text);
    if (!audioIndex.has(key)) return false;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (window.currentAudio) window.currentAudio.pause();
    const v = audioVersion[key] ? '?v=' + audioVersion[key] : '';
    window.currentAudio = new Audio('audio/' + key + '.mp3' + v);
    window.currentAudio.play().catch(function() {
        // 自动播放被拦截或文件缺失时，退回系统语音
        fallbackTTS(text);
    });
    return true;
}

// ─── 发音 ──────────────────────────────────────────────────────
async function speak(text) {
    if (!text) return;
    if (playMp3(text)) return;

    if (isSentenceMode()) {
        // 词典没有整句录音，句子直接用本地语音
        fallbackTTS(text);
        return;
    }

    const url = 'https://www.wordreference.com/audio/fr/fr/v1/' +
        encodeURIComponent(text.trim().toLowerCase()) + '.mp3';
    if (window.currentAudio) window.currentAudio.pause();
    window.currentAudio = new Audio(url);
    try {
        await Promise.race([
            window.currentAudio.play(),
            new Promise(function(_, r) { setTimeout(r, 800); })
        ]);
    } catch (e) {
        fallbackTTS(text);
    }
}

// ─── 每日词表生成（按词记账的间隔重复 SRS）────────────────────
//
//  每个词的状态存在 localStorage（key: fr_srs_<mode>），格式：
//    { "<wordId>": { level: 0~8, dueDate: 20260710 } }
//  不在表里的 id 就是"还没学过的新词"。

const SRS_INTERVALS = [1, 2, 4, 7, 15, 30, 60, 90, 180]; // 单位：天

function pseudoRandom(seed) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
}

function dateToSeed(d) {
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function seedToDate(seed) {
    const year  = Math.floor(seed / 10000);
    const month = Math.floor((seed % 10000) / 100);
    const day   = seed % 100;
    return new Date(year, month - 1, day);
}

function addDaysToSeed(seed, days) {
    const d = seedToDate(seed);
    d.setDate(d.getDate() + days);
    return dateToSeed(d);
}

function todayDateSeed() {
    return dateToSeed(new Date());
}

function loadSRS(mode) {
    const raw = localStorage.getItem('fr_srs_' + mode);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
        return {};
    }
}

function saveSRS(mode, state) {
    localStorage.setItem('fr_srs_' + mode, JSON.stringify(state));
}

// Fix 18: 间隔 ≥ 7 天时，在 ±15% 范围内挑到期词最少的一天，避免某天扎堆
function balancedDueDate(srs, interval) {
    const today = todayDateSeed();
    if (interval < 7) return addDaysToSeed(today, interval);
    const lo = Math.max(1, Math.round(interval * 0.85));
    const hi = Math.round(interval * 1.15);
    const load = {};
    Object.keys(srs).forEach(function(k) {
        const d = srs[k] && srs[k].dueDate;
        if (d) load[d] = (load[d] || 0) + 1;
    });
    let best = interval, bestLoad = Infinity;
    for (let k = lo; k <= hi; k++) {
        const n = load[addDaysToSeed(today, k)] || 0;
        if (n < bestLoad || (n === bestLoad && Math.abs(k - interval) < Math.abs(best - interval))) {
            best = k; bestLoad = n;
        }
    }
    return addDaysToSeed(today, best);
}

// 一遍就答对（没进过错题本）：按等级表往后推进一档，间隔变长
// Fix 17: 单词/动词的新词第一次就拼对，直接跳到 7 天那一档
function srsAdvance(mode, wordId) {
    const srs   = loadSRS(mode);
    const cur   = srs[wordId];
    let level;
    if (cur) level = Math.min((cur.level || 0) + 1, SRS_INTERVALS.length - 1);
    else     level = mode === 'sentence' ? 0 : FIRST_CORRECT_LEVEL;
    srs[wordId] = { level: level, dueDate: balancedDueDate(srs, SRS_INTERVALS[level]) };
    saveSRS(mode, srs);
}

// Fix 12: 答错、订正后才过关：降两级，明天必然再见
function srsLapse(mode, wordId) {
    const srs   = loadSRS(mode);
    const cur   = srs[wordId];
    const level = cur ? Math.max(0, (cur.level || 0) - 2) : 0;
    srs[wordId] = { level: level, dueDate: addDaysToSeed(todayDateSeed(), 1) };
    saveSRS(mode, srs);
}

// ─── Fix 8: 今日已过关词名单（跨 session 持久化）──────────────
function loadAnsweredToday(mode) {
    const raw = localStorage.getItem('fr_answered_today_' + mode);
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.dateSeed === todayDateSeed() && Array.isArray(parsed.ids)) {
                return parsed;
            }
        } catch (e) {
            // 解析失败按空名单处理
        }
    }
    return { dateSeed: todayDateSeed(), ids: [] };
}

function markAnsweredToday(mode, wordId) {
    const state = loadAnsweredToday(mode);
    if (!state.ids.includes(wordId)) {
        state.ids.push(wordId);
        localStorage.setItem('fr_answered_today_' + mode, JSON.stringify(state));
    }
}

// Fix 18: 每日总题数固定：复习优先，剩下的名额给新词（至少留 10%）
function buildTodayQueueSRS(allWords, mode, total) {
    if (!allWords || allWords.length === 0) {
        todayProgressInfo = null;
        return [];
    }

    const dateSeed      = todayDateSeed();
    const srs           = loadSRS(mode);
    const answeredToday = new Set(loadAnsweredToday(mode).ids);

    // 今天已经做过的题也算在今天的总数里（中途改设置/题库重算时不会多给）
    const budget = Math.max(0, total - answeredToday.size);

    const allDue = allWords
        .filter(w => srs[w.id] && srs[w.id].dueDate <= dateSeed && !answeredToday.has(w.id))
        // 越早到期越优先；同一天到期的，等级低（不熟）的优先
        .sort((a, b) => (srs[a.id].dueDate - srs[b.id].dueDate) || ((srs[a.id].level || 0) - (srs[b.id].level || 0)));
    const allNew = allWords
        .filter(w => !srs[w.id] && !answeredToday.has(w.id))
        .sort((a, b) => a.id - b.id); // 按 id 升序（=添加进词库的顺序 / 句子的话题顺序）

    // ① 复习：最多占 90%（新词学完了就不用留名额）；没排上的保持到期状态，明天最先出
    const minNew         = Math.min(allNew.length, Math.ceil(budget * MIN_NEW_RATIO));
    const reviewSelected = allDue.slice(0, budget - minNew);

    // ② 新词：剩下的名额
    const newSelected = allNew.slice(0, budget - reviewSelected.length);

    todayProgressInfo = {
        newIds:    newSelected.map(w => w.id),
        reviewIds: reviewSelected.map(w => w.id)
    };

    const shuffle = function(list) {
        return list.slice().sort((a, b) =>
            pseudoRandom(dateSeed + a.id + 999) - pseudoRandom(dateSeed + b.id + 999));
    };

    // ③ 出场顺序：句子模式复习打乱、新句保持话题顺序（同一话题连着学）；
    //    单词/动词全部打乱（确定性伪随机，同一天多次打开顺序一致）
    if (mode === 'sentence') {
        return shuffle(reviewSelected).concat(newSelected);
    }
    return shuffle(reviewSelected.concat(newSelected));
}

function renderProgressHeader() {
    if (!dom.progressInfo) return;
    if (!todayProgressInfo) {
        dom.progressInfo.textContent = '';
        return;
    }
    const n = todayProgressInfo.newIds.length;
    const r = todayProgressInfo.reviewIds.length;
    const srs     = loadSRS(currentMode);
    const learned = currentData.filter(w => srs[w.id]).length;
    dom.progressInfo.textContent =
        '今日复习 ' + r + ' · 新学 ' + n + ' · 已学 ' + learned + ' / ' + currentData.length;
}

// ─── 今日进度持久化 ────────────────────────────────────────────
function saveCurrentSession() {
    const sessionSnapshot = {
        dateSeed:         todayDateSeed(),
        queueIds:         queue.map(w => w.id),
        wrongBufferState: wrongBuffer.map(w => ({ id: w.id, streak: w.streak || 0 })),
        mainAnsweredCount,
        answeredIds:      [...answeredIds],
    };
    localStorage.setItem('fr_session_' + currentMode, JSON.stringify(sessionSnapshot));
}

function clearCurrentSession() {
    localStorage.removeItem('fr_session_' + currentMode);
}

// ─── Fix 9: 今日题库固化 ──────────────────────────────────────
//  plan.v = 3：新版规则（每日总题数）生成的题库；旧版本留下的当天题库一律作废重算。
//  题库里有词已经不在词库中（比如句子库整体更换）也作废重算。
function loadTodayPlan(mode, newLimit) {
    const raw = localStorage.getItem('fr_plan_' + mode);
    if (!raw) return null;
    try {
        const plan = JSON.parse(raw);
        if (plan && plan.v === 3 && plan.dateSeed === todayDateSeed() && plan.limit === newLimit &&
            Array.isArray(plan.ids) && plan.progress) {
            const ids = new Set(currentData.map(w => w.id));
            if (plan.ids.every(id => ids.has(id))) return plan;
        }
    } catch (e) {
        // 解析失败按没有处理
    }
    return null;
}

function saveTodayPlan(mode, newLimit, words) {
    localStorage.setItem('fr_plan_' + mode, JSON.stringify({
        v:        3,
        dateSeed: todayDateSeed(),
        limit:    newLimit,
        ids:      words.map(w => w.id),
        progress: todayProgressInfo
    }));
}

// ─── 队列构建（含历史恢复）────────────────────────────────────
function buildQueue(newLimit) {
    const dateSeed = todayDateSeed();

    let fullTodayQueue;
    const plan = loadTodayPlan(currentMode, newLimit);
    if (plan) {
        const byId = new Map(currentData.map(w => [w.id, w]));
        fullTodayQueue    = plan.ids.map(id => byId.get(id)).filter(Boolean);
        todayProgressInfo = plan.progress;
    } else {
        fullTodayQueue = buildTodayQueueSRS(currentData, currentMode, newLimit);
        saveTodayPlan(currentMode, newLimit, fullTodayQueue);
        clearCurrentSession(); // 题库重算了，旧快照不再对应
    }
    mainPool = new Set(fullTodayQueue.map(w => w.id));

    const savedSession = localStorage.getItem('fr_session_' + currentMode);
    let hasRestored    = false;

    if (savedSession) {
        try {
            const session = JSON.parse(savedSession);
            if (session && session.dateSeed === dateSeed) {
                queue = fullTodayQueue.filter(w => session.queueIds.includes(w.id));

                wrongBuffer = [];
                session.wrongBufferState.forEach(function(state) {
                    const wordObj = currentData.find(w => w.id === state.id);
                    if (wordObj) {
                        wrongBuffer.push(Object.assign({}, wordObj, { streak: state.streak || 0 }));
                    }
                });

                mainAnsweredCount  = session.mainAnsweredCount;
                answeredIds        = new Set(session.answeredIds || []);
                forceCorrectWordId = null;
                recentWords        = [];
                wrongBuffer        = wrongBuffer.filter(w => mainPool.has(w.id));

                hasRestored = true;
            }
        } catch (e) {
            console.error("快照解析失败，全新初始化", e);
        }
    }

    if (!hasRestored) {
        const doneToday    = new Set(loadAnsweredToday(currentMode).ids);
        queue              = fullTodayQueue.filter(w => !doneToday.has(w.id));
        wrongBuffer        = [];
        recentWords        = [];
        answeredIds        = new Set(fullTodayQueue.filter(w => doneToday.has(w.id)).map(w => w.id));
        forceCorrectWordId = null;
        mainAnsweredCount  = 0;
        clearCurrentSession();
    }

    updateCount();
}

// ─── 抽词算法核心 ──────────────────────────────────────────────
function pickNextWord() {
    if (wrongBuffer.length > 0) {
        const interval = wrongBuffer.length > WRONG_BACKLOG_LIMIT ? 1 : NEW_WORD_INTERVAL;

        if (queue.length === 0 || mainAnsweredCount >= interval) {
            const recentlySeen = recentWords.slice(-2);

            let idx = wrongBuffer.findIndex(function(w) {
                return w.id !== forceCorrectWordId && !recentlySeen.includes(w.id);
            });

            if (idx === -1) {
                idx = wrongBuffer.findIndex(function(w) { return w.id !== forceCorrectWordId; });
            }

            if (idx === -1) {
                if (queue.length > 0) return queue[0];
                idx = 0;
            }

            return wrongBuffer[idx] || queue[0] || null;
        }
    }

    if (queue.length > 0) return queue[0];

    return wrongBuffer[0] || null;
}

// ─── 句子模式 UI 切换 ──────────────────────────────────────────
function showSentenceUI() {
    dom.wordArea.style.display           = 'none';
    dom.sentenceRevealArea.style.display = 'flex';
    dom.sentenceAnswer.style.display     = 'none';
    dom.sentenceJudgeRow.style.display   = 'none';
    dom.sentenceHint.style.display       = 'block';
    sentenceRevealed                     = false;
}

function showWordUI() {
    dom.wordArea.style.display           = 'block';
    dom.sentenceRevealArea.style.display = 'none';
}

// ─── 卡片内容 ──────────────────────────────────────────────────
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

// Fix 15: 句子卡片上方显示话题标签
function cardHTML(word, overrideStreak) {
    let tag = '';
    if (isSentenceMode() && word.topic) {
        tag = '<div class="sentence-tag">' +
            (word.task ? 'Task ' + word.task + ' · ' : '') + escapeHtml(word.topic) + '</div>';
    }
    return tag + escapeHtml(word.cn) + buildStreakBadge(word.id, overrideStreak);
}

// ─── 渲染 ──────────────────────────────────────────────────────
function render() {
    clearTimeout(nextTimer);
    dom.feedback.innerText = '';

    if (queue.length === 0 && wrongBuffer.length === 0) {
        dom.cn.innerText = mainPool.size === 0 ? '今天没有到期的复习，也没有新内容了 👍' : '今日任务达成！🎉';
        if (isSentenceMode()) {
            dom.sentenceRevealArea.style.display = 'none';
        } else {
            dom.singleInp.style.display = 'none';
        }
        dom.finishArea.style.display = 'block';
        clearCurrentSession();
        renderProgressHeader();
        return;
    }

    // Fix 4: 先记录上一题再选下一题
    if (currentWord) {
        recentWords.push(currentWord.id);
        if (recentWords.length > 10) recentWords.shift();
    }

    currentWord = pickNextWord();
    if (!currentWord) return;

    dom.cn.className = 'word-cn';
    if (isSentenceMode()) {
        dom.cn.classList.add('sentence-mode');
        showSentenceUI();
    } else {
        if (currentWord.gender === 'f')      dom.cn.classList.add('gender-f');
        else if (currentWord.gender === 'm') dom.cn.classList.add('gender-m');
        showWordUI();
        dom.singleInp.readOnly      = false;
        dom.singleInp.style.opacity = '1';
        dom.singleInp.value         = '';
        dom.singleInp.style.display = '';
        dom.singleInp.focus();
    }

    dom.cn.innerHTML = cardHTML(currentWord);
}

// ─── 角标 ──────────────────────────────────────────────────────
function buildStreakBadge(wordId, overrideStreak) {
    const wi = wrongBuffer.findIndex(function(w) { return w.id === wordId; });
    if (wi === -1 && overrideStreak === undefined) return '';
    const streak = overrideStreak !== undefined ? overrideStreak : (wrongBuffer[wi].streak || 0);
    return '<span class="streak-badge">' + streak + '/2</span>';
}

// ─── 输入事件（单词/动词模式）────────────────────────────────
dom.singleInp.onkeypress = function(e) {
    if (e.key !== 'Enter') return;
    if (dom.singleInp.readOnly) return;
    if (isSentenceMode()) return;
    if (!currentWord) return;

    const input  = dom.singleInp.value;
    const result = compareAnswer(input, currentWord.fr);

    // 强制订正期
    if (forceCorrectWordId === currentWord.id) {
        if (result === 'ok') {
            forceCorrectWordId = null;
            mainAnsweredCount++; // Fix 1

            showMsg('✔ 订正完成', 'success');
            speak(currentWord.fr);

            dom.singleInp.readOnly      = true;
            dom.singleInp.style.opacity = '0.7';
            dom.singleInp.value         = '';

            saveCurrentSession();
            nextTimer = setTimeout(function() { render(); }, NEXT_DELAY);
        } else {
            showMsg(result === 'accent' ? '⚠️ 注意重音，再试一次' : '❌ 再试一次', 'error');
            dom.singleInp.value = '';
        }
        return;
    }

    speak(currentWord.fr);
    if (result === 'ok') {
        handleCorrect();
    } else {
        handleWrong(currentWord.fr, result === 'accent');
    }
};

// ─── 句子模式：键盘 ──────────────────────────────────────────
//  Enter 揭示答案；揭示后按 1 = 记住了，2 = 没记住
document.addEventListener('keydown', function(e) {
    if (!isSentenceMode() || !currentWord) return;
    if (dom.modal.style.display === 'block') return;
    if (!sentenceRevealed) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            revealSentence();
        }
        return;
    }
    if (dom.sentenceJudgeRow.style.display === 'none') return;
    if (e.key === '1') sentenceJudge(true);
    else if (e.key === '2') sentenceJudge(false);
});

function revealSentence() {
    if (sentenceRevealed) return;
    sentenceRevealed = true;

    dom.sentenceAnswer.innerText       = currentWord.fr;
    dom.sentenceAnswer.style.display   = 'block';
    dom.sentenceHint.style.display     = 'none';
    dom.sentenceJudgeRow.style.display = 'flex';

    speak(currentWord.fr);
}

// ─── 句子自评（记住了 / 没记住）──────────────────────────────
function sentenceJudge(remembered) {
    if (!currentWord) return;

    dom.sentenceJudgeRow.style.display = 'none';

    if (remembered) {
        handleCorrect();
    } else {
        const qi = queue.findIndex(function(w) { return w.id === currentWord.id; });
        if (qi !== -1) queue.splice(qi, 1);

        const wi = wrongBuffer.findIndex(function(w) { return w.id === currentWord.id; });
        if (wi === -1) {
            wrongBuffer.push(Object.assign({}, currentWord, { streak: 0 }));
        } else {
            wrongBuffer[wi].streak = 0;
        }

        mainAnsweredCount = 0;
        showMsg('📌 已加入复习队列', 'error');
        dom.cn.innerHTML = cardHTML(currentWord, 0);
        saveCurrentSession();
        updateCount();

        nextTimer = setTimeout(function() { render(); }, NEXT_DELAY);
    }
}

// ─── 答对处理 ──────────────────────────────────────────────────
function handleCorrect() {
    const wi        = wrongBuffer.findIndex(function(w) { return w.id === currentWord.id; });
    const fromWrong = wi !== -1;

    const qi = queue.findIndex(function(w) { return w.id === currentWord.id; });
    if (qi !== -1) queue.splice(qi, 1);

    if (fromWrong) {
        const newStreak = (wrongBuffer[wi].streak || 0) + 1;
        wrongBuffer[wi].streak = newStreak;

        if (newStreak >= 2) {
            wrongBuffer.splice(wi, 1);
            answeredIds.add(currentWord.id);
            markAnsweredToday(currentMode, currentWord.id);
            srsLapse(currentMode, currentWord.id); // Fix 12
            dom.cn.innerHTML = cardHTML(currentWord, 2);
        } else {
            dom.cn.innerHTML = cardHTML(currentWord, newStreak);
        }

        mainAnsweredCount = 0;
    } else {
        answeredIds.add(currentWord.id);
        markAnsweredToday(currentMode, currentWord.id);
        mainAnsweredCount++;
        srsAdvance(currentMode, currentWord.id);
    }

    showMsg('Très bien !', 'success');
    updateCount();
    saveCurrentSession();

    if (!isSentenceMode()) {
        dom.singleInp.readOnly      = true;
        dom.singleInp.style.opacity = '0.7';
    }

    nextTimer = setTimeout(function() { render(); }, NEXT_DELAY);
}

// ─── 答错处理（单词/动词模式）────────────────────────────────
function handleWrong(correct, accentOnly) {
    const qi = queue.findIndex(function(w) { return w.id === currentWord.id; });
    if (qi !== -1) queue.splice(qi, 1);

    const wi = wrongBuffer.findIndex(function(w) { return w.id === currentWord.id; });
    if (wi === -1) {
        wrongBuffer.push(Object.assign({}, currentWord, { streak: 0 }));
    } else {
        wrongBuffer[wi].streak = 0;
    }

    forceCorrectWordId = currentWord.id;
    mainAnsweredCount  = 0;

    showMsg((accentOnly ? '⚠️ 重音不对，正确是: ' : '正确答案: ') + correct, 'error');
    saveCurrentSession();

    dom.cn.innerHTML = cardHTML(currentWord, 0);
}

// ─── 计数 ──────────────────────────────────────────────────────
function updateCount() {
    dom.count.innerText = Math.max(0, mainPool.size - answeredIds.size);
    renderProgressHeader(); // "已学 X / Y" 跟着每次答题实时刷新
}

// ─── 每日总题数（兼容旧设置）──────────────────────────────────
function getNewLimit(mode) {
    const v = parseInt(localStorage.getItem('fr_total_' + mode));
    if (v > 0) return v;
    // 上一版存的是"每日新词数"，最早一版存的是"每日总数"：数值直接沿用
    const prev = parseInt(localStorage.getItem('fr_newlimit_' + mode)) ||
                 parseInt(localStorage.getItem('fr_limit_' + mode));
    if (prev > 0) return prev;
    return TOTAL_DEFAULT[mode] || 50;
}

// ─── 初始化 ────────────────────────────────────────────────────
async function startApp(mode) {
    currentMode = mode;
    currentWord = null;
    dom.finishArea.style.display = 'none';

    let fileName;
    if (mode === 'verb')          fileName = 'verbs.json';
    else if (mode === 'sentence') fileName = 'sentences.json';
    else                          fileName = 'words.json';

    const newLimit = getNewLimit(mode);
    dom.limitInp.value = newLimit;

    const [res] = await Promise.all([fetch(fileName), loadAudioIndex()]);
    currentData = await res.json();

    dom.modeOverlay.style.display = 'none';

    buildQueue(newLimit);
    renderProgressHeader();
    render();
}

// ─── 返回主页 ──────────────────────────────────────────────────
//  进度每答一题就已经保存（SRS + 当天快照），回主页再进来会接着做
function goHome() {
    clearTimeout(nextTimer);
    if (window.currentAudio) window.currentAudio.pause();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    closeSettings();

    currentMode        = null;
    currentWord        = null;
    forceCorrectWordId = null;
    queue = []; wrongBuffer = []; recentWords = [];
    answeredIds = new Set(); mainPool = new Set();

    dom.cn.innerText                     = '';
    dom.feedback.innerText               = '';
    dom.count.innerText                  = '0';
    dom.progressInfo.textContent         = '';
    dom.finishArea.style.display         = 'none';
    dom.sentenceRevealArea.style.display = 'none';
    dom.wordArea.style.display           = 'block';
    dom.singleInp.value                  = '';
    dom.singleInp.blur();
    dom.modeOverlay.style.display        = 'flex';
}

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && currentMode && dom.modal.style.display !== 'block') goHome();
});

function showMsg(text, type) {
    dom.feedback.innerText = text;
    dom.feedback.className = 'feedback ' + type;
}

function openSettings() {
    dom.modal.style.display = 'block';
}

function closeSettings() {
    dom.modal.style.display = 'none';
}

function saveSettings() {
    if (!currentMode) { closeSettings(); return; }
    const val = parseInt(dom.limitInp.value) || TOTAL_DEFAULT[currentMode] || 50;
    localStorage.setItem('fr_total_' + currentMode, val);
    clearCurrentSession();
    buildQueue(val);
    renderProgressHeader();
    render();
    closeSettings();
}

// ─── Fix 16: 进度导出 / 导入 ──────────────────────────────────
function exportProgress() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('fr_')) data[k] = localStorage.getItem(k);
    }
    const blob = new Blob([JSON.stringify({ app: 'french-srs', v: 1, exportedAt: new Date().toISOString(), data: data }, null, 1)],
                          { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'french-progress-' + todayDateSeed() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function importProgress() {
    dom.importFile.value = '';
    dom.importFile.click();
}

dom.importFile.onchange = function() {
    const file = dom.importFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function() {
        try {
            const parsed = JSON.parse(reader.result);
            if (!parsed || parsed.app !== 'french-srs' || typeof parsed.data !== 'object') throw new Error('格式不对');
            if (!confirm('导入会用这个文件覆盖当前浏览器里的学习进度，确定吗？')) return;
            Object.keys(localStorage).filter(k => k.startsWith('fr_')).forEach(k => localStorage.removeItem(k));
            Object.keys(parsed.data).forEach(function(k) {
                if (k.startsWith('fr_')) localStorage.setItem(k, parsed.data[k]);
            });
            alert('导入成功，页面将刷新。');
            location.reload();
        } catch (e) {
            alert('导入失败：' + e.message);
        }
    };
    reader.readAsText(file);
};

// Fix 3 / Fix 6: 系统语音兜底，优先本地法语人声
function fallbackTTS(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();

    function doSpeak() {
        const msg = new SpeechSynthesisUtterance(text);
        msg.lang  = 'fr-FR';

        const allFr   = window.speechSynthesis.getVoices().filter(function(v) { return v.lang.startsWith('fr'); });
        const localFr = allFr.filter(function(v) { return v.localService; });
        const pool    = localFr.length > 0 ? localFr : allFr;

        msg.voice = pool.find(function(v) { return /Aurélie/i.test(v.name); })
            || pool[0]
            || null;

        msg.rate = 0.9;
        window.speechSynthesis.speak(msg);
    }

    if (window.speechSynthesis.getVoices().length > 0) {
        doSpeak();
    } else {
        window.speechSynthesis.onvoiceschanged = function() {
            window.speechSynthesis.onvoiceschanged = null;
            doSpeak();
        };
    }
}

dom.cn.onclick = function() {
    if (!currentWord) return;
    if (isSentenceMode() && !sentenceRevealed) revealSentence();
    else speak(currentWord.fr);
};

// PWA：注册 service worker（离线缓存）
if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function() {
        navigator.serviceWorker.register('sw.js').catch(function() {});
    });
}

window.startApp       = startApp;
window.goHome         = goHome;
window.openSettings   = openSettings;
window.closeSettings  = closeSettings;
window.saveSettings   = saveSettings;
window.sentenceJudge  = sentenceJudge;
window.exportProgress = exportProgress;
window.importProgress = importProgress;
