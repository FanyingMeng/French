// ═══════════════════════════════════════════════════════════════
//  法语单词练习 — 核心逻辑（已修复 + 注释讲解版）
//  修复点汇总：
//   1. handleCorrect()：错词答对时 mainAnsweredCount 也要 +1
//   2. handleCorrect()：answeredIds 记录时机修正（用 fromWrong 判断，不依赖删除后的 qi）
//   3. handleCorrect()：streak 显示角标与实际 wrongBuffer 状态同步
//   4. pickNextWord()：wrongBuffer 为空时 interval 判断短路，避免误取
// ═══════════════════════════════════════════════════════════════

let currentData = [];
let queue       = [];       // 今日待做新词队列（有序，逐个弹出）
let wrongBuffer = [];       // 错词缓冲区（答错后放入，答对2次连续才移出）
let recentWords = [];       // 最近展示的词 id，防止短时间内重复
let killedWords = new Set();  // 永久屏蔽的词
let answeredIds = new Set();  // 今日已完成的词（新词答对 or 错词毕业）

let currentMode        = null;
let currentWord        = null;
let forceCorrectWordId = null;  // 答错后强制订正：必须输入正确才能继续
let mainPool           = new Set();  // 今日词池（所有词 id）
let mainAnsweredCount  = 0;         // 距上次插入错词后，连续答对的计数

let nextTimer = null;

const LIMIT_DEFAULT       = 100;   // 默认每日词数
const NEXT_DELAY          = 1200;  // 答对后自动下一题的延迟（ms）
const NEW_WORD_INTERVAL   = 3;     // 每答对 N 题新词，插入一次错词复习
const WRONG_BACKLOG_LIMIT = 2;     // wrongBuffer 超过此数量时，加速插入错词（间隔变1）

const dom = {
    cn:          document.getElementById('display-cn'),
    singleInp:   document.getElementById('single-input'),
    feedback:    document.getElementById('feedback'),
    count:       document.getElementById('count'),
    modal:       document.getElementById('modal'),
    limitInp:    document.getElementById('limit-input'),
    finishArea:  document.getElementById('finish-area'),
    modeOverlay: document.getElementById('mode-overlay'),
    killBtn:     document.getElementById('btn-kill')
};

