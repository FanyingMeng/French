const INTERVALS = [0, 5, 30, 720, 1440, 2880, 5760, 10080];
let allWords = [], queue = [], dailyLimit = parseInt(localStorage.getItem('fr_limit')) || 10;

const dom = {
    cn: document.getElementById('display-cn'),
    singleInp: document.getElementById('single-input'),
    wordArea: document.getElementById('word-area'),
    verbArea: document.getElementById('verb-area'),
    finishArea: document.getElementById('finish-area'),
    feedback: document.getElementById('feedback'),
    count: document.getElementById('count'),
    modal: document.getElementById('modal'),
    limitInp: document.getElementById('limit-input'),
    vInputs: document.querySelectorAll('.v-input'),
    vAnswers: document.querySelectorAll('.v-ans')
};

async function init() {
    try {
        const res = await fetch('words.json');
        allWords = await res.json();
        dom.limitInp.value = dailyLimit;
        buildQueue();
        render();
    } catch (e) { dom.cn.innerText = "未找到 words.json"; }
}

function buildQueue() {
    const progress = JSON.parse(localStorage.getItem('fr_progress') || '{}');
    const now = Date.now();

    // 1. 计算每个单词的“优先级分数”
    let scoredWords = allWords.map(w => {
        let p = progress[w.id] || { stage: 0, wrongCount: 0, next: 0 };
        let score = 0;

        if (p.stage === 0) {
            score = 1000; // 从未背过的最高优先级
        } else {
            // 错误次数权重：每错一次+10分
            score += (p.wrongCount || 0) * 10;
            // 艾宾浩斯到期权重：如果到期了，增加优先级
            if (p.next <= now) score += 50;
        }
        return { ...w, score, ...p };
    });

    // 2. 排序：分数高（新词和错题）的排在前面
    scoredWords.sort((a, b) => b.score - a.score);

    // 3. 截取今日要练习的量
    queue = scoredWords.slice(0, dailyLimit);
    
    // 4. 洗牌：虽然有优先级，但组内随机乱序，防止死记位置
    queue.sort(() => Math.random() - 0.5);
    updateCount();
}

function render() {
    if (queue.length === 0) {
        dom.cn.innerText = "今日打卡成功！🎉";
        dom.wordArea.style.display = dom.verbArea.style.display = 'none';
        dom.finishArea.style.display = 'block';
        return;
    }
    dom.finishArea.style.display = 'none';
    const current = queue[0];
    dom.cn.innerText = current.cn;
    dom.feedback.innerText = "";

    if (current.type === 'verb') {
        dom.wordArea.style.display = 'none';
        dom.verbArea.style.display = 'block';
        dom.vInputs.forEach((inp, i) => { 
            inp.value = ""; inp.style.borderColor = "#eee";
            dom.vAnswers[i].style.visibility = "hidden"; 
        });
    } else {
        dom.wordArea.style.display = 'block';
        dom.verbArea.style.display = 'none';
        dom.singleInp.value = ""; dom.singleInp.focus();
    }
}

dom.singleInp.onkeypress = (e) => {
    if (e.key === 'Enter') {
        const input = dom.singleInp.value.trim().toLowerCase();
        const correct = queue[0].fr.toLowerCase();
        input === correct ? handleCorrect() : handleWrong(correct);
    }
};

function checkVerb() {
    const answers = queue[0].conjugations;
    let errors = 0;
    dom.vInputs.forEach((input, i) => {
        if (input.value.trim().toLowerCase() !== answers[i].toLowerCase()) {
            input.style.borderColor = "#ff5e57";
            errors++;
        } else { input.style.borderColor = "#2ecc71"; }
    });
    errors === 0 ? handleCorrect() : handleWrong(null);
}

dom.verbArea.onkeypress = (e) => { if(e.key === 'Enter') checkVerb(); };

function handleCorrect() {
    const word = queue.shift();
    showMsg("正确！", "success");
    saveProgress(word.id, true);
    setTimeout(() => { render(); updateCount(); }, 800);
}

function handleWrong(ansText) {
    const word = queue.shift();
    if (word.type === 'verb') {
        showMsg("变位错误", "error");
        dom.vAnswers.forEach((div, i) => {
            div.innerText = "→ " + word.conjugations[i];
            div.style.visibility = "visible";
        });
    } else {
        showMsg(`${ansText}`, "error");
    }
    saveProgress(word.id, false);
    // 错题延迟出现
    queue.splice(Math.min(3, queue.length), 0, word); 
    setTimeout(() => { render(); updateCount(); }, word.type === 'verb' ? 5000 : 2500);
}

function saveProgress(id, isSuccess) {
    const data = JSON.parse(localStorage.getItem('fr_progress') || '{}');
    let p = data[id] || { stage: 0, wrongCount: 0 };
    
    if (isSuccess) {
        p.stage = Math.min(p.stage + 1, INTERVALS.length - 1);
    } else {
        p.stage = 1;
        p.wrongCount = (p.wrongCount || 0) + 1; // 增加错误计数
    }
    p.next = Date.now() + INTERVALS[p.stage] * 60000;
    data[id] = p;
    localStorage.setItem('fr_progress', JSON.stringify(data));
}

function clearAllProgress() {
    if(confirm("确定清空所有记录重来吗？")) {
        localStorage.removeItem('fr_progress');
        location.reload();
    }
}

function showMsg(t, c) { dom.feedback.innerText = t; dom.feedback.className = `feedback ${c}`; }
function updateCount() { dom.count.innerText = queue.length; }
function openSettings() { dom.modal.style.display = 'block'; }
function saveSettings() {
    localStorage.setItem('fr_limit', dom.limitInp.value);
    location.reload();
}
window.onclick = (e) => { if(e.target == dom.modal) dom.modal.style.display = 'none'; };

init();