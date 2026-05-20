/**
 * 法语记忆系统 (大词库哈希扩容 + 50%新词配额 + 纯内存海量消灭机制 + 防连击锁 + 今日断点快照续背 + 词性精准变色)
 */

// ─── 状态管理 ─────────────────────────────────────────────
let currentData = [];
let queue       = [];   // 今日主词队列
let wrongBuffer = [];   // 错词队列（包含 streak 属性）
let recentWords = [];   // 最近出现过的词历史（用于干扰计算）
let killedWords = new Set(); // 存储被斩掉的简单词 ID

let currentMode        = null;
let currentWord        = null;
let forceCorrectWordId = null;  
let mainPool           = new Set();  // 本轮主池原始词 id 集合
let mainAnsweredCount  = 0;  // 答过的主词数步长（控制错词插入频率）

let nextTimer          = null; 

const LIMIT_DEFAULT = 100;
const NEXT_DELAY    = 1500; 

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
    
    const newWordCount = Math.floor(limit * 0.5); 
    const reviewCount = limit - newWordCount;     

    function pseudoRandom(seedStr) {
        let hash = 0;
        for (let i = 0; i < seedStr.length; i++) {
            hash = seedStr.charCodeAt(i) + ((hash << 5) - hash);
        }
        const x = Math.sin(hash) * 10000;
        return x - Math.floor(x);
    }

    const BASE_CYCLE = 100000; 
    const startIndex = (dateSeed * newWordCount) % BASE_CYCLE;
    
    const newWordsPool = [];
    let offset = 0;
    while (newWordsPool.length < newWordCount && offset < allWords.length) {
        const realIndex = (startIndex + offset) % allWords.length;
        const w = allWords[realIndex];
        if (!killedWords.has(w.id)) {
            newWordsPool.push(w);
        }
        offset++;
    }

    const newWordsMap = new Set(newWordsPool.map(w => w.id));

    const intervals = [1, 2, 4, 7, 15, 30, 60, 90, 180]; 
    const reviewPool = [];

    for (let i = 0; i < allWords.length; i++) {
        const word = allWords[i];
        if (killedWords.has(word.id) || newWordsMap.has(word.id)) continue;

        let wordBirthDay = 0;
        for (let d = 0; d < 200; d++) {
            const historySeed = dateSeed - d;
            const histStartIndex = (historySeed * newWordCount) % BASE_CYCLE;
            
            let isBirth = false;
            for (let j = 0; j < newWordCount; j++) {
                if ((histStartIndex + j) % allWords.length === i) {
                    isBirth = true;
                    break;
                }
            }
            if (isBirth) {
                wordBirthDay = d; 
                break;
            }
        }

        if (intervals.indexOf(wordBirthDay) !== -1) {
            reviewPool.push(word);
        }
    }

    if (reviewPool.length < reviewCount) {
        const fallbackWords = allWords.filter(w => !killedWords.has(w.id) && !newWordsMap.has(w.id) && reviewPool.indexOf(w) === -1);
        fallbackWords.sort((a, b) => {
            return pseudoRandom(dateSeed + a.id) - pseudoRandom(dateSeed + b.id);
        });
        const needMore = reviewCount - reviewPool.length;
        reviewPool.push(...fallbackWords.slice(0, needMore));
    } else if (reviewPool.length > reviewCount) {
        reviewPool.sort((a, b) => pseudoRandom(dateSeed + a.id) - pseudoRandom(dateSeed + b.id));
        reviewPool.length = reviewCount; 
    }

    const todayQueue = [...newWordsPool, ...reviewPool];
    todayQueue.sort((a, b) => {
        return pseudoRandom(dateSeed + a.id + "shuffle") - pseudoRandom(dateSeed + b.id + "shuffle");
    });

    return todayQueue;
}

