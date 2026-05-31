// ============================================================
// DNA MMO - ПОЛНАЯ КЛИЕНТСКАЯ ЧАСТЬ (С СОХРАНЕНИЕМ СТАТУСА КВЕСТОВ)
// ============================================================

// ============================================================
// CONFIG
// ============================================================
const API_URL = 'https://serv-production-765e.up.railway.app';

// ============================================================
// ЗАПРЕТ КОНТЕКСТНОГО МЕНЮ И ВЫДЕЛЕНИЯ
// ============================================================
document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    return false;
});

document.addEventListener('selectstart', (e) => {
    e.preventDefault();
    return false;
});

document.addEventListener('dragstart', (e) => {
    e.preventDefault();
    return false;
});

// ============================================================
// ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
// ============================================================
let state = {
    token: null,
    user: null,
    inventory: [],
    incomePerHour: 0,
    adsCooldown: 0,
    isLoading: false,
    serverBalance: 0,
    lastServerSync: 0,
    visualTicker: null
};

let intervals = {
    adsTimer: null,
    specialQuests: null,
    leaderboard: null,
    marketplace: null
};

let activeQuestTimers = new Map();
let currentLeaderboardController = null;
let isMarketplaceTabActive = false;

// КЭШИ
let leaderboardCache = { data: null, expiresAt: 0 };
let marketplaceCache = { data: null, hash: null, expiresAt: 0 };

// Переменные для депозита
let currentPaymentMemo = null;
let currentPaymentAmount = null;

// Хранилище статусов квестов (pending, available, claimed)
let questStatuses = new Map();

// Ключ для хранения в localStorage
const QUESTS_STORAGE_KEY = 'dna_mmo_quests_status';

// ============================================================
// GAME DATA
// ============================================================
let CREATURES = [];
let CAPSULE_COSTS = { basic: 500, premium: 2000 };
let RARITY_WEIGHTS = {
    basic: { common: 80, uncommon: 20, rare: 0, epic: 0, legendary: 0 },
    premium: { common: 60, uncommon: 30, rare: 10, epic: 2, legendary: 1 }
};
let AD_REWARD = 100;
let AD_COOLDOWN = 60;
let UPGRADE_BASE_COST = 300;
let UPGRADE_MULTIPLIER = 1.5;
let MAX_INVENTORY_SLOTS = 50;
let SPECIAL_QUESTS = [];

const RARITY_COLORS = {
    common: '#94a3b8', uncommon: '#22c55e', rare: '#3b82f6',
    epic: '#a855f7', legendary: '#f59e0b', mythic: '#ef4444'
};
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

// ============================================================
// ВИЗУАЛЬНЫЙ ТИКЕР
// ============================================================
let visualTickerInterval = null;

function startVisualTicker() {
    if (visualTickerInterval) clearInterval(visualTickerInterval);
    
    visualTickerInterval = setInterval(() => {
        if (document.hidden || !state.user) return;
        
        const visualBalance = getVisualBalance();
        
        const balanceEl = document.getElementById('balanceDisplay');
        if (balanceEl) balanceEl.textContent = formatBalance(visualBalance);
        
        const walletBalanceEl = document.getElementById('walletBalance');
        if (walletBalanceEl) walletBalanceEl.textContent = formatBalance(visualBalance);
    }, 1000);
    
    state.visualTicker = { cancel: () => clearInterval(visualTickerInterval) };
}

function formatBalance(n) {
    const absN = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    return sign + absN.toFixed(3);
}

function getVisualBalance() {
    if (!state.user || !state.lastServerSync) return state.serverBalance;
    const elapsedSeconds = (Date.now() - state.lastServerSync) / 1000;
    const earned = (state.incomePerHour / 3600) * elapsedSeconds;
    return state.serverBalance + earned;
}

function updateServerSnapshot(newBalance, newIncomePerHour, newLastPassiveIncome) {
    state.serverBalance = newBalance;
    state.incomePerHour = newIncomePerHour;
    state.lastServerSync = newLastPassiveIncome ? new Date(newLastPassiveIncome).getTime() : Date.now();
    if (state.user) state.user.balance = newBalance;
}

let collectIncomeTimer = null;
async function startCollectIncomeLoop() {
    if (collectIncomeTimer) clearInterval(collectIncomeTimer);
    collectIncomeTimer = setInterval(async () => {
        if (document.hidden || !state.token) return;
        try {
            const res = await apiRequest('POST', '/api/game/collect-income');
            if (res && res.success) {
                updateServerSnapshot(res.balance, res.incomePerHour, res.lastPassiveIncome);
                if (state.user) state.user.balance = res.balance;
            }
        } catch (e) {}
    }, 5 * 60 * 1000);
}

// ============================================================
// API ЗАПРОСЫ
// ============================================================
let pendingRequests = new Map();

async function apiRequest(method, path, body = null, signal = null) {
    const key = `${method}:${path}:${JSON.stringify(body)}`;
    if (pendingRequests.has(key)) return pendingRequests.get(key);
    
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal
    };
    if (state.token) opts.headers['Authorization'] = `Bearer ${state.token}`;
    if (body) opts.body = JSON.stringify(body);
    
    const promise = (async () => {
        try {
            const res = await fetch(API_URL + path, opts);
            const data = await res.json();
            if (!res.ok) {
                console.warn(`API ${path} error:`, data.message);
                if (res.status === 401 || res.status === 403) {
                    localStorage.removeItem('token');
                    state.token = null;
                    showToast('Сессия истекла', '❌');
                }
            }
            return data;
        } catch (e) {
            if (e.name === 'AbortError') return null;
            console.error(`API ${path} fetch error:`, e);
            showToast('Ошибка соединения', '❌');
            return { success: false, message: 'Нет соединения' };
        } finally {
            setTimeout(() => pendingRequests.delete(key), 100);
        }
    })();
    
    pendingRequests.set(key, promise);
    return promise;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function getCreature(id) { return CREATURES.find(c => c.id === id); }
function formatNum(n) {
    const absN = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (absN >= 1000000) return sign + (absN/1000000).toFixed(1) + 'M';
    if (absN >= 1000) return sign + (absN/1000).toFixed(1) + 'K';
    return sign + Math.floor(absN).toString();
}
function getUsedSlots() {
    return state.inventory.reduce((s, i) => s + i.count, 0);
}
function getUpgradeCost() {
    return Math.floor(UPGRADE_BASE_COST * Math.pow(UPGRADE_MULTIPLIER, state.user?.inventoryUpgrades || 0));
}
function canMerge(creatureId) {
    const item = state.inventory.find(i => i.creatureId === creatureId);
    const c = getCreature(creatureId);
    return item && item.count >= 3 && c && c.rarity !== 'legendary' && c.rarity !== 'mythic';
}
function getLevelTitle(lvl) {
    const level = lvl || 1;
    if (level >= 20) return 'God Scientist';
    if (level >= 15) return 'DNA Master';
    if (level >= 10) return 'Geneticist';
    if (level >= 5) return 'Lab Expert';
    if (level >= 3) return 'Biologist';
    return 'Researcher';
}
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getIconHtml(creature, addShadow = false, shadowColor = null) {
    if (!creature) return '🧬';
    const icon = creature.icon;
    if (icon && (icon.startsWith('http') || icon.startsWith('/') || icon.startsWith('Images/'))) {
        const shadowStyle = addShadow && shadowColor ? `filter:drop-shadow(0 0 16px ${shadowColor});` : '';
        return `<img src="${icon}" alt="${escapeHtml(creature.name)}" loading="lazy" style="object-fit:contain;${shadowStyle}" class="card-icon-img" onerror="this.style.display='none'">`;
    }
    return icon || '🧬';
}

async function loadGameConfig() {
    const res = await apiRequest('GET', '/api/game/config');
    if (res && res.success) {
        const cfg = res.config;
        CAPSULE_COSTS = cfg.capsuleCosts || { basic: 500, premium: 2000 };
        RARITY_WEIGHTS = cfg.capsuleRarities || RARITY_WEIGHTS;
        AD_REWARD = cfg.adReward || 100;
        AD_COOLDOWN = cfg.adCooldown || 60;
        UPGRADE_BASE_COST = cfg.upgradeBaseCost || 300;
        UPGRADE_MULTIPLIER = cfg.upgradeMultiplier || 1.5;
        MAX_INVENTORY_SLOTS = cfg.limits?.maxInventorySlots || 50;
        SPECIAL_QUESTS = cfg.specialQuests || [];
        return true;
    }
    return false;
}

async function loadCreaturesFromServer() {
    const res = await apiRequest('GET', '/api/game/creatures');
    if (res && res.success && res.creatures) {
        CREATURES = res.creatures;
        console.log(`✅ Загружено ${CREATURES.length} существ`);
        return true;
    }
    return false;
}

async function getCurrentIncome() {
    let income = 0;
    for (const item of state.inventory) {
        const c = getCreature(item.creatureId);
        if (c) income += c.incomeBase * item.count;
    }
    return income;
}

// ============================================================
// TELEGRAM WEBAPP INIT
// ============================================================
function clearAllIntervals() {
    if (intervals.adsTimer) clearInterval(intervals.adsTimer);
    if (intervals.specialQuests) clearInterval(intervals.specialQuests);
    if (intervals.leaderboard) clearInterval(intervals.leaderboard);
    if (intervals.marketplace) clearInterval(intervals.marketplace);
    if (state.visualTicker) state.visualTicker.cancel();
    if (collectIncomeTimer) clearInterval(collectIncomeTimer);
    collectIncomeTimer = null;
    for (const timer of activeQuestTimers.values()) clearTimeout(timer);
    activeQuestTimers.clear();
    clearAllQuestTimers();
    if (window.questTimerInterval) clearInterval(window.questTimerInterval);
}

function startOptimizedIntervals() {
    intervals.leaderboard = setInterval(() => {
        if (!document.hidden) renderLeaderboard();
    }, 5 * 60 * 1000);
    
    intervals.specialQuests = setInterval(() => {
        if (!document.hidden) {
            loadGameConfig();
            renderSpecialQuests();
        }
    }, 5 * 60 * 1000);
    
    intervals.marketplace = setInterval(() => {
        if (!document.hidden && isMarketplaceTabActive) {
            renderMarketplaceBuy();
        }
    }, 10 * 1000);
    
    intervals.adsTimer = setInterval(updateAdsTimer, 1000);
}

function handleVisibilityChange() {
    if (document.hidden) {
        if (intervals.marketplace) clearInterval(intervals.marketplace);
        intervals.marketplace = null;
    } else {
        apiRequest('POST', '/api/game/collect-income').then(res => {
            if (res && res.success) {
                updateServerSnapshot(res.balance, res.incomePerHour, res.lastPassiveIncome);
                if (state.user) {
                    state.user.balance = res.balance;
                    updateHeader();
                }
                if (res.earned > 1) {
                    showToast(`+${formatNum(res.earned)} MMO получено`, '💰');
                }
            }
        }).catch(err => {
            console.warn('collect-income error on visibility change:', err);
        });

        if (isMarketplaceTabActive) {
            renderMarketplaceBuy();
            intervals.marketplace = setInterval(() => {
                if (!document.hidden && isMarketplaceTabActive) {
                    renderMarketplaceBuy();
                }
            }, 10 * 1000);
        }
    }
}

async function refreshUserProfile() {
    const res = await apiRequest('GET', '/api/user/profile');
    if (res && res.success) {
        state.user = res.user;
        state.inventory = res.inventory || [];
        state.incomePerHour = res.incomePerHour || 0;
        
        updateServerSnapshot(state.user.balance, state.incomePerHour, res.lastPassiveIncome);
        
        updateHeader();
        renderCards();
        updateFriendRewardButtons();
        
        const friendCountDisplay = document.getElementById('friendCountDisplay');
        if (friendCountDisplay && state.user) {
            friendCountDisplay.textContent = `${state.user.referralCount || 0} друзей 5+ уровня`;
        }
        
        if (res.offlineEarned > 10) {
            setTimeout(() => showToast(`+${formatNum(res.offlineEarned)} MMO offline!`, '💤'), 1000);
        }
    }
}

async function initTelegramApp() {
    clearAllIntervals();
    showLoadingScreen(true);

    const tg = window.Telegram?.WebApp;
    
    if (tg) {
        tg.ready();
        tg.expand();
        
        if (tg.enableClosingConfirmation) {
            tg.enableClosingConfirmation();
        }
        
        if (tg.requestFullscreen) {
            try {
                await tg.requestFullscreen();
                console.log('✅ Fullscreen requested');
            } catch (e) {
                console.log('Fullscreen request failed:', e);
            }
        }
        
        setTimeout(() => {
            const top = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tg-safe-area-inset-top')) || 55;
            document.querySelector('.header').style.paddingTop = (top + 40) + 'px';
        }, 400);
        
        if (tg.disableVerticalSwipes) {
            tg.disableVerticalSwipes();
        }
        
        setTimeout(() => {
            if (tg && typeof tg.expand === 'function') {
                tg.expand();
            }
        }, 500);
        
        tg.setHeaderColor('#080b14');
        tg.setBackgroundColor('#080b14');
        
        console.log('✅ Telegram WebApp initialized');
    } else {
        console.warn('⚠️ Telegram WebApp not available');
    }

    let initData = tg?.initData || '';
    let tgUser = tg?.initDataUnsafe?.user;
    
    let referralCode = null;
    
    if (tg?.initDataUnsafe?.start_param) {
        referralCode = tg.initDataUnsafe.start_param;
        console.log('📎 Реферальный код из start_param:', referralCode);
    }
    
    const urlParams = new URLSearchParams(window.location.search);
    if (!referralCode && urlParams.get('startapp')) {
        referralCode = urlParams.get('startapp');
        console.log('📎 Реферальный код из startapp URL:', referralCode);
    }
    
    if (!referralCode && urlParams.get('ref')) {
        referralCode = urlParams.get('ref');
        console.log('📎 Реферальный код из ref URL:', referralCode);
    }

    if (!initData && window.location.hostname === 'localhost') {
        console.warn('⚠️ Dev mode: using mock Telegram user');
        const mockUser = { id: 123456789, first_name: 'Test', username: 'testuser' };
        initData = `user=${encodeURIComponent(JSON.stringify(mockUser))}&hash=devhash`;
        tgUser = mockUser;
    }

    if (!initData) {
        showLoadingScreen(false);
        showToast('Открой игру через Telegram!', '⚠️');
        return;
    }

    const loginRes = await apiRequest('POST', '/api/auth/login', { initData, referralCode });

    if (!loginRes.success) {
        showLoadingScreen(false);
        showToast(loginRes.message || 'Ошибка авторизации', '❌');
        return;
    }

    state.token = loginRes.token;
    state.user = loginRes.user;
    state.inventory = loginRes.inventory || [];

    await loadGameConfig();
    await loadCreaturesFromServer();
    
    // Загружаем сохраненные статусы квестов
    loadQuestStatusesFromStorage();

    updatePlayerInfo();

    const profileRes = await apiRequest('GET', '/api/user/profile');
    if (profileRes.success) {
        state.user = profileRes.user;
        state.inventory = profileRes.inventory || [];
        state.incomePerHour = profileRes.incomePerHour || 0;
        
        updateServerSnapshot(state.user.balance, state.incomePerHour, profileRes.lastPassiveIncome);

        if (profileRes.offlineEarned > 10) {
            setTimeout(() => showToast(`+${formatNum(profileRes.offlineEarned)} MMO offline!`, '💤'), 1000);
        }
    }

    showLoadingScreen(false);
    renderAll();

    startVisualTicker();
    startCollectIncomeLoop();
    startOptimizedIntervals();
    
    document.addEventListener('visibilitychange', handleVisibilityChange);

    if (loginRes.isNewUser && referralCode) {
        setTimeout(() => showToast('🎉 Добро пожаловать! Реферальный бонус: 2% от депозитов друга', '🎁'), 800);
    } else if (loginRes.isNewUser) {
        setTimeout(() => showToast('Open a DNA Capsule to start!', '🧬'), 800);
    }
    
    if (state.user) {
        console.log('👥 Referral info:', {
            code: state.user.referralCode,
            count: state.user.referralCount,
            referredBy: state.user.referredBy
        });
    }
    
    setTimeout(() => checkActiveRequests(), 1000);
    
    updateAdsStatus();
    
    document.querySelectorAll('img').forEach(img => {
        img.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            return false;
        });
        img.addEventListener('touchstart', (e) => {
            if (e.touches.length > 1) {
                e.preventDefault();
            }
        });
    });
}

