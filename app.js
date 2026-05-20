/**
 * 法语记忆系统 (纯哈希 + 扇贝消灭版 + 防抖 + 极简黑名单)
 */

let currentData = [];
let queue       = [];   
let wrongBuffer = [];   
let recentWords = [];   
let killedWords = new Set(); // 极小内存占用：被斩掉的简单词 ID

let currentMode        = null;
let currentWord        = null;
let forceCorrectWordId = null;  
let mainPool           = new Set();  
let mainAnsweredCount  = 0;  

let nextTimer          = null; // 跳转倒计时

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

// ─── 发音模块 ───
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

// ─── 哈希抽词算法（附带极简黑名单过滤） ───
function hashPickWordsOptimized(allWords, dateSeed, limit = 100) {
    if (!allWords || allWords.length === 0) return [];
    
    const newWordCount = Math.floor(limit * 0.3); 
    const reviewCount = limit - newWordCount;     

    function pseudoRandom(seedStr) {
        let hash = 0;
        for (let i = 0; i < seedStr.length; i++) {
            hash = seedStr.charCodeAt(i) + ((hash << 5) - hash);
        }
        const x = Math.sin(hash) * 10000;
        return x - Math.floor(x);
    }

    const BASE_CYCLE = 10000; 
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

    const intervals = [1, 2, 4, 7, 15]; 
    const reviewPool = [];

    for (let i = 0; i < allWords.length; i++) {
        const word = allWords[i];
        if (killedWords.has(word.id) || newWordsMap.has(word.id)) continue;

        let wordBirthDay = 0;
        for (let d = 0; d < 30; d++) {
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
    } else {
        reviewPool.length = reviewCount;
    }

    const todayQueue = [...newWordsPool, ...reviewPool];
    todayQueue.sort((a, b) => {
        return pseudoRandom(dateSeed + a.id + "shuffle") - pseudoRandom(dateSeed + b.id + "shuffle");
    });

    return todayQueue;
}

// ─── 队列初始化 ───
function buildQueue(limit) {
    const today = new Date();
    const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();

    queue = hashPickWordsOptimized(currentData, dateSeed, limit);
    mainPool = new Set(queue.map(function(i) { return i.id; }));

    wrongBuffer        = [];
    recentWords        = [];
    forceCorrectWordId = null;
    mainAnsweredCount  = 0;

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

function render() {
    clearTimeout(nextTimer);
    dom.killBtn.style.display = 'none'; 
    
    // 恢复输入框可用状态
    dom.singleInp.readOnly = false; 
    dom.singleInp.style.opacity = '1';

    if (queue.length === 0 && wrongBuffer.length === 0) {
        dom.cn.innerText            = '今日任务达成！🎉';
        dom.singleInp.style.display = 'none';
        dom.finishArea.style.display = 'block';
        return;
    }

    currentWord = pickNextWord();
    dom.cn.innerText       = currentWord.cn;
    dom.feedback.innerText = '';
    dom.singleInp.value    = '';
    dom.singleInp.focus();

    recentWords.push(currentWord.id);
    if (recentWords.length > 10) recentWords.shift();
}

// ─── 太简单按钮点击事件 ───
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
    
    setTimeout(function() { render(); }, 800);
};

// ─── 键盘输入事件处理 ───
dom.singleInp.onkeypress = function(e) {
    if (e.key !== 'Enter') return;

    const input = dom.singleInp.value.trim().toLowerCase();
    if (!currentWord) return;

    const correct = currentWord.fr.toLowerCase();
    speak(currentWord.fr);

    if (forceCorrectWordId === currentWord.id) {
        if (input === correct) {
            forceCorrectWordId = null;
            showMsg('✔ 订正完成', 'success');
            
            // 锁定输入框，防止连击
            dom.singleInp.readOnly = true;
            dom.singleInp.style.opacity = '0.7'; 

            dom.killBtn.style.display = 'inline-block';
            nextTimer = setTimeout(function() { render(); }, NEXT_DELAY);
        } else {
            showMsg('❌ 再试一次', 'error');
            dom.singleInp.value = '';
        }
        return;
    }

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
        item.streak = (item.streak || 0) + 1;
        if (item.streak >= 2) wrongBuffer.splice(wi, 1); 
    }

    if (mainPool.has(item.id) && qi !== -1) {
        mainAnsweredCount++; 
    } else {
        mainAnsweredCount = 0; 
    }

    showMsg('Très bien !', 'success');
    updateCount();
    
    // 锁定输入框，防止连击
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
    dom.killBtn.style.display = 'inline-block';
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

// ─── 启动与设置 ───
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
    buildQueue(val);
    render();
    closeSettings();
}

dom.cn.onclick = function() {
    if (currentWord) speak(currentWord.fr);
};

window.startApp     = startApp;
window.openSettings = openSettings;
window.saveSettings = saveSettings;