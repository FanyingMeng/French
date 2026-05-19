/**
 * 法语记忆系统 - FSRS 2.0（统一节奏版 1200ms）
 */

let currentData = [];
let queue = [];
let wrongBuffer = [];
let recentWords = [];

let currentMode = null;
let currentWord = null;

let forceCorrectMode = false;

const NEXT_DELAY = 1200; // ⭐ 全局统一节奏

// ---------------- DOM ----------------
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

// ---------------- 发音 ----------------
async function speak(text) {
    if (!text) return;

    const word = text.trim().toLowerCase();
    const url = `https://www.wordreference.com/audio/fr/fr/v1/${encodeURIComponent(word)}.mp3`;

    if (window.currentAudio) {
        window.currentAudio.pause();
    }

    window.currentAudio = new Audio(url);

    try {
        const playPromise = window.currentAudio.play();
        const timeout = new Promise((_, reject) => setTimeout(reject, 800));
        await Promise.race([playPromise, timeout]);
    } catch {
        fallbackTTS(text);
    }
}

function fallbackTTS(text) {
    if (!window.speechSynthesis) return;

    window.speechSynthesis.cancel();

    const msg = new SpeechSynthesisUtterance(text);
    msg.lang = 'fr-FR';

    const voices = window.speechSynthesis.getVoices();
    const frVoices = voices.filter(v => v.lang.startsWith('fr'));

    msg.voice =
        frVoices.find(v => v.name.includes('Siri')) ||
        frVoices[0];

    msg.rate = 0.9;
    window.speechSynthesis.speak(msg);
}

// ---------------- FSRS 2.0 ----------------
function fsrsUpdate(p, grade) {
    const now = Date.now();

    const daysSince = p.due
        ? (now - p.due) / (1000 * 60 * 60 * 24)
        : 1;

    p.retrievability = Math.exp(-daysSince / (p.stability || 1));

    if (grade === 3) {
        p.stability *= 1.3;
        p.difficulty = Math.max(1, p.difficulty - 0.3);
    } else if (grade === 2) {
        p.stability *= 1.05;
    } else if (grade === 1) {
        p.stability *= 0.7;
        p.difficulty += 0.5;
    } else {
        p.stability *= 0.4;
        p.lapses++;
    }

    p.stability = Math.max(0.2, Math.min(p.stability, 30));
    p.difficulty = Math.max(1, Math.min(p.difficulty, 10));

    p.interval = Math.max(
        0.5,
        p.stability * (1 + (10 - p.difficulty) / 10)
    );

    p.due = now + p.interval * 24 * 60 * 60 * 1000;

    p.reps++;
    return p;
}

// ---------------- 保存 ----------------
function saveProgress(id, success) {
    const key = `fr_progress_${currentMode}`;
    const data = JSON.parse(localStorage.getItem(key) || '{}');

    let p = data[id] || {
        stability: 0.5,
        difficulty: 5,
        retrievability: 1,
        interval: 0.5,
        due: 0,
        lapses: 0,
        reps: 0
    };

    const grade = success ? 3 : 0;
    p = fsrsUpdate(p, grade);

    data[id] = p;
    localStorage.setItem(key, JSON.stringify(data));
}

// ---------------- 队列 ----------------
function buildQueue(limit) {
    const key = `fr_progress_${currentMode}`;
    const progress = JSON.parse(localStorage.getItem(key) || '{}');
    const now = Date.now();

    let scored = currentData.map(item => {
        let p = progress[item.id] || {
            stability: 0.5,
            difficulty: 5,
            retrievability: 1,
            interval: 0.5,
            due: 0
        };

        const overdue = Math.max(0, now - p.due);
        const overdueFactor = overdue > 0 ? 200 : 0;

        const score =
            overdueFactor +
            (1 - p.retrievability) * 80 +
            p.difficulty * 10 +
            (1 / (p.stability + 0.1)) * 30;

        return { ...item, ...p, score };
    });

    scored.sort((a, b) => b.score - a.score);

    queue = scored.slice(0, limit);
    queue.sort(() => Math.random() - 0.5);

    updateCount();
}