// ============================================================
// LOADING SCREEN
// ============================================================
function showLoadingScreen(show) {
    let el = document.getElementById('loadingScreen');
    
    if (!el && show) {
        el = document.createElement('div');
        el.id = 'loadingScreen';
        el.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100%;
            height: 100vh;
            height: 100dvh;
            background: url('load.webp') center/cover no-repeat;
            z-index: 9999;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-end;
            padding-bottom: 12vh;
        `;
        
        el.innerHTML = `
            <style>
                .loading-bar-container {
                    width: 200px;
                    height: 4px;
                    background: rgba(168,85,247,0.2);
                    border-radius: 4px;
                    overflow: hidden;
                }
                .loading-bar-fill {
                    width: 0%;
                    height: 100%;
                    background: linear-gradient(90deg, #a855f7, #06b6d4);
                    border-radius: 4px;
                    transition: width 0.3s ease;
                }
                .loading-text {
                    font-family: 'Orbitron', monospace;
                    font-size: 12px;
                    font-weight: 600;
                    color: #a855f7;
                    text-transform: uppercase;
                    letter-spacing: 3px;
                    margin-top: 16px;
                }
                .loading-percent {
                    font-family: 'Orbitron', monospace;
                    font-size: 11px;
                    color: #94a3b8;
                    margin-top: 6px;
                }
            </style>
            
            <div class="loading-bar-container">
                <div class="loading-bar-fill" id="loadingBarFill"></div>
            </div>
            <div class="loading-text">LOADING</div>
            <div class="loading-percent" id="loadingPercent">0%</div>
        `;
        
        document.body.appendChild(el);
        
        // Анимация роста полосы
        let percent = 0;
        const fillEl = document.getElementById('loadingBarFill');
        const percentEl = document.getElementById('loadingPercent');
        
        const interval = setInterval(() => {
            if (percent < 90) {
                percent += Math.random() * 10;
                percent = Math.min(percent, 90);
                if (fillEl) fillEl.style.width = percent + '%';
                if (percentEl) percentEl.textContent = Math.floor(percent) + '%';
            }
        }, 200);
        el.dataset.percentInterval = interval;
    } 
    else if (el && !show) {
        if (el.dataset.percentInterval) {
            clearInterval(parseInt(el.dataset.percentInterval));
        }
        const fillEl = document.getElementById('loadingBarFill');
        const percentEl = document.getElementById('loadingPercent');
        if (fillEl) fillEl.style.width = '100%';
        if (percentEl) percentEl.textContent = '100%';
        
        setTimeout(() => {
            el.style.transition = 'opacity 0.5s ease';
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 500);
        }, 200);
    }
}
// ============================================
// PVP СИСТЕМА
// ============================================

let pvpPollingInterval = null;
let pvpQueueStatus = false;
let pvpActiveMatch = null;

// Получить PvP статистику
async function loadPvPStats() {
    const res = await apiRequest('GET', '/api/pvp/stats');
    if (res && res.success) {
        return res.stats;
    }
    return null;
}

// Рендер PvP вкладки
async function renderPvP() {
    const container = document.getElementById('tab-pvp');
    if (!container) return;
    
    const stats = await loadPvPStats();
    if (!stats) {
        container.innerHTML = '<div class="empty-grid">Ошибка загрузки PvP данных</div>';
        return;
    }
    
    const nextLeaguePoints = stats.nextLeaguePoints || stats.leaguePoints;
    const progressPercent = ((stats.leaguePoints - (stats.leaguePoints - (nextLeaguePoints - stats.leaguePoints))) / (nextLeaguePoints - (stats.leaguePoints - (nextLeaguePoints - stats.leaguePoints)))) * 100;
    
    const leagueInfo = {
        name: stats.leagueName,
        icon: stats.leagueIcon,
        color: stats.leagueColor,
        entryFee: stats.entryFee
    };
    
    container.innerHTML = `
        <div class="pvp-container">
            <!-- League Card -->
            <div class="pvp-league-card" style="border-color: ${leagueInfo.color}">
                <div class="league-icon">${leagueInfo.icon}</div>
                <div class="league-name" style="color: ${leagueInfo.color}">${leagueInfo.name} лига</div>
                <div class="league-points">
                    ⭐ <span>${stats.leaguePoints}</span> / ${stats.nextLeaguePoints || '∞'}
                </div>
                <div class="league-progress">
                    <div class="progress-fill" style="width: ${Math.min(100, progressPercent)}%; background: ${leagueInfo.color}"></div>
                </div>
                <div class="entry-fee">💰 Взнос за бой: ${leagueInfo.entryFee} MMO</div>
            </div>
            
            <!-- PvP Button -->
            <button class="pvp-find-btn" id="pvpFindBtn" onclick="togglePvPQueue()">
                <i class="fa-solid fa-sword"></i> НАЙТИ ПРОТИВНИКА
            </button>
            
            <!-- Queue Status (hidden by default) -->
            <div class="pvp-queue-status" id="pvpQueueStatus" style="display: none">
                <div class="queue-spinner"></div>
                <div>Поиск соперника...</div>
                <div class="queue-timer" id="queueTimer">60</div>
                <button class="queue-leave-btn" onclick="leavePvPQueue()">Отмена</button>
            </div>
            
            <!-- Stats Grid -->
            <div class="pvp-stats-grid">
                <div class="pvp-stat-card">
                    <div class="pvp-stat-value">${stats.wins}</div>
                    <div class="pvp-stat-label">Побед</div>
                </div>
                <div class="pvp-stat-card">
                    <div class="pvp-stat-value">${stats.losses}</div>
                    <div class="pvp-stat-label">Поражений</div>
                </div>
                <div class="pvp-stat-card">
                    <div class="pvp-stat-value">${stats.winRate}%</div>
                    <div class="pvp-stat-label">Винрейт</div>
                </div>
                <div class="pvp-stat-card">
                    <div class="pvp-stat-value">${formatNum(stats.totalWonMMO)}</div>
                    <div class="pvp-stat-label">Выиграно MMO</div>
                </div>
                <div class="pvp-stat-card">
                    <div class="pvp-stat-value">${stats.currentStreak}</div>
                    <div class="pvp-stat-label">Текущая серия</div>
                </div>
                <div class="pvp-stat-card">
                    <div class="pvp-stat-value">${stats.bestStreak}</div>
                    <div class="pvp-stat-label">Лучшая серия</div>
                </div>
                <div class="pvp-stat-card">
                    <div class="pvp-stat-value">${stats.dailyBattles}/${stats.maxDailyBattles}</div>
                    <div class="pvp-stat-label">Боёв сегодня</div>
                </div>
                <div class="pvp-stat-card">
                    <div class="pvp-stat-value">${formatNum(stats.totalLostMMO)}</div>
                    <div class="pvp-stat-label">Проиграно MMO</div>
                </div>
            </div>
            
            <!-- Leaderboard -->
            <div class="section-title">🏆 Топ игроков ${leagueInfo.name} лиги</div>
            <div class="pvp-leaderboard-list" id="pvpLeaderboardList">
                <div style="text-align:center; padding:20px; color:var(--text3)">Загрузка...</div>
            </div>
            
            <!-- History -->
            <div class="section-title">📜 История боёв</div>
            <div class="pvp-history-list" id="pvpHistoryList">
                <div style="text-align:center; padding:20px; color:var(--text3)">Загрузка...</div>
            </div>
        </div>
    `;
    
    // Загружаем лидерборд и историю
    loadPvPLeaderboard(stats.league);
    loadPvPHistory();
    
    // Запускаем polling для проверки статуса
    startPvPPolling();
}

// Загрузить PvP лидерборд
async function loadPvPLeaderboard(league) {
    const res = await apiRequest(
    'GET',
    `/api/pvp/leaderboard?league=${league}`
);
    if (res && res.success && res.leaders) {
        const listEl = document.getElementById('pvpLeaderboardList');
        if (listEl) {
            if (res.leaders.length === 0) {
                listEl.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text3)">Нет игроков в лиге</div>';
            } else {
                listEl.innerHTML = res.leaders.map(leader => `
                    <div class="pvp-leaderboard-item">
                        <div class="lb-rank-icon">${leader.rank === 1 ? '🥇' : leader.rank === 2 ? '🥈' : leader.rank === 3 ? '🥉' : leader.rank}</div>
                        <div class="lb-player-info">
                            <div class="lb-player-name">${escapeHtml(leader.username)}</div>
                            <div class="lb-player-level">Ур. ${leader.level}</div>
                        </div>
                        <div class="lb-league">
                            ${leader.leagueIcon} ${leader.league}
                        </div>
                        <div class="lb-points">${leader.points} ⭐</div>
                    </div>
                `).join('');
            }
        }
    }
}

// Загрузить историю боёв
async function loadPvPHistory() {
    const res = await apiRequest('GET', '/api/pvp/history');
    if (res && res.success && res.history) {
        const listEl = document.getElementById('pvpHistoryList');
        if (listEl) {
            if (res.history.length === 0) {
                listEl.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text3)">Нет боёв</div>';
            } else {
                listEl.innerHTML = res.history.map(match => `
                    <div class="pvp-history-item ${match.isWinner ? 'pvp-history-win' : 'pvp-history-lose'}">
                        <div>
                            <div class="history-opponent">${escapeHtml(match.opponentName)}</div>
                            <div class="history-result ${match.isWinner ? 'history-result-win' : 'history-result-lose'}">
                                ${match.isWinner ? '🏆 Победа' : '💀 Поражение'}
                            </div>
                        </div>
                        <div class="history-amount">
                            ${match.isWinner ? `+${match.winnerGets}` : `-${match.betAmount}`} MMO
                        </div>
                    </div>
                `).join('');
            }
        }
    }
}

// Переключение очереди PvP
async function togglePvPQueue() {
    if (pvpQueueStatus) {
        await leavePvPQueue();
    } else {
        await joinPvPQueue();
    }
}

// Вступить в очередь
async function joinPvPQueue() {
    const res = await apiRequest('POST', '/api/pvp/queue/join');
    if (res && res.success) {
        pvpQueueStatus = true;
        updatePvPButton(true);
        showQueueStatus(true);
        startQueueTimer();
        startPvPPolling();
    } else {
        showToast(res?.message || 'Ошибка входа в очередь', '❌');
    }
}

// Выйти из очереди
async function leavePvPQueue() {
    const res = await apiRequest('POST', '/api/pvp/queue/leave');
    if (res && res.success) {
        pvpQueueStatus = false;
        updatePvPButton(false);
        showQueueStatus(false);
        stopQueueTimer();
    }
}

// Обновить кнопку PvP
function updatePvPButton(inQueue) {
    const btn = document.getElementById('pvpFindBtn');
    if (btn) {
        if (inQueue) {
            btn.innerHTML = '<i class="fa-solid fa-clock"></i> В ОЧЕРЕДИ...';
            btn.classList.add('in-queue');
        } else {
            btn.innerHTML = '<i class="fa-solid fa-sword"></i> НАЙТИ ПРОТИВНИКА';
            btn.classList.remove('in-queue');
        }
    }
}

// Показать/скрыть статус очереди
function showQueueStatus(show) {
    const statusEl = document.getElementById('pvpQueueStatus');
    if (statusEl) {
        statusEl.style.display = show ? 'block' : 'none';
    }
}

// Таймер очереди
let queueTimerInterval = null;

function startQueueTimer() {
    if (queueTimerInterval) clearInterval(queueTimerInterval);
    let seconds = 60;
    const timerEl = document.getElementById('queueTimer');
    if (timerEl) timerEl.textContent = seconds;
    
    queueTimerInterval = setInterval(() => {
        seconds--;
        if (timerEl) timerEl.textContent = seconds;
        if (seconds <= 0) {
            clearInterval(queueTimerInterval);
            if (pvpQueueStatus) {
                leavePvPQueue();
                showToast('Время поиска истекло. Попробуйте снова.', '⏳');
            }
        }
    }, 1000);
}

function stopQueueTimer() {
    if (queueTimerInterval) {
        clearInterval(queueTimerInterval);
        queueTimerInterval = null;
    }
}

// Polling для проверки статуса
function startPvPPolling() {
    if (pvpPollingInterval) clearInterval(pvpPollingInterval);
    
    pvpPollingInterval = setInterval(async () => {
        const res = await apiRequest('GET', '/api/pvp/queue/status');
        if (res && res.success) {
            // Проверяем наличие активного матча
            if (res.activeMatch && res.activeMatch.status === 'ready') {
                if (!pvpActiveMatch) {
                    pvpActiveMatch = res.activeMatch;
                    showMatchFoundModal(res.activeMatch);
                }
            } else {
                pvpActiveMatch = null;
            }
            
            // Обновляем статус очереди
            if (pvpQueueStatus !== res.inQueue) {
                pvpQueueStatus = res.inQueue;
                updatePvPButton(pvpQueueStatus);
                showQueueStatus(pvpQueueStatus);
                if (pvpQueueStatus) {
                    startQueueTimer();
                } else {
                    stopQueueTimer();
                }
            }
        }
    }, 3000);
}

// Показать модальное окно найденного матча
let matchTimerInterval = null;

function showMatchFoundModal(match) {
    // Закрываем существующее модальное окно
    const existingModal = document.querySelector('.match-found-modal');
    if (existingModal) existingModal.remove();
    
    const modalHtml = `
        <div class="match-found-modal" id="matchFoundModal">
            <div class="match-found-card">
                <div class="match-found-icon">⚔️</div>
                <div class="match-found-title">СОПЕРНИК НАЙДЕН!</div>
                <div class="match-opponent">
                    <div style="font-size: 14px; color: var(--text2);">Ваш противник</div>
                    <div style="font-size: 20px; font-weight: 700; margin: 8px 0;">Ожидание...</div>
                </div>
                <div class="match-bet">
                    Ставка: <span class="match-bet-amount">${match.betAmount} MMO</span>
                </div>
                <div class="match-timer" id="matchTimer">
                    Принять бой за: <span id="matchSeconds">30</span> секунд
                </div>
                <div class="match-actions">
                    <button class="match-accept-btn" onclick="acceptMatch('${match.id}')">
                        <i class="fa-solid fa-check"></i> ПРИНЯТЬ БОЙ
                    </button>
                    <button class="match-decline-btn" onclick="declineMatch('${match.id}')">
                        <i class="fa-solid fa-times"></i> ОТКАЗ
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Таймер на принятие боя
    let seconds = 30;
    const secondsEl = document.getElementById('matchSeconds');
    
    if (matchTimerInterval) clearInterval(matchTimerInterval);
    matchTimerInterval = setInterval(() => {
        seconds--;
        if (secondsEl) secondsEl.textContent = seconds;
        if (seconds <= 0) {
            clearInterval(matchTimerInterval);
            const modal = document.getElementById('matchFoundModal');
            if (modal) modal.remove();
            showToast('Время на принятие боя истекло', '⏳');
            pvpActiveMatch = null;
        }
    }, 1000);
}

// Принять матч
async function acceptMatch(matchId) {
    clearInterval(matchTimerInterval);
    const modal = document.getElementById('matchFoundModal');
    if (modal) modal.remove();
    
    showToast('Бой начинается...', '⚔️');
    
    const res = await apiRequest('POST', '/api/pvp/accept-match', { matchId });
    if (res && res.success) {
        showBattleAnimation(res.result);
    } else {
        showToast(res?.message || 'Ошибка боя', '❌');
    }
    
    pvpActiveMatch = null;
    pvpQueueStatus = false;
    updatePvPButton(false);
    showQueueStatus(false);
    stopQueueTimer();
    
    // Обновляем статистику
    setTimeout(() => {
        renderPvP();
    }, 2000);
}

// Отказаться от матча
async function declineMatch(matchId) {
    clearInterval(matchTimerInterval);
    const modal = document.getElementById('matchFoundModal');
    if (modal) modal.remove();
    
    const res = await apiRequest('POST', '/api/pvp/cancel-match', { matchId });
    if (res && res.success) {
        showToast(res.message, '⚠️');
    }
    
    pvpActiveMatch = null;
}

// Анимация боя
function showBattleAnimation(result) {
    const modalHtml = `
        <div class="battle-animation" id="battleAnimation">
            <div class="battle-players">
                <div class="battle-player">
                    <div style="font-size: 48px;">👤</div>
                    <div class="battle-player-name">ВЫ</div>
                    <div class="battle-player-power">⚔️ Сила: ${result.power1}</div>
                    <div class="battle-power-bar">
                        <div class="battle-power-fill" style="width: ${result.winChance}%; background: ${result.winner ? '#22c55e' : '#ef4444'}"></div>
                    </div>
                </div>
                <div class="battle-versus">VS</div>
                <div class="battle-player">
                    <div style="font-size: 48px;">👾</div>
                    <div class="battle-player-name">${escapeHtml(result.loserName)}</div>
                    <div class="battle-player-power">⚔️ Сила: ${result.power2}</div>
                    <div class="battle-power-bar">
                        <div class="battle-power-fill" style="width: ${100 - result.winChance}%; background: ${!result.winner ? '#22c55e' : '#ef4444'}"></div>
                    </div>
                </div>
            </div>
            <div class="battle-result">
                <div class="battle-result-text ${result.winner ? 'battle-result-win' : 'battle-result-lose'}">
                    ${result.winner ? '🏆 ПОБЕДА! 🏆' : '💀 ПОРАЖЕНИЕ 💀'}
                </div>
                ${result.winner ? `
                    <div class="battle-reward">
                        +${result.winnerGets} MMO
                    </div>
                    <div class="battle-reward" style="font-size: 12px; color: var(--text2);">
                        Комиссия: ${result.burnedFee} MMO
                    </div>
                ` : `
                    <div class="battle-reward" style="color: var(--mythic);">
                        -${result.betAmount || 100} MMO
                    </div>
                `}
                <div style="margin-top: 16px;">
                    <div>⭐ Очки лиги: ${result.winner ? '+' : '-'}${result.leaguePointsChange?.winner || result.leaguePointsChange?.loser || 0}</div>
                    <div style="font-size: 11px; color: var(--text2); margin-top: 8px;">Шанс победы: ${result.winChance}%</div>
                </div>
                <button class="battle-close-btn" onclick="closeBattleAnimation()">ПРОДОЛЖИТЬ</button>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function closeBattleAnimation() {
    const anim = document.getElementById('battleAnimation');
    if (anim) anim.remove();
    renderPvP();
}

// Остановить PvP polling (при переключении вкладки)
function stopPvPPolling() {
    if (pvpPollingInterval) {
        clearInterval(pvpPollingInterval);
        pvpPollingInterval = null;
    }
}

// Добавляем вкладку в навигацию
// В switchTab функцию добавляем:
// if (tab === 'pvp') renderPvP();

// В HTML добавляем новую вкладку в bottom-nav:
// <div class="nav-item" onclick="switchTab('pvp')" id="nav-pvp">
//     <i class="fa-solid fa-sword"></i>
//     <span data-i18n="nav.pvp">Арена</span>
// </div>

// И добавляем tab-content:
// <div class="tab-content" id="tab-pvp"></div>

// ============================================================
// PARTICLES
// ============================================================
(function initParticles() {
    const canvas = document.getElementById('particles-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W, H, particles = [];
    function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
    resize();
    window.addEventListener('resize', resize);
    for (let i = 0; i < 40; i++) {
        particles.push({
            x: Math.random() * 1000, y: Math.random() * 1000,
            r: Math.random() * 1.5 + 0.3,
            vx: (Math.random() - 0.5) * 0.3, vy: -Math.random() * 0.4 - 0.1,
            alpha: Math.random() * 0.4 + 0.1,
            color: Math.random() > 0.5 ? '124,58,237' : '6,182,212'
        });
    }
    function draw() {
        ctx.clearRect(0, 0, W, H);
        particles.forEach(p => {
            p.x += p.vx; p.y += p.vy;
            if (p.y < -5) { p.y = H + 5; p.x = Math.random() * W; }
            if (p.x < -5) p.x = W + 5;
            if (p.x > W + 5) p.x = -5;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${p.color},${p.alpha})`;
            ctx.fill();
        });
        requestAnimationFrame(draw);
    }
    draw();
})();

