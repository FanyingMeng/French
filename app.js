let currentData = [];
let queue       = [];
let wrongBuffer = [];
let recentWords = [];
let killedWords = new Set();
let answeredIds = new Set();   // ← 新增：显式追踪真正答对的词

let currentMode        = null;
let currentWord        = null;
let forceCorrectWordId = null;
let mainPool           = new Set();
let mainAnsweredCount  = 0;

let nextTimer = null;

const LIMIT_DEFAULT       = 100;
const NEXT_DELAY          = 1200;
const NEW_WORD_INTERVAL   = 3;
const WRONG_BACKLOG_LIMIT = 2;

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

// ─── 发音模块 ─────────────────────────────────────────────
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

// ─── 海量词库算法（50%新词 + 50%复习） ─────────────────────────
function hashPickWordsOptimized(allWords, dateSeed, limit = 100) {
    if (!allWords || allWords.length === 0) return [];

    const newWordCount = Math.floor(limit * 0.7);
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

// ─── 今日状态持久化快照层 ─────────────────────────────────────────
function saveCurrentSession() {
    const today    = new Date();
    const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();

    const sessionSnapshot = {
        dateSeed,
        queueIds:          queue.map(w => w.id),
        wrongBufferState:  wrongBuffer.map(w => ({ id: w.id, streak: w.streak || 0 })),
        mainAnsweredCount,
        answeredIds:       [...answeredIds],   // ← 新增
    };
    localStorage.setItem('fr_session_' + currentMode, JSON.stringify(sessionSnapshot));
}

function clearCurrentSession() {
    localStorage.removeItem('fr_session_' + currentMode);
}

// ─── 队列载入与历史恢复 ───────────────────────────────────────────
function buildQueue(limit) {
    const today    = new Date();
    const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();

    const fullTodayQueue = hashPickWordsOptimized(currentData, dateSeed, limit);
    mainPool = new Set(fullTodayQueue.map(function(i) { return i.id; }));

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
                answeredIds        = new Set(session.answeredIds || []);   // ← 新增
                forceCorrectWordId = null;
                recentWords        = [];

                wrongBuffer = wrongBuffer.filter(w => mainPool.has(w.id));

                hasRestored = true;
            }
        } catch (e) {
            console.error("快照解析失败，执行全新初始化", e);
        }
    }

    if (!hasRestored) {
        queue              = fullTodayQueue;
        wrongBuffer        = [];
        recentWords        = [];
        answeredIds        = new Set();   // ← 新增
        forceCorrectWordId = null;
        mainAnsweredCount  = 0;
        clearCurrentSession();
    }

    updateCount();
}

// ─── 下一题选词 ───────────────────────────────────────────────────
function pickNextWord() {
    if (wrongBuffer.length > 0) {
        const interval = wrongBuffer.length > WRONG_BACKLOG_LIMIT ? 1 : NEW_WORD_INTERVAL;

        if (queue.length === 0 || mainAnsweredCount >= interval) {
            const recentlySeen = recentWords.slice(-2);

            let idx = wrongBuffer.findIndex(function(item) {
                return item.id !== forceCorrectWordId && recentlySeen.indexOf(item.id) === -1;
            });

            if (idx === -1) {
                idx = wrongBuffer.findIndex(function(item) { return item.id !== forceCorrectWordId; });
                if (idx === -1) idx = 0;
            }

            return wrongBuffer[idx];
        }
    }

    if (queue.length > 0) {
        mainAnsweredCount = 0;
        return queue[0];
    }

    return wrongBuffer[0] || null;
}

// ─── 渲染层 ──────────────────────────────────────────────────────
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

    dom.cn.className = 'word-cn';
    if (currentWord.gender === 'f') {
        dom.cn.classList.add('gender-f');
    } else if (currentWord.gender === 'm') {
        dom.cn.classList.add('gender-m');
    }

    let badgeHtml = '';
    const wi = wrongBuffer.findIndex(w => w.id === currentWord.id);
    if (wi !== -1) {
        const currentStreak = wrongBuffer[wi].streak || 0;
        badgeHtml = `<span style="font-size:15px; color:#e67e22; background:#fff3e0; padding:4px 10px; border-radius:12px; margin-left:12px; vertical-align:middle; font-weight:normal;">${currentStreak}/2</span>`;
    }

    dom.cn.innerHTML = currentWord.cn + badgeHtml;

    dom.feedback.innerText = '';
    dom.singleInp.value    = '';
    dom.singleInp.focus();

    recentWords.push(currentWord.id);
    if (recentWords.length > 10) recentWords.shift();
}

