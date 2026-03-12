const INTERVALS = [0, 5, 30, 720, 1440, 2880, 5760, 10080];
let currentData = [], queue = [];
let dailyLimit = parseInt(localStorage.getItem('fr_limit')) || 10;
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

async function startApp(mode) {
    currentMode = mode;
    const fileName = mode === 'verb' ? 'verbs.json' : 'words.json';
    
    try {
        const res = await fetch(fileName);
        currentData = await res.json();
        
        // 彻底隐藏遮罩层
        dom.modeOverlay.style.display = 'none';
        dom.limitInp.value = dailyLimit;
        
        buildQueue();
        render();
    } catch (e) {
        dom.cn.innerText = `未找到 ${fileName}`;
    }
}

function buildQueue() {
    const storageKey = `fr_progress_${currentMode}`;
    const progress = JSON.parse(localStorage.getItem(storageKey) || '{}');
    const now = Date.now();

    let scoredItems = currentData.map(item => {
        let p = progress[item.id] || { stage: 0, wrongCount: 0, next: 0 };
        let score = 0;
        if (p.stage === 0) {
            score = 1000;
        } else {
            score += (p.wrongCount || 0) * 10;
            if (p.next <= now) score += 50;
        }
        return { ...item, score, ...p };
    });

    scoredItems.sort((a, b) => b.score - a.score);
    queue = scoredItems.slice(0, dailyLimit);
    queue.sort(() => Math.random() - 0.5);
    updateCount();
}

function render() {
    if (queue.length === 0) {
        dom.cn.innerText = "今日打卡成功！🎉";
        dom.cn.className = "word-cn gender-none";
        dom.singleInp.style.display = 'none';
        dom.finishArea.style.display = 'block';
        return;
    }
    
    dom.finishArea.style.display = 'none';
    dom.singleInp.style.display = 'block';
    const current = queue[0];
    dom.cn.innerText = current.cn;
    dom.feedback.innerText = "";

    dom.cn.classList.remove('gender-m', 'gender-f', 'gender-none');
    if (current.gender === 'm') dom.cn.classList.add('gender-m');
    else if (current.gender === 'f') dom.cn.classList.add('gender-f');
    else dom.cn.classList.add('gender-none');

    dom.singleInp.value = ""; 
    dom.singleInp.focus();
}

dom.singleInp.onkeypress = (e) => {
    if (e.key === 'Enter') {
        const input = dom.singleInp.value.trim().toLowerCase();
        const correct = queue[0].fr.toLowerCase();
        input === correct ? handleCorrect() : handleWrong(correct);
    }
};

function handleCorrect() {
    const item = queue.shift();
    showMsg("正确！", "success");
    saveProgress(item.id, true);
    setTimeout(() => { render(); updateCount(); }, 800);
}

function handleWrong(ansText) {
    const item = queue.shift();
    showMsg(`答案: ${ansText}`, "error");
    saveProgress(item.id, false);
    queue.splice(Math.min(2, queue.length), 0, item); 
    setTimeout(() => { render(); updateCount(); }, 2500);
}

function saveProgress(id, isSuccess) {
    const storageKey = `fr_progress_${currentMode}`;
    const data = JSON.parse(localStorage.getItem(storageKey) || '{}');
    let p = data[id] || { stage: 0, wrongCount: 0 };
    if (isSuccess) { p.stage = Math.min(p.stage + 1, INTERVALS.length - 1); } 
    else { p.stage = 1; p.wrongCount = (p.wrongCount || 0) + 1; }
    p.next = Date.now() + INTERVALS[p.stage] * 60000;
    data[id] = p;
    localStorage.setItem(storageKey, JSON.stringify(data));
}

function clearCurrentProgress() {
    if(confirm(`确定清空当前【${currentMode === 'word' ? '单词' : '变位'}】模式的记录吗？`)) {
        localStorage.removeItem(`fr_progress_${currentMode}`);
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