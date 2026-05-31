// ============================================
// server.js - ОПТИМИЗИРОВАННАЯ ВЕРСИЯ
// ============================================

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression'); // [OPTIMIZATION] Добавлено gzip сжатие

const app = express();

// ============================================
// MIDDLEWARE
// ============================================
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token']
}));
app.use(express.json());
app.use(compression()); // [OPTIMIZATION] Включено сжатие ответов

// ============================================
// РАСШИРЕННЫЙ RATE LIMITING С АВТООЧИСТКОЙ
// ============================================
const rateLimit = new Map();
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = 60 * 1000;

// [OPTIMIZATION] Автоматическая очистка rateLimit раз в минуту
setInterval(() => {
    const now = Date.now();
    let deletedCount = 0;
    for (const [ip, record] of rateLimit.entries()) {
        if (now > record.resetAt) {
            rateLimit.delete(ip);
            deletedCount++;
        }
    }
    if (deletedCount > 0) {
        console.log(`🧹 Очищено ${deletedCount} записей rateLimit`);
    }
}, RATE_LIMIT_WINDOW);

function rateLimiter(req, res, next) {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    
    if (!rateLimit.has(ip)) {
        rateLimit.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
        return next();
    }
    
    const record = rateLimit.get(ip);
    if (now > record.resetAt) {
        rateLimit.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
        return next();
    }
    
    if (record.count >= RATE_LIMIT_MAX) {
        return res.status(429).json({ success: false, message: 'Слишком много запросов. Подождите.' });
    }
    
    record.count++;
    next();
}

app.use(rateLimiter);

// ============================================
// СПЕЦИАЛЬНЫЙ RATE LIMIT ДЛЯ АДМИН-ЛОГИНА
// ============================================
const adminLoginAttempts = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of adminLoginAttempts.entries()) {
        if (now > data.resetAt) {
            adminLoginAttempts.delete(ip);
        }
    }
}, 60 * 60 * 1000);

// ============================================
// ПРОВЕРКА JWT_SECRET
// ============================================
if (!process.env.JWT_SECRET) {
    console.error('❌ JWT_SECRET не задан в .env');
    process.exit(1);
}

// ============================================
// ПОДКЛЮЧЕНИЕ К MongoDB С POOL SIZE
// ============================================
// [OPTIMIZATION] Увеличен poolSize для параллельных запросов
mongoose.connect(process.env.MONGODB_URI, {
    maxPoolSize: 20,
    minPoolSize: 5
})
    .then(() => {
        console.log('✅ MongoDB подключена');
        createIndexes();
    })
    .catch(err => console.error('❌ MongoDB ошибка:', err));

async function createIndexes() {
    try {
        await User.collection.createIndex({ level: -1, xp: -1 });
        await User.collection.createIndex({ telegramId: 1 });
        await User.collection.createIndex({ referralCode: 1 });
        await User.collection.createIndex({ referredBy: 1 });
        await User.collection.createIndex({ lastLogin: -1 });
        await Inventory.collection.createIndex({ telegramId: 1, creatureId: 1 });
        // [OPTIMIZATION] Новые индексы для ускорения частых запросов
        await Inventory.collection.createIndex({ telegramId: 1, count: -1 });
        await Marketplace.collection.createIndex({ active: 1, createdAt: -1 });
        await User.collection.createIndex({ level: -1, xp: -1, balance: -1 });
        console.log('✅ Индексы созданы');
    } catch (e) {
        console.warn('⚠️ Индексы:', e.message);
    }
}

// ============================================
// КОНСТАНТЫ
// ============================================
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [];
const MAX_OFFLINE_HOURS = 8;
const CLEANUP_INTERVAL = 60 * 60 * 1000;
const RECORD_TTL = 60 * 60 * 1000;
const MIN_TRANSACTION_AMOUNT = 5000;
const MAX_ACTIVE_REQUESTS = 2;
const MAX_ADS_PER_DAY = 10;
const REFERRAL_BONUS_PERCENT = 2;
const MAX_ACTIVE_LISTINGS = 2;
const MIN_MARKETPLACE_PRICE = 500;

// КЭШИ
let leaderboardCache = { data: null, expiresAt: 0 };
let marketplaceListingsCache = { data: null, expiresAt: 0 };
let cachedConfig = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 60 * 1000;

// [OPTIMIZATION] Кэш для инвентаря
const inventoryCache = new Map();
const INVENTORY_CACHE_TTL = 5000; // 5 секунд

// [OPTIMIZATION] Кэш для статистики админки
let cachedAdminStats = { data: null, expiresAt: 0 };
const ADMIN_STATS_CACHE_TTL = 60 * 1000; // 1 минута

// [OPTIMIZATION] Кэш для дохода пользователя
const userIncomeCache = new Map();
const INCOME_CACHE_TTL = 10000; // 10 секунд

// ============================================
// АДМИН АВТОРИЗАЦИЯ ПО ЛОГИНУ/ПАРОЛЮ
// ============================================

const ADMIN_LOGIN = process.env.ADMIN_LOGIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_LOGIN || !ADMIN_PASSWORD) {
    console.error('❌ ОШИБКА: ADMIN_LOGIN и ADMIN_PASSWORD должны быть заданы в .env');
    process.exit(1);
}

const adminSessions = new Map();

const adminAuthMiddleware = async (req, res, next) => {
    const sessionToken = req.headers['x-admin-token'];
    
    if (!sessionToken) {
        return res.status(401).json({ success: false, message: 'Не авторизован' });
    }
    
    const session = adminSessions.get(sessionToken);
    if (!session || session.expiresAt < Date.now()) {
        if (session) adminSessions.delete(sessionToken);
        return res.status(401).json({ success: false, message: 'Сессия истекла' });
    }
    
    req.adminLogin = session.login;
    next();
};

app.post('/api/admin/login', async (req, res) => {
    try {
        const { login, password } = req.body;
        const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
        
        if (!login || !password) {
            return res.status(400).json({ success: false, message: 'Введите логин и пароль' });
        }
        
        let attempts = adminLoginAttempts.get(ip);
        const now = Date.now();
        
        if (!attempts) {
            attempts = { count: 0, resetAt: now + 15 * 60 * 1000 };
            adminLoginAttempts.set(ip, attempts);
        }
        
        if (now > attempts.resetAt) {
            attempts.count = 0;
            attempts.resetAt = now + 15 * 60 * 1000;
        }
        
        if (attempts.count >= 5) {
            return res.status(429).json({ 
                success: false, 
                message: 'Слишком много попыток. Попробуйте через 15 минут.' 
            });
        }
        
        if (login !== ADMIN_LOGIN || password !== ADMIN_PASSWORD) {
            attempts.count++;
            adminLoginAttempts.set(ip, attempts);
            return res.status(401).json({ success: false, message: 'Неверный логин или пароль' });
        }
        
        adminLoginAttempts.delete(ip);
        
        const token = crypto.randomBytes(32).toString('hex');
        
        adminSessions.set(token, {
            login: login,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000
        });
        
        res.json({ success: true, token: token });
        
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/logout', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (token) {
        adminSessions.delete(token);
    }
    res.json({ success: true });
});

setInterval(() => {
    const now = Date.now();
    for (const [token, session] of adminSessions.entries()) {
        if (session.expiresAt < now) {
            adminSessions.delete(token);
        }
    }
}, 60 * 60 * 1000);

// ============================================
// МОДЕЛИ
// ============================================

const TransactionRequestSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    telegramId: { type: String, required: true },
    type: { type: String, enum: ['deposit', 'withdraw'], required: true },
    amount: { type: Number, required: true, min: MIN_TRANSACTION_AMOUNT },
    wallet: { type: String, default: '' },
    memo: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    adminNote: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null }
});

const TransactionRequest = mongoose.model('TransactionRequest', TransactionRequestSchema);

const PendingDepositSchema = new mongoose.Schema({
    memo: { type: String, required: true, unique: true },
    telegramId: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now, expires: 86400 }
});
const PendingDeposit = mongoose.model('PendingDeposit', PendingDepositSchema);

const MarketSaleHistorySchema = new mongoose.Schema({
    listingId: { type: mongoose.Schema.Types.ObjectId, required: true },
    creatureId: { type: String, required: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sellerTgId: { type: String, required: true },
    sellerName: { type: String, default: '' },
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    buyerTgId: { type: String, required: true },
    buyerName: { type: String, default: '' },
    price: { type: Number, required: true },
    fee: { type: Number, required: true },
    sellerEarns: { type: Number, required: true },
    soldAt: { type: Date, default: Date.now }
});

const MarketSaleHistory = mongoose.model('MarketSaleHistory', MarketSaleHistorySchema);

const SpecialQuestSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    icon: { type: String, default: '🎯' },
    reward: { type: Number, required: true, min: 1 },
    type: { type: String, enum: ['telegram_channel', 'custom_link', 'referral_count'], required: true },
    link: { type: String, default: '' },
    required_count: { type: Number, default: 1 },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

const GameConfigSchema = new mongoose.Schema({
    capsuleCosts: { basic: Number, premium: Number },
    capsuleRarities: {
        basic: { common: Number, uncommon: Number, rare: Number, epic: Number, legendary: Number },
        premium: { common: Number, uncommon: Number, rare: Number, epic: Number, legendary: Number }
    },
    adReward: { type: Number, default: 100 },
    adCooldown: { type: Number, default: 60 },
    upgradeBaseCost: { type: Number, default: 300 },
    upgradeMultiplier: { type: Number, default: 1.5 },
    specialQuests: [SpecialQuestSchema],
    limits: {
        maxInventorySlots: { type: Number, default: 50 },
        maxMarketplacePrice: { type: Number, default: 100000 },
        maxLevel: { type: Number, default: 100 }
    },
    updatedAt: { type: Date, default: Date.now }
});
const GameConfig = mongoose.model('GameConfig', GameConfigSchema);

const CreatureSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    rarity: { type: String, enum: RARITY_ORDER, required: true },
    icon: { type: String, required: true, default: '🧬' },
    incomeBase: { type: Number, required: true, min: 1 },
    desc: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});
const Creature = mongoose.model('Creature', CreatureSchema);

const UserSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    username: { type: String, default: '' },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    photoUrl: { type: String, default: '' },
    balance: { type: Number, default: 4000 },
    xp: { type: Number, default: 0 },
    level: { type: Number, default: 1 },
    mergeCount: { type: Number, default: 0 },
    capsulesOpened: { type: Number, default: 0 },
    inventorySlots: { type: Number, default: 10 },
    inventoryUpgrades: { type: Number, default: 0 },
    discovered: [{ type: String }],
    completedSpecialQuests: [{ type: String }],
    isBanned: { type: Boolean, default: false },
    banReason: { type: String, default: '' },
    transactions: [{
        name: String,
        amount: Number,
        time: { type: Date, default: Date.now }
    }],
    adsCooldownUntil: { type: Date, default: null },
    adsDailyCount: { type: Number, default: 0 },
    adsDailyReset: { type: Date, default: Date.now },
    lastPassiveIncome: { type: Date, default: Date.now },
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: String, default: null },
    referralCount: { type: Number, default: 0 },
    totalReferralBonus: { type: Number, default: 0 },
    notifiedLostIncome: { type: Boolean, default: false },
    lastLogin: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    // [OPTIMIZATION] Кэшированный доход
    cachedIncome: { type: Number, default: 0 },
    incomeCacheExpires: { type: Date, default: Date.now }
});

UserSchema.pre('save', function(next) {
    if (!this.referralCode) {
        this.referralCode = 'REF' + this.telegramId + Math.random().toString(36).slice(2, 7).toUpperCase();
    }
    next();
});

const User = mongoose.model('User', UserSchema);

const InventorySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    telegramId: { type: String, required: true },
    creatureId: { type: String, required: true },
    count: { type: Number, default: 1 },
    createdAt: { type: Date, default: Date.now }
});
InventorySchema.index({ telegramId: 1, creatureId: 1 }, { unique: true });
const Inventory = mongoose.model('Inventory', InventorySchema);

const MarketplaceSchema = new mongoose.Schema({
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sellerTgId: { type: String, required: true },
    sellerName: { type: String, default: '' },
    creatureId: { type: String, required: true },
    price: { type: Number, required: true, min: MIN_MARKETPLACE_PRICE },
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});
const Marketplace = mongoose.model('Marketplace', MarketplaceSchema);


// ============================================
// PVP МОДЕЛИ (добавить после существующих моделей)
// ============================================

// PvP Статистика игрока
const PvPStatsSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    league: { type: String, enum: ['bronze', 'silver', 'gold', 'platinum', 'diamond'], default: 'bronze' },
    leaguePoints: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    totalWonMMO: { type: Number, default: 0 },
    totalLostMMO: { type: Number, default: 0 },
    currentStreak: { type: Number, default: 0 },
    bestStreak: { type: Number, default: 0 },
    lastBattleAt: { type: Date, default: null },
    dailyBattles: { type: Number, default: 0 },
    dailyReset: { type: Date, default: Date.now }
});

// PvP Очередь
const PvPQueueSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    telegramId: { type: String, required: true },
    league: { type: String, required: true },
    leaguePoints: { type: Number, default: 0 },
    teamPower: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, expires: 120 } // автоудаление через 2 минуты
});

// PvP Матч
const PvPMatchSchema = new mongoose.Schema({
    player1: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    player2: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    betAmount: { type: Number, default: 100 },
    status: { 
        type: String, 
        enum: ['waiting', 'ready', 'in_progress', 'completed', 'cancelled', 'expired'], 
        default: 'waiting' 
    },
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    winnerGets: { type: Number, default: 0 },
    burnedFee: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: () => Date.now() + 60 * 1000 } // 60 секунд
});

const PvPStats = mongoose.model('PvPStats', PvPStatsSchema);
const PvPQueue = mongoose.model('PvPQueue', PvPQueueSchema);
const PvPMatch = mongoose.model('PvPMatch', PvPMatchSchema);

// ============================================
// PVP КОНСТАНТЫ
// ============================================

