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
//   Fix 5. 原"每日选词"用哈希算随机窗口，词库长度一变（天天加词）就会
//          稀释新词，导致新加的词永远抽不到；且复习节奏只按"哪天发的"
//          批次去猜，跟实际记没记住无关。改为按每个词单独记账的真间隔
//          重复（SRS）：新词按 id 升序（=添加顺序）依次学，不看词库
//          大小；复习到期日跟着你的真实答题表现走——一遍就过按等级表
//          往后推，答错需订正 2 次才过关的词则回到最短间隔（明天必见）。
//   Fix 6. 句子模式发音原本也去查在线词典的单词音频库，但词典没有完整
//          句子的录音，导致经常无声却不触发本地语音兜底。改为句子模式
//          直接使用本地 Mac 系统语音（Web Speech API），并优先选取
//          localService 的本地法语人声（Thomas/Amelie 等），音质更好。
//   Fix 7. 词库全部学完一轮后（不再有"从没学过"的词），自动清空该模式
//          的 SRS 记录，从 id 1 重新开始完整学一遍，循环往复，避免停
//          留在"全部变成超长间隔复习、每天凑不满数量"的状态。
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

// ─── 每日词表生成（按词记账的间隔重复 SRS）────────────────────
//
//  每个词的状态存在 localStorage（key: fr_srs_<mode>），格式：
//    { "<wordId>": { level: 0~8, dueDate: 20260710 } }
//  只要一个词的 id 不在这张表里，就是"还没学过的新词"——天然支持
//  词库无限扩容，不用管顺序、不用管游标，也不会被词库长度稀释。

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

// 一遍就答对（没进过错题本）：按等级表往后推进一档，间隔变长
function srsAdvance(mode, wordId) {
    const srs   = loadSRS(mode);
    const cur   = srs[wordId];
    const level = cur ? Math.min((cur.level || 0) + 1, SRS_INTERVALS.length - 1) : 0;
    srs[wordId] = { level: level, dueDate: addDaysToSeed(todayDateSeed(), SRS_INTERVALS[level]) };
    saveSRS(mode, srs);
}

// 答错、订正 2 次后才过关：印象不牢，退回最短间隔，明天必然再见
function srsReset(mode, wordId) {
    const srs = loadSRS(mode);
    srs[wordId] = { level: 0, dueDate: addDaysToSeed(todayDateSeed(), SRS_INTERVALS[0]) };
    saveSRS(mode, srs);
}

function buildTodayQueueSRS(allWords, mode, limit) {
    limit = limit || 100;
    if (!allWords || allWords.length === 0) return [];

    const newWordCount = Math.floor(limit * 0.5);
    const reviewCount  = limit - newWordCount;
    const dateSeed     = todayDateSeed();
    let   srs          = loadSRS(mode);

    // Fix 7: 词库里已经没有"从没学过"的词了，说明已经完整走完一轮——
    //        清空这个模式的 SRS 记录，从 id 1 开始重新完整学一遍，
    //        循环往复，不会停在"全部变成超长间隔复习"的状态。
    const hasUnlearned = allWords.some(w => !srs[w.id]);
    if (!hasUnlearned) {
        srs = {};
        saveSRS(mode, srs);
    }

    // ① 到期复习词：已学过、且到期日 <= 今天，越早到期越优先出现
    const dueWords = allWords
        .filter(w => srs[w.id] && srs[w.id].dueDate <= dateSeed)
        .sort((a, b) => srs[a.id].dueDate - srs[b.id].dueDate);

    const reviewSelected     = dueWords.slice(0, reviewCount);
    const leftoverReviewSlot = reviewCount - reviewSelected.length;

    // ② 新词：还没有 SRS 记录的词，按 id 升序（=添加进词库的顺序）依次取
    //    到期复习词不够时，多出来的名额用来多学一些新词
    const unlearned = allWords
        .filter(w => !srs[w.id])
        .sort((a, b) => a.id - b.id);

    const newSelected = unlearned.slice(0, newWordCount + Math.max(0, leftoverReviewSlot));

    let combined = [...newSelected, ...reviewSelected];

    // ③ 兜底：新词也不够、到期复习词也不够（比如刚好在轮回交界处）时，
    //    用还没到期但最快到期的词补满，保证每天都有内容可学
    if (combined.length < limit) {
        const usedIds   = new Set(combined.map(w => w.id));
        const notDueYet = allWords
            .filter(w => srs[w.id] && !usedIds.has(w.id))
            .sort((a, b) => srs[a.id].dueDate - srs[b.id].dueDate);
        combined.push(...notDueYet.slice(0, limit - combined.length));
    }

    // ④ 当天出场顺序打乱（确定性伪随机，保证同一天多次打开顺序一致）
    combined.sort((a, b) =>
        pseudoRandom(dateSeed + a.id + 999) - pseudoRandom(dateSeed + b.id + 999)
    );

    return combined;
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

    const fullTodayQueue = buildTodayQueueSRS(currentData, currentMode, limit);
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

    // 句子也尝试朗读（Fix 6: 句子不在词典音频库里，直接用本地语音）
    fallbackTTS(currentWord.fr);
}

// ─── 句子自评（记住了 / 没记住）──────────────────────────────
function sentenceJudge(remembered) {
    if (!currentWord) return;

    // 隐藏判断按钮，防止重复点
    dom.sentenceJudgeRow.style.display = 'none';

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
            srsReset(currentMode, currentWord.id); // 印象不牢，退回最短间隔，明天必见
            dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id, 2);
        } else {
            dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id, newStreak);
        }

        mainAnsweredCount = 0;
    } else {
        answeredIds.add(currentWord.id);
        mainAnsweredCount++;
        srsAdvance(currentMode, currentWord.id); // 一遍就过，长期间隔正常递增
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

    dom.cn.innerHTML = currentWord.cn + buildStreakBadge(currentWord.id, 0);
}

// ─── 计数 ──────────────────────────────────────────────────────
function updateCount() {
    const activeTotal = mainPool.size;
    const completed   = answeredIds.size;
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
// Fix 6: 优先选 Mac 本地自带的法语语音（localService === true），
//        而不是随手抓第一个（可能是音质较差的远程/合成语音）
function fallbackTTS(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();

    function doSpeak() {
        const msg = new SpeechSynthesisUtterance(text);
        msg.lang  = 'fr-FR';

        const allFr    = window.speechSynthesis.getVoices().filter(function(v) { return v.lang.startsWith('fr'); });
        const localFr  = allFr.filter(function(v) { return v.localService; });
        const pool     = localFr.length > 0 ? localFr : allFr;

        // Mac 系统自带法语人声常见名字：Thomas（男声）、Amelie/Audrey（女声）
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
    if (isSentenceMode()) {
        // 句子模式：点击中文也可以揭示答案
        if (!sentenceRevealed) revealSentence();
        else fallbackTTS(currentWord.fr);
    } else {
        speak(currentWord.fr);
    }
};

window.startApp       = startApp;
window.openSettings   = openSettings;
window.saveSettings   = saveSettings;
window.sentenceJudge  = sentenceJudge;