// ============================================================
// UPDATE UI
// ============================================================
function updatePlayerInfo() {
    if (!state.user) return;
    const name = state.user.username || state.user.firstName || 'GENOME_X';
    const avatarEl = document.getElementById('playerAvatar');
    const nameEl = document.querySelector('.player-name');
    if (avatarEl) avatarEl.textContent = name[0].toUpperCase();
    if (nameEl) nameEl.textContent = name.toUpperCase();
}

function renderAll() {
    updateHeader();
    renderCards();
    updateUpgradeButton();
    renderLeaderboard();
    renderSpecialQuests();
    updateFriendRewardButtons();
}

function updateHeader() {
    if (!state.user) return;
    const u = state.user;

    if (!state.incomePerHour) {
        let income = 0;
        state.inventory.forEach(item => {
            const c = getCreature(item.creatureId);
            if (c) income += c.incomeBase * item.count;
        });
        state.incomePerHour = income;
    }

    const visualBalance = getVisualBalance();
    document.getElementById('balanceDisplay').textContent = formatBalance(visualBalance);
    
    const incomeInline = document.getElementById('incomeInline');
    if (incomeInline) incomeInline.textContent = `+${formatNum(state.incomePerHour)}/hr`;

    const needed = u.level * 100;
    document.getElementById('xpLabel').textContent = `XP ${u.xp}/${needed}`;
    document.getElementById('xpFill').style.width = `${Math.min(100, (u.xp / needed) * 100)}%`;
    document.getElementById('playerLevelLabel').textContent = `LVL ${u.level} · ${getLevelTitle(u.level)}`;

    document.getElementById('walletIncome').textContent = formatNum(state.incomePerHour);
    document.getElementById('walletCards').textContent = state.inventory.reduce((s, i) => s + i.count, 0);
    document.getElementById('walletMerges').textContent = u.mergeCount || 0;
    document.getElementById('walletStorage').textContent = `${getUsedSlots()}/${u.inventorySlots}`;

    updateUpgradeButton();
    renderTransactions();

    const friendCountDisplay = document.getElementById('friendCountDisplay');
    if (friendCountDisplay && state.user) {
        friendCountDisplay.textContent = `${state.user.referralCount || 0} друзей 5+ уровня`;
    }
}

function updateUpgradeButton() {
    if (!state.user) return;
    const cost = getUpgradeCost();
    const btn = document.getElementById('quickUpgradeBtn');
    const costEl = document.getElementById('upgradeSlotCost');
    if (btn && costEl) {
        costEl.textContent = cost;
        const canAfford = state.serverBalance >= cost;
        btn.style.opacity = canAfford ? '1' : '0.5';
        btn.disabled = !canAfford;
    }
}

// ============================================================
// RENDER CARDS
// ============================================================
function renderCards() {
    const grid = document.getElementById('cardsGrid');
    if (!grid) return;

    if (!state.inventory.length) {
        grid.innerHTML = `<div class="empty-grid"><i class="fa-solid fa-dna"></i>Open a capsule to get your first creature!</div>`;
        document.getElementById('inventorySlots').textContent = `0/${state.user?.inventorySlots || 10}`;
        document.getElementById('encyclopediaProgress').textContent = `${state.user?.discovered?.length || 0}/${CREATURES.length}`;
        return;
    }

    const sorted = [...state.inventory].sort((a, b) => {
        const ai = RARITY_ORDER.indexOf(getCreature(a.creatureId)?.rarity || 'common');
        const bi = RARITY_ORDER.indexOf(getCreature(b.creatureId)?.rarity || 'common');
        return bi - ai;
    });

    grid.innerHTML = sorted.map(item => {
        const c = getCreature(item.creatureId);
        if (!c) return '';
        const merge = canMerge(item.creatureId);
        return `<div class="creature-card ${c.rarity}" onclick="onCardClick('${item.creatureId}')">
            ${merge ? `<div class="merge-ready-badge">MERGE!</div>` : ''}
            ${item.count > 1 ? `<div class="card-count">${item.count}</div>` : ''}
            <div class="card-icon">${getIconHtml(c)}</div>
            <div class="card-name">${escapeHtml(c.name)}</div>
            <div class="card-rarity-badge badge-${c.rarity}">${c.rarity}</div>
            <div class="card-income"><i class="fa-solid fa-bolt"></i>${c.incomeBase}/hr</div>
        </div>`;
    }).join('');

    document.getElementById('inventorySlots').textContent = `${getUsedSlots()}/${state.user?.inventorySlots || 10}`;
    document.getElementById('encyclopediaProgress').textContent = `${state.user?.discovered?.length || 0}/${CREATURES.length}`;
}

// ============================================================
// CAPSULE
// ============================================================
let lastCapsuleOpen = 0;