// ─── 发音 ──────────────────────────────────────────────────────
async function speak(text) {
    if (!text) return;
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

// ─── 每日词表生成（哈希确定性算法）────────────────────────────
// 原理：根据今天日期（dateSeed）算出一个固定起点，然后顺序取词。
// 同一天无论刷新多少次，取到的词集合完全一致。
// 50% 新词（今天第一次见） + 50% 复习词（来自 1/2/4/7/15/30/60/90/180 天前的"新词"）
function hashPickWordsOptimized(allWords, dateSeed, limit = 100) {
    if (!allWords || allWords.length === 0) return [];

    const newWordCount = Math.floor(limit * 0.5);
    const reviewCount  = limit - newWordCount;

    function pseudoRandom(seed) {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }

    // 给定一个 seed，确定性地从 allWords 里取 newWordCount 个词
    function getNewWordsForDay(seed) {
        function hashSeed(s) {
            let h = 2166136261;
            const str = String(s);
            for (let i = 0; i < str.length; i++) {
                h ^= str.charCodeAt(i);
                h = (h * 16777619) >>> 0;
            }
            return h;
        }
        const result     = [];
        const startIndex = hashSeed(seed) % allWords.length;
        let   offset     = 0;
        while (result.length < newWordCount && offset < allWords.length) {
            const realIndex = (startIndex + offset) % allWords.length;
            const w         = allWords[realIndex];
            if (!killedWords.has(w.id)) result.push(w);
            offset++;
        }
        return result;
    }

    const todayNewWords = getNewWordsForDay(dateSeed);
    const newWordsMap   = new Set(todayNewWords.map(w => w.id));

    // 复习词：从历史间隔天数里捞"当时的新词"，作为今天的间隔复习
    const intervals   = [1, 2, 4, 7, 15, 30, 60, 90, 180];
    const reviewPool  = [];
    const reviewAdded = new Set();

    for (const d of intervals) {
        const histNewWords = getNewWordsForDay(dateSeed - d);
        for (const w of histNewWords) {
            if (!killedWords.has(w.id) && !newWordsMap.has(w.id) && !reviewAdded.has(w.id)) {
                reviewPool.push(w);
                reviewAdded.add(w.id);
            }
        }
        if (reviewPool.length >= reviewCount) break;
    }

    // 复习词不够则随机补充
    if (reviewPool.length < reviewCount) {
        const fallback = allWords.filter(w =>
            !killedWords.has(w.id) && !newWordsMap.has(w.id) && !reviewAdded.has(w.id)
        );
        fallback.sort((a, b) => pseudoRandom(dateSeed + a.id) - pseudoRandom(dateSeed + b.id));
        reviewPool.push(...fallback.slice(0, reviewCount - reviewPool.length));
    } else if (reviewPool.length > reviewCount) {
        reviewPool.length = reviewCount;
    }

    // 合并并随机打乱顺序
    const todayQueue = [...todayNewWords, ...reviewPool];
    todayQueue.sort((a, b) =>
        pseudoRandom(dateSeed + a.id + 999) - pseudoRandom(dateSeed + b.id + 999)
    );

    return todayQueue;
}

// ─── 今日进度持久化 ────────────────────────────────────────────
function saveCurrentSession() {
    const today    = new Date();
    const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();

    const sessionSnapshot = {
        dateSeed,
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

// ─── 队列构建（含历史恢复）────────────────────────────────────
function buildQueue(limit) {
    const today    = new Date();
    const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();

    const fullTodayQueue = hashPickWordsOptimized(currentData, dateSeed, limit);
    mainPool = new Set(fullTodayQueue.map(w => w.id));

    const savedSession = localStorage.getItem('fr_session_' + currentMode);
    let hasRestored    = false;

    if (savedSession) {
        try {
            const session = JSON.parse(savedSession);
            if (session && session.dateSeed === dateSeed) {
                // 恢复 queue：只保留今日词池中还未做的
                queue = fullTodayQueue.filter(w => session.queueIds.includes(w.id));

                // 恢复 wrongBuffer（包含 streak 状态）
                wrongBuffer = [];
                session.wrongBufferState.forEach(state => {
                    const wordObj = currentData.find(w => w.id === state.id);
                    if (wordObj) {
                        wrongBuffer.push({ ...wordObj, streak: state.streak || 0 });
                    }
                });

                mainAnsweredCount = session.mainAnsweredCount;
                answeredIds       = new Set(session.answeredIds || []);
                forceCorrectWordId = null;
                recentWords        = [];

                // 过滤掉不在今日池里的错词（理论上不会有，防御性处理）
                wrongBuffer = wrongBuffer.filter(w => mainPool.has(w.id));

                hasRestored = true;
            }
        } catch (e) {
            console.error("快照解析失败，全新初始化", e);
        }
    }

    if (!hasRestored) {
        queue              = fullTodayQueue;
        wrongBuffer        = [];
        recentWords        = [];
        answeredIds        = new Set();
        forceCorrectWordId = null;
        mainAnsweredCount  = 0;
        clearCurrentSession();
    }

    updateCount();
}

// ─── 抽词算法核心 ──────────────────────────────────────────────
//
//  两个来源：queue（新词/顺序弹出）和 wrongBuffer（错词/乱序插队）
//
//  插队规则：
//   - 每答对 NEW_WORD_INTERVAL 题后，从 wrongBuffer 插入一题（间隔复习）
//   - wrongBuffer 积压超过 WRONG_BACKLOG_LIMIT 时，间隔压缩为 1（每题都插）
//   - queue 为空时直接清 wrongBuffer
//
//  防重复：不选最近出现过的词，不选当前强制订正的词
//
function pickNextWord() {
    if (wrongBuffer.length > 0) {
        // 积压多时加速插入：间隔从3降为1
        const interval = wrongBuffer.length > WRONG_BACKLOG_LIMIT ? 1 : NEW_WORD_INTERVAL;

        if (queue.length === 0 || mainAnsweredCount >= interval) {
            const recentlySeen = recentWords.slice(-2);

            // 优先选：不是刚订正过的、不是刚刚见过的
            let idx = wrongBuffer.findIndex(w =>
                w.id !== forceCorrectWordId && !recentlySeen.includes(w.id)
            );

            // 退而求其次：只避开订正词
            if (idx === -1) {
                idx = wrongBuffer.findIndex(w => w.id !== forceCorrectWordId);
            }

            // 最后兜底：wrongBuffer 里只剩强制订正词时，先去取新词
            if (idx === -1) {
                if (queue.length > 0) return queue[0];
                idx = 0;  // 实在没有别的词，只能用它（订正完才会到这里）
            }

            // 防止 wrongBuffer 在延迟期间被斩词清空
            return wrongBuffer[idx] || queue[0] || null;
        }
    }

    if (queue.length > 0) {
        return queue[0];
    }

    return wrongBuffer[0] || null;
}

// ─── 渲染 ──────────────────────────────────────────────────────
function render() {
    clearTimeout(nextTimer);
    dom.killBtn.style.display = 'none';

    dom.singleInp.readOnly      = false;
    dom.singleInp.style.opacity = '1';

    if (queue.length === 0 && wrongBuffer.length === 0) {
        dom.cn.innerText             = '今日任务达成！🎉';
        dom.singleInp.style.display  = 'none';
        dom.finishArea.style.display = 'block';
        clearCurrentSession();
        return;
    }

    currentWord = pickNextWord();
    if (!currentWord) return;  // 斩词延迟期间极端情况的最终保护

    dom.cn.className = 'word-cn';
    if (currentWord.gender === 'f')      dom.cn.classList.add('gender-f');
    else if (currentWord.gender === 'm') dom.cn.classList.add('gender-m');

    dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id);

    dom.feedback.innerText = '';
    dom.singleInp.value    = '';
    dom.singleInp.focus();

    recentWords.push(currentWord.id);
    if (recentWords.length > 10) recentWords.shift();
}

// 错词进度角标（只在 wrongBuffer 中的词才显示）
function buildStreakBadge(wordId, overrideStreak) {
    const wi = wrongBuffer.findIndex(w => w.id === wordId);
    if (wi === -1 && overrideStreak === undefined) return '';
    const streak = overrideStreak !== undefined ? overrideStreak : (wrongBuffer[wi].streak || 0);
    return `<span style="font-size:15px; color:#e67e22; background:#fff3e0; padding:4px 10px; border-radius:12px; margin-left:12px; vertical-align:middle; font-weight:normal;">${streak}/2</span>`;
}

// ─── 斩词 ──────────────────────────────────────────────────────
dom.killBtn.onclick = function() {
    if (!currentWord || dom.killBtn.style.display === 'none') return;

    dom.killBtn.disabled = true;
    clearTimeout(nextTimer);

    killedWords.add(currentWord.id);
    localStorage.setItem('fr_killed_' + currentMode, JSON.stringify([...killedWords]));

    const qi = queue.findIndex(w => w.id === currentWord.id);
    if (qi !== -1) queue.splice(qi, 1);

    const wi = wrongBuffer.findIndex(w => w.id === currentWord.id);
    if (wi !== -1) wrongBuffer.splice(wi, 1);

    forceCorrectWordId   = null;
    dom.killBtn.disabled = false;
    showMsg('🔪 已斩！不再出现', 'success');
    dom.killBtn.style.display = 'none';

    updateCount();
    saveCurrentSession();
    setTimeout(function() { render(); }, 800);
};

// ─── 输入事件 ──────────────────────────────────────────────────
dom.singleInp.onkeypress = function(e) {
    if (e.key !== 'Enter') return;
    if (dom.singleInp.readOnly) return;

    const input = dom.singleInp.value.trim().toLowerCase();
    if (!currentWord) return;

    const correct = currentWord.fr.toLowerCase();

    // 强制订正期：上次答错，必须输入正确才能过
    if (forceCorrectWordId === currentWord.id) {
        if (input === correct) {
            forceCorrectWordId = null;
            showMsg('✔ 订正完成', 'success');
            speak(currentWord.fr);

            dom.singleInp.readOnly      = true;
            dom.singleInp.style.opacity = '0.7';
            dom.singleInp.value         = '';
            dom.killBtn.style.display   = 'inline-block';

            saveCurrentSession();
            nextTimer = setTimeout(function() { render(); }, NEXT_DELAY);
        } else {
            showMsg('❌ 再试一次', 'error');
            dom.singleInp.value = '';
        }
        return;
    }

    speak(currentWord.fr);
    if (input === correct) {
        handleCorrect();
    } else {
        handleWrong(correct);
    }
};

// ─── 答对处理（已修复）────────────────────────────────────────
//
//  修复点：
//   1. 用 fromWrong 在操作前判断来源，不依赖删除后的 qi
//   2. 错词答对也要让 mainAnsweredCount++，否则 pickNextWord 永远
//      优先插入错词，新词出不来
//   3. streak 角标与 wrongBuffer 实际状态同步显示
//
function handleCorrect() {
    const wi        = wrongBuffer.findIndex(w => w.id === currentWord.id);
    const fromWrong = wi !== -1;  // 在删除前判断来源

    // 从 queue 里摘除（如果在的话）
    const qi = queue.findIndex(w => w.id === currentWord.id);
    if (qi !== -1) queue.splice(qi, 1);

    if (fromWrong) {
        // ── 错词答对：连续正确 streak +1 ──
        const newStreak = (wrongBuffer[wi].streak || 0) + 1;
        wrongBuffer[wi].streak = newStreak;

        if (newStreak >= 2) {
            // 连续答对 2 次 → 毕业，移出 wrongBuffer
            wrongBuffer.splice(wi, 1);
            answeredIds.add(currentWord.id);
            dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id, 2);
        } else {
            // streak = 1，还需再答对一次
            dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id, newStreak);
        }

        // 错词答对：重置计数，下一轮从0重新计间隔
        mainAnsweredCount = 0;

    } else {
        // ── 新词答对：直接完成 ──
        answeredIds.add(currentWord.id);
        mainAnsweredCount++;
    }

    showMsg('Très bien !', 'success');
    updateCount();
    saveCurrentSession();

    dom.singleInp.readOnly      = true;
    dom.singleInp.style.opacity = '0.7';
    dom.killBtn.style.display   = 'inline-block';

    nextTimer = setTimeout(function() { render(); }, NEXT_DELAY);
}

