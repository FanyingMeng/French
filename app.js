/**
 * 法语艾宾浩斯默写 - 自动跳题最终版
 */

const INTERVALS = [0, 5, 30, 720, 1440, 2880, 5760, 10080];

let currentData = [];
let queue = [];
let wrongBuffer = [];
let recentWords = [];
let currentMode = null;

let waitingNext = false;
let forceCorrectMode = false;
let currentAnswer = "";
let currentWord = null;

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

// --- 发音 ---
async function speak(text) {
    if (!text) return;

    const word = text.trim().toLowerCase();
    const url = `https://www.wordreference.com/audio/fr/fr/v1/${encodeURIComponent(word)}.mp3`;

    if (window.currentAudio) {
        window.currentAudio.pause();
        window.currentAudio = null;
    }

    window.currentAudio = new Audio(url);

    try {
        const playPromise = window.currentAudio.play();
        const timeout = new Promise((_, reject) => setTimeout(() => reject(), 800));
        await Promise.race([playPromise, timeout]);
    } catch {
        fallbackToMacFrench(text);
    }
}

function fallbackToMacFrench(text) {
    if (!window.speechSynthesis) return;

    window.speechSynthesis.cancel();

    const msg = new SpeechSynthesisUtterance(text);
    msg.lang = 'fr-FR';

    const voices = window.speechSynthesis.getVoices();
    const frVoices = voices.filter(v => v.lang.startsWith('fr'));

    const best =
        frVoices.find(v => v.name.includes('Siri')) ||
        frVoices.find(v => v.name.includes('Thomas')) ||
        frVoices.find(v => v.name.includes('Audrey')) ||
        frVoices[0];

    if (best) msg.voice = best;

    msg.rate = 0.9;
    window.speechSynthesis.speak(msg);
}

window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();

// --- Enter 控制 ---
dom.singleInp.onkeypress = (e) => {
    if (e.key !== 'Enter') return;

    const input = dom.singleInp.value.trim().toLowerCase();

    // 🔥 强制拼写模式
    if (forceCorrectMode) {
        if (input === currentAnswer) {
            showMsg("✔ 正确", "success");
            forceCorrectMode = false;

            // 👉 修复后也自动下一题
            setTimeout(() => {
                refillWrong();
                render();
                updateCount();
            }, 1200);

        } else {
            showMsg("❌ 还不对，再试一次", "error");
        }
        return;
    }

    const correct = currentWord.fr.toLowerCase();
    currentAnswer = correct;

    speak(correct);

    if (input === correct) {
        handleCorrect();
    } else {
        handleWrong(correct);
    }
};

// --- 启动 ---
async function startApp(mode) {
    dom.singleInp.setAttribute('autocomplete', 'off');
    dom.singleInp.setAttribute('spellcheck', 'false');

    currentMode = mode;

    const fileName = (mode === 'verb') ? 'verbs.json' : 'words.json';
    const limitKey = `fr_limit_${mode}`;
    const dailyLimit = parseInt(localStorage.getItem(limitKey)) || 10;

    dom.limitInp.value = dailyLimit;

    const res = await fetch(fileName);
    currentData = await res.json();

    dom.modeOverlay.style.display = 'none';

    buildQueue(dailyLimit);
    render();
}

// --- 队列 ---
function buildQueue(limit) {
    const key = `fr_progress_${currentMode}`;
    const progress = JSON.parse(localStorage.getItem(key) || '{}');
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

// --- 渲染 ---
function render() {
    if (queue.length === 0 && wrongBuffer.length === 0) {
        dom.cn.innerText = "今日任务达成！🎉";
        dom.singleInp.style.display = 'none';
        dom.finishArea.style.display = 'block';
        return;
    }

    refillWrong();

    const current = queue[0];
    currentWord = current;

    dom.cn.innerText = current.cn;
    dom.feedback.innerText = "";
    dom.cn.className = `word-cn gender-${current.gender || 'none'}`;

    dom.singleInp.value = "";
    dom.singleInp.focus();

    recentWords.push(current.id);
    if (recentWords.length > 5) recentWords.shift();
}

// --- 正确（🔥已改自动跳题） ---
function handleCorrect() {
    const item = queue.shift();

    if (item.retry && item.retry > 0) {
        item.retry--;

        if (item.retry > 0) {
            showMsg("再正确一次 ✔", "success");
            wrongBuffer.push(item);
            return;
        }
    }

    showMsg("Très bien !", "success");
    saveProgress(item.id, true);

    // 🔥 自动下一题
    setTimeout(() => {
        refillWrong();
        render();
        updateCount();
    }, 1200);
}

// --- 错误 ---
function handleWrong(ans) {
    const item = queue.shift();

    saveProgress(item.id, false);
    item.retry = 2;
    wrongBuffer.push(item);

    showMsg(`正确答案: ${ans}（请重新输入）`, "error");

    forceCorrectMode = true;
}

// --- 错词回流 ---
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

// --- 保存 ---
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

// --- UI ---
function showMsg(t, c) {
    dom.feedback.innerText = t;
    dom.feedback.className = `feedback ${c}`;
}

function updateCount() {
    dom.count.innerText = queue.length + wrongBuffer.length;
}

// 🔊 点击朗读（已修复）
dom.cn.onclick = () => {
    if (currentWord) speak(currentWord.fr);
};