const LEAGUES = {
    bronze: { name: 'Бронзовая', minPoints: 0, maxPoints: 299, entryFee: 50, color: '#cd7c3a', icon: '🥉', nextLeague: 'silver' },
    silver: { name: 'Серебряная', minPoints: 300, maxPoints: 699, entryFee: 100, color: '#c0c0c0', icon: '🥈', nextLeague: 'gold' },
    gold: { name: 'Золотая', minPoints: 700, maxPoints: 1199, entryFee: 200, color: '#f59e0b', icon: '🥇', nextLeague: 'platinum' },
    platinum: { name: 'Платиновая', minPoints: 1200, maxPoints: 1799, entryFee: 400, color: '#06b6d4', icon: '💎', nextLeague: 'diamond' },
    diamond: { name: 'Алмазная', minPoints: 1800, maxPoints: 9999, entryFee: 800, color: '#a855f7', icon: '🔮', nextLeague: null }
};

const RARITY_POWER_MULTIPLIER = {
    common: 1,
    uncommon: 2,
    rare: 4,
    epic: 8,
    legendary: 16,
    mythic: 32
};

const PVP_LIMITS = {
    maxBattlesPerDay: 20,
    minTimeBetweenBattles: 30, // секунд
    cancelPenalty: 50, // MMO штраф
    maxQueueTime: 60 // секунд
};

// ============================================
// PVP ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

async function getOrCreatePvPStats(telegramId) {
    let stats = await PvPStats.findOne({ telegramId });
    if (!stats) {
        stats = await PvPStats.create({ telegramId });
    }
    
    // Проверка дневного сброса
    const now = new Date();
    const lastReset = new Date(stats.dailyReset);
    if (now.getDate() !== lastReset.getDate() || now.getMonth() !== lastReset.getMonth()) {
        stats.dailyBattles = 0;
        stats.dailyReset = now;
        await stats.save();
    }
    
    return stats;
}

async function calculateTeamPower(telegramId) {
    const inventory = await Inventory.find({ telegramId }).lean();
    
    if (inventory.length === 0) return 0;
    
    let creatures = creaturesCache;
    if (!creatures) {
        creatures = await Creature.find({ isActive: true }).lean();
    }
    
    const creatureMap = new Map();
    for (const c of creatures) {
        creatureMap.set(c.id, c);
    }
    
    // Рассчитываем силу каждого существа: incomeBase * rarityMultiplier
    const powers = [];
    for (const item of inventory) {
        const creature = creatureMap.get(item.creatureId);
        if (creature) {
            const power = creature.incomeBase * RARITY_POWER_MULTIPLIER[creature.rarity];
            // Добавляем каждое существо отдельно (с учётом count)
            for (let i = 0; i < Math.min(item.count, 3); i++) {
                powers.push(power);
            }
        }
    }
    
    // Берём 3 самых сильных
    const top3 = powers.sort((a, b) => b - a).slice(0, 3);
    const totalPower = top3.reduce((sum, p) => sum + p, 0);
    
    // Проверка на 3 одинаковых существа (бонус синергии)
    const itemsList = [];
    for (const item of inventory) {
        const creature = creatureMap.get(item.creatureId);
        if (creature) {
            for (let i = 0; i < Math.min(item.count, 3); i++) {
                itemsList.push(creature.name);
            }
        }
    }
    const top3Names = itemsList.sort().slice(0, 3);
    const allSame = top3Names.length === 3 && top3Names.every(n => n === top3Names[0]);
    
    return allSame ? Math.floor(totalPower * 1.2) : totalPower; // +20% за сет
}

function getLeagueByPoints(points) {
    if (points <= 299) return 'bronze';
    if (points <= 699) return 'silver';
    if (points <= 1199) return 'gold';
    if (points <= 1799) return 'platinum';
    return 'diamond';
}

function getLeagueInfo(league) {
    return LEAGUES[league];
}

function calculateLeaguePointsChange(winnerPoints, loserPoints) {
    const diff = Math.abs(winnerPoints - loserPoints);
    
    if (winnerPoints < loserPoints) {
        // Победа над сильным
        return { winner: 30, loser: 15 };
    } else if (diff > 300) {
        // Победа над слабым — меньше очков
        return { winner: 10, loser: 5 };
    } else {
        // Равный бой
        return { winner: 20, loser: 10 };
    }
}

async function updateLeaguePoints(telegramId, pointsChange) {
    const stats = await getOrCreatePvPStats(telegramId);
    let newPoints = stats.leaguePoints + pointsChange;
    if (newPoints < 0) newPoints = 0;
    
    const newLeague = getLeagueByPoints(newPoints);
    
    stats.leaguePoints = newPoints;
    stats.league = newLeague;
    await stats.save();
    
    return { newPoints, newLeague };
}

// ============================================
// PVP API ЭНДПОИНТЫ
// ============================================

