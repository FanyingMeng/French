// ═══════════════════════════════════════════════════════════════
//  法语单词/动词/句子练习 — 核心逻辑
//
//  模式说明：
//   'word'     普通单词：显示中文 → 输入法语拼写
//   'verb'     动词变位：显示中文 → 输入法语拼写
//   'sentence' 背诵句子：显示中文 → 按 Enter 揭示答案 → 自评记住/没记住
//
//  Bug 修复清单（相比原始版本）：
//   Fix 1. forceCorrect 订正成功后 mainAnsweredCount++ （原本永不增加，
//          导致新词被错词无限挤出，几乎出不来）
//   Fix 2. killBtn 的 disabled 同帧解锁无防护；改为立即 display:none
//   Fix 3. fallbackTTS getVoices() 首次为空，改用 onvoiceschanged 事件
//   Fix 4. recentWords.push 时机错误，移到 pickNextWord 之前
// ═══════════════════════════════════════════════════════════════

let currentData = [];
let queue       = [];
let wrongBuffer = [];
let recentWords = [];
let killedWords = new Set();
let answeredIds = new Set();

let currentMode        = null;
let currentWord        = null;
let forceCorrectWordId = null;
let mainPool           = new Set();
let mainAnsweredCount  = 0;

// 句子模式专用：当前句子是否已翻开答案
let sentenceRevealed = false;

let nextTimer = null;

const LIMIT_DEFAULT       = 100;
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
    killBtn:            document.getElementById('btn-kill'),
    // 句子模式专用
    sentenceRevealArea: document.getElementById('sentence-reveal-area'),
    sentenceHint:       document.getElementById('sentence-hint'),
    sentenceAnswer:     document.getElementById('sentence-answer'),
    sentenceJudgeRow:   document.getElementById('sentence-judge-row'),
};

// ─── 是否句子模式 ──────────────────────────────────────────────
function isSentenceMode() {
    return currentMode === 'sentence';
}

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
function hashPickWordsOptimized(allWords, dateSeed, limit) {
    limit = limit || 100;
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

// ─── 渲染 ──────────────────────────────────────────────────────
function render() {
    clearTimeout(nextTimer);
    dom.killBtn.style.display  = 'none';
    dom.feedback.innerText     = '';

    if (queue.length === 0 && wrongBuffer.length === 0) {
        dom.cn.innerText             = '今日任务达成！🎉';
        if (isSentenceMode()) {
            dom.sentenceRevealArea.style.display = 'none';
        } else {
            dom.singleInp.style.display = 'none';
        }
        dom.finishArea.style.display = 'block';
        clearCurrentSession();
        return;
    }

    // Fix 4: 先记录上一题再选下一题，保证防重窗口覆盖当前题
    if (currentWord) {
        recentWords.push(currentWord.id);
        if (recentWords.length > 10) recentWords.shift();
    }

    currentWord = pickNextWord();
    if (!currentWord) return;

    // 根据模式设置 display-cn 的样式
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

    dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id);
}

// ─── 角标 ──────────────────────────────────────────────────────
function buildStreakBadge(wordId, overrideStreak) {
    const wi = wrongBuffer.findIndex(function(w) { return w.id === wordId; });
    if (wi === -1 && overrideStreak === undefined) return '';
    const streak = overrideStreak !== undefined ? overrideStreak : (wrongBuffer[wi].streak || 0);
    return '<span style="font-size:15px; color:#e67e22; background:#fff3e0; padding:4px 10px; border-radius:12px; margin-left:12px; vertical-align:middle; font-weight:normal;">' + streak + '/2</span>';
}

// ─── 斩词 ──────────────────────────────────────────────────────
// Fix 2: 立即 display:none，不用 disabled 同帧解锁
dom.killBtn.onclick = function() {
    if (!currentWord || dom.killBtn.style.display === 'none') return;

    dom.killBtn.style.display = 'none';
    clearTimeout(nextTimer);

    killedWords.add(currentWord.id);
    localStorage.setItem('fr_killed_' + currentMode, JSON.stringify([...killedWords]));

    const qi = queue.findIndex(function(w) { return w.id === currentWord.id; });
    if (qi !== -1) queue.splice(qi, 1);

    const wi = wrongBuffer.findIndex(function(w) { return w.id === currentWord.id; });
    if (wi !== -1) wrongBuffer.splice(wi, 1);

    forceCorrectWordId = null;

    showMsg('🔪 已斩！不再出现', 'success');
    updateCount();
    saveCurrentSession();
    setTimeout(function() { render(); }, 800);
};

