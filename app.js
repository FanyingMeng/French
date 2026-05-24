// ═══════════════════════════════════════════════════════════════
//  法语单词练习 — 核心逻辑（Bug 修复版）
//
//  修复清单：
//   Fix 1. forceCorrect 订正成功后 mainAnsweredCount++ （原本永不增加，
//          导致新词被错词无限挤出，几乎出不来）
//   Fix 2. killBtn.disabled 在同步帧内被立即解锁，800ms 延迟期间
//          可以二次误触；改为仅靠 display:none 防护，render() 统一重置
//   Fix 3. fallbackTTS getVoices() 首次调用返回空列表，改为监听
//          onvoiceschanged 事件后再朗读
//   Fix 4. recentWords.push 时机错误（先选词后记录，防重失效）；
//          改为先记录上一题再 pick，保证防重窗口覆盖当前题
// ═══════════════════════════════════════════════════════════════

let currentData = [];
let queue       = [];       // 今日待做新词队列（有序，逐个弹出）
let wrongBuffer = [];       // 错词缓冲区（答错后放入，连续答对2次才移出）
let recentWords = [];       // 最近展示的词 id，防止短时间内重复
let killedWords = new Set();  // 永久屏蔽的词
let answeredIds = new Set();  // 今日已完成的词（新词答对 or 错词毕业）

let currentMode        = null;
let currentWord        = null;
let forceCorrectWordId = null;  // 答错后强制订正：必须输入正确才能继续
let mainPool           = new Set();  // 今日词池（所有词 id）
let mainAnsweredCount  = 0;         // 距上次插入错词后，连续答对的计数

let nextTimer = null;