function showCapsuleModal(type) {
    const odds = RARITY_WEIGHTS[type];
    const cost = CAPSULE_COSTS[type];
    const title = type === 'premium' ? 'Premium DNA Capsule' : 'DNA Capsule';
    const canAfford = state.serverBalance >= cost;
    const rarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

    const oddsHtml = rarities.map(r => {
        const pct = odds[r] || 0;
        if (!pct) return '';
        const color = RARITY_COLORS[r];
        return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
            <div style="flex:1;font-size:12px;font-weight:600;color:${color};text-transform:uppercase">${r}</div>
            <div style="width:100px;height:6px;background:#1e2d4a;border-radius:3px;overflow:hidden">
                <div style="height:100%;width:${pct}%;background:${color};border-radius:3px"></div>
            </div>
            <div style="width:35px;text-align:right;font-family:'Orbitron',monospace;font-size:12px;font-weight:700;color:${color}">${pct}%</div>
        </div>`;
    }).join('');

    document.getElementById('popup').innerHTML = `
        <div class="popup-close" onclick="closeOverlay()"><i class="fa-solid fa-xmark"></i></div>
        <span class="popup-icon" style="filter:drop-shadow(0 0 16px ${type === 'premium' ? 'rgba(245,158,11,0.8)' : 'rgba(124,58,237,0.8)'})">${type === 'premium' ? '💎' : '🧬'}</span>
        <div class="popup-title">${title}</div>
        <div class="popup-subtitle" style="margin-bottom:16px">
            Cost: <span style="color:${type === 'premium' ? '#f59e0b' : '#a855f7'};font-weight:700">${cost} MMO</span>
        </div>
        <div style="background:#0d1120;border:1px solid #1e2d4a;border-radius:12px;padding:14px;margin-bottom:16px">
            <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Drop Rates</div>
            ${oddsHtml}
        </div>
        <button class="popup-btn" ${!canAfford ? 'disabled' : ''} 
            style="${!canAfford ? 'opacity:0.5;cursor:not-allowed;background:#1a2540' : type === 'premium' ? 'background:linear-gradient(135deg,#b45309,#f59e0b)' : ''}" 
            onclick="closeOverlay();openCapsule('${type}')">
            <i class="fa-solid fa-flask-vial"></i> ${canAfford ? 'OPEN NOW' : 'NOT ENOUGH MMO'}
        </button>
    `;
    document.getElementById('overlay').classList.add('show');
}

async function openCapsule(type) {
    if (state.isLoading) return;
    
    if (Date.now() - lastCapsuleOpen < 2000) {
        showToast('Слишком быстро! Подождите 2 секунды.', '⏳');
        return;
    }
    lastCapsuleOpen = Date.now();

    const cost = CAPSULE_COSTS[type];
    if (state.serverBalance < cost) {
        showToast('Not enough MMO!', '❌'); return;
    }
    if (getUsedSlots() >= (state.user?.inventorySlots || 10)) {
        showToast('Inventory full! Upgrade storage', '📦'); return;
    }

    state.isLoading = true;

    const cardEl = document.getElementById(type === 'premium' ? 'premiumCapsuleCard' : 'basicCapsuleCard');
    const iconEl = cardEl?.querySelector('.capsule-icon');
    iconEl?.classList.add('capsule-opening');
    setTimeout(() => iconEl?.classList.remove('capsule-opening'), 600);

    const res = await apiRequest('POST', '/api/game/open-capsule', { type });
    state.isLoading = false;

    if (!res.success) {
        showToast(res.message || 'Error opening capsule', '❌'); return;
    }

    state.user = res.user;
    state.inventory = res.inventory;
    state.incomePerHour = await getCurrentIncome();
    
    updateServerSnapshot(state.user.balance, state.incomePerHour, state.user.lastPassiveIncome || null);

    updateHeader();
    renderCards();

    setTimeout(() => showCapsulePopup(res.creature), 300);
}

function showCapsulePopup(creature) {
    const c = getCreature(creature.id) || creature;
    const color = RARITY_COLORS[c.rarity];

    document.getElementById('popup').innerHTML = `
        <div class="popup-close" onclick="closeOverlay()"><i class="fa-solid fa-xmark"></i></div>
        <div class="popup-icon">${getIconHtml(c, true, color)}</div>
        <div class="popup-title" style="color:${color}">${escapeHtml(c.name)}</div>
        <div class="popup-subtitle">${escapeHtml(c.desc || '')}</div>
        <div class="popup-rarity" style="background:${color}22;color:${color};border:1px solid ${color}44">${c.rarity.toUpperCase()}</div>
        <div class="popup-stats">
            <div class="popup-stat"><div class="popup-stat-val" style="color:${color}">${c.incomeBase}</div><div class="popup-stat-label">MMO/hr</div></div>
        </div>
        <button class="popup-btn" onclick="closeOverlay()">AWESOME!</button>
    `;
    document.getElementById('overlay').classList.add('show');
    spawnStars(c.rarity);
}

// ============================================================
// CARD CLICK
// ============================================================
function onCardClick(creatureId) {
    const c = getCreature(creatureId);
    if (!c) return;
    const item = state.inventory.find(i => i.creatureId === creatureId);
    const color = RARITY_COLORS[c.rarity];

    document.getElementById('popup').innerHTML = `
        <div class="popup-close" onclick="closeOverlay()"><i class="fa-solid fa-xmark"></i></div>
        <div class="popup-icon">${getIconHtml(c, true, color)}</div>
        <div class="popup-title" style="color:${color}">${escapeHtml(c.name)}</div>
        <div class="popup-subtitle">${escapeHtml(c.desc || '')}</div>
        <div class="popup-rarity" style="background:${color}22;color:${color};border:1px solid ${color}44">${c.rarity.toUpperCase()}</div>
        <div class="popup-stats">
            <div class="popup-stat"><div class="popup-stat-val" style="color:${color}">${c.incomeBase}</div><div class="popup-stat-label">MMO/hr</div></div>
            <div class="popup-stat"><div class="popup-stat-val">${item ? item.count : 0}</div><div class="popup-stat-label">Owned</div></div>
        </div>
        ${canMerge(creatureId)
            ? `<button class="popup-btn" style="background:linear-gradient(135deg,#16a34a,#22c55e)" onclick="closeOverlay();showMergePreview('${creatureId}')">
                <i class="fa-solid fa-code-merge"></i> MERGE x3
            </button>`
            : `<button class="popup-btn" onclick="closeOverlay()">CLOSE</button>`
        }
    `;
    document.getElementById('overlay').classList.add('show');
}

// ============================================================
// MERGE
// ============================================================
let lastMergeTime = 0;

function showMergePreview(creatureId) {
    const creature = getCreature(creatureId);
    if (!creature) return;
    if (creature.rarity === 'legendary') { showToast('Legendary is max!', '⭐'); return; }

    const currentRarityIdx = RARITY_ORDER.indexOf(creature.rarity);
    const nextRarity = currentRarityIdx < RARITY_ORDER.length - 2 ? RARITY_ORDER[currentRarityIdx + 1] : creature.rarity;
    const nextCreature = CREATURES.find(c => c.name === creature.name && c.rarity === nextRarity) || creature;
    const color = RARITY_COLORS[creature.rarity];

    document.getElementById('popup').innerHTML = `
        <div class="popup-close" onclick="closeOverlay()"><i class="fa-solid fa-xmark"></i></div>
        <div class="popup-title" style="margin-bottom:4px">Предпросмотр Слияния</div>
        <div class="popup-subtitle">3x ${escapeHtml(creature.name)} → ?</div>
        <div style="background:#0d1120;border:1px solid #1e2d4a;border-radius:14px;padding:16px;margin-bottom:16px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
                <div style="text-align:center;flex:1">
                    <div style="font-size:24px;margin-bottom:6px">${getIconHtml(creature)}</div>
                    <div style="font-size:10px;color:#94a3b8">Исходные</div>
                    <div style="font-size:11px;font-weight:600;color:#e2e8f0;margin-top:2px">3x ${escapeHtml(creature.name)}</div>
                </div>
                <div style="color:#4a5568;font-size:18px">→</div>
                <div style="text-align:center;flex:1">
                    <div style="font-size:24px;margin-bottom:6px">?</div>
                    <div style="font-size:10px;color:#94a3b8">Результат</div>
                    <div style="font-size:11px;font-weight:600;color:#e2e8f0;margin-top:2px">Unknown</div>
                </div>
            </div>
            <div style="border-top:1px solid #1e2d4a;padding-top:14px">
                <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">Возможные результаты</div>
                <div style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:10px;padding:10px;margin-bottom:8px">
                    <div style="display:flex;align-items:center;gap:8px">
                        <span style="font-size:18px">${getIconHtml(nextCreature)}</span>
                        <div style="flex:1">
                            <div style="font-size:11px;font-weight:600;color:#22c55e">30% Успех</div>
                            <div style="font-size:10px;color:#94a3b8">${escapeHtml(nextCreature.name)} (${nextRarity.toUpperCase()})</div>
                        </div>
                        <div style="font-size:12px;font-weight:700;color:#22c55e">▲ ПОВЫШЕНИЕ</div>
                    </div>
                </div>
                <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:10px;padding:10px">
                    <div style="display:flex;align-items:center;gap:8px">
                        <span style="font-size:18px">${getIconHtml(creature)}</span>
                        <div style="flex:1">
                            <div style="font-size:11px;font-weight:600;color:#ef4444">70% Провал</div>
                            <div style="font-size:10px;color:#94a3b8">${escapeHtml(creature.name)} (${creature.rarity.toUpperCase()})</div>
                        </div>
                        <div style="font-size:12px;font-weight:700;color:#ef4444">= БЕЗ ИЗМЕНЕНИЙ</div>
                    </div>
                </div>
            </div>
        </div>
        <button class="popup-btn" style="background:linear-gradient(135deg,#16a34a,#22c55e);margin-bottom:8px" onclick="closeOverlay();executeMerge('${creatureId}')">
            <i class="fa-solid fa-code-merge"></i> СЛИТЬ СЕЙЧАС
        </button>
        <button class="popup-btn" style="background:#1a2540;color:#e2e8f0" onclick="closeOverlay()">ОТМЕНА</button>
    `;
    document.getElementById('overlay').classList.add('show');
}

async function executeMerge(creatureId) {
    if (state.isLoading) return;
    if (!canMerge(creatureId)) return;
    
    if (Date.now() - lastMergeTime < 1000) {
        showToast('Слишком быстро! Подождите.', '⏳');
        return;
    }
    lastMergeTime = Date.now();

    state.isLoading = true;
    const res = await apiRequest('POST', '/api/game/merge', { creatureId });
    state.isLoading = false;

    if (!res.success) {
        showToast(res.message || 'Merge failed', '❌'); return;
    }

    state.user = res.user;
    state.inventory = res.inventory;
    if (res.incomePerHour !== undefined) {
        state.incomePerHour = res.incomePerHour;
    } else {
        state.incomePerHour = await getCurrentIncome();
    }
    
    updateServerSnapshot(state.user.balance, state.incomePerHour, state.user.lastPassiveIncome || null);

    updateHeader();
    renderCards();
    showMergeResultPopup(res.fromCreature, res.resultCreature, res.upgraded);
}

function showMergeResultPopup(from, to, success) {
    const fromC = getCreature(from.id) || from;
    const toC = getCreature(to.id) || to;
    const color = RARITY_COLORS[toC.rarity];

    document.getElementById('popup').innerHTML = `
        <div class="popup-close" onclick="closeOverlay()"><i class="fa-solid fa-xmark"></i></div>
        <div class="merge-popup-cards">
            <div class="merge-card-mini">${getIconHtml(fromC)}</div>
            <div class="merge-card-mini">${getIconHtml(fromC)}</div>
            <div class="merge-card-mini">${getIconHtml(fromC)}</div>
            <div class="merge-arrow"><i class="fa-solid fa-arrow-right"></i></div>
            <div class="merge-card-mini" style="border-color:${color};box-shadow:0 0 12px ${color}44;">${getIconHtml(toC)}</div>
        </div>
        <div class="popup-title" style="color:${color}">${escapeHtml(toC.name)}</div>
        <div class="popup-subtitle">${success ? '🎉 Эволюция успешна!' : '❌ Провал! Существо не изменилось'}</div>
        <div class="popup-rarity" style="background:${color}22;color:${color};border:1px solid ${color}44">
            ${toC.rarity.toUpperCase()} ${success ? '▲ UPGRADED' : ''}
        </div>
        <div class="popup-stats">
            <div class="popup-stat"><div class="popup-stat-val" style="color:${color}">${toC.incomeBase}</div><div class="popup-stat-label">MMO/hr</div></div>
            <div class="popup-stat"><div class="popup-stat-val" style="color:${success ? '#22c55e' : '#94a3b8'}">${success ? '+РЕДКОСТЬ' : '=РЕДКОСТЬ'}</div><div class="popup-stat-label">Result</div></div>
        </div>
        <button class="popup-btn" onclick="closeOverlay()" style="${success ? 'background:linear-gradient(135deg,#16a34a,#22c55e)' : ''}">
            ${success ? 'ЭВОЛЮЦИЯ!' : 'ЗАКРЫТЬ'}
        </button>
    `;
    document.getElementById('overlay').classList.add('show');
    if (success) spawnStars(toC.rarity);
}

// ============================================================
// UPGRADE INVENTORY
// ============================================================
async function upgradeInventory() {
    if (state.isLoading) return;
    
    const cost = getUpgradeCost();
    if (state.serverBalance < cost) {
        showToast(`Need ${cost} MMO to upgrade!`, '❌'); return;
    }

    state.isLoading = true;
    const res = await apiRequest('POST', '/api/game/upgrade-inventory');
    state.isLoading = false;

    if (!res.success) {
        showToast(res.message || 'Error', '❌'); return;
    }

    state.user = res.user;
    updateServerSnapshot(state.user.balance, state.incomePerHour, state.user.lastPassiveIncome || null);
    updateHeader();
    renderCards();
    showToast(`+1 slot! Now ${state.user.inventorySlots} total`, '📦');
}

// ============================================================
// ADS
// ============================================================
async function updateAdsStatus() {
    try {
        const res = await apiRequest('GET', '/api/game/ads-status');
        if (res && res.success) {
            const adsRemainingEl = document.getElementById('adsRemaining');
            if (adsRemainingEl) {
                adsRemainingEl.textContent = `${res.adsRemaining}/${res.maxAdsPerDay}`;
            }
            if (res.adsRemaining === 0) {
                const adsBtn = document.getElementById('adsBtn');
                if (adsBtn) {
                    adsBtn.style.opacity = '0.5';
                    adsBtn.disabled = true;
                }
            }
            if (res.cooldownSeconds > 0 && res.cooldownSeconds < 100) {
                const timerEl = document.getElementById('adsTimer');
                if (timerEl) timerEl.textContent = `${res.cooldownSeconds}s`;
            }
        }
    } catch (e) {
        console.error('updateAdsStatus error:', e);
    }
}

async function watchAd() {
    if (state.isLoading) return;

    if (state.adsCooldown > 0) {
        showToast(`Ad available in ${state.adsCooldown}s`, '⏳');
        return;
    }

    const btn = document.getElementById('adsBtn');
    const timer = document.getElementById('adsTimer');
    const reward = document.getElementById('adsReward');
    
    if (btn) { btn.style.opacity = '0.5'; btn.disabled = true; }
    if (timer) timer.textContent = '...';
    if (reward) reward.textContent = '';

    showToast('Loading ad...', '📺');

    try {
        let waited = 0;
        while (typeof window.showGiga !== 'function' && waited < 3000) {
            await new Promise(r => setTimeout(r, 100));
            waited += 100;
        }

        if (typeof window.showGiga !== 'function') {
            throw new Error('Giga Pub not loaded');
        }

        await window.showGiga();
        
        const res = await apiRequest('POST', '/api/game/watch-ad');

        if (!res.success) {
            if (res.dailyLimitReached) {
                showToast(res.message, '⚠️');
                if (btn) { btn.style.opacity = '0.5'; btn.disabled = true; }
                if (timer) timer.textContent = 'Limit';
                state.isLoading = false;
                return;
            }
            throw new Error(res.message || 'Failed');
        }

        state.user = res.user;
        state.adsCooldown = res.cooldownSeconds || AD_COOLDOWN;
        
        const adsRemainingEl = document.getElementById('adsRemaining');
        if (adsRemainingEl && res.adsRemaining !== undefined) {
            adsRemainingEl.textContent = `${res.adsRemaining}/${res.maxAdsPerDay}`;
        }
        
        updateServerSnapshot(state.user.balance, state.incomePerHour, state.user.lastPassiveIncome || null);
        updateHeader();
        showToast(`+${AD_REWARD} MMO! (${res.adsToday}/${res.maxAdsPerDay} today)`, '🎉');
        spawnFloatingMMO(AD_REWARD);
        
        if (res.adsRemaining === 0) {
            if (btn) { btn.style.opacity = '0.5'; btn.disabled = true; }
            if (timer) timer.textContent = 'Limit';
        } else {
            if (btn) { btn.style.opacity = '1'; btn.disabled = false; }
            if (timer) timer.textContent = 'Ready';
        }
        
    } catch (e) {
        console.error('Ad error:', e);
        showToast('Ad failed, try again', '❌');
        
        if (btn) { btn.style.opacity = '1'; btn.disabled = false; }
        if (timer) timer.textContent = 'Ready';
        if (reward) reward.textContent = `+${AD_REWARD}`;
        state.isLoading = false;
        return;
    }

    state.isLoading = false;
}

function updateAdsTimer() {
    if (!state.user) return;
    if (state.adsCooldown > 0) {
        state.adsCooldown--;
        const timerEl = document.getElementById('adsTimer');
        if (timerEl) timerEl.textContent = `${state.adsCooldown}s`;
        const btn = document.getElementById('adsBtn');
        if (btn && state.adsCooldown > 0) {
            btn.style.opacity = '0.5';
            btn.disabled = true;
        }
    } else {
        const timerEl = document.getElementById('adsTimer');
        if (timerEl) timerEl.textContent = 'Ready';
        const btn = document.getElementById('adsBtn');
        if (btn) {
            btn.style.opacity = '1';
            btn.disabled = false;
        }
    }
}

// ============================================================
// TRANSACTIONS
// ============================================================
function renderTransactions() {
    const list = document.getElementById('txList');
    if (!list) return;
    const txs = state.user?.transactions || [];
    if (!txs.length) {
        list.innerHTML = `<div style="text-align:center;color:#4a5568;padding:20px;font-size:12px">No transactions yet</div>`;
        return;
    }
    list.innerHTML = txs.slice(0, 10).map(tx => {
        const isPos = tx.amount > 0;
        const isNeg = tx.amount < 0;
        const icon = isPos ? '⬆️' : isNeg ? '⬇️' : '🔀';
        const color = isPos ? 'rgba(34,197,94,0.15)' : isNeg ? 'rgba(239,68,68,0.15)' : 'rgba(124,58,237,0.15)';
        const timeAgo = Math.floor((Date.now() - new Date(tx.time).getTime()) / 60000);
        const timeStr = timeAgo < 1 ? 'just now' : `${timeAgo}m ago`;
        return `<div class="tx-item">
            <div class="tx-icon" style="background:${color}"><span style="font-size:16px">${icon}</span></div>
            <div class="tx-info">
                <div class="tx-name">${escapeHtml(tx.name)}</div>
                <div class="tx-time">${timeStr}</div>
            </div>
            <div class="tx-amount ${isPos ? 'positive' : isNeg ? 'negative' : ''}" style="${!isPos && !isNeg ? 'color:#a855f7' : ''}">
                ${isPos ? '+' : ''}${tx.amount !== 0 ? formatNum(tx.amount) + ' MMO' : 'MERGE'}
            </div>
        </div>`;
    }).join('');
}

// ============================================================
// ENCYCLOPEDIA
// ============================================================
function showEncyclopedia() {
    const discovered = new Set(state.user?.discovered || []);
    const total = CREATURES.length;
    const found = discovered.size;

    const grouped = {};
    RARITY_ORDER.forEach(r => grouped[r] = []);
    CREATURES.forEach(c => { if (grouped[c.rarity]) grouped[c.rarity].push(c); });

    const sections = RARITY_ORDER.map(rarity => {
        if (!grouped[rarity].length) return '';
        const color = RARITY_COLORS[rarity];
        const items = grouped[rarity].map(c => {
            const isFound = discovered.has(c.id);
            return `<div class="coll-item ${isFound ? 'found' : 'not-found'}" style="${isFound ? `border-color:${color}44` : ''};cursor:pointer" onclick="showCreatureInfo('${c.id}')">
                <span style="font-size:22px;${isFound ? `filter:drop-shadow(0 0 6px ${color})` : ''}">${getIconHtml(c)}</span>
                <div class="coll-item-name">${isFound ? escapeHtml(c.name) : '???'}</div>
            </div>`;
        }).join('');
        return `<div style="margin-bottom:16px">
            <div style="font-size:10px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">${rarity}</div>
            <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px">${items}</div>
        </div>`;
    }).join('');

    document.getElementById('popup').innerHTML = `
        <div class="popup-close" onclick="closeOverlay()"><i class="fa-solid fa-xmark"></i></div>
        <div class="popup-title" style="margin-bottom:4px">Encyclopedia</div>
        <div class="popup-subtitle">${found}/${total} creatures discovered</div>
        <div style="height:6px;background:#1e2d4a;border-radius:3px;margin-bottom:16px;overflow:hidden">
            <div style="height:100%;width:${(found/total*100).toFixed(0)}%;background:linear-gradient(90deg,#7c3aed,#06b6d4);border-radius:3px;transition:width 0.5s"></div>
        </div>
        <div style="max-height:50vh;overflow-y:auto;padding:4px">${sections}</div>
    `;
    document.getElementById('overlay').classList.add('show');
}

function showCreatureInfo(creatureId) {
    const c = getCreature(creatureId);
    if (!c) return;
    const discovered = new Set(state.user?.discovered || []);
    const isFound = discovered.has(creatureId);
    const color = RARITY_COLORS[c.rarity];

    document.getElementById('popup').innerHTML = `
        <div class="popup-close" onclick="showEncyclopedia()"><i class="fa-solid fa-arrow-left"></i></div>
        <div class="popup-icon">${getIconHtml(c, true, color)}</div>
        <div class="popup-title" style="color:${color}">${escapeHtml(c.name)}</div>
        <div class="popup-subtitle">${escapeHtml(c.desc || '')}</div>
        <div class="popup-rarity" style="background:${color}22;color:${color};border:1px solid ${color}44">
            ${c.rarity.toUpperCase()} ${isFound ? '✓ DISCOVERED' : '🔒 UNDISCOVERED'}
        </div>
        <div class="popup-stats">
            <div class="popup-stat"><div class="popup-stat-val" style="color:${color}">${c.incomeBase}</div><div class="popup-stat-label">MMO/hr</div></div>
            <div class="popup-stat"><div class="popup-stat-val">${c.rarity === 'legendary' ? '★★★★★' : c.rarity === 'epic' ? '★★★★' : c.rarity === 'rare' ? '★★★' : c.rarity === 'uncommon' ? '★★' : '★'}</div><div class="popup-stat-label">Power</div></div>
        </div>
    `;
    document.getElementById('overlay').classList.add('show');
}

// ============================================================
// MARKETPLACE
// ============================================================
function switchMarketplaceTab(tab, event) {
    document.querySelectorAll('.marketplace-subtab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.marketplace-tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`marketplace-${tab}`).classList.add('active');
    
    if (event && event.target) {
        const btn = event.target.closest('.marketplace-tab-btn');
        if (btn) btn.classList.add('active');
    }
    
    isMarketplaceTabActive = true;

    if (tab === 'buy') renderMarketplaceBuy();
    if (tab === 'sell') renderMarketplaceSell();
    if (tab === 'mylistings') renderMarketplaceMyListings();
}

function getDataHash(data) {
    return JSON.stringify(data);
}

async function renderMarketplaceBuy() {
    const container = document.getElementById('marketplaceListings');
    if (!container) return;
    
    if (Date.now() < marketplaceCache.expiresAt && marketplaceCache.data) {
        renderMarketplaceListings(marketplaceCache.data);
        return;
    }
    
    container.innerHTML = `<div style="text-align:center;color:#94a3b8;padding:20px;font-size:12px">Loading...</div>`;

    const res = await apiRequest('GET', '/api/marketplace/listings');
    if (!res || !res.success) {
        container.innerHTML = `<div style="text-align:center;color:#4a5568;padding:30px;font-size:12px">Error loading listings</div>`;
        return;
    }

    const listings = Array.isArray(res.listings) ? res.listings : [];
    const newHash = getDataHash(listings);
    
    if (marketplaceCache.hash === newHash && marketplaceCache.data) {
        marketplaceCache.expiresAt = Date.now() + 10000;
        renderMarketplaceListings(marketplaceCache.data);
        return;
    }
    
    marketplaceCache = {
        data: listings,
        hash: newHash,
        expiresAt: Date.now() + 10000
    };
    
    renderMarketplaceListings(listings);
}

function renderMarketplaceListings(listings) {
    const container = document.getElementById('marketplaceListings');
    if (!container) return;
    
    if (!listings.length) {
        container.innerHTML = `<div style="text-align:center;color:#4a5568;padding:30px 20px;font-size:12px">No listings available</div>`;
        return;
    }

    container.innerHTML = listings.map(l => {
        const c = getCreature(l.creatureId);
        if (!c) return '';
        const color = RARITY_COLORS[c.rarity];
        const isOwn = l.sellerTgId === state.user?.telegramId;

        return `<div class="marketplace-listing">
            <div class="marketplace-listing-icon" style="background:${color}11;border-color:${color}44">${getIconHtml(c)}</div>
            <div class="marketplace-listing-info">
                <div class="marketplace-listing-name">${escapeHtml(c.name)}</div>
                <div class="marketplace-listing-seller">by ${escapeHtml(l.sellerName)}${isOwn ? ' (You)' : ''}</div>
                <div class="marketplace-listing-rarity badge-${c.rarity}">${c.rarity}</div>
            </div>
            <div class="marketplace-listing-price">
                <div class="marketplace-listing-amount">${l.price}</div>
                ${isOwn
                    ? `<button class="marketplace-cancel-btn" onclick="cancelMarketplaceListing('${l._id}')">CANCEL</button>`
                    : `<button class="marketplace-buy-btn" onclick="buyFromMarketplace('${l._id}', ${l.price}, '${l.creatureId}')">BUY</button>`
                }
            </div>
        </div>`;
    }).join('');
}

function renderMarketplaceSell() {
    const cards = document.getElementById('marketplaceSellCards');
    if (!cards) return;

    if (!state.inventory.length) {
        cards.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#4a5568;padding:30px 20px;font-size:12px">You have no creatures to sell</div>`;
        return;
    }

    cards.innerHTML = state.inventory.map(item => {
        const c = getCreature(item.creatureId);
        if (!c || !item.count) return '';
        return `<div class="marketplace-sell-card" style="cursor:pointer" onclick="openSellModal('${item.creatureId}', '${c.name}', ${item.count})">
            <div class="marketplace-sell-card-icon">${getIconHtml(c)}</div>
            <div class="marketplace-sell-card-name">${escapeHtml(c.name)}</div>
            <div style="font-size:9px;color:#4a5568">x${item.count}</div>
            <div style="font-size:10px;color:#06b6d4;font-weight:600;margin-top:4px">SET PRICE</div>
        </div>`;
    }).filter(Boolean).join('');
}

function openSellModal(creatureId, creatureName, count) {
    document.getElementById('popup').innerHTML = `
        <div class="popup-close" onclick="closeOverlay()"><i class="fa-solid fa-xmark"></i></div>
        <div class="popup-title">Sell ${escapeHtml(creatureName)}</div>
        <div class="popup-subtitle" style="margin-bottom:16px">Set your listing price</div>
        <div class="price-input-modal">
            <div>
                <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Price (MMO)</div>
                <input type="number" class="price-input-field" id="sellPriceInput" placeholder="Enter price" min="10" max="100000" value="100" oninput="updateFeeCalculator()">
            </div>
            <div class="fee-calculator">
                <div class="fee-row"><span class="fee-label">Your Price</span><span class="fee-value" id="priceDisplay">100</span></div>
                <div class="fee-row" style="color:#ef4444"><span class="fee-label">Platform Fee (10%)</span><span class="fee-value fee" id="feeDisplay">-10</span></div>
                <div class="fee-row total"><span>You Receive</span><span class="fee-value final" id="finalDisplay">90</span></div>
            </div>
        </div>
        <button class="popup-btn" style="background:linear-gradient(135deg,#22c55e,#16a34a);margin-top:16px" onclick="confirmSellListing('${creatureId}')">
            <i class="fa-solid fa-check"></i> LIST FOR SALE
        </button>
        <button class="popup-btn" style="background:#1a2540;color:#e2e8f0;margin-top:8px" onclick="closeOverlay()">CANCEL</button>
    `;
    document.getElementById('overlay').classList.add('show');
    updateFeeCalculator();
}

function updateFeeCalculator() {
    const input = document.getElementById('sellPriceInput');
    if (!input) return;
    const price = Math.max(10, Math.min(100000, parseInt(input.value) || 0));
    const fee = Math.floor(price * 0.1);
    document.getElementById('priceDisplay').textContent = price;
    document.getElementById('feeDisplay').textContent = `-${fee}`;
    document.getElementById('finalDisplay').textContent = price - fee;
}

async function confirmSellListing(creatureId) {
    const input = document.getElementById('sellPriceInput');
    const price = Math.max(10, Math.min(100000, parseInt(input?.value) || 0));

    if (price < 10) { showToast('Price must be at least 10 MMO', '❌'); return; }

    state.isLoading = true;
    const res = await apiRequest('POST', '/api/marketplace/list', { creatureId, price });
    state.isLoading = false;

    if (!res.success) {
        showToast(res.message || 'Error listing', '❌'); return;
    }

    state.inventory = res.inventory;
    closeOverlay();
    const c = getCreature(creatureId);
    showToast(`${c?.name || 'Creature'} listed for ${price} MMO!`, '✅');
    renderCards();
    renderMarketplaceSell();
    marketplaceCache.expiresAt = 0;
    switchMarketplaceTab('mylistings');
}

async function renderMarketplaceMyListings() {
    const container = document.getElementById('marketplaceMyListings');
    if (!container) return;
    
    container.innerHTML = `<div style="text-align:center;color:#94a3b8;padding:20px;font-size:12px">Загрузка...</div>`;

    const res = await apiRequest('GET', '/api/marketplace/my-listings');
    if (!res || !res.success) {
        container.innerHTML = `<div class="empty-listings">Ошибка загрузки</div>`;
        return;
    }

    const listings = Array.isArray(res.listings) ? res.listings : [];
    if (!listings.length) {
        container.innerHTML = `<div class="empty-listings">У вас нет активных лотов</div>`;
        return;
    }

    container.innerHTML = listings.map(l => {
        const c = getCreature(l.creatureId);
        if (!c) return '';
        const color = RARITY_COLORS[c.rarity];
        const date = new Date(l.createdAt).toLocaleDateString();
        
        return `<div class="marketplace-my-listing">
            <div class="marketplace-my-listing-icon" style="background:${color}11;border-color:${color}44">
                ${getIconHtml(c)}
            </div>
            <div class="marketplace-my-listing-info">
                <div class="marketplace-my-listing-name">${escapeHtml(c.name)}</div>
                <div class="marketplace-my-listing-status">Listed ${date}</div>
                <div class="marketplace-listing-rarity badge-${c.rarity}">${c.rarity}</div>
            </div>
            <div class="marketplace-my-listing-price">
                <div class="marketplace-my-listing-amount">${l.price} MMO</div>
                <button class="marketplace-cancel-btn" onclick="cancelMarketplaceListing('${l._id}')">ОТМЕНИТЬ</button>
            </div>
        </div>`;
    }).join('');
}

async function cancelMarketplaceListing(listingId) {
    state.isLoading = true;
    const res = await apiRequest('POST', '/api/marketplace/cancel', { listingId });
    state.isLoading = false;

    if (!res.success) {
        showToast(res.message || 'Error', '❌'); return;
    }

    state.inventory = res.inventory;
    renderCards();
    marketplaceCache.expiresAt = 0;
    renderMarketplaceMyListings();
    showToast('Listing cancelled, card returned', '✅');
}

async function buyFromMarketplace(listingId, price, creatureId) {
    if (state.isLoading) return;
    if (state.serverBalance < price) {
        showToast(`Need ${price} MMO`, '❌'); return;
    }

    state.isLoading = true;
    const res = await apiRequest('POST', '/api/marketplace/buy', { listingId });
    state.isLoading = false;

    if (!res.success) {
        showToast(res.message || 'Error buying', '❌'); return;
    }

    state.user = res.user;
    state.inventory = res.inventory;
    if (res.incomePerHour !== undefined) {
        state.incomePerHour = res.incomePerHour;
    } else {
        state.incomePerHour = await getCurrentIncome();
    }
    
    updateServerSnapshot(state.user.balance, state.incomePerHour, state.user.lastPassiveIncome || null);

    const c = getCreature(creatureId);
    updateHeader();
    renderCards();
    marketplaceCache.expiresAt = 0;
    renderMarketplaceBuy();
    showToast(`Bought ${c?.name || 'creature'} for ${price} MMO!`, '✅');
    spawnFloatingMMO(-price);
}

// ============================================================
// LEADERBOARD
// ============================================================
async function renderLeaderboard() {
    const list = document.getElementById('leaderboardList');
    if (!list) return;

    if (!state.token) {
        list.innerHTML = `<div style="text-align:center;color:#4a5568;padding:20px;font-size:12px">Loading...</div>`;
        return;
    }
    
    if (Date.now() < leaderboardCache.expiresAt && leaderboardCache.data) {
        renderLeaderboardData(leaderboardCache.data);
        return;
    }

    if (currentLeaderboardController) {
        currentLeaderboardController.abort();
    }
    currentLeaderboardController = new AbortController();

    const res = await apiRequest('GET', '/api/user/leaderboard', null, currentLeaderboardController.signal);
    if (!res || !res.success) {
        if (res === null) return;
        list.innerHTML = `<div style="text-align:center;color:#4a5568;padding:20px;font-size:12px">Ошибка сервера</div>`;
        return;
    }
    
    if (res.leaders) {
        res.leaders = res.leaders.map(l => ({
            ...l,
            telegramId: l.telegramId
        }));
    }
    
    leaderboardCache = {
        data: res,
        expiresAt: Date.now() + 30 * 1000
    };
    
    renderLeaderboardData(res);
    currentLeaderboardController = null;
}

function renderLeaderboardData(data) {
    const list = document.getElementById('leaderboardList');
    if (!list) return;
    
    const currentUserId = state.user?.telegramId;
    if (!currentUserId) {
        console.warn('No current user telegram ID');
        return;
    }
    
    const leaders = data.leaders || [];
    
    if (!leaders.length) {
        list.innerHTML = `<div class="empty-listings">No players yet</div>`;
        return;
    }
    
    list.innerHTML = leaders.map(l => {
        const rank = l.rank;
        const rankClass = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
        const rankIcon = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
        const isMe = l.telegramId === currentUserId;
        
        return `<div class="lb-item ${isMe ? 'me' : ''}">
            <div class="lb-rank ${rankClass}">${rankIcon}</div>
            <div class="lb-avatar" style="background:${isMe ? '#a855f7' : '#4a5568'}33;border:1px solid ${isMe ? '#a855f7' : '#4a5568'}44;color:${isMe ? '#a855f7' : '#fff'}">
                ${l.username[0]?.toUpperCase() || '?'}
            </div>
            <div class="lb-info">
                <div class="lb-name">${escapeHtml(l.username)} ${isMe ? '<span style="font-size:9px;color:#a855f7">(You)</span>' : ''}</div>
                <div class="lb-level">УР ${l.level} · ${getLevelTitle(l.level)}</div>
                <div class="lb-xp" style="font-size:9px;color:#4a5568">ОП: ${l.xp}/${l.level * 100}</div>
            </div>
            <div class="lb-score" style="display:flex;flex-direction:column;align-items:flex-end">
                <span style="font-size:12px;font-weight:700;color:#f59e0b">УР ${l.level}</span>
                <span style="font-size:9px;color:#22c55e">${formatNum(l.balance)} MMO</span>
            </div>
        </div>`;
    }).join('');
}

// ============================================================
// FRIENDS (ОБНОВЛЕНО - ТРЕБОВАНИЕ 5+ УРОВНЯ)
// ============================================================
async function inviteFriend() {
    const res = await apiRequest('GET', '/api/user/referrals');
    const link = res.referralLink || `https://t.me/your_bot?start=${state.user?.referralCode}`;

    if (window.Telegram?.WebApp) {
        window.Telegram.WebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Join DNA MMO and get bonus MMO!')}`);
    } else {
        try {
            await navigator.clipboard.writeText(link);
            showToast('Invite link copied!', '🔗');
        } catch {
            showToast(link, '🔗');
        }
    }
}

async function renderFriendsList() {
    const container = document.getElementById('friendsList');
    if (!container) return;
    
    try {
        const res = await apiRequest('GET', '/api/user/referrals');
        if (!res || !res.success) {
            container.innerHTML = `<div style="text-align:center;color:#4a5568;padding:30px 20px;font-size:12px">
                <i class="fa-solid fa-circle-exclamation"></i> Error loading friends
            </div>`;
            return;
        }
        
        const referrals = res.referrals || [];
        const qualifiedCount = res.referralCount || 0;
        
        const friendCountDisplay = document.getElementById('friendCountDisplay');
        if (friendCountDisplay) {
            friendCountDisplay.textContent = `${qualifiedCount} друзей 5+ уровня из ${referrals.length}`;
        }
        
        if (referrals.length === 0) {
            container.innerHTML = `<div style="text-align:center;color:#4a5568;padding:30px 20px;font-size:12px">
                <i class="fa-solid fa-user-plus" style="font-size:24px;margin-bottom:10px;display:block"></i>
                Нет друзей<br>Пригласите друзей и помогите им достичь 5 уровня!
            </div>`;
            return;
        }
        
        container.innerHTML = referrals.map(friend => {
            const date = new Date(friend.joinedAt);
            const formattedDate = date.toLocaleDateString();
            const isQualified = friend.level >= 5;
            
            return `
                <div style="background:#0d1120;border:1px solid ${isQualified ? '#22c55e' : '#1e2d4a'};border-radius:12px;padding:12px;display:flex;align-items:center;gap:12px;margin-bottom:8px">
                    <div style="width:40px;height:40px;background:${isQualified ? 'linear-gradient(135deg,#22c55e,#16a34a)' : 'linear-gradient(135deg,#1e2d4a,#0d1120)'};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:1px solid ${isQualified ? '#22c55e' : '#a855f744'}">👤</div>
                    <div style="flex:1">
                        <div style="font-size:13px;font-weight:600;color:#e2e8f0">${escapeHtml(friend.username)}</div>
                        <div style="font-size:10px;color:#4a5568">Уровень ${friend.level} • Присоединился ${formattedDate}</div>
                    </div>
                    <div style="text-align:right">
                        ${isQualified 
                            ? '<div style="font-size:11px;color:#22c55e;font-weight:600">✅ 5+ уровень</div>'
                            : `<div style="font-size:11px;color:#f59e0b">📈 нужно ${5 - friend.level} ур.</div>`
                        }
                        <div style="font-size:12px;font-weight:700;color:#a855f7">${formatNum(friend.balance)} MMO</div>
                    </div>
                </div>
            `;
        }).join('');
        
    } catch (e) {
        console.error('renderFriendsList error:', e);
        container.innerHTML = `<div style="text-align:center;color:#4a5568;padding:20px;font-size:12px">Ошибка загрузки друзей</div>`;
    }
}

// ============================================================
// РЕФЕРАЛЬНЫЕ НАГРАДЫ (ТРЕБОВАНИЕ 5+ УРОВНЯ)
// ============================================================
async function claimFriendReward(requiredFriends, creatureId, creatureName, creatureIcon) {
    if (state.isLoading) return;
    
    const currentFriends = state.user?.referralCount || 0;
    
    if (currentFriends < requiredFriends) {
        showToast(`Нужно ${requiredFriends} друзей 5+ уровня (у вас ${currentFriends})`, '❌');
        return;
    }
    
    const rewardKey = `friend_reward_${requiredFriends}`;
    if (state.user?.completedSpecialQuests?.includes(rewardKey)) {
        showToast('Вы уже получили эту награду', 'ℹ️');
        return;
    }
    
    state.isLoading = true;
    showToast('🔄 Получение награды...', '');
    
    const res = await apiRequest('POST', '/api/game/claim-friend-reward', { requiredFriends, creatureId });
    
    state.isLoading = false;
    
    if (!res.success) {
        showToast(res.message || 'Ошибка', '❌');
        return;
    }
    
    state.user = res.user;
    state.inventory = res.inventory;
    if (res.incomePerHour !== undefined) {
        state.incomePerHour = res.incomePerHour;
    } else {
        state.incomePerHour = await getCurrentIncome();
    }
    
    updateServerSnapshot(state.user.balance, state.incomePerHour, state.user.lastPassiveIncome || null);
    updateHeader();
    renderCards();
    updateFriendRewardButtons();
    renderSpecialQuests();
    
    showFriendRewardPopup(creatureName, creatureIcon);
}

function showFriendRewardPopup(creatureName, creatureIcon) {
    const colorMap = {
        'Rare Wolf': '#3b82f6',
        'Epic Wolf': '#a855f7',
        'Legendary Wolf': '#f59e0b'
    };
    const color = colorMap[creatureName] || '#a855f7';
    
    document.getElementById('popup').innerHTML = `
        <div class="popup-close" onclick="closeOverlay()"><i class="fa-solid fa-xmark"></i></div>
        <span class="popup-icon" style="filter:drop-shadow(0 0 16px ${color})">${creatureIcon || '🐺'}</span>
        <div class="popup-title" style="color:${color}">${escapeHtml(creatureName)}</div>
        <div class="popup-subtitle">Получен за ${creatureName === 'Legendary Wolf' ? '150' : creatureName === 'Epic Wolf' ? '50' : '10'} друзей 5+ уровня!</div>
        <div class="popup-rarity" style="background:${color}22;color:${color};border:1px solid ${color}44">🎁 НАГРАДА</div>
        <button class="popup-btn" onclick="closeOverlay()">ОТЛИЧНО!</button>
    `;
    document.getElementById('overlay').classList.add('show');
    spawnStars('epic');
}

function updateFriendRewardButtons() {
    const currentQualified = state.user?.referralCount || 0;
    const completedQuests = new Set(state.user?.completedSpecialQuests || []);
    
    const rewards = [
        { friends: 10, creatureId: 'wolf_r', creatureName: 'Rare Wolf', creatureIcon: '🐺', rarity: 'rare', btnId: 'reward-10-btn', cardId: 'reward-10' },
        { friends: 50, creatureId: 'wolf_e', creatureName: 'Epic Wolf', creatureIcon: '🐺', rarity: 'epic', btnId: 'reward-50-btn', cardId: 'reward-50' },
        { friends: 150, creatureId: 'wolf_l', creatureName: 'Legendary Wolf', creatureIcon: '🐺', rarity: 'legendary', btnId: 'reward-150-btn', cardId: 'reward-150' }
    ];
    
    rewards.forEach(reward => {
        const btn = document.getElementById(reward.btnId);
        const card = document.getElementById(reward.cardId);
        if (!btn) return;
        
        const alreadyClaimed = completedQuests.has(`friend_reward_${reward.friends}`);
        
        if (alreadyClaimed) {
            btn.textContent = '✅ ПОЛУЧЕНО';
            btn.style.background = 'rgba(34,197,94,0.2)';
            btn.style.color = '#22c55e';
            btn.style.cursor = 'default';
            btn.disabled = true;
            if (card) card.style.opacity = '0.6';
        } else if (currentQualified >= reward.friends) {
            btn.textContent = '🎁 ЗАБРАТЬ';
            btn.style.background = `linear-gradient(135deg, #f59e0b, #d97706)`;
            btn.style.color = '#fff';
            btn.style.cursor = 'pointer';
            btn.disabled = false;
            btn.onclick = () => claimFriendReward(reward.friends, reward.creatureId, reward.creatureName, reward.creatureIcon);
            if (card) card.style.borderColor = `var(--${reward.rarity})`;
        } else {
            btn.textContent = `🔒 ${reward.friends} ДРУЗЕЙ 5+ УРОВНЯ`;
            btn.style.background = '#1a2540';
            btn.style.color = '#94a3b8';
            btn.style.cursor = 'not-allowed';
            btn.disabled = true;
        }
    });
    
    renderFriendsList();
}

// ============================================================
// SPECIAL QUESTS (С СОХРАНЕНИЕМ В localStorage)
// ============================================================

// Функция загрузки статусов квестов из localStorage
function loadQuestStatusesFromStorage() {
    const saved = localStorage.getItem(QUESTS_STORAGE_KEY);
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            for (const [questId, data] of Object.entries(parsed)) {
                if (data.expiresAt && data.expiresAt > Date.now()) {
                    const remainingSeconds = Math.ceil((data.expiresAt - Date.now()) / 1000);
                    questStatuses.set(questId, {
                        status: data.status,
                        expiresAt: data.expiresAt,
                        timerId: null
                    });
                    restartQuestTimer(questId, remainingSeconds);
                } else if (data.status === 'pending' && data.expiresAt && data.expiresAt <= Date.now()) {
                    questStatuses.set(questId, { status: 'available', expiresAt: null, timerId: null });
                    saveQuestStatusesToStorage();
                    if (document.getElementById(`tab-special`).classList.contains('active')) {
                        updateQuestButton(questId, 'available');
                    }
                } else if (data.status === 'available') {
                    questStatuses.set(questId, { status: 'available', expiresAt: null, timerId: null });
                }
            }
        } catch (e) {
            console.error('Ошибка загрузки статусов квестов:', e);
        }
    }
}