// ─── 斩词按钮 ─────────────────────────────────────────────────────
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

// ─── 核心打卡交互事件 ─────────────────────────────────────────────
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

    // 正常测试期
    speak(currentWord.fr);
    if (input === correct) {
        handleCorrect();
    } else {
        handleWrong(correct);
    }
};

// ─── 答对处理 ─────────────────────────────────────────────────────
function handleCorrect() {
    const item = { ...currentWord };

    const qi = queue.findIndex(function(w) { return w.id === item.id; });
    if (qi !== -1) queue.splice(qi, 1);

    const wi = wrongBuffer.findIndex(function(w) { return w.id === item.id; });
    if (wi !== -1) {
        item.streak = (wrongBuffer[wi].streak || 0) + 1;
        wrongBuffer[wi] = { ...wrongBuffer[wi], streak: item.streak };

        if (item.streak === 1) {
            dom.cn.innerHTML = currentWord.cn +
                `<span style="font-size:15px; color:#e67e22; background:#fff3e0; padding:4px 10px; border-radius:12px; margin-left:12px; vertical-align:middle; font-weight:normal;">1/2</span>`;
        } else if (item.streak >= 2) {
            wrongBuffer.splice(wi, 1);
            answeredIds.add(item.id);   // ← 新增：错词毕业时记录
            dom.cn.innerHTML = currentWord.cn +
                `<span style="font-size:15px; color:#e67e22; background:#fff3e0; padding:4px 10px; border-radius:12px; margin-left:12px; vertical-align:middle; font-weight:normal;">2/2</span>`;
        }
    } else if (mainPool.has(item.id) && qi !== -1) {
        answeredIds.add(item.id);   // ← 新增：新词第一次答对时记录
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

// ─── 答错处理 ─────────────────────────────────────────────────────
function handleWrong(correct) {
    const item = { ...currentWord };

    const qi = queue.findIndex(function(w) { return w.id === item.id; });
    if (qi !== -1) queue.splice(qi, 1);

    const wi = wrongBuffer.findIndex(function(w) { return w.id === item.id; });
    if (wi === -1) {
        item.streak = 0;
        wrongBuffer.push(item);
    } else {
        wrongBuffer[wi].streak = 0;
    }

    forceCorrectWordId = item.id;

    showMsg('正确答案: ' + correct, 'error');
    saveCurrentSession();
    dom.killBtn.style.display = 'inline-block';

    dom.cn.innerHTML = currentWord.cn +
        `<span style="font-size:15px; color:#e67e22; background:#fff3e0; padding:4px 10px; border-radius:12px; margin-left:12px; vertical-align:middle; font-weight:normal;">0/2</span>`;
}

// ─── 计数更新（用 answeredIds 正向统计，不再反推）────────────────
function updateCount() {
    const activeTotal = [...mainPool].filter(id => !killedWords.has(id)).length;
    const completed   = [...answeredIds].filter(id => !killedWords.has(id)).length;
    dom.count.innerText = Math.max(0, activeTotal - completed);
}

// ─── 初始化环境加载 ─────────────────────────────────────────────
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
    const msg   = new SpeechSynthesisUtterance(text);
    msg.lang    = 'fr-FR';
    const frvoc = window.speechSynthesis.getVoices().filter(function(v) {
        return v.lang.startsWith('fr');
    });
    msg.voice = frvoc.find(function(v) { return v.name.includes('Siri'); }) || frvoc[0];
    msg.rate  = 0.9;
    window.speechSynthesis.speak(msg);
}

dom.cn.onclick = function() {
    if (currentWord) speak(currentWord.fr);
};

// ─── 外部方法挂载 ────────────────────────────────────────────
window.startApp     = startApp;
window.openSettings = openSettings;
window.saveSettings = saveSettings;