const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(compression());
app.use(helmet());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// MongoDB connection
const MONGODB_URI = 'mongodb://mongo:FeHWcshaCKYTtPAPcdoygkOiJHSLSHSE@hopper.proxy.rlwy.net:38172';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  dbName: 'adearn_db'
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// ==================== SCHEMAS ====================

// User Schema
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: { type: String, default: '' },
  firstName: { type: String, required: true },
  lastName: { type: String, default: '' },
  balance: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  adsWatched: { type: Number, default: 0 },
  todayEarned: { type: Number, default: 0 },
  lastWatchDate: { type: String, default: () => new Date().toDateString() },
  watchedToday: { type: Number, default: 0 },
  streak: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  walletAddress: { type: String, default: '' },
  referralCode: { type: String, unique: true },
  referredBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});

// Transaction Schema
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['ad_watch', 'withdraw', 'referral_bonus', 'nft_purchase', 'nft_sale'], required: true },
  amount: { type: Number, required: true },
  description: { type: String, required: true },
  status: { type: String, enum: ['pending', 'completed', 'cancelled'], default: 'completed' },
  createdAt: { type: Date, default: Date.now }
});

// NFT Collection Schema
const nftSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  nftId: { type: Number, required: true },
  name: { type: String, required: true },
  level: { type: Number, required: true },
  bonus: { type: Number, required: true },
  isActive: { type: Boolean, default: false },
  purchasedAt: { type: Date, default: Date.now }
});

// Referral Schema
const referralSchema = new mongoose.Schema({
  referrerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  referredId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  referredAt: { type: Date, default: Date.now },
  earnings: { type: Number, default: 0 }
});

// Withdraw Request Schema
const withdrawSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  walletAddress: { type: String, required: true },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  processedAt: { type: Date },
  notes: { type: String, default: '' }
});

// Admin Settings Schema
const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now }
});

// Create models
const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const NFT = mongoose.model('NFT', nftSchema);
const Referral = mongoose.model('Referral', referralSchema);
const Withdraw = mongoose.model('Withdraw', withdrawSchema);
const Settings = mongoose.model('Settings', settingsSchema);

// ==================== CONSTANTS ====================
const BASE_REWARD = 0.0006;
const ADS_PER_LEVEL = 500;
const DAILY_LIMIT = 45;
const REFERRAL_PERCENT = 10; // 10% от дохода реферала
const NFT_COLLECTIONS = [
  { id: 1, name: "Древний амулет", level: 1, bonus: 1, price: 50, icon: "📿", desc: "Древний артефакт, дарующий удачу", rarity: "common" },
  { id: 2, name: "Магический кристалл", level: 2, bonus: 3, price: 150, icon: "🔮", desc: "Кристалл чистой энергии", rarity: "rare" },
  { id: 3, name: "Корона дракона", level: 3, bonus: 10, price: 500, icon: "👑", desc: "Власть над драконами", rarity: "epic" },
  { id: 4, name: "Золотое руно", level: 4, bonus: 30, price: 1500, icon: "🐑", desc: "Мифическое сокровище", rarity: "legendary" },
  { id: 5, name: "Сердце вселенной", level: 5, bonus: 50, price: 5000, icon: "💎", desc: "Божественная сила", rarity: "mythic" }
];

// Helper functions
function getLevelByWatched(adsWatched) {
  return Math.floor(adsWatched / ADS_PER_LEVEL) + 1;
}

function getRewardByLevel(level, bonus = 0) {
  return BASE_REWARD * level * (1 + bonus / 100);
}

function generateReferralCode(telegramId) {
  return 'REF' + telegramId.slice(-6) + Math.random().toString(36).substring(2, 6).toUpperCase();
}

// Initialize default settings
async function initSettings() {
  const defaultSettings = [
    { key: 'base_reward', value: BASE_REWARD },
    { key: 'daily_limit', value: DAILY_LIMIT },
    { key: 'min_withdraw', value: 1 },
    { key: 'referral_percent', value: REFERRAL_PERCENT },
    { key: 'ads_per_level', value: ADS_PER_LEVEL }
  ];
  
  for (const setting of defaultSettings) {
    await Settings.findOneAndUpdate(
      { key: setting.key },
      { key: setting.key, value: setting.value, updatedAt: new Date() },
      { upsert: true }
    );
  }
}