// Функция сохранения статусов квестов в localStorage
function saveQuestStatusesToStorage() {
    const toSave = {};
    for (const [questId, data] of questStatuses.entries()) {
        toSave[questId] = {
            status: data.status,
            expiresAt: data.expiresAt || null
        };
    }
    localStorage.setItem(QUESTS_STORAGE_KEY, JSON.stringify(toSave));
}

// Функция перезапуска таймера квеста
function restartQuestTimer(questId, remainingSeconds) {
    if (remainingSeconds <= 0) return;
    
    const timerId = setTimeout(async () => {
        const questData = questStatuses.get(questId);
        if (questData && questData.status === 'pending') {
            questStatuses.set(questId, { status: 'available', expiresAt: null, timerId: null });
            saveQuestStatusesToStorage();
            updateQuestButton(questId, 'available');
            
            const quest = SPECIAL_QUESTS.find(q => q.id === questId);
            if (quest) {
                showToast(`✅ Квест "${quest.title}" выполнен! Нажмите "ЗАБРАТЬ" для получения награды.`, '🎁');
            }
        }
    }, remainingSeconds * 1000);
    
    const questData = questStatuses.get(questId);
    if (questData) {
        questData.timerId = timerId;
        questStatuses.set(questId, questData);
    }
}

// Функция очистки всех таймеров квестов
function clearAllQuestTimers() {
    for (const [questId, data] of questStatuses.entries()) {
        if (data.timerId) {
            clearTimeout(data.timerId);
        }
    }
    questStatuses.clear();
    localStorage.removeItem(QUESTS_STORAGE_KEY);
}