const LIMIT_DEFAULT       = 100;
const NEXT_DELAY          = 1200;
const NEW_WORD_INTERVAL   = 3;     // 每答对 N 题新词，插入一次错词复习
const WRONG_BACKLOG_LIMIT = 2;     // wrongBuffer 超过此数量时，间隔压缩为 1

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
function hashPickWordsOptimized(allWords, dateSeed, limit = 100) {
    if (!allWords || allWords.length === 0) return [];

    const newWordCount = Math.floor(limit * 0.5);
    const reviewCount  = limit - newWordCount;

    function pseudoRandom(seed) {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }

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

    if (reviewPool.length < reviewCount) {
        const fallback = allWords.filter(w =>
            !killedWords.has(w.id) && !newWordsMap.has(w.id) && !reviewAdded.has(w.id)
        );
        fallback.sort((a, b) => pseudoRandom(dateSeed + a.id) - pseudoRandom(dateSeed + b.id));
        reviewPool.push(...fallback.slice(0, reviewCount - reviewPool.length));
    } else if (reviewPool.length > reviewCount) {
        reviewPool.length = reviewCount;
    }

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
                queue = fullTodayQueue.filter(w => session.queueIds.includes(w.id));

                wrongBuffer = [];
                session.wrongBufferState.forEach(state => {
                    const wordObj = currentData.find(w => w.id === state.id);
                    if (wordObj) {
                        wrongBuffer.push({ ...wordObj, streak: state.streak || 0 });
                    }
                });

                mainAnsweredCount  = session.mainAnsweredCount;
                answeredIds        = new Set(session.answeredIds || []);
                forceCorrectWordId = null;
                recentWords        = [];

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
function pickNextWord() {
    if (wrongBuffer.length > 0) {
        const interval = wrongBuffer.length > WRONG_BACKLOG_LIMIT ? 1 : NEW_WORD_INTERVAL;

        if (queue.length === 0 || mainAnsweredCount >= interval) {
            const recentlySeen = recentWords.slice(-2);

            let idx = wrongBuffer.findIndex(w =>
                w.id !== forceCorrectWordId && !recentlySeen.includes(w.id)
            );

            if (idx === -1) {
                idx = wrongBuffer.findIndex(w => w.id !== forceCorrectWordId);
            }

            if (idx === -1) {
                if (queue.length > 0) return queue[0];
                idx = 0;
            }

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

    // Fix 4: 先把上一题记录进 recentWords，再 pick 下一题
    // 原代码在 render 末尾才 push，导致 pickNextWord 里的防重窗口落后一题
    if (currentWord) {
        recentWords.push(currentWord.id);
        if (recentWords.length > 10) recentWords.shift();
    }

    currentWord = pickNextWord();
    if (!currentWord) return;

    dom.cn.className = 'word-cn';
    if (currentWord.gender === 'f')      dom.cn.classList.add('gender-f');
    else if (currentWord.gender === 'm') dom.cn.classList.add('gender-m');

    dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id);

    dom.feedback.innerText = '';
    dom.singleInp.value    = '';
    dom.singleInp.focus();
}

// 错词进度角标
function buildStreakBadge(wordId, overrideStreak) {
    const wi = wrongBuffer.findIndex(w => w.id === wordId);
    if (wi === -1 && overrideStreak === undefined) return '';
    const streak = overrideStreak !== undefined ? overrideStreak : (wrongBuffer[wi].streak || 0);
    return `<span style="font-size:15px; color:#e67e22; background:#fff3e0; padding:4px 10px; border-radius:12px; margin-left:12px; vertical-align:middle; font-weight:normal;">${streak}/2</span>`;
}

// ─── 斩词 ──────────────────────────────────────────────────────
// Fix 2: 移除 disabled=true/false 的同帧解锁逻辑；
//        改为仅依赖 display:none 防止重复点击，render() 开头统一重置
dom.killBtn.onclick = function() {
    if (!currentWord || dom.killBtn.style.display === 'none') return;

    // 立即隐藏，防止 800ms 延迟内二次触发
    dom.killBtn.style.display = 'none';
    clearTimeout(nextTimer);

    killedWords.add(currentWord.id);
    localStorage.setItem('fr_killed_' + currentMode, JSON.stringify([...killedWords]));

    const qi = queue.findIndex(w => w.id === currentWord.id);
    if (qi !== -1) queue.splice(qi, 1);

    const wi = wrongBuffer.findIndex(w => w.id === currentWord.id);
    if (wi !== -1) wrongBuffer.splice(wi, 1);

    forceCorrectWordId = null;

    showMsg('🔪 已斩！不再出现', 'success');

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

    // 强制订正期
    if (forceCorrectWordId === currentWord.id) {
        if (input === correct) {
            forceCorrectWordId = null;

            // Fix 1: 订正成功也要推进计数，否则新词永远被错词挤占
            // 此处不走 handleCorrect() 完整流程（错词 streak 已在 handleWrong 时设为0，
            // 此次订正仅是"看了一眼正确答案"，不算 streak 进度），
            // 但 mainAnsweredCount 必须更新，让新词有机会弹出
            mainAnsweredCount++;

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

// ─── 答对处理 ──────────────────────────────────────────────────
function handleCorrect() {
    const wi        = wrongBuffer.findIndex(w => w.id === currentWord.id);
    const fromWrong = wi !== -1;

    const qi = queue.findIndex(w => w.id === currentWord.id);
    if (qi !== -1) queue.splice(qi, 1);

    if (fromWrong) {
        const newStreak = (wrongBuffer[wi].streak || 0) + 1;
        wrongBuffer[wi].streak = newStreak;

        if (newStreak >= 2) {
            wrongBuffer.splice(wi, 1);
            answeredIds.add(currentWord.id);
            dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id, 2);
        } else {
            dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id, newStreak);
        }

        // 错词答对：重置计数
        mainAnsweredCount = 0;

    } else {
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
    const qi = queue.findIndex(w => w.id === currentWord.id);
    if (qi !== -1) queue.splice(qi, 1);

    const wi = wrongBuffer.findIndex(w => w.id === currentWord.id);
    if (wi === -1) {
        wrongBuffer.push({ ...currentWord, streak: 0 });
    } else {
        wrongBuffer[wi].streak = 0;
    }

    forceCorrectWordId = currentWord.id;
    mainAnsweredCount  = 0;

    showMsg('正确答案: ' + correct, 'error');
    saveCurrentSession();
    dom.killBtn.style.display = 'inline-block';

    dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id, 0);
}

// ─── 计数 ──────────────────────────────────────────────────────
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

// Fix 3: getVoices() 首次调用常返回空列表（浏览器异步加载声音库）
//        改为监听 onvoiceschanged 事件，确保拿到法语声音后再朗读
function fallbackTTS(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();

    function doSpeak() {
        const msg    = new SpeechSynthesisUtterance(text);
        msg.lang     = 'fr-FR';
        const frvoc  = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith('fr'));
        msg.voice    = frvoc.find(v => v.name.includes('Siri')) || frvoc[0] || null;
        msg.rate     = 0.9;
        window.speechSynthesis.speak(msg);
    }

    if (window.speechSynthesis.getVoices().length > 0) {
        doSpeak();
    } else {
        window.speechSynthesis.onvoiceschanged = function() {
            window.speechSynthesis.onvoiceschanged = null; // 只触发一次
            doSpeak();
        };
    }
}

dom.cn.onclick = function() {
    if (currentWord) speak(currentWord.fr);
};

window.startApp     = startApp;
window.openSettings = openSettings;
window.saveSettings = saveSettings;