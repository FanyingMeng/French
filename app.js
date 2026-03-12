const INTERVALS = [0, 5, 30, 720, 1440, 2880, 5760, 10080];
let currentData = [], queue = [];
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

/**
 * 启动应用并根据模式加载数据
 * @param {string} mode - 'word' 或 'verb'
 */
async function startApp(mode) {
    currentMode = mode;
    const fileName = (mode === 'verb') ? 'verbs.json' : 'words.json';
    
    // 1. 获取该模式专属的每日任务数 (持久化存储)
    const modeLimitKey = `fr_limit_${currentMode}`;
    const dailyLimit = parseInt(localStorage.getItem(modeLimitKey)) || 10;
    dom.limitInp.value = dailyLimit;

    try {
        const res = await fetch(fileName);
        currentData = await res.json();
        
        // 2. 隐藏模式选择遮罩
        dom.modeOverlay.style.display = 'none';
        
        // 3. 构建学习队列
        buildQueue(dailyLimit);
        render();
    } catch (e) {
        dom.cn.innerText = `加载 ${fileName} 失败，请检查文件是否存在。`;
    }
}

/**
 * 构建学习队列：根据艾宾浩斯算法筛选
 */
function buildQueue(limit) {
    // 获取该模式专属的进度数据
    const progressKey = `fr_progress_${currentMode}`;
    const progress = JSON.parse(localStorage.getItem(progressKey) || '{}');
    const now = Date.now();

    let scoredItems = currentData.map(item => {
        let p = progress[item.id] || { stage: 0, wrongCount: 0, next: 0 };
        // 评分逻辑：新词(stage 0)权重最高，已到复习时间的词权重次之
        let score = (p.stage === 0) ? 1000 : (p.wrongCount || 0) * 10 + (p.next <= now ? 50 : 0);
        return { ...item, score, ...p };
    });

    // 排序并截取任务量
    scoredItems.sort((a, b) => b.score - a.score);
    queue = scoredItems.slice(0, limit);
    // 随机乱序，增加挑战性
    queue.sort(() => Math.random() - 0.5);
    updateCount();
}

/**
 * 渲染当前题目
 */
function render() {
    if (queue.length === 0) {
        dom.cn.innerText = "今日任务达成！🎉";
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

    // 设置性别颜色
    dom.cn.className = `word-cn gender-${current.gender || 'none'}`;
    
    dom.singleInp.value = ""; 
    dom.singleInp.focus();
}

// 监听回车键提交
dom.singleInp.onkeypress = (e) => {
    if (e.key === 'Enter') {
        const input = dom.singleInp.value.trim().toLowerCase();
        const correct = queue[0].fr.toLowerCase();
        input === correct ? handleCorrect() : handleWrong(correct);
    }
};

function handleCorrect() {
    const item = queue.shift();
    showMsg("Très bien !", "success");
    saveProgress(item.id, true);
    setTimeout(() => { render(); updateCount(); }, 800);
}

function handleWrong(ansText) {
    const item = queue.shift();
    showMsg(`正确答案: ${ansText}`, "error");
    saveProgress(item.id, false);
    // 错词插回队列前面的位置，强化记忆
    queue.splice(Math.min(2, queue.length), 0, item); 
    setTimeout(() => { render(); updateCount(); }, 2500);
}

/**
 * 持久化保存进度到 localStorage
 */
function saveProgress(id, isSuccess) {
    const progressKey = `fr_progress_${currentMode}`;
    const data = JSON.parse(localStorage.getItem(progressKey) || '{}');
    let p = data[id] || { stage: 0, wrongCount: 0 };
    
    if (isSuccess) {
        p.stage = Math.min(p.stage + 1, INTERVALS.length - 1);
    } else {
        p.stage = 1; // 错误后重置到阶段1
        p.wrongCount = (p.wrongCount || 0) + 1;
    }
    
    p.next = Date.now() + INTERVALS[p.stage] * 60000;
    data[id] = p;
    localStorage.setItem(progressKey, JSON.stringify(data));
}

/**
 * 设置：保存任务量
 */
function saveSettings() {
    const limitKey = `fr_limit_${currentMode}`;
    localStorage.setItem(limitKey, dom.limitInp.value);
    location.reload();
}

/**
 * 设置：清空当前模式进度
 */
function clearCurrentProgress() {
    if(confirm(`确定要清空【${currentMode === 'word' ? '单词' : '变位'}】模式的进度吗？\n此操作不可恢复。`)) {
        localStorage.removeItem(`fr_progress_${currentMode}`);
        location.reload();
    }
}

// 基础 UI 工具函数
function showMsg(t, c) { dom.feedback.innerText = t; dom.feedback.className = `feedback ${c}`; }
function updateCount() { dom.count.innerText = queue.length; }
function openSettings() { dom.modal.style.display = 'block'; }
window.onclick = (e) => { if(e.target == dom.modal) dom.modal.style.display = 'none'; };