// Функция получения названия квеста
function getQuestTitle(questId) {
    const quest = SPECIAL_QUESTS.find(q => q.id === questId);
    return quest ? quest.title : 'квест';
}

// Функция обновления кнопки квеста в зависимости от статуса
function updateQuestButton(questId, status) {
    const questCard = document.querySelector(`.special-quest-card[data-quest-id="${questId}"]`);
    if (!questCard) return;
    
    const footer = questCard.querySelector('.special-quest-footer');
    if (!footer) return;
    
    const quest = SPECIAL_QUESTS.find(q => q.id === questId);
    if (!quest) return;
    
    const isCompleted = state.user?.completedSpecialQuests?.includes(questId);
    
    if (isCompleted) {
        footer.innerHTML = `<button class="special-quest-btn completed" disabled><i class="fa-solid fa-check"></i> ВЫПОЛНЕНО</button>`;
        return;
    }
    
    switch (status) {
        case 'pending':
            footer.innerHTML = `<button class="special-quest-btn pending" disabled style="background: #f59e0b; animation: pulse 1.5s infinite;">
                <i class="fa-solid fa-clock"></i> ⏳ НА ПРОВЕРКЕ...
            </button>`;
            break;
        case 'available':
            footer.innerHTML = `<button class="special-quest-btn claim" onclick="claimSpecialQuest('${questId}')" style="background: linear-gradient(135deg, #eab308, #ca8a04); animation: pulse 1.5s infinite;">
                <i class="fa-solid fa-gift"></i> 🎁 ЗАБРАТЬ НАГРАДУ
            </button>`;
            break;
        default:
            if (quest.type === 'telegram_channel') {
                footer.innerHTML = `<button class="special-quest-btn" onclick="openChannelAndStartTimer('${quest.id}', '${quest.link}')">
                    <i class="fa-brands fa-telegram"></i> ВЫПОЛНИТЬ
                </button>`;
            } else if (quest.type === 'custom_link') {
                footer.innerHTML = `<button class="special-quest-btn" onclick="openCustomLinkAndComplete('${quest.id}', '${quest.link}')">
                    <i class="fa-solid fa-globe"></i> ВЫПОЛНИТЬ
                </button>`;
            } else if (quest.type === 'referral_count') {
                const currentFriends = state.user?.referralCount || 0;
                const required = quest.required_count || 1;
                if (currentFriends >= required) {
                    footer.innerHTML = `<button class="special-quest-btn claim" onclick="claimSpecialQuest('${quest.id}')">
                        <i class="fa-solid fa-gift"></i> ЗАБРАТЬ (${currentFriends}/${required})
                    </button>`;
                } else {
                    footer.innerHTML = `<button class="special-quest-btn locked" disabled>
                        <i class="fa-solid fa-lock"></i> НУЖНО ${required} ДРУЗЕЙ 5+ (${currentFriends})
                    </button>`;
                }
            }
            break;
    }
}

