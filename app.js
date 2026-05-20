/**
 * 法语记忆系统
 * 修复清单：
 *   P0-1  handleWrong / handleCorrect 用浅拷贝，不再污染 currentData
 *   P0-2  hashPickWordsOptimized 复习词算法重写（getNewWordsForDay 辅助函数）
 *   P1-3  updateCount 跳过 killedWords，activeTotal 动态计算
 *   P1-4  pickNextWord 兜底逻辑，防止 wrongBuffer 唯一词被 recentWords 挤死
 *   P3-6  killBtn.onclick 加 disabled 防重入
 *   P4-7  【新增】mainAnsweredCount 取新词时重置，修复错词连续霸占队列的 bug
 *   P4-8  【新增】wrongBuffer.length > 2 的硬锁改为软优先（动态 interval）
 *   P4-9  【新增】handleWrong 中删除错误的 mainAnsweredCount++ 累加
 */

// ─── 状态管理 ─────────────────────────────────────────────
let currentData = [];
let queue       = [];
let wrongBuffer = [];
let recentWords = [];
let killedWords = new Set();

let currentMode        = null;
let currentWord        = null;
let forceCorrectWordId = null;
let mainPool           = new Set();
let mainAnsweredCount  = 0;

let nextTimer = null;

const LIMIT_DEFAULT       = 100;
const NEXT_DELAY          = 1500;
// FIX P4-7：每取 NEW_WORD_INTERVAL 道新词后插入一次错词
const NEW_WORD_INTERVAL   = 3;
// FIX P4-8：wrongBuffer 积压超过此数时缩短间隔为 1（每道新词后立刻插错词）
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
// FIX P0-2：抽取某天新词的纯函数，基于 allWords.length 取模，复习池直接调用它
function hashPickWordsOptimized(allWords, dateSeed, limit = 100) {
    if (!allWords || allWords.length === 0) return [];

    const newWordCount = Math.floor(limit * 0.5);
    const reviewCount  = limit - newWordCount;

    function pseudoRandom(seed) {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }

    // ✅ 纯函数：返回指定日期种子下应学的新词列表
    function getNewWordsForDay(seed) {
        // FNV-1a 哈希散列，充分打散起点，避免线性乘法的周期重叠问题
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

    // ✅ 复习池：遍历间隔天数，直接复用 getNewWordsForDay 获取历史新词
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

    // fallback：复习词不足时随机补充
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

// ─── 今日状态持久化快照层 (断点续背保护) ─────────────────────────
function saveCurrentSession() {
    const today    = new Date();
    const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();

    const sessionSnapshot = {
        dateSeed:          dateSeed,
        queueIds:          queue.map(w => w.id),
        wrongBufferState:  wrongBuffer.map(w => ({ id: w.id, streak: w.streak || 0 })),
        mainAnsweredCount: mainAnsweredCount
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
                forceCorrectWordId = null;
                recentWords        = [];
                hasRestored        = true;
            }
        } catch (e) {
            console.error("快照解析失败，执行全新初始化", e);
        }
    }

    if (!hasRestored) {
        queue              = fullTodayQueue;
        wrongBuffer        = [];
        recentWords        = [];
        forceCorrectWordId = null;
        mainAnsweredCount  = 0;
        clearCurrentSession();
    }

    updateCount();
}

// ─── 下一题选词 ───────────────────────────────────────────────────
// FIX P1-4：wrongBuffer 所有词都在 recentlySeen 时强制取 idx=0，queue 清空后无条件兜底
// FIX P4-7：取新词时重置 mainAnsweredCount = 0
// FIX P4-8：wrongBuffer 积压超过 WRONG_BACKLOG_LIMIT 时缩短插入间隔
function pickNextWord() {
    if (wrongBuffer.length > 0) {
        // ✅ FIX P4-8：积压多时每道新词后立刻插错词，积压少时每 NEW_WORD_INTERVAL 道插一次
        const interval = wrongBuffer.length > WRONG_BACKLOG_LIMIT ? 1 : NEW_WORD_INTERVAL;

        if (queue.length === 0 || mainAnsweredCount >= interval) {
            const recentlySeen = recentWords.slice(-2);

            let idx = wrongBuffer.findIndex(function(item) {
                return item.id !== forceCorrectWordId && recentlySeen.indexOf(item.id) === -1;
            });

            // ✅ FIX P1-4：兜底时先排除 forceCorrectWordId，实在只剩一个词才允许选它
            if (idx === -1) {
                idx = wrongBuffer.findIndex(function(item) { return item.id !== forceCorrectWordId; });
                if (idx === -1) idx = 0;
            }

            return wrongBuffer[idx];
        }
    }

    if (queue.length > 0) {
        // ✅ FIX P4-7：取新词时重置计数，保证"答 N 道新词 → 插一次错词"的节奏
        mainAnsweredCount = 0;
        return queue[0];
    }

    // ✅ queue 已空且 wrongBuffer 也走完了上面分支的兜底
    return wrongBuffer[0] || null;
}