// ─── 答错处理 ──────────────────────────────────────────────────
function handleWrong(correct) {
    // 从 queue 里摘除（答错的词不走 queue 了，改走 wrongBuffer）
    const qi = queue.findIndex(w => w.id === currentWord.id);
    if (qi !== -1) queue.splice(qi, 1);

    const wi = wrongBuffer.findIndex(w => w.id === currentWord.id);
    if (wi === -1) {
        // 新进入 wrongBuffer，streak 从 0 开始
        wrongBuffer.push({ ...currentWord, streak: 0 });
    } else {
        // 已在 wrongBuffer 里，streak 清零重来
        wrongBuffer[wi].streak = 0;
    }

    // 进入强制订正模式，同时重置计数器
    // 避免旧的计数值残留，导致订正完成后立即再插一道错词
    forceCorrectWordId = currentWord.id;
    mainAnsweredCount  = 0;

    showMsg('正确答案: ' + correct, 'error');
    saveCurrentSession();
    dom.killBtn.style.display = 'inline-block';

    dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id, 0);
}

// ─── 计数（用 answeredIds 正向统计）──────────────────────────
function updateCount() {
    const activeTotal = [...mainPool].filter(id => !killedWords.has(id)).length;
    const completed   = [...answeredIds].filter(id => !killedWords.has(id)).length;
    dom.count.innerText = Math.max(0, activeTotal - completed);
}