function openChannelAndStartTimer(questId, channelLink) {
    if (channelLink) {
        if (window.Telegram?.WebApp && channelLink.includes('t.me')) {
            window.Telegram.WebApp.openTelegramLink(channelLink);
        } else {
            window.open(channelLink, '_blank');
        }
    }
    
    if (state.user?.completedSpecialQuests?.includes(questId)) {
        showToast('Вы уже получили награду за этот квест', 'ℹ️');
        return;
    }
    
    const existingStatus = questStatuses.get(questId);
    if (existingStatus && existingStatus.status === 'pending') {
        const remainingTime = existingStatus.expiresAt ? Math.ceil((existingStatus.expiresAt - Date.now()) / 1000) : 0;
        if (remainingTime > 0) {
            showToast(`Квест уже на проверке! Осталось ${remainingTime} секунд.`, '⏳');
            return;
        }
    }
    
    if (existingStatus && existingStatus.status === 'available') {
        showToast('Квест уже выполнен! Нажмите "ЗАБРАТЬ НАГРАДУ".', '🎁');
        updateQuestButton(questId, 'available');
        return;
    }
    
    const expiresAt = Date.now() + 60000;
    questStatuses.set(questId, { 
        status: 'pending', 
        expiresAt: expiresAt,
        timerId: null 
    });
    saveQuestStatusesToStorage();
    
    updateQuestButton(questId, 'pending');
    
    const timerId = setTimeout(async () => {
        const questData = questStatuses.get(questId);
        if (questData && questData.status === 'pending') {
            questStatuses.set(questId, { status: 'available', expiresAt: null, timerId: null });
            saveQuestStatusesToStorage();
            updateQuestButton(questId, 'available');
            
            showToast(`✅ Квест "${getQuestTitle(questId)}" выполнен! Нажмите "ЗАБРАТЬ" для получения награды.`, '🎁');
        }
    }, 60000);
    
    const questData = questStatuses.get(questId);
    questData.timerId = timerId;
    questStatuses.set(questId, questData);
    
    showToast('🔍 Проверка выполнения квеста... Подождите 60 секунд.', '⏳');
}

function openCustomLinkAndComplete(questId, link) {
    if (link) {
        window.open(link, '_blank');
    }
    
    if (state.user?.completedSpecialQuests?.includes(questId)) {
        showToast('Вы уже получили награду за этот квест', 'ℹ️');
        return;
    }
    
    const existingStatus = questStatuses.get(questId);
    if (existingStatus && existingStatus.status === 'pending') {
        const remainingTime = existingStatus.expiresAt ? Math.ceil((existingStatus.expiresAt - Date.now()) / 1000) : 0;
        if (remainingTime > 0) {
            showToast(`Квест уже на проверке! Осталось ${remainingTime} секунд.`, '⏳');
            return;
        }
    }
    
    if (existingStatus && existingStatus.status === 'available') {
        showToast('Квест уже выполнен! Нажмите "ЗАБРАТЬ НАГРАДУ".', '🎁');
        updateQuestButton(questId, 'available');
        return;
    }
    
    const expiresAt = Date.now() + 60000;
    questStatuses.set(questId, { 
        status: 'pending', 
        expiresAt: expiresAt,
        timerId: null 
    });
    saveQuestStatusesToStorage();
    
    updateQuestButton(questId, 'pending');
    
    const timerId = setTimeout(async () => {
        const questData = questStatuses.get(questId);
        if (questData && questData.status === 'pending') {
            questStatuses.set(questId, { status: 'available', expiresAt: null, timerId: null });
            saveQuestStatusesToStorage();
            updateQuestButton(questId, 'available');
            
            showToast(`✅ Квест "${getQuestTitle(questId)}" выполнен! Нажмите "ЗАБРАТЬ" для получения награды.`, '🎁');
        }
    }, 60000);
    
    const questData = questStatuses.get(questId);
    questData.timerId = timerId;
    questStatuses.set(questId, questData);
    
    showToast('🔍 Проверка выполнения квеста... Подождите 60 секунд.', '⏳');
}

async function claimSpecialQuest(questId) {
    if (state.isLoading) return;
    
    const questStatus = questStatuses.get(questId);
    if (questStatus && questStatus.status !== 'available') {
        if (questStatus && questStatus.status === 'pending') {
            const remainingTime = questStatus.expiresAt ? Math.ceil((questStatus.expiresAt - Date.now()) / 1000) : 0;
            if (remainingTime > 0) {
                showToast(`Квест ещё на проверке! Осталось ${remainingTime} секунд.`, '⏳');
            } else {
                showToast('Квест ещё на проверке! Подождите немного.', '⏳');
            }
        } else {
            showToast('Сначала выполните квест!', '⚠️');
        }
        return;
    }
    
    if (state.user?.completedSpecialQuests?.includes(questId)) {
        showToast('Вы уже получили награду за этот квест', 'ℹ️');
        return;
    }
    
    state.isLoading = true;
    const res = await apiRequest('POST', '/api/game/complete-special-quest', { questId });
    state.isLoading = false;
    
    if (!res.success) {
        showToast(res.message || 'Ошибка', '❌');
        return;
    }
    
    state.user = res.user;
    updateServerSnapshot(state.user.balance, state.incomePerHour, state.user.lastPassiveIncome || null);
    updateHeader();
    
    const existing = questStatuses.get(questId);
    if (existing && existing.timerId) {
        clearTimeout(existing.timerId);
    }
    questStatuses.delete(questId);
    saveQuestStatusesToStorage();
    
    await renderSpecialQuests();
    showToast(`+${res.reward} MMO получено!`, '✅');
    spawnFloatingMMO(res.reward);
}

async function claimSpecialQuestSilent(questId) {
    if (state.isLoading) return;
    
    const questStatus = questStatuses.get(questId);
    if (questStatus && questStatus.status !== 'available') {
        return;
    }
    
    if (state.user?.completedSpecialQuests?.includes(questId)) {
        return;
    }
    
    state.isLoading = true;
    const res = await apiRequest('POST', '/api/game/complete-special-quest', { questId });
    state.isLoading = false;
    
    if (!res.success) {
        console.log('Ошибка получения награды:', res.message);
        return;
    }
    
    state.user = res.user;
    updateServerSnapshot(state.user.balance, state.incomePerHour, state.user.lastPassiveIncome || null);
    updateHeader();
    
    const existing = questStatuses.get(questId);
    if (existing && existing.timerId) {
        clearTimeout(existing.timerId);
    }
    questStatuses.delete(questId);
    saveQuestStatusesToStorage();
    
    await renderSpecialQuests();
    showToast(`+${res.reward} MMO получено за квест!`, '✅');
}

async function renderSpecialQuests() {
    const container = document.getElementById('specialQuestsList');
    if (!container) return;

    if (!SPECIAL_QUESTS.length) {
        container.innerHTML = `<div class="empty-grid" style="padding:40px;text-align:center">📢 Нет активных спец-квестов</div>`;
        return;
    }

    const completedQuests = new Set(state.user?.completedSpecialQuests || []);
    
    const filteredQuests = SPECIAL_QUESTS.filter(q => 
        q.type === 'telegram_channel' || q.type === 'referral_count' || q.type === 'custom_link'
    );
    
    if (filteredQuests.length === 0) {
        container.innerHTML = `<div class="empty-grid" style="padding:40px;text-align:center">📢 Скоро появятся новые квесты!</div>`;
        return;
    }
    
    // Обновляем статусы из localStorage при рендере
    for (const [questId, data] of questStatuses.entries()) {
        if (data.status === 'pending' && data.expiresAt && data.expiresAt <= Date.now()) {
            questStatuses.set(questId, { status: 'available', expiresAt: null, timerId: null });
            saveQuestStatusesToStorage();
        }
    }
    
    container.innerHTML = filteredQuests.map(quest => {
        const isCompleted = completedQuests.has(quest.id);
        const questStatus = questStatuses.get(quest.id);
        
        let actionHtml = '';
        
        if (isCompleted) {
            actionHtml = `<button class="special-quest-btn completed" disabled><i class="fa-solid fa-check"></i> ВЫПОЛНЕНО</button>`;
        } else if (questStatus && questStatus.status === 'pending') {
            const remainingTime = questStatus.expiresAt ? Math.ceil((questStatus.expiresAt - Date.now()) / 1000) : 60;
            const remainingText = remainingTime > 0 ? ` (${remainingTime}с)` : '';
            actionHtml = `<button class="special-quest-btn pending" disabled style="background: #f59e0b; animation: pulse 1.5s infinite;">
                <i class="fa-solid fa-clock"></i> ⏳ НА ПРОВЕРКЕ${remainingText}
            </button>`;
        } else if (questStatus && questStatus.status === 'available') {
            actionHtml = `<button class="special-quest-btn claim" onclick="claimSpecialQuest('${quest.id}')" style="background: linear-gradient(135deg, #eab308, #ca8a04); animation: pulse 1.5s infinite;">
                <i class="fa-solid fa-gift"></i> 🎁 ЗАБРАТЬ НАГРАДУ
            </button>`;
        } else {
            switch (quest.type) {
                case 'telegram_channel':
                    actionHtml = `<button class="special-quest-btn" onclick="openChannelAndStartTimer('${quest.id}', '${quest.link}')">
                        <i class="fa-brands fa-telegram"></i> ВЫПОЛНИТЬ
                    </button>`;
                    break;
                case 'custom_link':
                    actionHtml = `<button class="special-quest-btn" onclick="openCustomLinkAndComplete('${quest.id}', '${quest.link}')">
                        <i class="fa-solid fa-globe"></i> ВЫПОЛНИТЬ
                    </button>`;
                    break;
                case 'referral_count':
                    const currentFriends = state.user?.referralCount || 0;
                    const required = quest.required_count || 1;
                    if (currentFriends >= required) {
                        actionHtml = `<button class="special-quest-btn claim" onclick="claimSpecialQuest('${quest.id}')">
                            <i class="fa-solid fa-gift"></i> ЗАБРАТЬ (${currentFriends}/${required})
                        </button>`;
                    } else {
                        actionHtml = `<button class="special-quest-btn locked" disabled>
                            <i class="fa-solid fa-lock"></i> НУЖНО ${required} ДРУЗЕЙ 5+ (${currentFriends})
                        </button>`;
                    }
                    break;
            }
        }
        
        return `<div class="special-quest-card" data-quest-id="${quest.id}">
            <div class="special-quest-header">
                <div class="special-quest-icon">${quest.icon || '🎯'}</div>
                <div class="special-quest-info">
                    <div class="special-quest-title">${escapeHtml(quest.title)}</div>
                    <div class="special-quest-desc">${escapeHtml(quest.description || '')}</div>
                </div>
                <div class="special-quest-reward">+${quest.reward} MMO</div>
            </div>
            <div class="special-quest-footer">${actionHtml}</div>
        </div>`;
    }).join('');
    
    // Запускаем обновление таймеров каждую секунду для отображения обратного отсчета
    if (window.questTimerInterval) clearInterval(window.questTimerInterval);
    window.questTimerInterval = setInterval(() => {
        const pendingButtons = document.querySelectorAll('.special-quest-btn.pending');
        if (pendingButtons.length === 0) {
            if (window.questTimerInterval) clearInterval(window.questTimerInterval);
            return;
        }
        
        for (const btn of pendingButtons) {
            const card = btn.closest('.special-quest-card');
            if (card) {
                const questId = card.dataset.questId;
                const questStatus = questStatuses.get(questId);
                if (questStatus && questStatus.expiresAt) {
                    const remaining = Math.ceil((questStatus.expiresAt - Date.now()) / 1000);
                    if (remaining > 0) {
                        btn.innerHTML = `<i class="fa-solid fa-clock"></i> ⏳ НА ПРОВЕРКЕ (${remaining}с)`;
                    } else {
                        btn.innerHTML = `<i class="fa-solid fa-clock"></i> ⏳ НА ПРОВЕРКЕ...`;
                    }
                }
            }
        }
    }, 1000);
}

async function updateSpecialQuests() {
    await loadGameConfig();
    renderSpecialQuests();
}

// ============================================================
// ДЕПОЗИТЫ И ВЫВОДЫ
// ============================================================

const MIN_TRANSACTION_AMOUNT = 5000;
const MAX_ACTIVE_REQUESTS = 2;