// ─── 渲染层 (自动区分正常词与错词) ─────────────────
function render() {
    clearTimeout(nextTimer);
    dom.killBtn.style.display = 'none';

    dom.singleInp.readOnly    = false;
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
// FIX P3-6：disabled 防连击
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
    dom.killBtn.disabled = false; // display:none 已防住，状态复位保持干净
    showMsg('🔪 已斩！不再出现', 'success');
    dom.killBtn.style.display = 'none';

    updateCount();
    saveCurrentSession();

    setTimeout(function() { render(); }, 800);
};

// ─── 核心打卡交互事件 ─────────────────────────────────────────────
dom.singleInp.onkeypress = function(e) {
    if (e.key !== 'Enter') return;
    if (dom.singleInp.readOnly) return; // ✅ 输入框已锁则直接忽略，防连击穿透

    const input = dom.singleInp.value.trim().toLowerCase();
    if (!currentWord) return;

    const correct = currentWord.fr.toLowerCase();

    // 强制订正期
    if (forceCorrectWordId === currentWord.id) {
        if (input === correct) {
            forceCorrectWordId = null;
            showMsg('✔ 订正完成', 'success');
            speak(currentWord.fr);

            // ✅ 立刻锁死输入框，防止连击回车在 timer 触发前走入正常测试分支
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

// FIX P0-1（correct 分支）：浅拷贝 currentWord，streak 从 wrongBuffer 读取，不污染 currentData
// FIX P4-7：mainAnsweredCount 在此累加（取新词时重置，形成计数周期）
function handleCorrect() {
    const item = { ...currentWord };

    const qi = queue.findIndex(function(w) { return w.id === item.id; });
    if (qi !== -1) queue.splice(qi, 1);

    const wi = wrongBuffer.findIndex(function(w) { return w.id === item.id; });
    if (wi !== -1) {
        // ✅ 从 wrongBuffer 取 streak，写回 wrongBuffer，不碰 currentData
        item.streak = (wrongBuffer[wi].streak || 0) + 1;
        wrongBuffer[wi] = { ...wrongBuffer[wi], streak: item.streak };

        if (item.streak === 1) {
            dom.cn.innerHTML = currentWord.cn +
                `<span style="font-size:15px; color:#e67e22; background:#fff3e0; padding:4px 10px; border-radius:12px; margin-left:12px; vertical-align:middle; font-weight:normal;">1/2</span>`;
        } else if (item.streak >= 2) {
            wrongBuffer.splice(wi, 1);
            dom.cn.innerHTML = currentWord.cn +
                `<span style="font-size:15px; color:#e67e22; background:#fff3e0; padding:4px 10px; border-radius:12px; margin-left:12px; vertical-align:middle; font-weight:normal;">2/2</span>`;
        }
        // ✅ 错词答对不累加 mainAnsweredCount，不归零，避免打乱错词插入节奏
    } else if (mainPool.has(item.id) && qi !== -1) {
        // ✅ FIX P4-7：只有答对新词（来自 queue，且在 mainPool 中）才累加计数
        // pickNextWord 取新词时已将计数重置为 0，这里做累加
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

// FIX P0-1（wrong 分支）：浅拷贝 currentWord，不污染 currentData
// FIX P4-9：删除原来错误的 mainAnsweredCount++，答错不应计入"已答新词数"
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
    // ✅ FIX P4-9：此处不再累加 mainAnsweredCount
    // 原来的 `if (qi !== -1) mainAnsweredCount++` 会让答错的新词也触发错词插入计数，
    // 导致节奏错乱——现在只有 handleCorrect 里答对新词才推进计数

    showMsg('正确答案: ' + correct, 'error');
    saveCurrentSession();
    dom.killBtn.style.display = 'inline-block';

    dom.cn.innerHTML = currentWord.cn +
        `<span style="font-size:15px; color:#e67e22; background:#fff3e0; padding:4px 10px; border-radius:12px; margin-left:12px; vertical-align:middle; font-weight:normal;">0/2</span>`;
}

// ─── 计数更新 ─────────────────────────────────────────────────────
// FIX P1-3：跳过 killedWords，用 activeTotal 作分母
function updateCount() {
    let completed = 0;
    mainPool.forEach(function(id) {
        if (killedWords.has(id)) return; // ✅ 已斩词既不算完成也不算剩余
        const isStillWrong   = wrongBuffer.some(w => w.id === id);
        if (isStillWrong) return;
        const isStillInQueue = queue.some(w => w.id === id);
        if (!isStillInQueue) completed++;
    });

    const activeTotal = [...mainPool].filter(id => !killedWords.has(id)).length;
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