// Получить PvP статистику
app.get('/api/pvp/stats', authMiddleware, async (req, res) => {
    try {
        const stats = await getOrCreatePvPStats(req.user.telegramId);
        const leagueInfo = getLeagueInfo(stats.league);
        
        // Получаем текущий матч если есть
        const activeMatch = await PvPMatch.findOne({
            $or: [{ player1: req.user._id }, { player2: req.user._id }],
            status: { $in: ['waiting', 'ready', 'in_progress'] }
        });
        
        res.json({
            success: true,
            stats: {
                league: stats.league,
                leagueName: leagueInfo.name,
                leagueIcon: leagueInfo.icon,
                leagueColor: leagueInfo.color,
                leaguePoints: stats.leaguePoints,
                nextLeaguePoints: leagueInfo.nextLeague ? LEAGUES[leagueInfo.nextLeague].minPoints : null,
                entryFee: leagueInfo.entryFee,
                wins: stats.wins,
                losses: stats.losses,
                winRate: stats.wins + stats.losses > 0 ? Math.round((stats.wins / (stats.wins + stats.losses)) * 100) : 0,
                totalWonMMO: stats.totalWonMMO,
                totalLostMMO: stats.totalLostMMO,
                currentStreak: stats.currentStreak,
                bestStreak: stats.bestStreak,
                dailyBattles: stats.dailyBattles,
                maxDailyBattles: PVP_LIMITS.maxBattlesPerDay
            },
            activeMatch: activeMatch ? {
                id: activeMatch._id,
                status: activeMatch.status,
                betAmount: activeMatch.betAmount
            } : null
        });
    } catch (e) {
        console.error('pvp stats error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Вступить в очередь поиска
app.post('/api/pvp/queue/join', authMiddleware, async (req, res) => {
    try {
        const user = req.user;
        const stats = await getOrCreatePvPStats(user.telegramId);
        const leagueInfo = getLeagueInfo(stats.league);
        
        // Проверка лимитов
        if (stats.dailyBattles >= PVP_LIMITS.maxBattlesPerDay) {
            return res.status(400).json({ 
                success: false, 
                message: `Лимит боёв на сегодня: ${PVP_LIMITS.maxBattlesPerDay}` 
            });
        }
        
        if (stats.lastBattleAt) {
            const secondsSinceLastBattle = (Date.now() - new Date(stats.lastBattleAt).getTime()) / 1000;
            if (secondsSinceLastBattle < PVP_LIMITS.minTimeBetweenBattles) {
                return res.status(400).json({ 
                    success: false, 
                    message: `Подождите ${Math.ceil(PVP_LIMITS.minTimeBetweenBattles - secondsSinceLastBattle)} секунд между боями` 
                });
            }
        }
        
        // Проверка баланса для ставки
        if (user.balance < leagueInfo.entryFee) {
            return res.status(400).json({ 
                success: false, 
                message: `Недостаточно MMO. Нужно ${leagueInfo.entryFee} MMO для входа в ${leagueInfo.name} лигу` 
            });
        }
        
        // Проверяем, не в очереди ли уже
        const existingInQueue = await PvPQueue.findOne({ userId: user._id });
        if (existingInQueue) {
            return res.status(400).json({ success: false, message: 'Вы уже в очереди' });
        }
        
        // Списываем ставку
        await User.updateOne({ _id: user._id }, { $inc: { balance: -leagueInfo.entryFee } });
        
        // Рассчитываем силу команды
        const teamPower = await calculateTeamPower(user.telegramId);
        
        // Добавляем в очередь
        await PvPQueue.create({
            userId: user._id,
            telegramId: user.telegramId,
            league: stats.league,
            leaguePoints: stats.leaguePoints,
            teamPower
        });
        
        // Запускаем поиск соперника
        tryMatchPlayers();
        
        res.json({ success: true, message: 'Вы в очереди на бой' });
        
    } catch (e) {
        console.error('pvp queue join error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Выйти из очереди
app.post('/api/pvp/queue/leave', authMiddleware, async (req, res) => {
    try {
        const user = req.user;
        const queueEntry = await PvPQueue.findOne({ userId: user._id });
        
        if (queueEntry) {
            const leagueInfo = getLeagueInfo(queueEntry.league);
            // Возвращаем ставку
            await User.updateOne({ _id: user._id }, { $inc: { balance: leagueInfo.entryFee } });
            await PvPQueue.deleteOne({ userId: user._id });
        }
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Функция поиска соперников
async function tryMatchPlayers() {
    const queues = await PvPQueue.aggregate([
        { $group: { _id: "$league", players: { $push: "$$ROOT" } } }
    ]);
    
    for (const leagueGroup of queues) {
        const players = leagueGroup.players;
        
        while (players.length >= 2) {
            const p1 = players.shift();
            const p2 = players.shift();
            
            // Проверка, что игроки ещё в очереди
            const p1Exists = await PvPQueue.findOne({ userId: p1.userId });
            const p2Exists = await PvPQueue.findOne({ userId: p2.userId });
            
            if (!p1Exists || !p2Exists) continue;
            
            // Удаляем из очереди
            await PvPQueue.deleteMany({ userId: { $in: [p1.userId, p2.userId] } });
            
            const leagueInfo = getLeagueInfo(leagueGroup._id);
            
            // Создаём матч
            const match = await PvPMatch.create({
                player1: p1.userId,
                player2: p2.userId,
                betAmount: leagueInfo.entryFee,
                status: 'ready',
                expiresAt: new Date(Date.now() + 30 * 1000)
            });
            
            // Уведомляем игроков (через WebSocket или polling)
            console.log(`✅ Матч создан: ${p1.userId} vs ${p2.userId}`);
        }
    }
}

// Принять матч и выполнить бой
app.post('/api/pvp/accept-match', authMiddleware, async (req, res) => {
    try {
        const { matchId } = req.body;
        const user = req.user;
        
        const match = await PvPMatch.findById(matchId)
            .populate('player1')
            .populate('player2');
        
        if (!match) {
            return res.status(404).json({ success: false, message: 'Матч не найден' });
        }
        
        if (match.status !== 'ready') {
            return res.status(400).json({ success: false, message: 'Матч уже неактивен' });
        }
        
        if (match.expiresAt < new Date()) {
            match.status = 'expired';
            await match.save();
            return res.status(400).json({ success: false, message: 'Время на принятие матча истекло' });
        }
        
        // Убеждаемся, что игрок участвует в матче
        if (match.player1._id.toString() !== user._id.toString() && 
            match.player2._id.toString() !== user._id.toString()) {
            return res.status(403).json({ success: false, message: 'Это не ваш матч' });
        }
        
        match.status = 'in_progress';
        await match.save();
        
        // Рассчитываем силу команд
        const power1 = await calculateTeamPower(match.player1.telegramId);
        const power2 = await calculateTeamPower(match.player2.telegramId);
        
        // Логика боя
        const totalPower = power1 + power2;
        let winChance1 = totalPower > 0 ? power1 / totalPower : 0.5;
        
        // Добавляем случайность (20%)
        winChance1 = winChance1 * 0.8 + Math.random() * 0.2;
        
        const random = Math.random();
        const winner = random < winChance1 ? match.player1 : match.player2;
        const loser = winner._id === match.player1._id ? match.player2 : match.player1;
        
        // Расчёт выигрыша (75% от призового фонда, 25% сгорает)
        const prizePool = match.betAmount * 2;
        const winnerGets = Math.floor(prizePool * 0.75);
        const burnedFee = prizePool - winnerGets;
        
        // Начисляем победителю
        await User.updateOne({ _id: winner._id }, { $inc: { balance: winnerGets } });
        
        // Обновляем статистику
        const winnerStats = await getOrCreatePvPStats(winner.telegramId);
        const loserStats = await getOrCreatePvPStats(loser.telegramId);
        
        winnerStats.wins += 1;
        winnerStats.totalWonMMO += winnerGets;
        winnerStats.currentStreak += 1;
        winnerStats.bestStreak = Math.max(winnerStats.bestStreak, winnerStats.currentStreak);
        winnerStats.dailyBattles += 1;
        winnerStats.lastBattleAt = new Date();
        
        loserStats.losses += 1;
        loserStats.totalLostMMO += match.betAmount;
        loserStats.currentStreak = 0;
        loserStats.dailyBattles += 1;
        loserStats.lastBattleAt = new Date();
        
        // Обновляем очки лиги
        const pointsChange = calculateLeaguePointsChange(winnerStats.leaguePoints, loserStats.leaguePoints);
        await updateLeaguePoints(winner.telegramId, pointsChange.winner);
        await updateLeaguePoints(loser.telegramId, -pointsChange.loser);
        
        await winnerStats.save();
        await loserStats.save();
        
        // Завершаем матч
        match.winner = winner._id;
        match.winnerGets = winnerGets;
        match.burnedFee = burnedFee;
        match.status = 'completed';
        await match.save();
        
        // Логируем сгоревшие MMO
        console.log(`🔥 Сгорело MMO в PvP: ${burnedFee}`);
        
        res.json({
            success: true,
            result: {
                winner: winner._id.toString() === user._id.toString(),
                winnerName: winner.username || winner.firstName || 'Игрок',
                loserName: loser.username || loser.firstName || 'Игрок',
                winnerGets,
                burnedFee,
                power1,
                power2,
                winChance: Math.round(winChance1 * 100),
                leaguePointsChange: {
                    winner: pointsChange.winner,
                    loser: pointsChange.loser
                }
            }
        });
        
    } catch (e) {
        console.error('pvp accept match error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// PvP лидерборд
app.get('/api/pvp/leaderboard', authMiddleware, async (req, res) => {
    try {
        const { league } = req.query;
        const query = league ? { league } : {};
        
        const leaders = await PvPStats.find(query)
            .sort({ leaguePoints: -1, wins: -1 })
            .limit(50)
            .lean();
        
        // Обогащаем данными пользователей
        const enriched = await Promise.all(leaders.map(async (stat, idx) => {
            const user = await User.findOne({ telegramId: stat.telegramId })
                .select('username firstName level');
            const leagueInfo = getLeagueInfo(stat.league);
            return {
                rank: idx + 1,
                username: user?.username || user?.firstName || 'Аноним',
                level: user?.level || 1,
                league: stat.league,
                leagueIcon: leagueInfo.icon,
                leagueColor: leagueInfo.color,
                points: stat.leaguePoints,
                wins: stat.wins,
                losses: stat.losses,
                winRate: stat.wins + stat.losses > 0 ? Math.round((stat.wins / (stat.wins + stat.losses)) * 100) : 0
            };
        }));
        
        res.json({ success: true, leaders: enriched });
    } catch (e) {
        console.error('pvp leaderboard error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Отмена матча (если игрок не принял)
app.post('/api/pvp/cancel-match', authMiddleware, async (req, res) => {
    try {
        const { matchId } = req.body;
        const user = req.user;
        
        const match = await PvPMatch.findById(matchId);
        if (!match) {
            return res.status(404).json({ success: false, message: 'Матч не найден' });
        }
        
        if (match.status !== 'ready') {
            return res.status(400).json({ success: false, message: 'Матч нельзя отменить' });
        }
        
        // Штраф для отменившего
        await User.updateOne({ _id: user._id }, { $inc: { balance: -PVP_LIMITS.cancelPenalty } });
        
        match.status = 'cancelled';
        await match.save();
        
        res.json({ success: true, message: `Матч отменён. Штраф: -${PVP_LIMITS.cancelPenalty} MMO` });
        
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// История боёв
app.get('/api/pvp/history', authMiddleware, async (req, res) => {
    try {
        const matches = await PvPMatch.find({
            $or: [{ player1: req.user._id }, { player2: req.user._id }],
            status: 'completed'
        })
            .populate('player1 player2 winner')
            .sort({ createdAt: -1 })
            .limit(20);
        
        const history = matches.map(match => {
            const isWinner = match.winner && match.winner._id.toString() === req.user._id.toString();
            const opponent = match.player1._id.toString() === req.user._id.toString() ? match.player2 : match.player1;
            return {
                id: match._id,
                opponentName: opponent?.username || opponent?.firstName || 'Игрок',
                isWinner,
                betAmount: match.betAmount,
                winnerGets: match.winnerGets,
                createdAt: match.createdAt
            };
        });
        
        res.json({ success: true, history });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Статус очереди (для polling)
app.get('/api/pvp/queue/status', authMiddleware, async (req, res) => {
    try {
        const inQueue = await PvPQueue.exists({ userId: req.user._id });
        const activeMatch = await PvPMatch.findOne({
            $or: [{ player1: req.user._id }, { player2: req.user._id }],
            status: { $in: ['ready', 'in_progress'] }
        });
        
        res.json({
            success: true,
            inQueue: !!inQueue,
            activeMatch: activeMatch ? {
                id: activeMatch._id,
                status: activeMatch.status,
                betAmount: activeMatch.betAmount,
                expiresAt: activeMatch.expiresAt
            } : null
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ С КЭШИРОВАНИЕМ
// ============================================

function escapeRegex(str) {
    if (!str) return '';
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let creaturesCache = null;

// [OPTIMIZATION] Кэшированная версия formatInventory
async function formatInventory(telegramId) {
    const cached = inventoryCache.get(telegramId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
    }
    
    const inventory = await Inventory.find({ telegramId }).lean();
    if (inventory.length === 0) {
        inventoryCache.set(telegramId, { data: [], expiresAt: Date.now() + INVENTORY_CACHE_TTL });
        return [];
    }
    
    let creatures = creaturesCache;
    if (!creatures) {
        creatures = await Creature.find({ isActive: true }).lean();
        creaturesCache = creatures;
    }
    
    const creatureMap = new Map();
    for (const c of creatures) {
        creatureMap.set(c.id, c);
    }
    
    const result = inventory.map(item => {
        const creature = creatureMap.get(item.creatureId);
        return { ...item, incomeBase: creature?.incomeBase || 1 };
    });
    
    inventoryCache.set(telegramId, { data: result, expiresAt: Date.now() + INVENTORY_CACHE_TTL });
    return result;
}

// [OPTIMIZATION] Функция для инвалидации кэша инвентаря
function invalidateInventoryCache(telegramId) {
    inventoryCache.delete(telegramId);
    userIncomeCache.delete(telegramId);
}

// [OPTIMIZATION] Кэшированная версия getUserIncome
async function getUserIncome(telegramId) {
    const cached = userIncomeCache.get(telegramId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.income;
    }
    
    const inventory = await Inventory.find({ telegramId }).lean();
    if (inventory.length === 0) return 0;
    
    let creatures = creaturesCache;
    if (!creatures) {
        creatures = await Creature.find({ isActive: true }).lean();
        creaturesCache = creatures;
    }
    
    const creatureMap = new Map();
    for (const c of creatures) {
        creatureMap.set(c.id, c);
    }
    
    let income = 0;
    for (const item of inventory) {
        const creature = creatureMap.get(item.creatureId);
        if (creature) {
            income += creature.incomeBase * item.count;
        }
    }
    
    userIncomeCache.set(telegramId, { income, expiresAt: Date.now() + INCOME_CACHE_TTL });
    return income;
}

function addTransaction(user, name, amount) {
    user.transactions.unshift({ name, amount, time: new Date() });
    if (user.transactions.length > 30) user.transactions = user.transactions.slice(0, 30);
}

function addXP(user, amount) {
    user.xp += amount;
    const needed = user.level * 100;
    if (user.xp >= needed) {
        user.xp -= needed;
        user.level += 1;
    }
}

function formatUser(user) {
    return {
        id: user._id,
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        photoUrl: user.photoUrl,
        balance: user.balance,
        xp: user.xp,
        level: user.level,
        mergeCount: user.mergeCount,
        capsulesOpened: user.capsulesOpened,
        inventorySlots: user.inventorySlots,
        inventoryUpgrades: user.inventoryUpgrades,
        discovered: user.discovered || [],
        completedSpecialQuests: user.completedSpecialQuests || [],
        transactions: (user.transactions || []).slice(0, 20),
        adsCooldownUntil: user.adsCooldownUntil,
        adsDailyCount: user.adsDailyCount || 0,
        adsDailyReset: user.adsDailyReset,
        referralCode: user.referralCode,
        referralCount: user.referralCount,
        totalReferralBonus: user.totalReferralBonus || 0,
        isBanned: user.isBanned,
        banReason: user.banReason,
        lastLogin: user.lastLogin,
        lastPassiveIncome: user.lastPassiveIncome,
        createdAt: user.createdAt
    };
}

// ============================================
// ПАССИВНЫЙ ДОХОД
// ============================================
const incomeLocks = new Map();

async function calculateAndAddIncome(user, forceCheck = false) {
    const telegramId = user.telegramId;

    if (incomeLocks.get(telegramId)) {
        return { earned: 0, elapsedSeconds: 0 };
    }
    incomeLocks.set(telegramId, true);

    try {
        const freshUser = await User.findOne({ telegramId }).select('lastPassiveIncome balance transactions');
        if (!freshUser) return { earned: 0, elapsedSeconds: 0 };

        const now = Date.now();
        const lastIncome = new Date(freshUser.lastPassiveIncome).getTime();
        let elapsedSeconds = (now - lastIncome) / 1000;
        if (elapsedSeconds < 0) elapsedSeconds = 0;

        if (!forceCheck && elapsedSeconds < 60) {
            return { earned: 0, elapsedSeconds: 0 };
        }

        const MAX_SECONDS = MAX_OFFLINE_HOURS * 3600;
        const cappedSeconds = Math.min(elapsedSeconds, MAX_SECONDS);

        const inventory = await Inventory.find({ telegramId }).lean();
        
        let creatures = creaturesCache;
        if (!creatures) {
            creatures = await Creature.find({ isActive: true }).lean();
            creaturesCache = creatures;
        }
        
        const creatureMap = new Map();
        for (const c of creatures) {
            creatureMap.set(c.id, c);
        }
        
        let incomePerHour = 0;
        for (const item of inventory) {
            const creature = creatureMap.get(item.creatureId);
            if (creature) incomePerHour += creature.incomeBase * item.count;
        }

        const earned = Math.floor((incomePerHour / 3600) * cappedSeconds * 100) / 100;
        if (earned < 0.01) {
            return { earned: 0, elapsedSeconds: 0, incomePerHour };
        }

        const newLastPassiveIncome = new Date(now);
        const newTx = { name: 'Passive Income', amount: earned, time: new Date() };

        const updated = await User.findOneAndUpdate(
            {
                telegramId,
                lastPassiveIncome: freshUser.lastPassiveIncome
            },
            {
                $inc: { balance: earned },
                $set: { lastPassiveIncome: newLastPassiveIncome },
                $push: {
                    transactions: {
                        $each: [newTx],
                        $position: 0,
                        $slice: 30
                    }
                }
            },
            { new: true }
        );

        if (!updated) {
            return { earned: 0, elapsedSeconds: 0, incomePerHour };
        }

        user.balance = updated.balance;
        user.lastPassiveIncome = updated.lastPassiveIncome;
        user.transactions = updated.transactions;

        return { earned, elapsedSeconds: cappedSeconds, incomePerHour };
    } finally {
        incomeLocks.delete(telegramId);
    }
}

// ============================================
// КЭШИРОВАНИЕ КОНФИГА
// ============================================
async function getGameConfig() {
    const now = Date.now();
    if (cachedConfig && now - configCacheTime < CONFIG_CACHE_TTL) {
        return cachedConfig;
    }
    
    let config = await GameConfig.findOne();
    if (!config) {
        config = await GameConfig.create({
            capsuleCosts: { basic: 500, premium: 2000 },
            capsuleRarities: {
                basic: { common: 80, uncommon: 20, rare: 0, epic: 0, legendary: 0 },
                premium: { common: 60, uncommon: 30, rare: 10, epic: 2, legendary: 1 }
            },
            adReward: 100,
            adCooldown: 60,
            upgradeBaseCost: 300,
            upgradeMultiplier: 1.5,
            specialQuests: [],
            limits: {
                maxInventorySlots: 50,
                maxMarketplacePrice: 100000,
                maxLevel: 100
            }
        });
        console.log('✅ Созданы настройки игры по умолчанию');
    }
    
    cachedConfig = config;
    configCacheTime = now;
    return config;
}

async function invalidateConfigCache() {
    cachedConfig = null;
    configCacheTime = 0;
    leaderboardCache = { data: null, expiresAt: 0 };
    marketplaceListingsCache = { data: null, expiresAt: 0 };
    creaturesCache = null;
    inventoryCache.clear();
    userIncomeCache.clear();
    console.log('🔄 Кэш конфига сброшен');
}

// ============================================
// ФУНКЦИИ ДЛЯ СУЩЕСТВ
// ============================================

async function getCreature(id) {
    if (creaturesCache) {
        return creaturesCache.find(c => c.id === id) || null;
    }
    const creature = await Creature.findOne({ id });
    return creature;
}

async function loadCreaturesToCache() {
    creaturesCache = await Creature.find({ isActive: true }).lean();
    console.log(`✅ Загружено ${creaturesCache.length} существ в кэш`);
}

async function randomCreatureByRarity(rarity) {
    const pool = creaturesCache ? creaturesCache.filter(c => c.rarity === rarity && c.isActive) : await Creature.find({ rarity, isActive: true });
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
}

// ============================================
// ОЧИСТКА СТАРЫХ ЗАПИСЕЙ
// ============================================
const lastOpenTimes = new Map();
const lastMergeTimes = new Map();

function cleanupOldRecords() {
    const now = Date.now();
    let deletedOpen = 0, deletedMerge = 0;
    
    for (const [id, time] of lastOpenTimes) {
        if (now - time > RECORD_TTL) {
            lastOpenTimes.delete(id);
            deletedOpen++;
        }
    }
    
    for (const [id, time] of lastMergeTimes) {
        if (now - time > RECORD_TTL) {
            lastMergeTimes.delete(id);
            deletedMerge++;
        }
    }
    
    if (deletedOpen > 0 || deletedMerge > 0) {
        console.log(`🧹 Очищено ${deletedOpen} openTimes, ${deletedMerge} mergeTimes`);
    }
}

setInterval(cleanupOldRecords, CLEANUP_INTERVAL);

// ============================================
// ХРАНИЛИЩЕ ДЛЯ РЕАЛЬНЫХ МЕТРИК
// ============================================
let recentErrors = [];
let requestLog = [];
const REQUEST_LOG_MAX = 1000;

app.use((req, res, next) => {
    const startTime = Date.now();
    
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        
        if (res.statusCode >= 500) {
            recentErrors.unshift({
                timestamp: new Date().toISOString(),
                status: res.statusCode,
                path: req.path,
                method: req.method,
                message: res.statusMessage || 'Server error'
            });
            if (recentErrors.length > 100) recentErrors.pop();
            console.error(`❌ ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`);
        }
        
        requestLog.unshift({
            timestamp: Date.now(),
            path: req.path,
            status: res.statusCode
        });
        if (requestLog.length > REQUEST_LOG_MAX) requestLog.pop();
    });
    
    next();
});

app.get('/api/admin/metrics', adminAuthMiddleware, async (req, res) => {
    try {
        const oneMinuteAgo = Date.now() - 60 * 1000;
        
        const requestsLastMinute = requestLog.filter(log => log.timestamp > oneMinuteAgo).length;
        const errorsLastMinute = requestLog.filter(log => 
            log.timestamp > oneMinuteAgo && log.status >= 500 && log.status < 600
        ).length;
        
        const errorRate5xx = requestsLastMinute > 0 
            ? (errorsLastMinute / requestsLastMinute * 100).toFixed(3)
            : 0;
        
        const memUsage = process.memoryUsage();
        res.json({
            success: true,
            requestsLastMinute: requestsLastMinute,
            errorRate5xx: parseFloat(errorRate5xx),
            uptime: Math.floor(process.uptime()),
            memoryUsage: Math.round(memUsage.rss / 1024 / 1024),
            recentErrors: recentErrors.slice(0, 20),
            timestamp: Date.now()
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.delete('/api/admin/metrics/errors', adminAuthMiddleware, async (req, res) => {
    recentErrors = [];
    res.json({ success: true, message: 'Ошибки очищены' });
});

// ============================================
// SUSPICIOUS EVENTS
// ============================================
let suspiciousEvents = [];

app.get('/api/admin/suspicious-events', adminAuthMiddleware, async (req, res) => {
    try {
        res.json({ success: true, events: suspiciousEvents });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/suspicious-events', adminAuthMiddleware, async (req, res) => {
    try {
        const { userId, userName, reason } = req.body;
        if (!userId || !reason) {
            return res.status(400).json({ success: false, message: 'Не все поля заполнены' });
        }
        
        const event = {
            id: Date.now().toString(),
            userId,
            userName: userName || 'Unknown',
            reason,
            timestamp: new Date().toISOString(),
            status: 'open'
        };
        
        suspiciousEvents.unshift(event);
        if (suspiciousEvents.length > 100) suspiciousEvents.pop();
        
        res.json({ success: true, event });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// LOGS ПОЛЬЗОВАТЕЛЯ
// ============================================
app.get('/api/admin/users/:id/logs', adminAuthMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('transactions');
        if (!user) {
            return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        }
        res.json({ success: true, logs: user.transactions || [] });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// ИСТОРИЯ ПРОДАЖ МАРКЕТА (АДМИН)
// ============================================
app.get('/api/admin/market-sales-history', adminAuthMiddleware, async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        
        const history = await MarketSaleHistory.find()
            .sort({ soldAt: -1 })
            .limit(parseInt(limit))
            .lean();
        
        let creatures = creaturesCache;
        if (!creatures) {
            creatures = await Creature.find({ isActive: true }).lean();
        }
        
        const creatureMap = new Map();
        for (const c of creatures) {
            creatureMap.set(c.id, c);
        }
        
        const enrichedHistory = history.map(sale => ({
            ...sale,
            creature: creatureMap.get(sale.creatureId) || { name: sale.creatureId, rarity: 'common', icon: '🧬' }
        }));
        
        res.json({ success: true, history: enrichedHistory });
    } catch (e) {
        console.error('market-sales-history error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// MIDDLEWARE (ОСНОВНОЙ API)
// ============================================
const authMiddleware = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ success: false, message: 'Токен не предоставлен' });
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.userId);
        if (!user) return res.status(401).json({ success: false, message: 'Пользователь не найден' });
        if (user.isBanned) {
            return res.status(403).json({ success: false, message: `Ваш аккаунт заблокирован. Причина: ${user.banReason || 'Нарушение правил'}` });
        }
        req.user = user;
        next();
    } catch (e) {
        return res.status(401).json({ success: false, message: 'Невалидный токен' });
    }
};

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});

app.get('/', (req, res) => {
    res.json({ success: true, message: '🚀 DNA MMO Backend работает!', version: '5.0.5' });
});

// ============================================
// ПУБЛИЧНЫЕ ЭНДПОИНТЫ
// ============================================
app.get('/api/game/config', async (req, res) => {
    try {
        const config = await getGameConfig();
        res.json({
            success: true,
            config: {
                capsuleCosts: config.capsuleCosts,
                capsuleRarities: config.capsuleRarities,
                adReward: config.adReward,
                adCooldown: config.adCooldown,
                upgradeBaseCost: config.upgradeBaseCost,
                upgradeMultiplier: config.upgradeMultiplier,
                limits: config.limits,
                specialQuests: config.specialQuests.filter(q => q.isActive),
                marketplace: {
                    minPrice: MIN_MARKETPLACE_PRICE,
                    maxActiveListings: MAX_ACTIVE_LISTINGS
                }
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/game/creatures', async (req, res) => {
    try {
        const creatures = await Creature.find({ isActive: true }).sort({ rarity: 1, name: 1 });
        res.json({ success: true, creatures });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// AUTH
// ============================================
const verifyTelegramData = (initData, botToken) => {
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        if (!hash) return null;
        urlParams.delete('hash');
        const params = [];
        urlParams.forEach((value, key) => params.push(`${key}=${value}`));
        params.sort();
        const dataCheckString = params.join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (calculatedHash !== hash) return null;
        const userStr = urlParams.get('user');
        if (!userStr) return null;
        return JSON.parse(decodeURIComponent(userStr));
    } catch (e) {
        console.error('Telegram auth error:', e);
        return null;
    }
};

app.post('/api/auth/login', async (req, res) => {
    try {
        const { initData, referralCode } = req.body;
        
        if (!initData) {
            return res.status(400).json({ success: false, message: 'initData обязателен' });
        }

        let userData = verifyTelegramData(initData, process.env.BOT_TOKEN);

        if (!userData && process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH === 'true') {
            try {
                const urlParams = new URLSearchParams(initData);
                const userStr = urlParams.get('user');
                if (userStr) userData = JSON.parse(decodeURIComponent(userStr));
                if (!userData) userData = JSON.parse(initData);
                console.warn('⚠️ DEV MODE: Используется мок-авторизация');
            } catch (e) {}
        }

        if (!userData) {
            return res.status(401).json({ success: false, message: 'Невалидные данные Telegram' });
        }

        let user = await User.findOne({ telegramId: String(userData.id) });
        const isNewUser = !user;

        if (!user) {
            user = new User({
                telegramId: String(userData.id),
                username: userData.username || '',
                firstName: userData.first_name || '',
                lastName: userData.last_name || '',
                photoUrl: userData.photo_url || '',
                balance: 4000,
            });

            let referrerInfo = null;
            if (referralCode) {
                const referrer = await User.findOne({ referralCode });
                if (referrer && referrer.telegramId !== String(userData.id)) {
                    user.referredBy = referrer.telegramId;
                    referrer.referralCount += 1;
                    await referrer.save();
                    referrerInfo = referrer;
                    console.log(`✅ Реферал: ${userData.username || userData.first_name} приглашен ${referrer.username || referrer.firstName}`);
                }
            }
            await user.save();
            
            const inviterName = referrerInfo 
                ? (referrerInfo.username || referrerInfo.firstName || referrerInfo.telegramId)
                : (referralCode ? 'неизвестный код' : 'самостоятельно');
            
            const notificationMessage = `🆕 <b>НОВЫЙ ИГРОК!</b>\n\n` +
                `👤 ID: <code>${userData.id}</code>\n` +
                `📛 Имя: ${userData.first_name || '?'} ${userData.last_name || ''}\n` +
                `🔗 Username: ${userData.username ? '@' + userData.username : 'нет'}\n` +
                `🎁 Пригласил: ${inviterName}\n` +
                `💰 Баланс: ${user.balance} MMO\n` +
                `🕐 Время: ${new Date().toLocaleString()}`;
            
            await notifyAdmins(notificationMessage);
            
        } else {
            user.username = userData.username || user.username;
            user.firstName = userData.first_name || user.firstName;
            user.lastName = userData.last_name || user.lastName;
            user.lastLogin = new Date();
            await user.save();
        }

        const token = jwt.sign(
            { userId: user._id, telegramId: user.telegramId },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        const inventoryWithIncome = await formatInventory(user.telegramId);

        res.json({ 
            success: true, 
            token, 
            isNewUser, 
            user: formatUser(user), 
            inventory: inventoryWithIncome 
        });
    } catch (e) {
        console.error('Login error:', e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// ============================================
// ДЕПОЗИТЫ
// ============================================
app.post('/api/wallet/get-payment-details', authMiddleware, async (req, res) => {
    try {
        const { amount } = req.body;
        const user = req.user;
        
        if (amount < MIN_TRANSACTION_AMOUNT) {
            return res.status(400).json({ success: false, message: `Минимальная сумма ${MIN_TRANSACTION_AMOUNT.toLocaleString()} MMO` });
        }
        
        const walletAddress = process.env.TON_DEPOSIT_WALLET || 'UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        const generatedMemo = crypto.randomBytes(16).toString('hex');
        
        await PendingDeposit.create({
            memo: generatedMemo,
            telegramId: user.telegramId,
            userId: user._id,
            amount: amount
        });
        
        res.json({
            success: true,
            wallet: walletAddress,
            memo: generatedMemo,
            amount: amount
        });
        
    } catch (e) {
        console.error('get-payment-details error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/wallet/create-deposit-request', authMiddleware, async (req, res) => {
    try {
        const { memo } = req.body;
        const user = req.user;
        
        const pending = await PendingDeposit.findOne({ memo });
        if (!pending) {
            return res.status(404).json({ success: false, message: 'Данные платежа не найдены или истекли. Начните заново.' });
        }
        
        if (pending.telegramId !== user.telegramId) {
            return res.status(403).json({ success: false, message: 'Неверный мемо' });
        }
        
        const pendingCount = await TransactionRequest.countDocuments({
            telegramId: user.telegramId,
            status: 'pending'
        });
        
        if (pendingCount >= MAX_ACTIVE_REQUESTS) {
            return res.status(400).json({ success: false, message: `У вас уже ${MAX_ACTIVE_REQUESTS} активных заявок` });
        }
        
        const request = await TransactionRequest.create({
            userId: user._id,
            telegramId: user.telegramId,
            type: 'deposit',
            amount: pending.amount,
            wallet: process.env.TON_DEPOSIT_WALLET,
            memo: memo
        });
        
        await PendingDeposit.deleteOne({ memo });
        
        const replyMarkup = {
            inline_keyboard: [
                [
                    { text: "✅ ПОДТВЕРДИТЬ", callback_data: `approve_${request._id}` },
                    { text: "❌ ОТКЛОНИТЬ", callback_data: `reject_${request._id}` }
                ]
            ]
        };
        
        const adminMessage = `💎 <b>НОВАЯ ЗАЯВКА НА ДЕПОЗИТ</b>\n\n` +
            `🆔 #${request._id.toString().slice(-8)}\n` +
            `👤 ${user.username || user.firstName || user.telegramId}\n` +
            `💰 Сумма: ${request.amount.toLocaleString()} MMO\n` +
            `🏦 Кошелек TON: ${request.wallet}\n` +
            `📝 Мемо: <code>${request.memo}</code>\n` +
            `🕐 ${new Date().toLocaleString()}\n\n` +
            `⚠️ Проверьте получение средств по мемо и подтвердите заявку.`;
        
        await notifyAdmins(adminMessage, replyMarkup);
        
        res.json({
            success: true,
            request,
            message: 'Заявка создана! Администратор проверит платеж и начислит средства.'
        });
        
    } catch (e) {
        console.error('create-deposit-request error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// API ДЛЯ БОТА
// ============================================
app.get('/api/bot/user/:telegramId', async (req, res) => {
    const botKey = req.headers['x-bot-key'];
    if (!process.env.BOT_INTERNAL_KEY || botKey !== process.env.BOT_INTERNAL_KEY) {
        return res.status(403).json({ success: false, message: 'Доступ запрещён' });
    }
    
    try {
        const user = await User.findOne({ telegramId: req.params.telegramId });
        if (!user) {
            return res.json({ success: false, message: 'User not found' });
        }
        res.json({
            success: true,
            user: {
                telegramId: user.telegramId,
                username: user.username,
                firstName: user.firstName,
                balance: user.balance,
                level: user.level,
                xp: user.xp,
                mergeCount: user.mergeCount,
                capsulesOpened: user.capsulesOpened,
                inventorySlots: user.inventorySlots,
                referralCode: user.referralCode,
                referralCount: user.referralCount
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// ВЫВОДЫ
// ============================================
app.post('/api/wallet/withdraw-request', authMiddleware, async (req, res) => {
    try {
        const { amount, wallet } = req.body;
        const user = req.user;
        
        if (amount < MIN_TRANSACTION_AMOUNT) {
            return res.status(400).json({ success: false, message: `Минимальная сумма ${MIN_TRANSACTION_AMOUNT.toLocaleString()} MMO` });
        }
        
        if (!wallet || wallet.trim().length < 20) {
            return res.status(400).json({ success: false, message: 'Введите корректный TON кошелек (минимум 20 символов)' });
        }
        
        if (user.balance < amount) {
            return res.status(400).json({ success: false, message: 'Недостаточно средств' });
        }
        
        const pendingCount = await TransactionRequest.countDocuments({
            telegramId: user.telegramId,
            status: 'pending'
        });
        
        if (pendingCount >= MAX_ACTIVE_REQUESTS) {
            return res.status(400).json({ success: false, message: `У вас уже ${MAX_ACTIVE_REQUESTS} активных заявок. Дождитесь обработки.` });
        }
        
        const updatedUser = await User.findOneAndUpdate(
            { _id: user._id, balance: { $gte: amount } },
            {
                $inc: { balance: -amount },
                $push: {
                    transactions: {
                        $each: [{ 
                            name: `Withdraw request: ${amount} MMO to ${wallet.slice(0, 10)}...`, 
                            amount: -amount, 
                            time: new Date() 
                        }],
                        $position: 0,
                        $slice: 30
                    }
                }
            },
            { new: true }
        );
        
        if (!updatedUser) {
            return res.status(400).json({ success: false, message: 'Ошибка списания средств' });
        }
        
        const request = await TransactionRequest.create({
            userId: user._id,
            telegramId: user.telegramId,
            type: 'withdraw',
            amount,
            wallet: wallet.trim(),
            status: 'pending'
        });
        
        const replyMarkup = {
            inline_keyboard: [
                [
                    { text: "✅ ПОДТВЕРДИТЬ", callback_data: `approve_${request._id}` },
                    { text: "❌ ОТКЛОНИТЬ", callback_data: `reject_${request._id}` }
                ]
            ]
        };
        
        const adminMessage = `💸 <b>НОВАЯ ЗАЯВКА НА ВЫВОД</b>\n\n` +
            `🆔 #${request._id.toString().slice(-8)}\n` +
            `👤 ${user.username || user.firstName || user.telegramId}\n` +
            `💰 Сумма: ${amount.toLocaleString()} MMO\n` +
            `🏦 TON Кошелек: <code>${wallet}</code>\n` +
            `📊 Баланс после списания: ${updatedUser.balance.toLocaleString()} MMO\n` +
            `🕐 ${new Date().toLocaleString()}\n\n` +
            `⚠️ Средства уже списаны с баланса пользователя.\n` +
            `Подтвердите вывод, чтобы отправить средства на кошелек.`;
        
        await notifyAdmins(adminMessage, replyMarkup);
        
        try {
            await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: user.telegramId,
                    text: `💸 <b>Заявка на вывод создана</b>\n\n` +
                        `Сумма: -${amount.toLocaleString()} MMO\n` +
                        `Кошелек: <code>${wallet}</code>\n` +
                        `Статус: ⏳ Ожидает подтверждения администратора\n\n` +
                        `После подтверждения средства будут отправлены на ваш кошелек.`,
                    parse_mode: 'HTML'
                })
            });
        } catch (e) {}
        
        res.json({ 
            success: true, 
            request, 
            balance: updatedUser.balance,
            message: 'Заявка создана, средства списаны. Ожидайте подтверждения администратора.' 
        });
        
    } catch (e) {
        console.error('withdraw-request error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// АДМИН ОБРАБОТКА ЗАЯВОК
// ============================================
app.post('/api/admin/transaction-request/:id', adminAuthMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { action, note } = req.body;
        
        const request = await TransactionRequest.findById(id);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Заявка не найдена' });
        }
        
        if (request.status !== 'pending') {
            return res.status(400).json({ success: false, message: 'Заявка уже обработана' });
        }
        
        const user = await User.findById(request.userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        }
        
        if (action === 'approve') {
            if (request.type === 'deposit') {
                user.balance += request.amount;
                addTransaction(user, `Deposit (Подтвержден)`, request.amount);
                await user.save();
                
                if (user.referredBy) {
                    const referrer = await User.findOne({ telegramId: user.referredBy });
                    if (referrer) {
                        const referralBonus = Math.floor(request.amount * REFERRAL_BONUS_PERCENT / 100);
                        if (referralBonus > 0) {
                            referrer.balance += referralBonus;
                            referrer.totalReferralBonus = (referrer.totalReferralBonus || 0) + referralBonus;
                            addTransaction(referrer, `Referral bonus from ${user.username || user.firstName || user.telegramId} (${REFERRAL_BONUS_PERCENT}% of deposit)`, referralBonus);
                            await referrer.save();
                            
                            await sendNotificationToUser(referrer.telegramId, 
                                `🎉 <b>Реферальный бонус!</b>\n\n` +
                                `Ваш друг ${user.username || user.firstName || 'игрок'} пополнил баланс на ${request.amount.toLocaleString()} MMO\n` +
                                `Вы получили ${REFERRAL_BONUS_PERCENT}%: +${referralBonus.toLocaleString()} MMO\n\n` +
                                `💰 Ваш баланс: ${referrer.balance.toLocaleString()} MMO\n` +
                                `🏆 Всего получено бонусов: ${referrer.totalReferralBonus.toLocaleString()} MMO`
                            );
                            
                            console.log(`✅ Реферальный бонус: ${referrer.username || referrer.firstName} получил +${referralBonus} MMO за депозит ${user.telegramId}`);
                        }
                    }
                }
                
                const successMessage = `✅ <b>Депозит подтвержден!</b>\n\n` +
                    `┌─────────────────────┐\n` +
                    `│ 💰 Сумма: +${request.amount.toLocaleString()} MMO\n` +
                    `│ 💳 Баланс: ${user.balance.toLocaleString()} MMO\n` +
                    `└─────────────────────┘\n\n` +
                    `Спасибо за пополнение! 🎉`;
                await sendNotificationToUser(user.telegramId, successMessage);
                
            } else if (request.type === 'withdraw') {
                const successMessage = `✅ <b>Вывод подтвержден!</b>\n\n` +
                    `┌─────────────────────────┐\n` +
                    `│ 💰 Сумма: -${request.amount.toLocaleString()} MMO\n` +
                    `│ 💳 Баланс: ${user.balance.toLocaleString()} MMO\n` +
                    `│ 🏦 Кошелек: ${request.wallet}\n` +
                    `└─────────────────────────┘\n\n` +
                    `⏱ Средства поступят в течение 1-30 минут.`;
                await sendNotificationToUser(user.telegramId, successMessage);
            }
            
            request.status = 'approved';
            
        } else if (action === 'reject') {
            
            if (request.type === 'withdraw') {
                await User.findByIdAndUpdate(user._id, {
                    $inc: { balance: request.amount },
                    $push: {
                        transactions: {
                            $each: [{ 
                                name: `Withdraw rejected: refund ${request.amount} MMO`, 
                                amount: request.amount, 
                                time: new Date() 
                            }],
                            $position: 0,
                            $slice: 30
                        }
                    }
                });
                
                const rejectMessage = `❌ <b>Вывод отклонен</b>\n\n` +
                    `Средства возвращены на баланс.`;
                await sendNotificationToUser(user.telegramId, rejectMessage);
                
            } else if (request.type === 'deposit') {
                const rejectMessage = `❌ Депозит отклонен\n\n` +
                    `💰 Сумма: ${request.amount.toLocaleString()} MMO\n` +
                    `📝 Причина: ${note || 'Свяжитесь с администратором'}\n\n` +
                    `Если вы отправляли средства, обратитесь к администратору.`;
                await sendNotificationToUser(user.telegramId, rejectMessage);
            }
            
            request.status = 'rejected';
        }
        
        request.adminNote = note || request.adminNote;
        request.processedAt = new Date();
        await request.save();
        
        await notifyAdmins(`🔄 <b>ЗАЯВКА ОБРАБОТАНА</b>\n\n` +
            `🆔 #${request._id.toString().slice(-8)}\n` +
            `👤 ${user.username || user.firstName || user.telegramId}\n` +
            `💰 Сумма: ${request.amount.toLocaleString()} MMO\n` +
            `📊 Статус: ${action === 'approve' ? '✅ ПОДТВЕРЖДЕНА' : '❌ ОТКЛОНЕНА'}\n` +
            `🕐 ${new Date().toLocaleString()}`);
        
        res.json({ success: true, request, message: `Заявка ${action === 'approve' ? 'подтверждена' : 'отклонена'}` });
        
    } catch (e) {
        console.error('admin transaction request error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/wallet/requests', authMiddleware, async (req, res) => {
    try {
        const requests = await TransactionRequest.find({
            telegramId: req.user.telegramId,
            status: 'pending'
        }).sort({ createdAt: -1 });
        
        res.json({ success: true, requests });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// USER PROFILE
// ============================================
app.get('/api/user/profile', authMiddleware, async (req, res) => {
    try {
        const user = req.user;
        const incomeResult = await calculateAndAddIncome(user, false);
        const incomePerHour = incomeResult.incomePerHour ?? await getUserIncome(user.telegramId);
        const freshUser = await User.findOne({ telegramId: user.telegramId });
        const inventoryWithIncome = await formatInventory(user.telegramId);

        res.json({
            success: true,
            user: formatUser(freshUser),
            inventory: inventoryWithIncome,
            offlineEarned: incomeResult.earned || 0,
            incomePerHour: Math.floor(incomePerHour * 100) / 100,
            lastPassiveIncome: freshUser.lastPassiveIncome
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

app.post('/api/game/collect-income', authMiddleware, async (req, res) => {
    try {
        const user = req.user;
        const incomeResult = await calculateAndAddIncome(user, true);
        const freshUser = await User.findOne({ telegramId: user.telegramId })
            .select('balance lastPassiveIncome transactions');
        const incomePerHour = incomeResult.incomePerHour ?? await getUserIncome(user.telegramId);

        res.json({
            success: true,
            earned: incomeResult.earned || 0,
            balance: freshUser.balance,
            incomePerHour: Math.floor(incomePerHour * 100) / 100,
            lastPassiveIncome: freshUser.lastPassiveIncome
        });
    } catch (e) {
        console.error('collect-income error:', e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// ============================================
// РЕФЕРАЛЬНАЯ ИНФОРМАЦИЯ
// ============================================
app.get('/api/user/referrals', authMiddleware, async (req, res) => {
    try {
        const user = req.user;
        
        const allReferrals = await User.find({ referredBy: user.telegramId })
            .select('username firstName balance level createdAt')
            .lean();
        
        const qualifiedReferrals = allReferrals.filter(r => r.level >= 5);
        const qualifiedCount = qualifiedReferrals.length;
        
        if (user.referralCount !== qualifiedCount) {
            user.referralCount = qualifiedCount;
            await user.save();
        }

        res.json({
            success: true,
            referralCode: user.referralCode,
            referralLink: `https://t.me/${process.env.BOT_USERNAME}?start=${user.referralCode}`,
            referralCount: qualifiedCount,
            referrals: allReferrals.map(r => ({
                username: r.username || r.firstName || 'Аноним',
                balance: r.balance,
                level: r.level,
                isQualified: r.level >= 5,
                joinedAt: r.createdAt
            }))
        });
    } catch (e) {
        console.error('referrals error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

async function getQualifiedReferralsCount(telegramId) {
    const qualifiedUsers = await User.find({ 
        referredBy: telegramId,
        level: { $gte: 5 }
    }).select('_id');
    return qualifiedUsers.length;
}

// ============================================
// НАГРАДЫ ЗА ДРУЗЕЙ
// ============================================
app.post('/api/game/claim-friend-reward', authMiddleware, async (req, res) => {
    try {
        const { requiredFriends, creatureId } = req.body;
        const user = req.user;
        
        const qualifiedCount = await getQualifiedReferralsCount(user.telegramId);
        
        if (qualifiedCount < requiredFriends) {
            return res.status(400).json({ 
                success: false, 
                message: `Нужно ${requiredFriends} друзей 5+ уровня (у вас ${qualifiedCount})` 
            });
        }
        
        const rewardKey = `friend_reward_${requiredFriends}`;
        if (user.completedSpecialQuests?.includes(rewardKey)) {
            return res.status(400).json({ success: false, message: 'Награда уже получена' });
        }
        
        const creature = await getCreature(creatureId);
        if (!creature) return res.status(400).json({ success: false, message: 'Существо не найдено' });
        
        const inventory = await Inventory.find({ telegramId: user.telegramId });
        const usedSlots = inventory.reduce((sum, i) => sum + i.count, 0);
        if (usedSlots >= user.inventorySlots) {
            return res.status(400).json({ success: false, message: 'Инвентарь полон' });
        }
        
        let invItem = await Inventory.findOne({ telegramId: user.telegramId, creatureId });
        if (invItem) {
            invItem.count += 1;
            await invItem.save();
        } else {
            await Inventory.create({ userId: user._id, telegramId: user.telegramId, creatureId, count: 1 });
        }
        
        if (!user.discovered.includes(creatureId)) user.discovered.push(creatureId);
        if (!user.completedSpecialQuests) user.completedSpecialQuests = [];
        user.completedSpecialQuests.push(rewardKey);
        await user.save();
        
        const updatedInventory = await formatInventory(user.telegramId);
        const incomePerHour = await getUserIncome(user.telegramId);
        
        res.json({ 
            success: true, 
            creatureName: creature.name, 
            creatureIcon: creature.icon, 
            user: formatUser(user), 
            inventory: updatedInventory, 
            incomePerHour: Math.floor(incomePerHour * 100) / 100 
        });
    } catch (e) {
        console.error('claim-friend-reward error:', e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// ============================================
// GAME: OPEN CAPSULE
// ============================================
app.post('/api/game/open-capsule', authMiddleware, async (req, res) => {
    try {
        const { type } = req.body;
        const user = req.user;
        
        const config = await getGameConfig();
        
        const lastOpen = lastOpenTimes.get(user.telegramId) || 0;
        if (Date.now() - lastOpen < 2000) {
            return res.status(429).json({ success: false, message: 'Слишком часто! Подождите 2 секунды.' });
        }
        lastOpenTimes.set(user.telegramId, Date.now());

        if (!['basic', 'premium'].includes(type)) {
            return res.status(400).json({ success: false, message: 'Неверный тип капсулы' });
        }

        const cost = config.capsuleCosts[type];

        const inventoryBefore = await Inventory.find({ telegramId: user.telegramId });
        const usedSlots = inventoryBefore.reduce((sum, i) => sum + i.count, 0);
        if (usedSlots >= user.inventorySlots) {
            return res.status(400).json({ success: false, message: 'Инвентарь полон' });
        }

        const updatedUser = await User.findOneAndUpdate(
            { _id: user._id, balance: { $gte: cost } },
            {
                $inc: { balance: -cost, capsulesOpened: 1 },
                $push: {
                    transactions: {
                        $each: [{ name: `${type === 'premium' ? 'Premium' : 'DNA'} Capsule`, amount: -cost, time: new Date() }],
                        $position: 0, $slice: 30
                    }
                }
            },
            { new: true }
        );

        if (!updatedUser) {
            return res.status(400).json({ success: false, message: 'Недостаточно MMO' });
        }

        addXP(updatedUser, 10);

        const weights = config.capsuleRarities[type];
        const roll = Math.random() * 100;
        let cum = 0;
        let rarity = 'common';
        for (const [r, chance] of Object.entries(weights)) {
            cum += chance;
            if (roll < cum) { rarity = r; break; }
        }

        const creature = await randomCreatureByRarity(rarity);
        if (!creature) {
            await User.findByIdAndUpdate(user._id, { $inc: { balance: cost, capsulesOpened: -1 } });
            return res.status(500).json({ success: false, message: 'Ошибка: существо не найдено' });
        }

        let invItem = await Inventory.findOne({ telegramId: user.telegramId, creatureId: creature.id });
        if (invItem) {
            invItem.count += 1;
            await invItem.save();
        } else {
            invItem = await Inventory.create({ userId: user._id, telegramId: user.telegramId, creatureId: creature.id, count: 1 });
        }

        if (!updatedUser.discovered.includes(creature.id)) {
            updatedUser.discovered.push(creature.id);
        }

        await updatedUser.save();
        
        // [OPTIMIZATION] Инвалидация кэша инвентаря
        invalidateInventoryCache(user.telegramId);
        
        const updatedInventory = await formatInventory(user.telegramId);
        const incomePerHour = await getUserIncome(user.telegramId);

        res.json({
            success: true,
            creature: { id: creature.id, name: creature.name, rarity: creature.rarity, icon: creature.icon, incomeBase: creature.incomeBase, desc: creature.desc },
            user: formatUser(updatedUser),
            inventory: updatedInventory,
            incomePerHour: Math.floor(incomePerHour * 100) / 100
        });
    } catch (e) {
        console.error('open-capsule error:', e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// ============================================
// GAME: MERGE
// ============================================
app.post('/api/game/merge', authMiddleware, async (req, res) => {
    try {
        const { creatureId } = req.body;
        const user = req.user;
        
        const lastMerge = lastMergeTimes.get(user.telegramId) || 0;
        if (Date.now() - lastMerge < 1000) {
            return res.status(429).json({ success: false, message: 'Слишком часто! Подождите.' });
        }
        lastMergeTimes.set(user.telegramId, Date.now());

        const creature = await getCreature(creatureId);
        if (!creature) return res.status(400).json({ success: false, message: 'Существо не найдено' });

        if (creature.rarity === 'legendary' || creature.rarity === 'mythic') {
            return res.status(400).json({ success: false, message: 'Это существо нельзя слить' });
        }

        const inventoryBefore = await Inventory.find({ telegramId: user.telegramId });
        const usedSlots = inventoryBefore.reduce((sum, i) => sum + i.count, 0);
        
        const invItemCheck = inventoryBefore.find(i => i.creatureId === creatureId);
        if (!invItemCheck || invItemCheck.count < 3) {
            return res.status(400).json({ success: false, message: 'Нужно 3 одинаковых существа' });
        }
        
        if (usedSlots - 2 > user.inventorySlots) {
            return res.status(400).json({ success: false, message: 'Инвентарь полон' });
        }

        const invItem = await Inventory.findOneAndUpdate(
            { telegramId: user.telegramId, creatureId, count: { $gte: 3 } },
            { $inc: { count: -3 } },
            { new: true }
        );

        if (!invItem) {
            return res.status(400).json({ success: false, message: 'Нужно 3 одинаковых существа' });
        }

        if (invItem.count === 0) {
            await Inventory.deleteOne({ _id: invItem._id });
        }

        const currentRarityIdx = RARITY_ORDER.indexOf(creature.rarity);
        const success = Math.random() < 0.3;

        let resultCreature;
        if (success && currentRarityIdx < RARITY_ORDER.length - 2) {
            const nextRarity = RARITY_ORDER[currentRarityIdx + 1];
            resultCreature = await Creature.findOne({ name: creature.name, rarity: nextRarity });
            if (!resultCreature) resultCreature = creature;
        } else {
            resultCreature = creature;
        }

        let resultItem = await Inventory.findOne({ telegramId: user.telegramId, creatureId: resultCreature.id });
        if (resultItem) {
            resultItem.count += 1;
            await resultItem.save();
        } else {
            await Inventory.create({ userId: user._id, telegramId: user.telegramId, creatureId: resultCreature.id, count: 1 });
        }

        if (!user.discovered.includes(resultCreature.id)) {
            user.discovered.push(resultCreature.id);
        }

        user.mergeCount += 1;
        addXP(user, 20);
        addTransaction(user, `Merge → ${resultCreature.name} (${resultCreature.rarity})`, 0);
        await user.save();

        // [OPTIMIZATION] Инвалидация кэша инвентаря
        invalidateInventoryCache(user.telegramId);
        
        const updatedInventory = await formatInventory(user.telegramId);
        const incomePerHour = await getUserIncome(user.telegramId);

        res.json({
            success: true,
            upgraded: success,
            fromCreature: { id: creature.id, name: creature.name, rarity: creature.rarity, icon: creature.icon, incomeBase: creature.incomeBase },
            resultCreature: { id: resultCreature.id, name: resultCreature.name, rarity: resultCreature.rarity, icon: resultCreature.icon, incomeBase: resultCreature.incomeBase },
            user: formatUser(user),
            inventory: updatedInventory,
            incomePerHour: Math.floor(incomePerHour * 100) / 100
        });
    } catch (e) {
        console.error('merge error:', e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// ============================================
// GAME: UPGRADE INVENTORY
// ============================================
app.post('/api/game/upgrade-inventory', authMiddleware, async (req, res) => {
    try {
        const user = req.user;
        
        const config = await getGameConfig();
        const limits = config.limits;
        
        if (user.inventorySlots >= limits.maxInventorySlots) {
            return res.status(400).json({ success: false, message: 'Максимум слотов достигнут' });
        }
        
        const cost = Math.floor(config.upgradeBaseCost * Math.pow(config.upgradeMultiplier, user.inventoryUpgrades));

        const updatedUser = await User.findOneAndUpdate(
            { _id: user._id, balance: { $gte: cost } },
            {
                $inc: { balance: -cost, inventorySlots: 1, inventoryUpgrades: 1 },
                $push: {
                    transactions: {
                        $each: [{ name: 'Inventory Upgrade', amount: -cost, time: new Date() }],
                        $position: 0, $slice: 30
                    }
                }
            },
            { new: true }
        );

        if (!updatedUser) {
            return res.status(400).json({ success: false, message: 'Недостаточно MMO', required: cost });
        }

        addXP(updatedUser, 25);
        await updatedUser.save();
        
        // [OPTIMIZATION] Инвалидация кэша инвентаря
        invalidateInventoryCache(user.telegramId);

        res.json({ success: true, user: formatUser(updatedUser) });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// ============================================
// GAME: WATCH AD
// ============================================
app.post('/api/game/watch-ad', authMiddleware, async (req, res) => {
    try {
        const user = req.user;
        const config = await getGameConfig();
        const now = new Date();

        const reward = config.adReward;
        const newCooldown = new Date(now.getTime() + config.adCooldown * 1000);

        const lastReset = new Date(user.adsDailyReset);
        const isNewDay = now.getDate() !== lastReset.getDate() || 
                         now.getMonth() !== lastReset.getMonth() || 
                         now.getFullYear() !== lastReset.getFullYear();

        let dailyCount = user.adsDailyCount;
        let dailyReset = user.adsDailyReset;

        if (isNewDay) {
            dailyCount = 0;
            dailyReset = now;
        }

        if (dailyCount >= MAX_ADS_PER_DAY) {
            return res.status(400).json({ 
                success: false, 
                message: `Вы достигли лимита ${MAX_ADS_PER_DAY} рекламы в сутки. Завтра будет доступно снова.`,
                dailyLimitReached: true
            });
        }

        const updatedUser = await User.findOneAndUpdate(
            {
                _id: user._id,
                $or: [
                    { adsCooldownUntil: null },
                    { adsCooldownUntil: { $lte: now } }
                ]
            },
            {
                $inc: { balance: reward, adsDailyCount: 1 },
                $set: { 
                    adsCooldownUntil: newCooldown,
                    adsDailyReset: dailyReset
                },
                $push: {
                    transactions: {
                        $each: [{ name: 'Watch Ad Reward', amount: reward, time: new Date() }],
                        $position: 0,
                        $slice: 30
                    }
                }
            },
            { new: true }
        );

        if (!updatedUser) {
            const freshUser = await User.findById(user._id).select('adsCooldownUntil');
            const secondsLeft = Math.ceil((new Date(freshUser.adsCooldownUntil) - now) / 1000);
            return res.status(400).json({ success: false, message: 'Реклама ещё не доступна', secondsLeft });
        }

        addXP(updatedUser, 15);
        await updatedUser.save();

        const remainingToday = MAX_ADS_PER_DAY - updatedUser.adsDailyCount;

        res.json({ 
            success: true, 
            reward,
            cooldownSeconds: config.adCooldown,
            user: formatUser(updatedUser),
            adsToday: updatedUser.adsDailyCount,
            adsRemaining: remainingToday,
            maxAdsPerDay: MAX_ADS_PER_DAY
        });
    } catch (e) {
        console.error('watch-ad error:', e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// ============================================
// GAME: GET ADS STATUS
// ============================================
app.get('/api/game/ads-status', authMiddleware, async (req, res) => {
    try {
        const user = req.user;
        const now = new Date();
        
        const lastReset = new Date(user.adsDailyReset);
        const isNewDay = now.getDate() !== lastReset.getDate() || 
                         now.getMonth() !== lastReset.getMonth() || 
                         now.getFullYear() !== lastReset.getFullYear();
        
        let dailyCount = user.adsDailyCount;
        if (isNewDay) {
            dailyCount = 0;
        }
        
        const remaining = Math.max(0, MAX_ADS_PER_DAY - dailyCount);
        const cooldownSeconds = user.adsCooldownUntil 
            ? Math.max(0, Math.ceil((new Date(user.adsCooldownUntil) - now) / 1000))
            : 0;
        
        res.json({
            success: true,
            adsToday: dailyCount,
            adsRemaining: remaining,
            maxAdsPerDay: MAX_ADS_PER_DAY,
            cooldownSeconds: cooldownSeconds,
            isNewDay: isNewDay
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// GAME: SPECIAL QUEST COMPLETE
// ============================================
app.post('/api/game/complete-special-quest', authMiddleware, async (req, res) => {
    try {
        const { questId } = req.body;
        const user = req.user;
        
        const config = await getGameConfig();
        
        if (user.completedSpecialQuests.includes(questId)) {
            return res.status(400).json({ success: false, message: 'Вы уже получили награду за этот квест' });
        }
        
        const quest = config.specialQuests.find(q => q.id === questId && q.isActive);
        if (!quest) {
            return res.status(404).json({ success: false, message: 'Квест не найден или отключён' });
        }
        
        if (quest.type === 'referral_count') {
            if (user.referralCount < quest.required_count) {
                return res.status(400).json({ success: false, message: `Нужно ${quest.required_count} друзей (у вас ${user.referralCount})` });
            }
        }
        
        const updatedUser = await User.findOneAndUpdate(
            { _id: user._id, completedSpecialQuests: { $ne: questId } },
            {
                $inc: { balance: quest.reward },
                $push: {
                    completedSpecialQuests: questId,
                    transactions: {
                        $each: [{ name: `Special Quest: ${quest.title}`, amount: quest.reward, time: new Date() }],
                        $position: 0, $slice: 30
                    }
                }
            },
            { new: true }
        );

        if (!updatedUser) {
            return res.status(400).json({ success: false, message: 'Вы уже получили награду за этот квест' });
        }

        addXP(updatedUser, 20);
        await updatedUser.save();
        
        res.json({ success: true, reward: quest.reward, message: `Выполнено! +${quest.reward} MMO`, user: formatUser(updatedUser) });
    } catch (e) {
        console.error('complete-special-quest error:', e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// ============================================
// MARKETPLACE
// ============================================
app.post('/api/marketplace/list', authMiddleware, async (req, res) => {
    try {
        const { creatureId, price } = req.body;
        const user = req.user;
        
        const config = await getGameConfig();
        const limits = config.limits;

        if (!price || price < MIN_MARKETPLACE_PRICE) {
            return res.status(400).json({ success: false, message: `Минимальная цена ${MIN_MARKETPLACE_PRICE} MMO` });
        }
        
        if (price > limits.maxMarketplacePrice) {
            return res.status(400).json({ success: false, message: `Максимальная цена ${limits.maxMarketplacePrice} MMO` });
        }

        const activeListingsCount = await Marketplace.countDocuments({
            sellerTgId: user.telegramId,
            active: true
        });
        
        if (activeListingsCount >= MAX_ACTIVE_LISTINGS) {
            return res.status(400).json({ 
                success: false, 
                message: `Вы уже выставили ${MAX_ACTIVE_LISTINGS} лотов. Сначала отмените или дождитесь продажи существующих.` 
            });
        }

        const creature = await getCreature(creatureId);
        if (!creature) return res.status(400).json({ success: false, message: 'Существо не найдено' });

        const invItem = await Inventory.findOne({ telegramId: user.telegramId, creatureId });
        if (!invItem || invItem.count < 1) {
            return res.status(400).json({ success: false, message: 'Существо не найдено в инвентаре' });
        }

        invItem.count -= 1;
        if (invItem.count <= 0) {
            await Inventory.deleteOne({ _id: invItem._id });
        } else {
            await invItem.save();
        }

        const listing = await Marketplace.create({
            sellerId: user._id,
            sellerTgId: user.telegramId,
            sellerName: user.username || user.firstName || `User${user.telegramId.slice(-4)}`,
            creatureId,
            price,
            active: true
        });
        
        marketplaceListingsCache = { data: null, expiresAt: 0 };
        
        // [OPTIMIZATION] Инвалидация кэша инвентаря
        invalidateInventoryCache(user.telegramId);
        
        const updatedInventory = await formatInventory(user.telegramId);

        res.json({ success: true, listing, inventory: updatedInventory });
    } catch (e) {
        console.error('marketplace list error:', e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

app.post('/api/marketplace/buy', authMiddleware, async (req, res) => {
    try {
        const { listingId } = req.body;
        const buyer = req.user;

        const listing = await Marketplace.findById(listingId);
        if (!listing || !listing.active) {
            return res.status(400).json({ success: false, message: 'Лот не найден или уже продан' });
        }

        if (listing.sellerTgId === buyer.telegramId) {
            return res.status(400).json({ success: false, message: 'Нельзя купить свой лот' });
        }

        const buyerInventory = await Inventory.find({ telegramId: buyer.telegramId });
        const usedSlots = buyerInventory.reduce((sum, i) => sum + i.count, 0);
        if (usedSlots >= buyer.inventorySlots) {
            return res.status(400).json({ success: false, message: 'Инвентарь покупателя полон' });
        }

        const creature = await getCreature(listing.creatureId);
        if (!creature) return res.status(400).json({ success: false, message: 'Существо не найдено' });

        const closedListing = await Marketplace.findOneAndUpdate(
            { _id: listingId, active: true },
            { $set: { active: false } },
            { new: true }
        );

        if (!closedListing) {
            return res.status(400).json({ success: false, message: 'Лот уже куплен другим игроком' });
        }

        const updatedBuyer = await User.findOneAndUpdate(
            { _id: buyer._id, balance: { $gte: listing.price } },
            {
                $inc: { balance: -listing.price },
                $push: {
                    transactions: {
                        $each: [{ name: `Bought: ${creature.name} from ${listing.sellerName}`, amount: -listing.price, time: new Date() }],
                        $position: 0, $slice: 30
                    }
                }
            },
            { new: true }
        );

        if (!updatedBuyer) {
            await Marketplace.findByIdAndUpdate(listingId, { $set: { active: true } });
            return res.status(400).json({ success: false, message: 'Недостаточно MMO' });
        }

        const fee = Math.floor(listing.price * 0.1);
        const sellerEarns = listing.price - fee;
        const seller = await User.findOne({ telegramId: listing.sellerTgId });
        if (seller) {
            await User.findByIdAndUpdate(seller._id, {
                $inc: { balance: sellerEarns },
                $push: {
                    transactions: {
                        $each: [{ name: `Sold: ${creature.name}`, amount: sellerEarns, time: new Date() }],
                        $position: 0, $slice: 30
                    }
                }
            });
        }

        await MarketSaleHistory.create({
            listingId: closedListing._id,
            creatureId: listing.creatureId,
            sellerId: listing.sellerId,
            sellerTgId: listing.sellerTgId,
            sellerName: listing.sellerName,
            buyerId: updatedBuyer._id,
            buyerTgId: updatedBuyer.telegramId,
            buyerName: updatedBuyer.username || updatedBuyer.firstName || 'Аноним',
            price: listing.price,
            fee: fee,
            sellerEarns: sellerEarns,
            soldAt: new Date()
        });

        let invItem = await Inventory.findOne({ telegramId: buyer.telegramId, creatureId: listing.creatureId });
        if (invItem) {
            invItem.count += 1;
            await invItem.save();
        } else {
            await Inventory.create({ userId: buyer._id, telegramId: buyer.telegramId, creatureId: listing.creatureId, count: 1 });
        }

        if (!updatedBuyer.discovered.includes(listing.creatureId)) {
            updatedBuyer.discovered.push(listing.creatureId);
            await updatedBuyer.save();
        }

        addXP(updatedBuyer, 5);
        await updatedBuyer.save();

        marketplaceListingsCache = { data: null, expiresAt: 0 };
        
        // [OPTIMIZATION] Инвалидация кэша инвентаря
        invalidateInventoryCache(buyer.telegramId);
        
        const updatedInventory = await formatInventory(buyer.telegramId);

        res.json({
            success: true,
            creature: { id: creature.id, name: creature.name, icon: creature.icon, incomeBase: creature.incomeBase },
            user: formatUser(updatedBuyer),
            inventory: updatedInventory
        });
    } catch (e) {
        console.error('marketplace buy error:', e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

app.get('/api/marketplace/listings', async (req, res) => {
    try {
        if (Date.now() < marketplaceListingsCache.expiresAt && marketplaceListingsCache.data) {
            return res.json({ success: true, listings: marketplaceListingsCache.data });
        }
        
        const listings = await Marketplace.find({ active: true })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
            
        marketplaceListingsCache = {
            data: listings,
            expiresAt: Date.now() + 10 * 1000
        };
        
        res.json({ success: true, listings });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

app.get('/api/marketplace/my-listings', authMiddleware, async (req, res) => {
    try {
        const listings = await Marketplace.find({
            sellerTgId: req.user.telegramId,
            active: true
        }).sort({ createdAt: -1 }).lean();

        res.json({ success: true, listings });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

app.post('/api/marketplace/cancel', authMiddleware, async (req, res) => {
    try {
        const { listingId } = req.body;
        const user = req.user;

        const listing = await Marketplace.findById(listingId);
        if (!listing || !listing.active) {
            return res.status(400).json({ success: false, message: 'Лот не найден' });
        }

        if (listing.sellerTgId !== user.telegramId) {
            return res.status(403).json({ success: false, message: 'Это не ваш лот' });
        }

        const inventory = await Inventory.find({ telegramId: user.telegramId });
        const usedSlots = inventory.reduce((sum, i) => sum + i.count, 0);
        
        if (usedSlots >= user.inventorySlots) {
            return res.status(400).json({ 
                success: false, 
                message: 'Нет свободных слотов в инвентаре. Продайте или объедините существа.' 
            });
        }

        let invItem = await Inventory.findOne({ telegramId: user.telegramId, creatureId: listing.creatureId });
        if (invItem) {
            invItem.count += 1;
            await invItem.save();
        } else {
            await Inventory.create({ userId: user._id, telegramId: user.telegramId, creatureId: listing.creatureId, count: 1 });
        }

        listing.active = false;
        await listing.save();
        
        marketplaceListingsCache = { data: null, expiresAt: 0 };
        
        // [OPTIMIZATION] Инвалидация кэша инвентаря
        invalidateInventoryCache(user.telegramId);
        
        const updatedInventory = await formatInventory(user.telegramId);

        res.json({ success: true, inventory: updatedInventory });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// ============================================
// LEADERBOARD (обновлен TTL на 120 сек)
// ============================================
app.get('/api/user/leaderboard', authMiddleware, async (req, res) => {
    try {
        // [OPTIMIZATION] Увеличен TTL до 120 секунд
        if (Date.now() < leaderboardCache.expiresAt && leaderboardCache.data) {
            return res.json({ success: true, ...leaderboardCache.data });
        }
        
        const leaders = await User.find({ isBanned: { $ne: true } })
            .sort({ level: -1, xp: -1, balance: -1 })
            .limit(50)
            .select('username firstName telegramId balance level xp')
            .lean();
            
        const myRank = await User.countDocuments({ 
            isBanned: { $ne: true },
            $or: [
                { level: { $gt: req.user.level } },
                { level: req.user.level, xp: { $gt: req.user.xp } }
            ]
        }) + 1;
        
        const data = {
            myRank,
            leaders: leaders.map((u, i) => ({
                rank: i + 1,
                username: u.username || u.firstName || `User${u.telegramId.slice(-4)}`,
                balance: u.balance,
                level: u.level,
                xp: u.xp,
                isMe: u.telegramId === req.user.telegramId
            }))
        };
        
        // [OPTIMIZATION] TTL изменён с 30 на 120 секунд
        leaderboardCache = {
            data,
            expiresAt: Date.now() + 120 * 1000
        };
        
        res.json({ success: true, ...data });
    } catch (e) {
        console.error('leaderboard error:', e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// ============================================
// ИНИЦИАЛИЗАЦИЯ СУЩЕСТВ
// ============================================
async function initCreatures() {
    const staticCreatures = [
        { id: 'duck_c', name: 'Duck', rarity: 'common', icon: 'https://ndammo.github.io/Mmodna/dc.png', incomeBase: 2, desc: 'Young waterfowl.' },
        { id: 'duck_u', name: 'Duck', rarity: 'uncommon', icon: 'https://ndammo.github.io/Mmodna/du.png', incomeBase: 8, desc: 'Mature waterfowl.' },
        { id: 'duck_r', name: 'Duck', rarity: 'rare', icon: 'https://ndammo.github.io/Mmodna/dr.png', incomeBase: 25, desc: 'Ancient waterfowl.' },
        { id: 'duck_e', name: 'Duck', rarity: 'epic', icon: 'https://ndammo.github.io/Mmodna/de.png', incomeBase: 80, desc: 'Eternal waterfowl.' },
        { id: 'duck_l', name: 'Duck', rarity: 'legendary', icon: 'https://ndammo.github.io/Mmodna/dl.png', incomeBase: 250, desc: 'Divine waterfowl.' },
        { id: 'owl_c', name: 'Owl', rarity: 'common', icon: 'https://ndammo.github.io/Mmodna/oc.png', incomeBase: 2, desc: 'Small night hunter.' },
        { id: 'owl_u', name: 'Owl', rarity: 'uncommon', icon: 'https://ndammo.github.io/Mmodna/ou.png', incomeBase: 8, desc: 'Experienced night hunter.' },
        { id: 'owl_r', name: 'Owl', rarity: 'rare', icon: 'https://ndammo.github.io/Mmodna/or.png', incomeBase: 25, desc: 'Wise night guardian.' },
        { id: 'owl_e', name: 'Owl', rarity: 'epic', icon: 'https://ndammo.github.io/Mmodna/oe.png', incomeBase: 80, desc: 'Eternal guardian.' },
        { id: 'owl_l', name: 'Owl', rarity: 'legendary', icon: 'https://ndammo.github.io/Mmodna/ol.png', incomeBase: 250, desc: 'Divine guardian.' },
        { id: 'shark_c', name: 'Shark', rarity: 'common', icon: 'https://ndammo.github.io/Mmodna/sc.png', incomeBase: 2, desc: 'Young predator.' },
        { id: 'shark_u', name: 'Shark', rarity: 'uncommon', icon: 'https://ndammo.github.io/Mmodna/su.png', incomeBase: 8, desc: 'Experienced apex predator.' },
        { id: 'shark_r', name: 'Shark', rarity: 'rare', icon: 'https://ndammo.github.io/Mmodna/sr.png', incomeBase: 25, desc: 'Legendary predator.' },
        { id: 'shark_e', name: 'Shark', rarity: 'epic', icon: 'https://ndammo.github.io/Mmodna/se.png', incomeBase: 80, desc: 'Eternal terror.' },
        { id: 'shark_l', name: 'Shark', rarity: 'legendary', icon: 'https://ndammo.github.io/Mmodna/sl.png', incomeBase: 250, desc: 'Divine terror.' },
        { id: 'wolf_c', name: 'Wolf', rarity: 'common', icon: 'https://ndammo.github.io/Mmodna/wc.png', incomeBase: 2, desc: 'Young pack member.' },
        { id: 'wolf_u', name: 'Wolf', rarity: 'uncommon', icon: 'https://ndammo.github.io/Mmodna/wu.png', incomeBase: 8, desc: 'Pack leader in training.' },
        { id: 'wolf_r', name: 'Rare Wolf', rarity: 'rare', icon: 'https://ndammo.github.io/Mmodna/wr.png', incomeBase: 25, desc: 'Rare wolf for 10 friends 5+.' },
        { id: 'wolf_e', name: 'Epic Wolf', rarity: 'epic', icon: 'https://ndammo.github.io/Mmodna/we.png', incomeBase: 80, desc: 'Epic wolf for 50 friends 5+.' },
        { id: 'wolf_l', name: 'Legendary Wolf', rarity: 'legendary', icon: 'https://ndammo.github.io/Mmodna/wl.png', incomeBase: 250, desc: 'Legendary wolf for 150 friends 5+.' },
        { id: 'dragon_c', name: 'Dragon', rarity: 'common', icon: 'https://ndammo.github.io/Mmodna/ddc.png', incomeBase: 2, desc: 'Young fire breather.' },
        { id: 'dragon_u', name: 'Dragon', rarity: 'uncommon', icon: 'https://ndammo.github.io/Mmodna/ddu.png', incomeBase: 8, desc: 'Grown fire breather.' },
        { id: 'dragon_r', name: 'Dragon', rarity: 'rare', icon: 'https://ndammo.github.io/Mmodna/ddr.png', incomeBase: 25, desc: 'Ancient fire drake.' },
        { id: 'dragon_e', name: 'Dragon', rarity: 'epic', icon: 'https://ndammo.github.io/Mmodna/dde.png', incomeBase: 80, desc: 'Eternal flame.' },
        { id: 'dragon_l', name: 'Dragon', rarity: 'legendary', icon: 'https://ndammo.github.io/Mmodna/ddl.png', incomeBase: 250, desc: 'Divine flame.' },
        { id: 'unicorn_c', name: 'Unicorn', rarity: 'common', icon: 'https://ndammo.github.io/Mmodna/uc.png', incomeBase: 2, desc: 'Young magical beast.' },
        { id: 'unicorn_u', name: 'Unicorn', rarity: 'uncommon', icon: 'https://ndammo.github.io/Mmodna/uu.png', incomeBase: 8, desc: 'Magical evolution.' },
        { id: 'unicorn_r', name: 'Unicorn', rarity: 'rare', icon: 'https://ndammo.github.io/Mmodna/ru.png', incomeBase: 25, desc: 'Rare magical entity.' },
        { id: 'unicorn_e', name: 'Unicorn', rarity: 'epic', icon: 'https://ndammo.github.io/Mmodna/er.png', incomeBase: 80, desc: 'Eternal magic.' },
        { id: 'unicorn_l', name: 'Unicorn', rarity: 'legendary', icon: 'https://ndammo.github.io/Mmodna/ll.png', incomeBase: 250, desc: 'Divine magic.' },
        { id: 'lion_mythic', name: 'Lion', rarity: 'mythic', icon: 'https://ndammo.github.io/Mmodna/lm.png', incomeBase: 1000, desc: 'THE MYTHIC KING.' },
        { id: 'panther_mythic', name: 'Black Panther', rarity: 'mythic', icon: 'https://ndammo.github.io/Mmodna/pm.png', incomeBase: 2000, desc: 'TOP 1 SEASON.' }
    ];

    for (const creature of staticCreatures) {
        const exists = await Creature.findOne({ id: creature.id });
        if (!exists) {
            await Creature.create(creature);
            console.log(`✅ Добавлено существо: ${creature.name}`);
        }
    }
    await loadCreaturesToCache();
    console.log('✅ Существа инициализированы');
}

// ============================================
// АДМИН-ПАНЕЛЬ API
// ============================================
app.get('/api/admin/special-quests', adminAuthMiddleware, async (req, res) => {
    try {
        const config = await getGameConfig();
        res.json({ success: true, specialQuests: config.specialQuests });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/special-quests', adminAuthMiddleware, async (req, res) => {
    try {
        const { id, title, description, icon, reward, type, link, required_count, isActive } = req.body;
        
        if (!id || !title || !reward || !type) {
            return res.status(400).json({ success: false, message: 'Не все обязательные поля заполнены' });
        }
        
        const config = await getGameConfig();
        
        if (config.specialQuests.some(q => q.id === id)) {
            return res.status(400).json({ success: false, message: 'Квест с таким ID уже существует' });
        }
        
        config.specialQuests.push({
            id, title, description: description || '', icon: icon || '🎯', reward, type,
            link: link || '', required_count: required_count || 1, isActive: isActive !== false
        });
        
        await config.save();
        await invalidateConfigCache();
        
        res.json({ success: true, specialQuests: config.specialQuests });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.put('/api/admin/special-quests/:id', adminAuthMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, icon, reward, type, link, required_count, isActive } = req.body;
        
        const config = await getGameConfig();
        const quest = config.specialQuests.find(q => q.id === id);
        
        if (!quest) {
            return res.status(404).json({ success: false, message: 'Квест не найден' });
        }
        
        if (title) quest.title = title;
        if (description !== undefined) quest.description = description;
        if (icon) quest.icon = icon;
        if (reward) quest.reward = reward;
        if (type) quest.type = type;
        if (link !== undefined) quest.link = link;
        if (required_count) quest.required_count = required_count;
        if (isActive !== undefined) quest.isActive = isActive;
        
        await config.save();
        await invalidateConfigCache();
        
        res.json({ success: true, specialQuests: config.specialQuests });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.delete('/api/admin/special-quests/:id', adminAuthMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const config = await getGameConfig();
        
        const questIndex = config.specialQuests.findIndex(q => q.id === id);
        if (questIndex === -1) {
            return res.status(404).json({ success: false, message: 'Квест не найден' });
        }
        
        config.specialQuests.splice(questIndex, 1);
        await config.save();
        await invalidateConfigCache();
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/users', adminAuthMiddleware, async (req, res) => {
    try {
        const { search, limit = 50, skip = 0 } = req.query;
        let query = {};
        if (search) {
            const escapedSearch = escapeRegex(search);
            query = {
                $or: [
                    { telegramId: { $regex: escapedSearch, $options: 'i' } },
                    { username: { $regex: escapedSearch, $options: 'i' } },
                    { firstName: { $regex: escapedSearch, $options: 'i' } }
                ]
            };
        }
        const users = await User.find(query)
            .sort({ createdAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .select('-transactions');
        const total = await User.countDocuments(query);
        res.json({ success: true, users, total });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/users/:id', adminAuthMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        
        let inventory = await Inventory.find({ telegramId: user.telegramId }).lean();
        inventory = await Promise.all(inventory.map(async (item) => {
            const creature = await getCreature(item.creatureId);
            return { ...item, name: creature?.name || item.creatureId, icon: creature?.icon || '🧬', incomeBase: creature?.incomeBase || 1 };
        }));
        
        const referrals = await User.find({ referredBy: user.telegramId }).select('username firstName balance createdAt');
        
        res.json({ success: true, user: formatUser(user), inventory, referrals });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.put('/api/admin/users/:id/balance', adminAuthMiddleware, async (req, res) => {
    try {
        const { amount, reason } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        
        if (typeof amount !== 'number' || isNaN(amount)) {
            return res.status(400).json({ success: false, message: 'Неверная сумма' });
        }
        if (Math.abs(amount) > 1000000) {
            return res.status(400).json({ success: false, message: 'Слишком большая сумма' });
        }
        if (user.balance + amount < 0) {
            return res.status(400).json({ success: false, message: 'Баланс не может быть отрицательным' });
        }
        
        user.balance += amount;
        addTransaction(user, `Admin: ${reason || 'Изменение баланса'} (${amount > 0 ? '+' : ''}${amount})`, amount);
        await user.save();
        
        leaderboardCache = { data: null, expiresAt: 0 };
        
        res.json({ success: true, newBalance: user.balance });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/users/:id/give-item', adminAuthMiddleware, async (req, res) => {
    try {
        const { creatureId, count = 1 } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        
        const creature = await getCreature(creatureId);
        if (!creature) return res.status(400).json({ success: false, message: 'Существо не найдено' });
        
        const inventory = await Inventory.find({ telegramId: user.telegramId });
        const usedSlots = inventory.reduce((sum, i) => sum + i.count, 0);
        if (usedSlots + count > user.inventorySlots) {
            return res.status(400).json({ success: false, message: 'У пользователя недостаточно места в инвентаре' });
        }
        
        let invItem = await Inventory.findOne({ telegramId: user.telegramId, creatureId });
        if (invItem) {
            invItem.count += count;
            await invItem.save();
        } else {
            await Inventory.create({ userId: user._id, telegramId: user.telegramId, creatureId, count });
        }
        
        if (!user.discovered.includes(creatureId)) {
            user.discovered.push(creatureId);
            await user.save();
        }
        
        // [OPTIMIZATION] Инвалидация кэша инвентаря
        invalidateInventoryCache(user.telegramId);
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.delete('/api/admin/users/:id/item', adminAuthMiddleware, async (req, res) => {
    try {
        const { creatureId, count = 1 } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        
        const invItem = await Inventory.findOne({ telegramId: user.telegramId, creatureId });
        if (!invItem || invItem.count < count) {
            return res.status(400).json({ success: false, message: 'У пользователя нет столько существ' });
        }
        
        invItem.count -= count;
        if (invItem.count <= 0) {
            await invItem.deleteOne();
        } else {
            await invItem.save();
        }
        
        // [OPTIMIZATION] Инвалидация кэша инвентаря
        invalidateInventoryCache(user.telegramId);
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.put('/api/admin/users/:id/ban', adminAuthMiddleware, async (req, res) => {
    try {
        const { isBanned, reason } = req.body;
        const userToBan = await User.findById(req.params.id);
        if (!userToBan) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        
        userToBan.isBanned = isBanned;
        userToBan.banReason = reason || '';
        await userToBan.save();
        
        leaderboardCache = { data: null, expiresAt: 0 };
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/users/:id/reset', adminAuthMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
        
        await Inventory.deleteMany({ telegramId: user.telegramId });
        user.balance = 4000;
        user.xp = 0;
        user.level = 1;
        user.mergeCount = 0;
        user.capsulesOpened = 0;
        user.discovered = [];
        user.completedSpecialQuests = [];
        await user.save();
        
        leaderboardCache = { data: null, expiresAt: 0 };
        
        // [OPTIMIZATION] Инвалидация кэша инвентаря
        invalidateInventoryCache(user.telegramId);
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/creatures', adminAuthMiddleware, async (req, res) => {
    try {
        const creatures = await Creature.find().sort({ rarity: 1, name: 1 });
        res.json({ success: true, creatures });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/creatures', adminAuthMiddleware, async (req, res) => {
    try {
        const { id, name, rarity, icon, incomeBase, desc } = req.body;
        if (!id || !name || !rarity || !incomeBase) {
            return res.status(400).json({ success: false, message: 'Не все поля заполнены' });
        }
        const existing = await Creature.findOne({ $or: [{ id }, { name }] });
        if (existing) {
            return res.status(400).json({ success: false, message: 'Существо с таким id или именем уже существует' });
        }
        const creature = await Creature.create({ id, name, rarity, icon: icon || '🧬', incomeBase, desc: desc || '' });
        await loadCreaturesToCache();
        res.json({ success: true, creature });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.put('/api/admin/creatures/:id', adminAuthMiddleware, async (req, res) => {
    try {
        const { name, rarity, icon, incomeBase, desc, isActive } = req.body;
        const creature = await Creature.findOne({ id: req.params.id });
        if (!creature) return res.status(404).json({ success: false, message: 'Существо не найдено' });
        
        if (name) creature.name = name;
        if (rarity) creature.rarity = rarity;
        if (icon) creature.icon = icon;
        if (incomeBase) creature.incomeBase = incomeBase;
        if (desc !== undefined) creature.desc = desc;
        if (isActive !== undefined) creature.isActive = isActive;
        await creature.save();
        await loadCreaturesToCache();
        
        res.json({ success: true, creature });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.delete('/api/admin/creatures/:id', adminAuthMiddleware, async (req, res) => {
    try {
        const creature = await Creature.findOne({ id: req.params.id });
        if (!creature) return res.status(404).json({ success: false, message: 'Существо не найдено' });
        
        const inInventory = await Inventory.findOne({ creatureId: creature.id });
        if (inInventory) {
            return res.status(400).json({ success: false, message: 'Нельзя удалить существо, оно есть у игроков' });
        }
        
        await creature.deleteOne();
        await loadCreaturesToCache();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/config', adminAuthMiddleware, async (req, res) => {
    try {
        const config = await getGameConfig();
        res.json({ success: true, config });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.put('/api/admin/config', adminAuthMiddleware, async (req, res) => {
    try {
        let config = await GameConfig.findOne();
        if (!config) config = new GameConfig();
        
        if (req.body.capsuleCosts) config.capsuleCosts = { ...config.capsuleCosts, ...req.body.capsuleCosts };
        if (req.body.capsuleRarities) config.capsuleRarities = req.body.capsuleRarities;
        if (req.body.adReward !== undefined) config.adReward = req.body.adReward;
        if (req.body.adCooldown !== undefined) config.adCooldown = req.body.adCooldown;
        if (req.body.upgradeBaseCost !== undefined) config.upgradeBaseCost = req.body.upgradeBaseCost;
        if (req.body.upgradeMultiplier !== undefined) config.upgradeMultiplier = req.body.upgradeMultiplier;
        if (req.body.limits) config.limits = { ...config.limits, ...req.body.limits };
        if (req.body.specialQuests) config.specialQuests = req.body.specialQuests;
        config.updatedAt = new Date();
        await config.save();
        
        await invalidateConfigCache();
        
        res.json({ success: true, config });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// [OPTIMIZATION] ОПТИМИЗИРОВАННАЯ ВЕРСИЯ /api/admin/stats (ОДНА АГРЕГАЦИЯ + КЭШ)
app.get('/api/admin/stats', adminAuthMiddleware, async (req, res) => {
    try {
        // Проверяем кэш
        if (cachedAdminStats.expiresAt > Date.now() && cachedAdminStats.data) {
            return res.json({ success: true, stats: cachedAdminStats.data });
        }
        
        const totalUsers = await User.countDocuments();
        const bannedUsers = await User.countDocuments({ isBanned: true });
        
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const newUsersLast7Days = await User.countDocuments({ createdAt: { $gte: sevenDaysAgo } });
        
        const oneDayAgo = new Date();
        oneDayAgo.setDate(oneDayAgo.getDate() - 1);
        const activeToday = await User.countDocuments({ lastLogin: { $gte: oneDayAgo } });
        
        // [OPTIMIZATION] ОДНА агрегация вместо четырёх
        const aggregated = await User.aggregate([{
            $group: {
                _id: null,
                totalBalance: { $sum: "$balance" },
                avgLevel: { $avg: "$level" },
                totalMerges: { $sum: "$mergeCount" },
                totalCapsules: { $sum: "$capsulesOpened" }
            }
        }]);
        
        const agg = aggregated[0] || { totalBalance: 0, avgLevel: 1, totalMerges: 0, totalCapsules: 0 };
        
        const stats = {
            totalUsers,
            bannedUsers,
            activeToday,
            newUsersLast7Days,
            totalBalance: agg.totalBalance,
            avgLevel: agg.avgLevel,
            totalMerges: agg.totalMerges,
            totalCapsules: agg.totalCapsules
        };
        
        // Сохраняем в кэш на 1 минуту
        cachedAdminStats = {
            data: stats,
            expiresAt: Date.now() + ADMIN_STATS_CACHE_TTL
        };
        
        res.json({ success: true, stats });
    } catch (e) {
        console.error('admin stats error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/give-to-all', adminAuthMiddleware, async (req, res) => {
    try {
        const { type, amount, creatureId } = req.body;
        
        if (type === 'coins' && amount) {
            if (Math.abs(amount) > 1000000) {
                return res.status(400).json({ success: false, message: 'Слишком большая сумма' });
            }
            const result = await User.updateMany({}, { $inc: { balance: amount } });
            leaderboardCache = { data: null, expiresAt: 0 };
            res.json({ success: true, message: `Выдано ${amount} MMO ${result.modifiedCount} игрокам` });
        } 
        else if (type === 'creature' && creatureId) {
            const creature = await getCreature(creatureId);
            if (!creature) return res.status(400).json({ success: false, message: 'Существо не найдено' });
            
            let count = 0;
            const batchSize = 100;
            let skip = 0;
            let hasMore = true;
            
            while (hasMore) {
                const users = await User.find({})
                    .select('_id telegramId inventorySlots')
                    .skip(skip)
                    .limit(batchSize)
                    .lean();
                
                if (users.length === 0) {
                    hasMore = false;
                    break;
                }
                
                const bulkOps = [];
                for (const user of users) {
                    const inventory = await Inventory.find({ telegramId: user.telegramId });
                    const usedSlots = inventory.reduce((sum, i) => sum + i.count, 0);
                    if (usedSlots >= user.inventorySlots) continue;
                    
                    bulkOps.push({
                        updateOne: {
                            filter: { telegramId: user.telegramId, creatureId },
                            update: { $inc: { count: 1 } },
                            upsert: true
                        }
                    });
                    
                    if (!user.discovered?.includes(creatureId)) {
                        await User.updateOne(
                            { _id: user._id },
                            { $addToSet: { discovered: creatureId } }
                        );
                    }
                    count++;
                }
                
                if (bulkOps.length > 0) {
                    await Inventory.bulkWrite(bulkOps);
                }
                
                skip += batchSize;
            }
            
            // [OPTIMIZATION] Инвалидация всех кэшей инвентаря после массовой выдачи
            inventoryCache.clear();
            userIncomeCache.clear();
            
            res.json({ success: true, message: `Выдано существо ${creature.name} ${count} игрокам` });
        }
        else {
            res.status(400).json({ success: false, message: 'Неверные параметры' });
        }
    } catch (e) {
        console.error('give-to-all error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/refresh-cache', adminAuthMiddleware, async (req, res) => {
    try {
        await invalidateConfigCache();
        await loadCreaturesToCache();
        inventoryCache.clear();
        userIncomeCache.clear();
        cachedAdminStats = { data: null, expiresAt: 0 };
        res.json({ success: true, message: 'Кэш обновлён' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// ЗАПУСК
// ============================================
mongoose.connection.once('open', async () => {
    await initCreatures();
    await getGameConfig();
    console.log('✅ Сервер готов');
    console.log('👥 Telegram Админы: ' + (ADMIN_IDS.join(', ') || 'не заданы'));
    console.log('🔐 Web Админ: ' + ADMIN_LOGIN);
    console.log('💰 Мин. сумма транзакции: ' + MIN_TRANSACTION_AMOUNT + ' MMO');
    console.log('📋 Макс. активных заявок: ' + MAX_ACTIVE_REQUESTS);
    console.log('📺 Макс. реклам в день: ' + MAX_ADS_PER_DAY);
    console.log('🎁 Реферальный бонус: ' + REFERRAL_BONUS_PERCENT + '% от депозита друга (требование: друг 5+ уровня для наград)');
    console.log('🏪 Маркет: мин. цена ' + MIN_MARKETPLACE_PRICE + ' MMO, макс. лотов ' + MAX_ACTIVE_LISTINGS);
    console.log('⚡ Оптимизации: кэш инвентаря, доходов, stats (1 агрегация), увеличен TLL leaderboard до 120с');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📌 Режим: ${process.env.NODE_ENV || 'production'}`);
});