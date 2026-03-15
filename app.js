/**
 * 法语艾宾浩斯默写 - Mac 优化增强版核心逻辑
 */

const INTERVALS = [0, 5, 30, 720, 1440, 2880, 5760, 10080];

let currentData = [];
let queue = [];
let wrongBuffer = [];
let recentWords = [];
let currentMode = null;

const dom = {
    cn: document.getElementById('display-cn'),
    singleInp: document.getElementById('single-input'),
    feedback: document.getElementById('feedback'),
    count: document.getElementById('count'),
    modal: document.getElementById('modal'),
    limitInp: document.getElementById('limit-input'),
    finishArea: document.getElementById('finish-area'),
    modeOverlay: document.getElementById('mode-overlay')
};

// --- 核心发音逻辑 (Mac 专用) ---
async function speak(text) {
    if (!text) return;
    const word = text.trim().toLowerCase();
    
    // 1. 优先级一：尝试 WordReference 真人音频 MP3
    const wrUrl = `https://www.wordreference.com/audio/fr/fr/v1/${encodeURIComponent(word)}.mp3`;
    
    if (window.currentAudio) {
        window.currentAudio.pause();
        window.currentAudio = null;
    }

    window.currentAudio = new Audio(wrUrl);

    try {
        // 设置 800ms 超时，防止网络卡顿时一直没声音
        const playPromise = window.currentAudio.play();
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject('timeout'), 800));
        await Promise.race([playPromise, timeoutPromise]);
    } catch (e) {
        // 2. 优先级二：调用 Mac 系统下载的高级语音包
        fallbackToMacFrench(text);
    }
}

function fallbackToMacFrench(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel(); // 停止当前所有声音
    
    const msg = new SpeechSynthesisUtterance(text);
    msg.lang = 'fr-FR'; // 强制法语
    
    const voices = window.speechSynthesis.getVoices();
    // 过滤出真正的法语声音
    const frVoices = voices.filter(v => v.lang.startsWith('fr'));
    
    // 针对 Mac 寻找最佳音质：Siri > Thomas(Enhanced) > Audrey > 其他法语
    const bestVoice = frVoices.find(v => v.name.includes('Siri')) ||
                     frVoices.find(v => v.name.includes('Thomas')) ||
                     frVoices.find(v => v.name.includes('Audrey')) ||
                     frVoices[0];

    if (bestVoice) {
        msg.voice = bestVoice;
    }
    
    msg.rate = 0.9; // 语速微调
    window.speechSynthesis.speak(msg);
}

// 解决 Mac 浏览器启动时语音列表加载延迟
window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();

// --- 核心交互逻辑 ---

dom.singleInp.onkeypress = (e) => {
    if (e.key === 'Enter') {
        const input = dom.singleInp.value.trim().toLowerCase();
        const correct = queue[0].fr.toLowerCase();
        
        // 【关键改动】按下回车即刻朗读正确答案
        speak(correct); 

        // 判断对错
        input === correct ? handleCorrect() : handleWrong(correct);
    }
};

async function startApp(mode) {
    currentMode = mode;
    const fileName = (mode === 'verb') ? 'verbs.json' : 'words.json';
    const limitKey = `fr_limit_${mode}`;
    const dailyLimit = parseInt(localStorage.getItem(limitKey)) || 10;
    dom.limitInp.value = dailyLimit;

    try {
        const res = await fetch(fileName);
        currentData = await res.json();
        dom.modeOverlay.style.display = 'none';
        buildQueue(dailyLimit);
        render();
    } catch (e) {
        alert("无法加载数据文件，请确保 words.json 或 verbs.json 在同一目录下。");
    }
}

function buildQueue(limit) {
    const progressKey = `fr_progress_${currentMode}`;
    const progress = JSON.parse(localStorage.getItem(progressKey) || '{}');
    const now = Date.now();

    let scored = currentData.map(item => {
        let p = progress[item.id] || { stage: 0, wrongCount: 0, next: 0 };
        let score = (p.stage === 0) ? 1000 : (p.wrongCount * 10 + (p.next <= now ? 50 : 0));
        return { ...item, ...p, score };
    });

    scored.sort((a, b) => b.score - a.score);
    queue = scored.slice(0, limit);
    queue.sort(() => Math.random() - 0.5);
    updateCount();
}

function render() {
    if (queue.length === 0 && wrongBuffer.length === 0) {
        dom.cn.innerText = "今日任务达成！🎉";
        dom.singleInp.style.display = 'none';
        dom.finishArea.style.display = 'block';
        return;
    }

    refillWrong();
    const current = queue[0];
    dom.cn.innerText = current.cn;
    dom.feedback.innerText = "";
    dom.cn.className = `word-cn gender-${current.gender || 'none'}`;

    recentWords.push(current.id);
    if (recentWords.length > 5) recentWords.shift();

    dom.singleInp.value = "";
    dom.singleInp.focus();
}

function handleCorrect() {
    const item = queue.shift();
    if (item.retry && item.retry > 0) {
        item.retry--;
        if (item.retry > 0) {
            showMsg("再正确一次 ✔", "success");
            wrongBuffer.push(item);
        } else {
            showMsg("Très bien !", "success");
            saveProgress(item.id, true);
        }
    } else {
        showMsg("Très bien !", "success");
        saveProgress(item.id, true);
    }

    setTimeout(() => {
        refillWrong();
        render();
        updateCount();
    }, 800);
}

function handleWrong(ans) {
    const item = queue.shift();
    showMsg(`正确答案: ${ans}`, "error");
    saveProgress(item.id, false);
    item.retry = 2;
    wrongBuffer.push(item);

    setTimeout(() => {
        refillWrong();
        render();
        updateCount();
    }, 2000);
}

function refillWrong() {
    if (wrongBuffer.length === 0) return;
    if (queue.length <= 3) {
        let index = wrongBuffer.findIndex(i => !recentWords.includes(i.id));
        if (index === -1) index = 0;
        const item = wrongBuffer.splice(index, 1)[0];
        const pos = Math.min(3, queue.length);
        queue.splice(pos, 0, item);
    }
}

function saveProgress(id, success) {
    const key = `fr_progress_${currentMode}`;
    const data = JSON.parse(localStorage.getItem(key) || '{}');
    let p = data[id] || { stage: 0, wrongCount: 0 };
    if (success) {
        p.stage = Math.min(p.stage + 1, INTERVALS.length - 1);
    } else {
        p.stage = 1;
        p.wrongCount = (p.wrongCount || 0) + 1;
    }
    p.next = Date.now() + INTERVALS[p.stage] * 60000;
    data[id] = p;
    localStorage.setItem(key, JSON.stringify(data));
}

function saveSettings() {
    localStorage.setItem(`fr_limit_${currentMode}`, dom.limitInp.value);
    location.reload();
}

function clearCurrentProgress() {
    if (confirm("确定清空当前模式的所有学习进度吗？")) {
        localStorage.removeItem(`fr_progress_${currentMode}`);
        location.reload();
    }
}

function showMsg(t, c) {
    dom.feedback.innerText = t;
    dom.feedback.className = `feedback ${c}`;
}

function updateCount() {
    dom.count.innerText = queue.length + wrongBuffer.length;
}

function openSettings() {
    dom.modal.style.display = 'block';
}

window.onclick = (e) => {
    if (e.target == dom.modal) dom.modal.style.display = 'none';
};

// 点击页面上的中文也可以随时重听
dom.cn.onclick = () => {
    if (queue.length > 0) speak(queue[0].fr);
};