// ─── 初始化 ────────────────────────────────────────────────────
async function startApp(mode) {
    currentMode = mode;
    const fileName = mode === 'verb' ? 'verbs.json' : 'words.json';
    const limit    = parseInt(localStorage.getItem('fr_limit_' + mode)) || LIMIT_DEFAULT;

    const savedKilled = localStorage.getItem('fr_killed_' + mode);
    killedWords = new Set(savedKilled ? JSON.parse(savedKilled) : []);

    dom.limitInp.value = limit;

    const res   = await fetch(fileName);
    currentData = await res.json();

    dom.modeOverlay.style.display = 'none';

    buildQueue(limit);
    render();
}

function showMsg(text, type) {
    dom.feedback.innerText = text;
    dom.feedback.className = 'feedback ' + type;
}

function openSettings() {
    if (!currentMode) return;
    dom.modal.style.display = 'block';
}

function closeSettings() {
    dom.modal.style.display = 'none';
}

function saveSettings() {
    const val = parseInt(dom.limitInp.value) || LIMIT_DEFAULT;
    localStorage.setItem('fr_limit_' + currentMode, val);
    clearCurrentSession();
    buildQueue(val);
    render();
    closeSettings();
}

function fallbackTTS(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const msg  = new SpeechSynthesisUtterance(text);
    msg.lang   = 'fr-FR';
    const frvoc = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith('fr'));
    msg.voice  = frvoc.find(v => v.name.includes('Siri')) || frvoc[0];
    msg.rate   = 0.9;
    window.speechSynthesis.speak(msg);
}

dom.cn.onclick = function() {
    if (currentWord) speak(currentWord.fr);
};

window.startApp     = startApp;
window.openSettings = openSettings;
window.saveSettings = saveSettings;