// ─── 输入事件（单词/动词模式）────────────────────────────────
dom.singleInp.onkeypress = function(e) {
    if (e.key !== 'Enter') return;
    if (dom.singleInp.readOnly) return;
    if (isSentenceMode()) return;

    const input = dom.singleInp.value.trim().toLowerCase();
    if (!currentWord) return;

    const correct = currentWord.fr.toLowerCase();

    // 强制订正期
    if (forceCorrectWordId === currentWord.id) {
        if (input === correct) {
            forceCorrectWordId = null;

            // Fix 1: 订正成功也要推进计数
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

// ─── 句子模式：Enter 键揭示答案 ──────────────────────────────
document.addEventListener('keypress', function(e) {
    if (e.key !== 'Enter') return;
    if (!isSentenceMode()) return;
    if (!currentWord) return;
    if (sentenceRevealed) return;

    revealSentence();
});

function revealSentence() {
    if (sentenceRevealed) return;
    sentenceRevealed = true;

    dom.sentenceAnswer.innerText     = currentWord.fr;
    dom.sentenceAnswer.style.display = 'block';
    dom.sentenceHint.style.display   = 'none';
    dom.sentenceJudgeRow.style.display = 'flex';
    dom.killBtn.style.display          = 'inline-block';

    // 句子也尝试朗读
    speak(currentWord.fr);
}

// ─── 句子自评（记住了 / 没记住）──────────────────────────────
function sentenceJudge(remembered) {
    if (!currentWord) return;

    // 隐藏判断按钮，防止重复点
    dom.sentenceJudgeRow.style.display = 'none';
    dom.killBtn.style.display          = 'none';

    if (remembered) {
        handleCorrect();
    } else {
        // 没记住：放入 wrongBuffer，streak 归零，不需要订正直接下一题
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
        dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id, 0);
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
            dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id, 2);
        } else {
            dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id, newStreak);
        }

        mainAnsweredCount = 0;
    } else {
        answeredIds.add(currentWord.id);
        mainAnsweredCount++;
    }

    showMsg('Très bien !', 'success');
    updateCount();
    saveCurrentSession();

    if (!isSentenceMode()) {
        dom.singleInp.readOnly      = true;
        dom.singleInp.style.opacity = '0.7';
        dom.killBtn.style.display   = 'inline-block';
    }

    nextTimer = setTimeout(function() { render(); }, NEXT_DELAY);
}

// ─── 答错处理（单词/动词模式）────────────────────────────────
function handleWrong(correct) {
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

    showMsg('正确答案: ' + correct, 'error');
    saveCurrentSession();
    dom.killBtn.style.display = 'inline-block';

    dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id, 0);
}

// ─── 计数 ──────────────────────────────────────────────────────
function updateCount() {
    const activeTotal = [...mainPool].filter(function(id) { return !killedWords.has(id); }).length;
    const completed   = [...answeredIds].filter(function(id) { return !killedWords.has(id); }).length;
    dom.count.innerText = Math.max(0, activeTotal - completed);
}

// ─── 初始化 ────────────────────────────────────────────────────
async function startApp(mode) {
    currentMode = mode;

    let fileName;
    if (mode === 'verb')     fileName = 'verbs.json';
    else if (mode === 'sentence') fileName = 'sentences.json';
    else                     fileName = 'words.json';

    const limit = parseInt(localStorage.getItem('fr_limit_' + mode)) || LIMIT_DEFAULT;

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

// Fix 3: onvoiceschanged 事件等声音库加载完毕后再朗读
function fallbackTTS(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();

    function doSpeak() {
        const msg   = new SpeechSynthesisUtterance(text);
        msg.lang    = 'fr-FR';
        const frvoc = window.speechSynthesis.getVoices().filter(function(v) { return v.lang.startsWith('fr'); });
        msg.voice   = frvoc.find(function(v) { return v.name.includes('Siri'); }) || frvoc[0] || null;
        msg.rate    = 0.9;
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
    if (isSentenceMode()) {
        // 句子模式：点击中文也可以揭示答案
        if (!sentenceRevealed) revealSentence();
        else speak(currentWord.fr);
    } else {
        speak(currentWord.fr);
    }
};

window.startApp       = startApp;
window.openSettings   = openSettings;
window.saveSettings   = saveSettings;
window.sentenceJudge  = sentenceJudge;