// ---------------- 渲染 ----------------
function render() {
    if (queue.length === 0 && wrongBuffer.length === 0) {
        dom.cn.innerText = "今日任务达成！🎉";
        dom.singleInp.style.display = "none";
        dom.finishArea.style.display = "block";
        return;
    }

    refillWrong();

    currentWord = queue[0];

    dom.cn.innerText = currentWord.cn;
    dom.feedback.innerText = "";
    dom.cn.className = `word-cn gender-${currentWord.gender || 'none'}`;

    dom.singleInp.value = "";
    dom.singleInp.focus();

    recentWords.push(currentWord.id);
    if (recentWords.length > 5) recentWords.shift();
}

// ---------------- 正确 ----------------
function handleCorrect() {
    const item = queue.shift();

    showMsg("Très bien !", "success");
    saveProgress(item.id, true);

    setTimeout(() => {
        render();
        updateCount();
    }, NEXT_DELAY); // ⭐ 统一
}

// ---------------- 错误 ----------------
function handleWrong(correct) {
    const item = queue.shift();

    saveProgress(item.id, false);

    wrongBuffer.push(item);

    showMsg(`正确答案: ${correct}`, "error");

    forceCorrectMode = true;
}

// ---------------- 错词回流 ----------------
function refillWrong() {
    if (wrongBuffer.length === 0) return;

    if (queue.length <= 3) {
        let index = wrongBuffer.findIndex(i => !recentWords.includes(i.id));
        if (index === -1) index = 0;

        const item = wrongBuffer.splice(index, 1)[0];
        queue.splice(Math.min(3, queue.length), 0, item);
    }
}

// ---------------- 输入 ----------------
dom.singleInp.onkeypress = (e) => {
    if (e.key !== "Enter") return;

    const input = dom.singleInp.value.trim().toLowerCase();

    if (!currentWord) return;

    const correct = currentWord.fr.toLowerCase();

    speak(correct);

    // ⭐ 强制订正模式
    if (forceCorrectMode) {
        if (input === correct) {
            showMsg("✔ 正确", "success");
            forceCorrectMode = false;

            saveProgress(currentWord.id, true);
            queue.shift();

            setTimeout(() => {
                render();
                updateCount();
            }, NEXT_DELAY); // ⭐ 统一
        } else {
            showMsg("❌ 再试一次", "error");
            dom.singleInp.value = "";
            dom.singleInp.focus(); 
        }
        return;
    }

    if (input === correct) {
        handleCorrect();
    } else {
        handleWrong(correct);
    }
};

// ---------------- 启动 ----------------
async function startApp(mode) {
    currentMode = mode;

    const fileName = mode === "verb" ? "verbs.json" : "words.json";

    const limitKey = `fr_limit_${mode}`;
    const limit = parseInt(localStorage.getItem(limitKey)) || 10;

    dom.limitInp.value = limit;

    const res = await fetch(fileName);
    currentData = await res.json();

    dom.modeOverlay.style.display = "none";

    buildQueue(limit);
    render();
}

// ---------------- UI ----------------
function showMsg(text, type) {
    dom.feedback.innerText = text;
    dom.feedback.className = `feedback ${type}`;
}

function updateCount() {
    dom.count.innerText = queue.length + wrongBuffer.length;
}

// ---------------- 设置 ----------------
function openSettings() {
    if (!currentMode) return;
    dom.modal.style.display = "block";
}

function closeSettings() {
    dom.modal.style.display = "none";
}

function saveSettings() {
    const val = parseInt(dom.limitInp.value) || 10;

    localStorage.setItem(`fr_limit_${currentMode}`, val);

    buildQueue(val);
    render();

    closeSettings();
}

function clearCurrentProgress() {
    localStorage.removeItem(`fr_progress_${currentMode}`);

    showMsg("已重置进度", "success");

    buildQueue(parseInt(dom.limitInp.value) || 10);
    render();

    closeSettings();
}

// ---------------- 点击发音 ----------------
dom.cn.onclick = () => {
    if (currentWord) speak(currentWord.fr);
};

// ---------------- 暴露 ----------------
window.startApp = startApp;
window.openSettings = openSettings;
window.saveSettings = saveSettings;
window.clearCurrentProgress = clearCurrentProgress;