async function showDepositModal() {
    if (state.isLoading) return;
    
    const activeCount = await checkActiveRequests();
    if (activeCount >= MAX_ACTIVE_REQUESTS) {
        showToast(`У вас уже ${MAX_ACTIVE_REQUESTS} активных заявок. Дождитесь обработки.`, '⚠️');
        return;
    }
    
    document.getElementById('popup').innerHTML = `
        <div class="popup-close" onclick="closeOverlay()"><i class="fa-solid fa-xmark"></i></div>
        <div class="popup-title">💎 Пополнение баланса</div>
        <div class="popup-subtitle" style="margin-bottom:16px">Минимальная сумма: ${MIN_TRANSACTION_AMOUNT.toLocaleString()} MMO</div>
        <div class="price-input-modal">
            <div>
                <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Сумма (MMO)</div>
                <input type="number" class="price-input-field" id="depositAmount" placeholder="Введите сумму" min="${MIN_TRANSACTION_AMOUNT}">
            </div>
        </div>
        <button class="popup-btn" style="background:linear-gradient(135deg,#06b6d4,#0891b2);margin-top:16px" onclick="getPaymentDetails()">
            <i class="fa-solid fa-arrow-down"></i> ПРОДОЛЖИТЬ
        </button>
        <button class="popup-btn" style="background:#1a2540;color:#e2e8f0;margin-top:8px" onclick="closeOverlay()">ОТМЕНА</button>
    `;
    document.getElementById('overlay').classList.add('show');
}

async function getPaymentDetails() {
    const amountInput = document.getElementById('depositAmount');
    const amount = parseInt(amountInput?.value);
    
    if (!amount || amount < MIN_TRANSACTION_AMOUNT) {
        showToast(`Минимальная сумма ${MIN_TRANSACTION_AMOUNT.toLocaleString()} MMO`, '❌');
        return;
    }
    
    state.isLoading = true;
    const res = await apiRequest('POST', '/api/wallet/get-payment-details', { amount });
    state.isLoading = false;
    
    if (!res.success) {
        showToast(res.message || 'Ошибка', '❌');
        return;
    }
    
    currentPaymentMemo = res.memo;
    currentPaymentAmount = res.amount;
    
    showPaymentDetails(res.wallet, res.memo, res.amount);
}

function showPaymentDetails(wallet, memo, amount) {
    const amountInTON = (amount / 1000).toFixed(2);
    
    document.getElementById('popup').innerHTML = `
        <div class="popup-close" onclick="closeOverlay()"><i class="fa-solid fa-xmark"></i></div>
        <div class="popup-title">💎 Оплатите депозит</div>
        <div class="popup-subtitle">Сумма: ${amount.toLocaleString()} MMO</div>
        
        <div style="background:#0d1120;border:1px solid #1e2d4a;border-radius:16px;padding:16px;margin-bottom:16px">
            <div style="margin-bottom:12px">
                <div style="font-size:10px;color:#94a3b8;margin-bottom:4px">💰 Сумма в TON (примерно)</div>
                <div style="font-family:'Orbitron',monospace;font-size:18px;font-weight:700;color:#f59e0b">≈ ${amountInTON} TON</div>
            </div>
            
            <div style="margin-bottom:12px">
                <div style="font-size:10px;color:#94a3b8;margin-bottom:4px">🏦 Кошелек TON</div>
                <div style="background:#080b14;padding:10px;border-radius:10px;font-family:monospace;font-size:11px;word-break:break-all;border:1px solid #1e2d4a">
                    ${wallet}
                </div>
                <button onclick="copyToClipboard('${wallet}')" style="margin-top:6px;padding:4px 10px;background:#1a2540;border:none;border-radius:6px;color:#94a3b8;font-size:10px;cursor:pointer">
                    <i class="fa-regular fa-copy"></i> Копировать кошелек
                </button>
            </div>
            
            <div style="margin-bottom:12px">
                <div style="font-size:10px;color:#94a3b8;margin-bottom:4px">📝 Мемо (ОБЯЗАТЕЛЬНО!)</div>
                <div style="background:#080b14;padding:10px;border-radius:10px;font-family:monospace;font-size:11px;font-weight:700;color:#06b6d4;border:1px solid #1e2d4a">
                    ${memo}
                </div>
                <button onclick="copyToClipboard('${memo}')" style="margin-top:6px;padding:4px 10px;background:#1a2540;border:none;border-radius:6px;color:#94a3b8;font-size:10px;cursor:pointer">
                    <i class="fa-regular fa-copy"></i> Копировать мемо
                </button>
            </div>
            
            <div style="font-size:10px;color:#ef4444;background:rgba(239,68,68,0.1);padding:8px;border-radius:8px;margin-top:8px">
                ⚠️ <b>Важно!</b> Укажите мемо в комментарии к переводу!\nПосле оплаты нажмите "Я ОПЛАТИЛ".
            </div>
        </div>
        
        <div style="display:flex;gap:10px">
            <button class="popup-btn" style="flex:1;background:linear-gradient(135deg,#22c55e,#16a34a)" onclick="createDepositRequestAfterPayment()">
                <i class="fa-solid fa-check"></i> Я ОПЛАТИЛ
            </button>
            <button class="popup-btn" style="flex:1;background:#1a2540;color:#e2e8f0" onclick="closeOverlay()">
                <i class="fa-solid fa-times"></i> ОТМЕНИТЬ
            </button>
        </div>
    `;
    document.getElementById('overlay').classList.add('show');
}

async function createDepositRequestAfterPayment() {
    if (!currentPaymentMemo) {
        showToast('Ошибка: данные оплаты утеряны. Начните заново.', '❌');
        closeOverlay();
        return;
    }
    
    state.isLoading = true;
    showToast('Создание заявки...', '⏳');
    
    const res = await apiRequest('POST', '/api/wallet/create-deposit-request', { 
        memo: currentPaymentMemo
    });
    state.isLoading = false;
    
    if (!res.success) {
        showToast(res.message || 'Ошибка создания заявки', '❌');
        return;
    }
    
    closeOverlay();
    showToast('✅ Заявка создана! Администратор проверит платеж и начислит средства.', '✅');
    await checkActiveRequests();
    
    currentPaymentMemo = null;
    currentPaymentAmount = null;
}

async function showWithdrawModal() {
    if (state.isLoading) return;
    
    const activeCount = await checkActiveRequests();
    if (activeCount >= MAX_ACTIVE_REQUESTS) {
        showToast(`У вас уже ${MAX_ACTIVE_REQUESTS} активных заявок. Дождитесь обработки.`, '⚠️');
        return;
    }
    
    document.getElementById('popup').innerHTML = `
        <div class="popup-close" onclick="closeOverlay()"><i class="fa-solid fa-xmark"></i></div>
        <div class="popup-title">💸 Вывод средств</div>
        <div class="popup-subtitle" style="margin-bottom:16px">Минимальная сумма: ${MIN_TRANSACTION_AMOUNT.toLocaleString()} MMO</div>
        <div class="price-input-modal">
            <div>
                <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Сумма (MMO)</div>
                <input type="number" class="price-input-field" id="withdrawAmount" placeholder="Введите сумму" min="${MIN_TRANSACTION_AMOUNT}">
            </div>
            <div>
                <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">TON Кошелек</div>
                <input type="text" class="price-input-field" id="withdrawWallet" placeholder="Введите TON адрес кошелька">
            </div>
        </div>
        <button class="popup-btn" style="background:linear-gradient(135deg,#16a34a,#22c55e);margin-top:16px" onclick="createWithdrawRequest()">
            <i class="fa-solid fa-arrow-up"></i> ОТПРАВИТЬ ЗАЯВКУ
        </button>
        <button class="popup-btn" style="background:#1a2540;color:#e2e8f0;margin-top:8px" onclick="closeOverlay()">ОТМЕНА</button>
    `;
    document.getElementById('overlay').classList.add('show');
}

async function createWithdrawRequest() {
    const amountInput = document.getElementById('withdrawAmount');
    const walletInput = document.getElementById('withdrawWallet');
    
    const amount = parseInt(amountInput?.value);
    const wallet = walletInput?.value.trim();
    
    if (!amount || amount < MIN_TRANSACTION_AMOUNT) {
        showToast(`Минимальная сумма ${MIN_TRANSACTION_AMOUNT.toLocaleString()} MMO`, '❌');
        return;
    }
    
    if (!wallet || wallet.length < 20) {
        showToast('Введите корректный TON адрес кошелька (минимум 20 символов)', '❌');
        return;
    }
    
    if (state.user?.balance < amount) {
        showToast(`Недостаточно средств. Ваш баланс: ${state.user.balance.toLocaleString()} MMO`, '❌');
        return;
    }
    
    state.isLoading = true;
    const res = await apiRequest('POST', '/api/wallet/withdraw-request', { amount, wallet });
    state.isLoading = false;
    
    if (!res.success) {
        showToast(res.message || 'Ошибка создания заявки', '❌');
        return;
    }
    
    closeOverlay();
    showToast(`Заявка на вывод ${amount.toLocaleString()} MMO создана! Ожидайте подтверждения администратора.`, '✅');
    
    await refreshUserProfile();
    await checkActiveRequests();
}

async function checkActiveRequests() {
    try {
        const res = await apiRequest('GET', '/api/wallet/requests');
        if (res?.success) {
            const count = res.requests.length;
            const pendingDiv = document.getElementById('pendingRequests');
            if (pendingDiv) {
                if (count > 0) {
                    const requestsHtml = res.requests.map(req => `
                        <div style="background:#f59e0b22;border:1px solid #f59e0b44;border-radius:12px;padding:12px;margin-top:8px">
                            <div style="display:flex;justify-content:space-between;align-items:center">
                                <div>
                                    <div style="font-size:12px;font-weight:600;color:#f59e0b">
                                        ${req.type === 'deposit' ? '📥 Депозит' : '📤 Вывод'}
                                    </div>
                                    <div style="font-size:11px;color:#94a3b8">${req.amount.toLocaleString()} MMO</div>
                                    <div style="font-size:9px;color:#4a5568">${new Date(req.createdAt).toLocaleString()}</div>
                                </div>
                                <div style="background:#f59e0b;padding:4px 10px;border-radius:20px;font-size:10px;font-weight:700">⏳ ОЖИДАНИЕ</div>
                            </div>
                        </div>
                    `).join('');
                    
                    pendingDiv.innerHTML = `
                        <div style="background:#f59e0b22;border:1px solid #f59e0b44;border-radius:12px;padding:10px;margin-top:10px">
                            <div style="font-size:11px;font-weight:600;color:#f59e0b;margin-bottom:8px">
                                <i class="fa-solid fa-clock"></i> Активных заявок: ${count}/${MAX_ACTIVE_REQUESTS}
                            </div>
                            ${requestsHtml}
                        </div>
                    `;
                } else {
                    pendingDiv.innerHTML = '';
                }
            }
            return count;
        }
    } catch (e) {
        console.error('checkActiveRequests error:', e);
    }
    return 0;
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('Скопировано!', '📋');
    }).catch(() => {
        showToast('Не удалось скопировать', '❌');
    });
}

// ============================================================
// NAVIGATION
// ============================================================
function switchTab(tab) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    document.getElementById(`nav-${tab}`).classList.add('active');
    document.getElementById('mainContent').scrollTop = 0;
    
    isMarketplaceTabActive = (tab === 'shop');

    if (tab === 'leaderboard') {
        leaderboardCache = { data: null, expiresAt: 0 };
        renderLeaderboard();
    }
    if (tab === 'special') renderSpecialQuests();
    if (tab === 'wallet') {
        updateHeader();
        checkActiveRequests();
    }
    if (tab === 'shop') renderMarketplaceBuy();
    if (tab === 'friends') renderFriendsList();


    if (tab === 'pvp') renderPvP();
}

// ============================================================
// OVERLAY
// ============================================================
function closeOverlay(e) {
    if (e && e.target !== document.getElementById('overlay')) return;
    document.getElementById('overlay').classList.remove('show');
}

// ============================================================
// TOAST
// ============================================================
function showToast(msg, icon = '') {
    const t = document.getElementById('toast');
    t.textContent = (icon ? icon + ' ' : '') + msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
}

// ============================================================
// EFFECTS
// ============================================================
function spawnStars(rarity) {
    const count = rarity === 'legendary' || rarity === 'mythic' ? 8 : rarity === 'epic' ? 5 : 3;
    const icons = ['✨', '⭐', '🌟', '💫', '✦'];
    for (let i = 0; i < count; i++) {
        setTimeout(() => {
            const el = document.createElement('div');
            el.className = 'star-burst';
            el.textContent = icons[Math.floor(Math.random() * icons.length)];
            el.style.left = (30 + Math.random() * 40) + '%';
            el.style.top = (20 + Math.random() * 40) + '%';
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 900);
        }, i * 80);
    }
}

function spawnFloatingMMO(amount) {
    const el = document.createElement('div');
    el.className = 'float-mmo';
    el.textContent = `${amount > 0 ? '+' : ''}${amount} MMO`;
    el.style.left = '50%';
    el.style.top = '40%';
    el.style.transform = 'translateX(-50%)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1600);
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    initTelegramApp();
});

// ============================================================
// ЭКСПОРТ ФУНКЦИЙ ДЛЯ ГЛОБАЛЬНОГО ДОСТУПА
// ============================================================

window.updateHeader = updateHeader;
window.renderCards = renderCards;
window.renderLeaderboard = renderLeaderboard;
window.renderSpecialQuests = renderSpecialQuests;
window.renderFriendsList = renderFriendsList;
window.updateFriendRewardButtons = updateFriendRewardButtons;
window.renderMarketplaceBuy = renderMarketplaceBuy;
window.renderMarketplaceSell = renderMarketplaceSell;
window.renderMarketplaceMyListings = renderMarketplaceMyListings;
window.showToast = showToast;
window.state = state;
window.formatNum = formatNum;
window.getVisualBalance = getVisualBalance;
window.updateAdsStatus = updateAdsStatus;
window.switchTab = switchTab;
window.closeOverlay = closeOverlay;
window.showCapsuleModal = showCapsuleModal;
window.openCapsule = openCapsule;
window.onCardClick = onCardClick;
window.showMergePreview = showMergePreview;
window.executeMerge = executeMerge;
window.upgradeInventory = upgradeInventory;
window.watchAd = watchAd;
window.showEncyclopedia = showEncyclopedia;
window.showCreatureInfo = showCreatureInfo;
window.switchMarketplaceTab = switchMarketplaceTab;
window.openSellModal = openSellModal;
window.updateFeeCalculator = updateFeeCalculator;
window.confirmSellListing = confirmSellListing;
window.cancelMarketplaceListing = cancelMarketplaceListing;
window.buyFromMarketplace = buyFromMarketplace;
window.inviteFriend = inviteFriend;
window.claimFriendReward = claimFriendReward;
window.openChannelAndStartTimer = openChannelAndStartTimer;
window.claimSpecialQuest = claimSpecialQuest;
window.openCustomLinkAndComplete = openCustomLinkAndComplete;
window.showDepositModal = showDepositModal;
window.getPaymentDetails = getPaymentDetails;
window.createDepositRequestAfterPayment = createDepositRequestAfterPayment;
window.showWithdrawModal = showWithdrawModal;
window.createWithdrawRequest = createWithdrawRequest;
window.copyToClipboard = copyToClipboard;
window.checkActiveRequests = checkActiveRequests;