// ==================== MIDDLEWARE ====================
async function authMiddleware(req, res, next) {
  const telegramId = req.headers['x-telegram-id'];
  if (!telegramId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const user = await User.findOne({ telegramId });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  req.user = user;
  next();
}

// ==================== API ROUTES ====================

// Auth & User
app.post('/api/auth/register', async (req, res) => {
  try {
    const { telegramId, firstName, lastName, username, referredBy } = req.body;
    
    let user = await User.findOne({ telegramId });
    
    if (!user) {
      const referralCode = generateReferralCode(telegramId);
      user = new User({
        telegramId,
        firstName,
        lastName,
        username,
        referralCode,
        referredBy: referredBy || null
      });
      await user.save();
      
      // Handle referral
      if (referredBy) {
        const referrer = await User.findOne({ referralCode: referredBy });
        if (referrer) {
          const referral = new Referral({
            referrerId: referrer._id,
            referredId: user._id
          });
          await referral.save();
        }
      }
    }
    
    res.json({
      success: true,
      user: {
        telegramId: user.telegramId,
        firstName: user.firstName,
        username: user.username,
        balance: user.balance,
        totalEarned: user.totalEarned,
        adsWatched: user.adsWatched,
        streak: user.streak,
        level: getLevelByWatched(user.adsWatched),
        referralCode: user.referralCode,
        walletAddress: user.walletAddress
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const activeNFT = await NFT.findOne({ userId: user._id, isActive: true });
    const bonus = activeNFT ? activeNFT.bonus : 0;
    
    res.json({
      success: true,
      user: {
        telegramId: user.telegramId,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        balance: user.balance,
        totalEarned: user.totalEarned,
        adsWatched: user.adsWatched,
        todayEarned: user.todayEarned,
        streak: user.streak,
        level: getLevelByWatched(user.adsWatched),
        referralCode: user.referralCode,
        walletAddress: user.walletAddress,
        activeBonus: bonus
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Watch Ad
app.post('/api/ads/watch', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const today = new Date().toDateString();
    
    // Reset daily counter if needed
    if (user.lastWatchDate !== today) {
      user.lastWatchDate = today;
      user.watchedToday = 0;
    }
    
    if (user.watchedToday >= DAILY_LIMIT) {
      return res.status(400).json({ error: 'Daily limit reached' });
    }
    
    // Get active NFT bonus
    const activeNFT = await NFT.findOne({ userId: user._id, isActive: true });
    const bonus = activeNFT ? activeNFT.bonus : 0;
    const level = getLevelByWatched(user.adsWatched);
    const reward = getRewardByLevel(level, bonus);
    
    // Update user
    user.balance += reward;
    user.totalEarned += reward;
    user.todayEarned += reward;
    user.adsWatched += 1;
    user.watchedToday += 1;
    user.streak += 1;
    user.lastActive = new Date();
    
    await user.save();
    
    // Create transaction
    const transaction = new Transaction({
      userId: user._id,
      type: 'ad_watch',
      amount: reward,
      description: `Просмотр рекламы (уровень ${level})`
    });
    await transaction.save();
    
    res.json({
      success: true,
      reward: reward,
      balance: user.balance,
      adsWatched: user.adsWatched,
      todayEarned: user.todayEarned,
      streak: user.streak,
      level: getLevelByWatched(user.adsWatched),
      remainingToday: DAILY_LIMIT - user.watchedToday
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user NFTs
app.get('/api/nft/list', authMiddleware, async (req, res) => {
  try {
    const ownedNFTs = await NFT.find({ userId: req.user._id });
    
    const nftsWithStatus = NFT_COLLECTIONS.map(nft => {
      const owned = ownedNFTs.find(o => o.nftId === nft.id);
      return {
        ...nft,
        owned: !!owned,
        isActive: owned ? owned.isActive : false,
        ownedId: owned ? owned._id : null
      };
    });
    
    res.json({ success: true, nfts: nftsWithStatus });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Buy NFT
app.post('/api/nft/buy', authMiddleware, async (req, res) => {
  try {
    const { nftId } = req.body;
    const nft = NFT_COLLECTIONS.find(n => n.id === nftId);
    
    if (!nft) {
      return res.status(404).json({ error: 'NFT not found' });
    }
    
    const existing = await NFT.findOne({ userId: req.user._id, nftId });
    if (existing) {
      return res.status(400).json({ error: 'Already owned' });
    }
    
    if (req.user.balance < nft.price) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Purchase NFT
    req.user.balance -= nft.price;
    await req.user.save();
    
    const newNFT = new NFT({
      userId: req.user._id,
      nftId: nft.id,
      name: nft.name,
      level: nft.level,
      bonus: nft.bonus,
      isActive: false
    });
    await newNFT.save();
    
    // Create transaction
    const transaction = new Transaction({
      userId: req.user._id,
      type: 'nft_purchase',
      amount: -nft.price,
      description: `Покупка NFT: ${nft.name}`
    });
    await transaction.save();
    
    res.json({
      success: true,
      balance: req.user.balance,
      nft: { ...nft, owned: true, isActive: false }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Sell NFT
app.post('/api/nft/sell', authMiddleware, async (req, res) => {
  try {
    const { nftId } = req.body;
    const nftData = NFT_COLLECTIONS.find(n => n.id === nftId);
    const nft = await NFT.findOne({ userId: req.user._id, nftId });
    
    if (!nft) {
      return res.status(404).json({ error: 'NFT not found' });
    }
    
    const sellPrice = Math.floor(nftData.price * 0.7);
    req.user.balance += sellPrice;
    await req.user.save();
    
    // Create transaction
    const transaction = new Transaction({
      userId: req.user._id,
      type: 'nft_sale',
      amount: sellPrice,
      description: `Продажа NFT: ${nft.name}`
    });
    await transaction.save();
    
    await NFT.deleteOne({ _id: nft._id });
    
    res.json({
      success: true,
      balance: req.user.balance,
      sellPrice: sellPrice
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Equip NFT
app.post('/api/nft/equip', authMiddleware, async (req, res) => {
  try {
    const { nftId } = req.body;
    
    // Deactivate all user NFTs
    await NFT.updateMany({ userId: req.user._id }, { isActive: false });
    
    // Activate selected NFT
    const nft = await NFT.findOneAndUpdate(
      { userId: req.user._id, nftId },
      { isActive: true },
      { new: true }
    );
    
    if (!nft) {
      return res.status(404).json({ error: 'NFT not found' });
    }
    
    res.json({
      success: true,
      activeBonus: nft.bonus,
      nftId: nft.nftId
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Unequip NFT
app.post('/api/nft/unequip', authMiddleware, async (req, res) => {
  try {
    await NFT.updateMany({ userId: req.user._id }, { isActive: false });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Transactions history
app.get('/api/user/transactions', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const transactions = await Transaction.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(limit);
    
    res.json({ success: true, transactions });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Withdraw request
app.post('/api/user/withdraw', authMiddleware, async (req, res) => {
  try {
    const { amount, walletAddress } = req.body;
    const settings = await Settings.findOne({ key: 'min_withdraw' });
    const minWithdraw = settings ? settings.value : 1;
    
    if (amount < minWithdraw) {
      return res.status(400).json({ error: `Minimum withdraw is ${minWithdraw}$` });
    }
    
    if (amount > req.user.balance) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Create withdraw request
    const withdraw = new Withdraw({
      userId: req.user._id,
      amount,
      walletAddress: walletAddress || req.user.walletAddress,
      status: 'pending'
    });
    await withdraw.save();
    
    // Freeze balance (optional - subtract immediately or wait for approval)
    // For now, we'll subtract immediately and refund if rejected
    req.user.balance -= amount;
    await req.user.save();
    
    const transaction = new Transaction({
      userId: req.user._id,
      type: 'withdraw',
      amount: -amount,
      description: `Заявка на вывод ${amount}$`,
      status: 'pending'
    });
    await transaction.save();
    
    res.json({
      success: true,
      balance: req.user.balance,
      withdrawId: withdraw._id
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Save wallet address
app.post('/api/user/wallet', authMiddleware, async (req, res) => {
  try {
    const { walletAddress } = req.body;
    req.user.walletAddress = walletAddress;
    await req.user.save();
    res.json({ success: true, walletAddress });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Ranking (top users)
app.get('/api/ranking', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const topUsers = await User.find({ totalEarned: { $gt: 0 } })
      .sort({ totalEarned: -1 })
      .limit(limit)
      .select('firstName lastName username totalEarned telegramId');
    
    res.json({ success: true, ranking: topUsers });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Referral stats
app.get('/api/referrals/stats', authMiddleware, async (req, res) => {
  try {
    const referrals = await Referral.find({ referrerId: req.user._id }).populate('referredId', 'firstName lastName totalEarned');
    const totalEarnings = await Transaction.aggregate([
      { $match: { userId: req.user._id, type: 'referral_bonus' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    res.json({
      success: true,
      count: referrals.length,
      earnings: totalEarnings[0]?.total || 0,
      referrals: referrals.map(r => ({
        firstName: r.referredId.firstName,
        lastName: r.referredId.lastName,
        totalEarned: r.referredId.totalEarned
      }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin middleware
async function adminMiddleware(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  // You should store this in environment variable
  if (adminKey !== process.env.ADMIN_KEY && adminKey !== 'AdEarnProAdmin2024') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ==================== ADMIN ROUTES ====================

// Get all users (admin)
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    
    const users = await User.find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-__v');
    
    const total = await User.countDocuments();
    
    res.json({
      success: true,
      users,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single user (admin)
app.get('/api/admin/user/:telegramId', adminMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.params.telegramId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const transactions = await Transaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(50);
    const nfts = await NFT.find({ userId: user._id });
    const withdraws = await Withdraw.find({ userId: user._id }).sort({ createdAt: -1 });
    
    res.json({
      success: true,
      user,
      transactions,
      nfts,
      withdraws
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user balance (admin)
app.post('/api/admin/user/balance', adminMiddleware, async (req, res) => {
  try {
    const { telegramId, amount, reason } = req.body;
    const user = await User.findOne({ telegramId });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    user.balance += amount;
    await user.save();
    
    const transaction = new Transaction({
      userId: user._id,
      type: 'admin_adjustment',
      amount: amount,
      description: reason || `Административная корректировка: ${amount}$`
    });
    await transaction.save();
    
    res.json({ success: true, newBalance: user.balance });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all withdraw requests (admin)
app.get('/api/admin/withdraws', adminMiddleware, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const withdraws = await Withdraw.find({ status }).populate('userId', 'firstName lastName telegramId balance');
    res.json({ success: true, withdraws });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update withdraw status (admin)
app.post('/api/admin/withdraw/update', adminMiddleware, async (req, res) => {
  try {
    const { withdrawId, status, notes } = req.body;
    const withdraw = await Withdraw.findById(withdrawId);
    
    if (!withdraw) {
      return res.status(404).json({ error: 'Withdraw not found' });
    }
    
    withdraw.status = status;
    withdraw.processedAt = new Date();
    if (notes) withdraw.notes = notes;
    await withdraw.save();
    
    // If rejected, refund user
    if (status === 'rejected') {
      const user = await User.findById(withdraw.userId);
      user.balance += withdraw.amount;
      await user.save();
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get settings (admin)
app.get('/api/admin/settings', adminMiddleware, async (req, res) => {
  try {
    const settings = await Settings.find({});
    const settingsObj = {};
    settings.forEach(s => { settingsObj[s.key] = s.value; });
    res.json({ success: true, settings: settingsObj });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update settings (admin)
app.post('/api/admin/settings', adminMiddleware, async (req, res) => {
  try {
    const { settings } = req.body;
    for (const [key, value] of Object.entries(settings)) {
      await Settings.findOneAndUpdate(
        { key },
        { key, value, updatedAt: new Date() },
        { upsert: true }
      );
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get statistics (admin)
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayUsers = await User.countDocuments({ lastActive: { $gte: today } });
    const totalEarned = await User.aggregate([{ $group: { _id: null, total: { $sum: '$totalEarned' } } }]);
    const totalWithdrawn = await Withdraw.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const pendingWithdraws = await Withdraw.countDocuments({ status: 'pending' });
    
    res.json({
      success: true,
      stats: {
        totalUsers,
        activeToday: todayUsers,
        totalEarned: totalEarned[0]?.total || 0,
        totalWithdrawn: totalWithdrawn[0]?.total || 0,
        pendingWithdraws
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await initSettings();
  console.log('✅ Settings initialized');
  console.log(`📊 MongoDB: ${MONGODB_URI.split('@')[1]}`);
});