// ─── 今日状态持久化快照层 (断点续背保护) ─────────────────────────
function saveCurrentSession() {
    const today = new Date();
    const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    
    const sessionSnapshot = {
        dateSeed: dateSeed,
        queueIds: queue.map(w => w.id),
        wrongBufferState: wrongBuffer.map(w => ({ id: w.id, streak: w.streak || 0 })),
        mainAnsweredCount: mainAnsweredCount
    };
    localStorage.setItem('fr_session_' + currentMode, JSON.stringify(sessionSnapshot));
}

function clearCurrentSession() {
    localStorage.removeItem('fr_session_' + currentMode);
}

// ─── 队列载入与历史恢复 ───────────────────────────────────────────
function buildQueue(limit) {
    const today = new Date();
    const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();

    const fullTodayQueue = hashPickWordsOptimized(currentData, dateSeed, limit);
    mainPool = new Set(fullTodayQueue.map(function(i) { return i.id; }));

    const savedSession = localStorage.getItem('fr_session_' + currentMode);
    let hasRestored = false;

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

                mainAnsweredCount = session.mainAnsweredCount;
                forceCorrectWordId = null;
                recentWords = [];
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
        forceCorrectWordId = null;
        mainAnsweredCount  = 0;
        clearCurrentSession(); 
    }

    updateCount();
}

function pickNextWord() {
    if (wrongBuffer.length > 0) {
        const recentlySeen = recentWords.slice(-2); 
        let idx = wrongBuffer.findIndex(function(item) {
            return item.id !== forceCorrectWordId && recentlySeen.indexOf(item.id) === -1;
        });

        if (idx !== -1 && (queue.length === 0 || mainAnsweredCount >= 3 || wrongBuffer.length > 2)) {
            return wrongBuffer[idx];
        }
    }
    if (queue.length > 0) {
        return queue[0];
    }
    return wrongBuffer[0] || null;
}

// ─── 渲染层 (自动区分正常词与错词) ─────────────────
function render() {
    clearTimeout(nextTimer);
    dom.killBtn.style.display = 'none'; 
    
    dom.singleInp.readOnly = false; 
    dom.singleInp.style.opacity = '1';

    if (queue.length === 0 && wrongBuffer.length === 0) {
        dom.cn.innerText            = '今日任务达成！🎉';
        dom.singleInp.style.display = 'none';
        dom.finishArea.style.display = 'block';
        clearCurrentSession(); 
        return;
    }

    currentWord = pickNextWord();
    
    // 词性颜色处理
    dom.cn.className = 'word-cn'; 
    if (currentWord.gender === 'f') {
        dom.cn.classList.add('gender-f'); 
    } else if (currentWord.gender === 'm') {
        dom.cn.classList.add('gender-m'); 
    }

    // 判断当前词是否在错词池中。如果在，才渲染标签；如果是正常词，干干净净。
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

// ─── 核心打卡交互事件 ───────────────────────────────────────────
dom.killBtn.onclick = function() {
    if (!currentWord || dom.killBtn.style.display === 'none') return;
    
    clearTimeout(nextTimer); 
    
    killedWords.add(currentWord.id);
    localStorage.setItem('fr_killed_' + currentMode, JSON.stringify([...killedWords]));
    
    const qi = queue.findIndex(w => w.id === currentWord.id);
    if (qi !== -1) queue.splice(qi, 1);
    
    const wi = wrongBuffer.findIndex(w => w.id === currentWord.id);
    if (wi !== -1) wrongBuffer.splice(wi, 1);

    forceCorrectWordId = null;
    showMsg('🔪 已斩！不再出现', 'success');
    dom.killBtn.style.display = 'none';
    
    updateCount();
    saveCurrentSession(); 
    
    setTimeout(function() { render(); }, 800);
};

dom.singleInp.onkeypress = function(e) {
    if (e.key !== 'Enter') return;

    const input = dom.singleInp.value.trim().toLowerCase();
    if (!currentWord) return;

    const correct = currentWord.fr.toLowerCase();

    // 强制订正期输入捕获
    if (forceCorrectWordId === currentWord.id) {
        if (input === correct) {
            forceCorrectWordId = null;
            showMsg('✔ 订正完成', 'success');
            speak(currentWord.fr);

            // 强制订正仅仅是过眼熟，不计入进度（streak保持不变），原有的 0/2 标签留在原位
            dom.singleInp.readOnly = true;
            dom.singleInp.style.opacity = '0.7'; 
            dom.killBtn.style.display = 'inline-block';
            
            saveCurrentSession();
            nextTimer = setTimeout(function() { render(); }, NEXT_DELAY);
        } else {
            showMsg('❌ 再试一次', 'error');
            dom.singleInp.value = '';
        }
        return;
    }

    // 正常测试期捕获（凭记忆默写）
    speak(currentWord.fr);
    if (input === correct) {
        handleCorrect();
    } else {
        handleWrong(correct);
    }
};

function handleCorrect() {
    const item = currentWord;
    const qi = queue.findIndex(function(w) { return w.id === item.id; });
    if (qi !== -1) queue.splice(qi, 1);

    const wi = wrongBuffer.findIndex(function(w) { return w.id === item.id; });
    if (wi !== -1) {
        // 只有在错词池里的词凭记忆再次默写正确，才真正计入进度并实时更新标签
        item.streak = (item.streak || 0) + 1;
        
        if (item.streak === 1) {
            dom.cn.innerHTML = currentWord.cn + `<span style="font-size:15px; color:#e67e22; background:#fff3e0; padding:4px 10px; border-radius:12px; margin-left:12px; vertical-align:middle; font-weight:normal;">1/2</span>`;
        } else if (item.streak >= 2) {
            wrongBuffer.splice(wi, 1); // 达到 2/2，脱离苦海
            dom.cn.innerHTML = currentWord.cn + `<span style="font-size:15px; color:#e67e22; background:#fff3e0; padding:4px 10px; border-radius:12px; margin-left:12px; vertical-align:middle; font-weight:normal;">2/2</span>`;
        }
    } 
    // 如果不在错词池（也就是第一次见面的正常词打对了），什么标签都不会加

    if (mainPool.has(item.id) && qi !== -1) {
        mainAnsweredCount++; 
    } else {
        mainAnsweredCount = 0; 
    }

    showMsg('Très bien !', 'success');
    updateCount();
    saveCurrentSession(); 

    dom.singleInp.readOnly = true;
    dom.singleInp.style.opacity = '0.7';
    dom.killBtn.style.display = 'inline-block';
    
    nextTimer = setTimeout(function() { render(); }, NEXT_DELAY);
}

function handleWrong(correct) {
    const item = currentWord;
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
    if (qi !== -1) mainAnsweredCount++;

    showMsg('正确答案: ' + correct, 'error');
    saveCurrentSession(); 
    dom.killBtn.style.display = 'inline-block';

    // 只要答错，瞬间在顶部挂上 0/2，并且后续必须经过强制订正
    dom.cn.innerHTML = currentWord.cn + `<span style="font-size:15px; color:#e67e22; background:#fff3e0; padding:4px 10px; border-radius:12px; margin-left:12px; vertical-align:middle; font-weight:normal;">0/2</span>`;
}

function updateCount() {
    let completed = 0;
    mainPool.forEach(function(id) {
        const isStillWrong = wrongBuffer.some(function(w) { return w.id === id; });
        if (isStillWrong) return;
        const isStillInQueue = queue.some(function(w) { return w.id === id; });
        if (!isStillInQueue) {
            completed++;
        }
    });
    dom.count.innerText = Math.max(0, mainPool.size - completed);
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
    msg.voice   = frvoc.find(function(v) { return v.name.includes('Siri'); }) || frvoc[0];
    msg.rate    = 0.9;
    window.speechSynthesis.speak(msg);
}

dom.cn.onclick = function() {
    if (currentWord) speak(currentWord.fr);
};

// ─── 外部方法挂载 ────────────────────────────────────────────
window.startApp     = startApp;
window.openSettings = openSettings;
window.saveSettings = saveSettings;