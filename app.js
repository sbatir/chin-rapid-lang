// HSK 3.0 Level 1 Vocabulary Trainer - Main Application
// Implements IndexedDB storage, enhanced spaced repetition, and Claude API integration

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║                           API KEY CONFIGURATION                               ║
// ║                                                                              ║
// ║  The API key is stored in localStorage under 'claude_api_key'                ║
// ║  It is used in the generateSentences() method (line ~700)                    ║
// ║                                                                              ║
// ║  To set your API key programmatically:                                       ║
// ║    localStorage.setItem('claude_api_key', 'your-api-key-here');              ║
// ║                                                                              ║
// ║  Or use the in-app modal when clicking "Generate Sample Sentences"          ║
// ║                                                                              ║
// ║  IMPORTANT: Your API key must have browser access enabled at:                ║
// ║  https://console.anthropic.com/settings/keys                                 ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

class HSKDatabase {
    constructor() {
        this.dbName = 'HSKTrainerDB';
        this.dbVersion = 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Profiles store
                if (!db.objectStoreNames.contains('profiles')) {
                    const profileStore = db.createObjectStore('profiles', { keyPath: 'name' });
                    profileStore.createIndex('createdAt', 'createdAt', { unique: false });
                }

                // Word progress store (per profile)
                if (!db.objectStoreNames.contains('wordProgress')) {
                    const progressStore = db.createObjectStore('wordProgress', { keyPath: ['profileName', 'wordId'] });
                    progressStore.createIndex('profileName', 'profileName', { unique: false });
                    progressStore.createIndex('nextReview', 'nextReview', { unique: false });
                    progressStore.createIndex('level', 'level', { unique: false });
                    progressStore.createIndex('successRate', 'successRate', { unique: false });
                }

                // Daily study log
                if (!db.objectStoreNames.contains('dailyLog')) {
                    const logStore = db.createObjectStore('dailyLog', { keyPath: ['profileName', 'date'] });
                    logStore.createIndex('profileName', 'profileName', { unique: false });
                }

                // Settings store
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
            };
        });
    }

    async getAll(storeName) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async get(storeName, key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async put(storeName, data) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put(data);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async delete(storeName, key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getByIndex(storeName, indexName, value) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const index = store.index(indexName);
            const request = index.getAll(value);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
}

class HSKTrainer {
    constructor() {
        this.vocabulary = HSK_VOCABULARY;
        this.db = new HSKDatabase();
        this.currentProfile = null;
        this.currentCard = null;
        this.isCardFlipped = false;
        this.isInputMode = false;

        // ════════════════════════════════════════════════════════════════
        // API KEY LOCATION: Stored in localStorage, key name: 'claude_api_key'
        // To change: localStorage.setItem('claude_api_key', 'your-key')
        // ════════════════════════════════════════════════════════════════
        this.apiKey = localStorage.getItem('claude_api_key') || '';

        // Hanzi Writer instances
        this.hanziWriters = [];
        this.isQuizMode = false;

        // Daily limits
        this.NEW_CARDS_PER_DAY = 10;
        this.REVIEW_CARDS_PER_DAY = 50;

        // Word progress cache for current profile
        this.wordProgressCache = new Map();

        this.initializeApp();
    }

    // ==================== INITIALIZATION ====================

    async initializeApp() {
        try {
            await this.db.init();
            await this.loadProfiles();
            this.renderProfileList();
            this.attachEventListeners();
        } catch (error) {
            console.error('Failed to initialize database:', error);
            // Fallback to localStorage
            this.useFallbackStorage = true;
            this.loadProfilesFromLocalStorage();
            this.renderProfileList();
            this.attachEventListeners();
        }
    }

    attachEventListeners() {
        // Profile screen
        document.getElementById('create-profile-btn').addEventListener('click', () => this.createProfile());
        document.getElementById('new-profile-name').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.createProfile();
        });

        // Learning screen
        document.getElementById('logout-btn').addEventListener('click', () => this.logout());
        document.getElementById('flashcard').addEventListener('click', () => this.flipCard());
        document.getElementById('yes-btn').addEventListener('click', () => this.markAnswer(true));
        document.getElementById('no-btn').addEventListener('click', () => this.markAnswer(false));
        document.getElementById('generate-sentences-btn').addEventListener('click', () => this.generateSentences());
        document.getElementById('check-answer-btn').addEventListener('click', () => this.checkMandarinInput());
        document.getElementById('mandarin-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.checkMandarinInput();
        });

        // API Key modal
        document.getElementById('save-api-key-btn').addEventListener('click', () => this.saveApiKey());
        document.getElementById('cancel-api-key-btn').addEventListener('click', () => this.hideApiKeyModal());

        // Hanzi Writer controls
        document.getElementById('animate-all-btn').addEventListener('click', () => this.animateAllCharacters());
        document.getElementById('quiz-mode-btn').addEventListener('click', () => this.toggleQuizMode());

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));
    }

    handleKeyboard(e) {
        if (this.currentProfile && document.getElementById('learning-screen').classList.contains('active')) {
            if (e.key === 'ArrowLeft' || e.key === 'n' || e.key === 'N') {
                this.markAnswer(false);
            } else if (e.key === 'ArrowRight' || e.key === 'y' || e.key === 'Y') {
                this.markAnswer(true);
            } else if (e.key === ' ' && !this.isInputMode) {
                e.preventDefault();
                this.flipCard();
            }
        }
    }

    // ==================== PROFILE MANAGEMENT ====================

    async loadProfiles() {
        if (this.useFallbackStorage) {
            this.loadProfilesFromLocalStorage();
            return;
        }
        const profiles = await this.db.getAll('profiles');
        this.profiles = {};
        profiles.forEach(p => this.profiles[p.name] = p);
    }

    loadProfilesFromLocalStorage() {
        const profiles = localStorage.getItem('hsk_profiles');
        this.profiles = profiles ? JSON.parse(profiles) : {};
    }

    async saveProfile(profile) {
        if (this.useFallbackStorage) {
            this.profiles[profile.name] = profile;
            localStorage.setItem('hsk_profiles', JSON.stringify(this.profiles));
            return;
        }
        await this.db.put('profiles', profile);
        this.profiles[profile.name] = profile;
    }

    async createProfile() {
        const nameInput = document.getElementById('new-profile-name');
        const name = nameInput.value.trim();

        if (!name) {
            alert('Please enter a profile name');
            return;
        }

        if (this.profiles[name]) {
            alert('A profile with this name already exists');
            return;
        }

        const profile = {
            name: name,
            createdAt: Date.now(),
            totalCorrect: 0,
            totalIncorrect: 0,
            lastStudied: null,
            streakDays: 0,
            lastStreakDate: null
        };

        await this.saveProfile(profile);
        this.renderProfileList();
        nameInput.value = '';
    }

    async deleteProfile(name) {
        if (confirm(`Are you sure you want to delete profile "${name}"?`)) {
            if (this.useFallbackStorage) {
                delete this.profiles[name];
                localStorage.setItem('hsk_profiles', JSON.stringify(this.profiles));
            } else {
                await this.db.delete('profiles', name);
                delete this.profiles[name];
            }
            this.renderProfileList();
        }
    }

    async selectProfile(name) {
        this.currentProfile = this.profiles[name];
        await this.loadWordProgress();
        await this.checkAndUpdateDailyLog();
        this.showScreen('learning-screen');
        document.getElementById('current-user').textContent = name;
        this.updateStats();
        await this.loadNextCard();
    }

    logout() {
        this.currentProfile = null;
        this.currentCard = null;
        this.wordProgressCache.clear();
        this.showScreen('profile-screen');
    }

    renderProfileList() {
        const profileList = document.getElementById('profile-list');
        profileList.innerHTML = '';

        const profileNames = Object.keys(this.profiles);

        if (profileNames.length === 0) {
            profileList.innerHTML = '<p style="color: var(--light-gray);">No profiles yet. Create one to start learning!</p>';
            return;
        }

        profileNames.forEach(name => {
            const profile = this.profiles[name];
            const profileItem = document.createElement('div');
            profileItem.className = 'profile-item';
            profileItem.innerHTML = `
                <div>
                    <span class="profile-name">${name}</span>
                    <span class="profile-stats">Streak: ${profile.streakDays || 0} days</span>
                </div>
                <button class="delete-profile" data-name="${name}">×</button>
            `;

            profileItem.addEventListener('click', (e) => {
                if (!e.target.classList.contains('delete-profile')) {
                    this.selectProfile(name);
                }
            });

            profileItem.querySelector('.delete-profile').addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteProfile(name);
            });

            profileList.appendChild(profileItem);
        });
    }

    // ==================== WORD PROGRESS MANAGEMENT ====================

    async loadWordProgress() {
        this.wordProgressCache.clear();

        if (this.useFallbackStorage) {
            const stored = localStorage.getItem(`hsk_progress_${this.currentProfile.name}`);
            if (stored) {
                const data = JSON.parse(stored);
                Object.entries(data).forEach(([wordId, progress]) => {
                    this.wordProgressCache.set(parseInt(wordId), progress);
                });
            }
            return;
        }

        const progressList = await this.db.getByIndex('wordProgress', 'profileName', this.currentProfile.name);
        progressList.forEach(p => {
            this.wordProgressCache.set(p.wordId, p);
        });
    }

    async saveWordProgress(wordId, progress) {
        progress.profileName = this.currentProfile.name;
        progress.wordId = wordId;
        this.wordProgressCache.set(wordId, progress);

        if (this.useFallbackStorage) {
            const data = {};
            this.wordProgressCache.forEach((v, k) => data[k] = v);
            localStorage.setItem(`hsk_progress_${this.currentProfile.name}`, JSON.stringify(data));
            return;
        }

        await this.db.put('wordProgress', progress);
    }

    getWordProgress(wordId) {
        if (!this.wordProgressCache.has(wordId)) {
            return {
                profileName: this.currentProfile.name,
                wordId: wordId,
                level: 0,
                ease: 2.5, // SM-2 ease factor
                interval: 0,
                nextReview: Date.now(),
                correctCount: 0,
                incorrectCount: 0,
                successRate: 0,
                lastReviewed: null,
                firstSeen: null
            };
        }
        return this.wordProgressCache.get(wordId);
    }

    // ==================== DAILY LOG & LIMITS ====================

    getTodayKey() {
        return new Date().toISOString().split('T')[0];
    }

    async checkAndUpdateDailyLog() {
        const today = this.getTodayKey();

        if (this.useFallbackStorage) {
            const logKey = `hsk_daily_${this.currentProfile.name}`;
            const stored = localStorage.getItem(logKey);
            this.dailyLog = stored ? JSON.parse(stored) : {};

            if (!this.dailyLog[today]) {
                this.dailyLog[today] = { newCardsStudied: 0, reviewsDone: 0, date: today };
            }
            return;
        }

        const log = await this.db.get('dailyLog', [this.currentProfile.name, today]);
        if (!log) {
            this.dailyLog = {
                profileName: this.currentProfile.name,
                date: today,
                newCardsStudied: 0,
                reviewsDone: 0
            };
            await this.db.put('dailyLog', this.dailyLog);
        } else {
            this.dailyLog = log;
        }

        // Update streak
        await this.updateStreak();
    }

    async updateStreak() {
        const today = this.getTodayKey();
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

        if (this.currentProfile.lastStreakDate === today) {
            return; // Already updated today
        }

        if (this.currentProfile.lastStreakDate === yesterday) {
            this.currentProfile.streakDays = (this.currentProfile.streakDays || 0) + 1;
        } else if (this.currentProfile.lastStreakDate !== today) {
            this.currentProfile.streakDays = 1;
        }

        this.currentProfile.lastStreakDate = today;
        await this.saveProfile(this.currentProfile);
    }

    async saveDailyLog() {
        if (this.useFallbackStorage) {
            const logKey = `hsk_daily_${this.currentProfile.name}`;
            const stored = localStorage.getItem(logKey);
            const logs = stored ? JSON.parse(stored) : {};
            logs[this.dailyLog.date] = this.dailyLog;
            localStorage.setItem(logKey, JSON.stringify(logs));
            return;
        }
        await this.db.put('dailyLog', this.dailyLog);
    }

    canStudyNewCard() {
        const today = this.getTodayKey();
        if (!this.dailyLog || this.dailyLog.date !== today) {
            return true;
        }
        return this.dailyLog.newCardsStudied < this.NEW_CARDS_PER_DAY;
    }

    // ==================== ENHANCED SPACED REPETITION ====================
    // Uses SM-2 algorithm with decay prevention and meta-learning principles

    getReviewInterval(level, ease) {
        // SM-2 inspired intervals with 2357 influence
        const baseIntervals = [
            0,                          // Level 0: immediate
            10 * 60 * 1000,             // Level 1: 10 minutes
            60 * 60 * 1000,             // Level 2: 1 hour
            6 * 60 * 60 * 1000,         // Level 3: 6 hours
            24 * 60 * 60 * 1000,        // Level 4: 1 day
            2 * 24 * 60 * 60 * 1000,    // Level 5: 2 days
            4 * 24 * 60 * 60 * 1000,    // Level 6: 4 days
            7 * 24 * 60 * 60 * 1000,    // Level 7: 7 days
            14 * 24 * 60 * 60 * 1000,   // Level 8: 14 days
            30 * 24 * 60 * 60 * 1000,   // Level 9: 30 days
            60 * 24 * 60 * 60 * 1000    // Level 10+: 60 days
        ];

        const baseInterval = baseIntervals[Math.min(level, baseIntervals.length - 1)];
        return Math.round(baseInterval * ease);
    }

    async updateWordProgress(wordId, correct) {
        const progress = this.getWordProgress(wordId);
        const now = Date.now();

        if (!progress.firstSeen) {
            progress.firstSeen = now;
        }

        if (correct) {
            progress.level = Math.min(progress.level + 1, 10);
            progress.correctCount++;
            progress.ease = Math.min(progress.ease + 0.1, 3.0);
            this.currentProfile.totalCorrect++;
        } else {
            // On incorrect, reduce level more gradually
            progress.level = Math.max(0, progress.level - 1);
            progress.incorrectCount++;
            progress.ease = Math.max(1.3, progress.ease - 0.2);
            this.currentProfile.totalIncorrect++;
        }

        // Calculate success rate
        const total = progress.correctCount + progress.incorrectCount;
        progress.successRate = total > 0 ? progress.correctCount / total : 0;

        // Calculate next review time
        progress.interval = this.getReviewInterval(progress.level, progress.ease);
        progress.nextReview = now + progress.interval;
        progress.lastReviewed = now;

        this.currentProfile.lastStudied = now;

        await this.saveWordProgress(wordId, progress);
        await this.saveProfile(this.currentProfile);
    }

    getDueCards() {
        const now = Date.now();
        const dueCards = [];

        this.vocabulary.forEach(word => {
            const progress = this.wordProgressCache.get(word.id);
            if (progress && progress.nextReview <= now) {
                dueCards.push({
                    ...word,
                    progress: progress,
                    // Priority: lower success rate = higher priority (refresh struggling cards)
                    priority: progress.successRate,
                    isReview: true
                });
            }
        });

        // Sort by success rate (lowest first - these are the "worst performing" cards)
        dueCards.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.progress.nextReview - b.progress.nextReview;
        });

        return dueCards;
    }

    getWorstPerformingCards(limit = 10) {
        const cardsWithProgress = [];

        this.vocabulary.forEach(word => {
            const progress = this.wordProgressCache.get(word.id);
            if (progress && progress.incorrectCount > 0) {
                cardsWithProgress.push({
                    ...word,
                    progress: progress,
                    successRate: progress.successRate
                });
            }
        });

        // Sort by success rate (lowest first)
        cardsWithProgress.sort((a, b) => a.successRate - b.successRate);

        return cardsWithProgress.slice(0, limit);
    }

    getNewCards(limit = 10) {
        const newCards = [];

        for (const word of this.vocabulary) {
            if (!this.wordProgressCache.has(word.id)) {
                newCards.push(word);
                if (newCards.length >= limit) break;
            }
        }

        return newCards;
    }

    // ==================== CARD DISPLAY & INTERACTION ====================

    async loadNextCard() {
        // Priority order:
        // 1. Due review cards (especially worst performing)
        // 2. New cards (up to daily limit)

        let dueCards = this.getDueCards();

        if (dueCards.length > 0) {
            // Prioritize worst performing cards at start of session
            const worstCards = dueCards.filter(c => c.progress.successRate < 0.5);
            if (worstCards.length > 0) {
                this.currentCard = worstCards[0];
            } else {
                this.currentCard = dueCards[0];
            }
            this.currentCard.isNew = false;
        } else if (this.canStudyNewCard()) {
            // Introduce new cards
            const newCards = this.getNewCards(1);
            if (newCards.length > 0) {
                this.currentCard = newCards[0];
                this.currentCard.isNew = true;

                // Initialize progress for new card
                const progress = this.getWordProgress(this.currentCard.id);
                progress.firstSeen = Date.now();
                await this.saveWordProgress(this.currentCard.id, progress);

                // Update daily log
                this.dailyLog.newCardsStudied++;
                await this.saveDailyLog();
            } else {
                this.showCompletionMessage();
                return;
            }
        } else {
            this.showDailyLimitMessage();
            return;
        }

        this.displayCard();
        this.updateStats();
    }

    displayCard() {
        if (!this.currentCard) return;

        this.isCardFlipped = false;
        const flashcard = document.getElementById('flashcard');
        flashcard.classList.remove('flipped');

        // 70% chance to show Chinese first
        this.isInputMode = Math.random() < 0.3;

        const inputContainer = document.getElementById('input-container');

        if (this.isInputMode) {
            flashcard.style.display = 'none';
            inputContainer.classList.remove('hidden');
            document.getElementById('english-prompt').textContent = this.currentCard.english;
            document.getElementById('mandarin-input').value = '';
            document.getElementById('answer-feedback').classList.add('hidden');
            document.getElementById('mandarin-input').focus();
        } else {
            flashcard.style.display = 'block';
            inputContainer.classList.add('hidden');
            document.getElementById('card-character').textContent = this.currentCard.chinese;
            document.getElementById('card-pinyin').textContent = this.currentCard.pinyin;
            document.getElementById('card-pinyin').classList.add('hidden');
            document.getElementById('card-english').textContent = this.currentCard.english;
            document.getElementById('card-pinyin-back').textContent = this.currentCard.pinyin;
            document.getElementById('card-chinese-back').textContent = this.currentCard.chinese;
        }

        // Show example sentence if available
        this.displayExampleSentence();

        // Update stroke order
        this.updateStrokeOrder();

        // Hide generated sentences from previous card
        document.getElementById('sentences-container').classList.add('hidden');
    }

    displayExampleSentence() {
        const container = document.getElementById('sentences-container');
        const content = document.getElementById('sentences-content');

        // Check if vocabulary has built-in example
        if (this.currentCard.example) {
            content.innerHTML = `
                <div class="sentence-item">
                    <div class="sentence-chinese">${this.currentCard.example.chinese}</div>
                    <div class="sentence-pinyin">${this.currentCard.example.pinyin}</div>
                    <div class="sentence-english">${this.currentCard.example.english}</div>
                </div>
            `;
            container.classList.remove('hidden');
        }
    }

    flipCard() {
        if (this.isInputMode || !this.currentCard) return;

        this.isCardFlipped = !this.isCardFlipped;
        const flashcard = document.getElementById('flashcard');

        if (this.isCardFlipped) {
            flashcard.classList.add('flipped');
            document.getElementById('card-pinyin').classList.remove('hidden');
        } else {
            flashcard.classList.remove('flipped');
        }
    }

    checkMandarinInput() {
        const input = document.getElementById('mandarin-input').value.trim();
        const feedback = document.getElementById('answer-feedback');

        if (!input) {
            feedback.textContent = 'Please enter your answer';
            feedback.className = 'answer-feedback incorrect';
            feedback.classList.remove('hidden');
            return;
        }

        const correct = input === this.currentCard.chinese;

        feedback.classList.remove('hidden');
        if (correct) {
            feedback.className = 'answer-feedback correct';
            feedback.innerHTML = `✓ Correct! <br><strong>${this.currentCard.chinese}</strong> (${this.currentCard.pinyin})`;
        } else {
            feedback.className = 'answer-feedback incorrect';
            feedback.innerHTML = `✗ The answer is: <br><strong>${this.currentCard.chinese}</strong> (${this.currentCard.pinyin})`;
        }
    }

    async markAnswer(correct) {
        if (!this.currentCard) return;

        await this.updateWordProgress(this.currentCard.id, correct);

        // Update daily review count
        if (this.dailyLog) {
            this.dailyLog.reviewsDone++;
            await this.saveDailyLog();
        }

        await this.loadNextCard();
    }

    showCompletionMessage() {
        const cardContainer = document.querySelector('.card-container');
        document.getElementById('flashcard').style.display = 'none';
        document.getElementById('input-container').classList.add('hidden');

        const learnedCount = Array.from(this.wordProgressCache.values()).filter(p => p.level >= 3).length;

        cardContainer.innerHTML = `
            <div class="no-cards-message">
                <h3>🎉 Great job!</h3>
                <p>You've completed all due reviews and reached today's new card limit.</p>
                <p>Come back tomorrow for more learning!</p>
                <p style="margin-top: 1rem; color: var(--red);">
                    Total mastered: ${learnedCount} / ${this.vocabulary.length}
                </p>
                <p style="margin-top: 0.5rem; color: var(--light-gray);">
                    Streak: ${this.currentProfile.streakDays || 1} days 🔥
                </p>
            </div>
        `;
    }

    showDailyLimitMessage() {
        const cardContainer = document.querySelector('.card-container');
        document.getElementById('flashcard').style.display = 'none';
        document.getElementById('input-container').classList.add('hidden');

        cardContainer.innerHTML = `
            <div class="no-cards-message">
                <h3>Daily Limit Reached</h3>
                <p>You've studied ${this.NEW_CARDS_PER_DAY} new cards today!</p>
                <p>This limit helps prevent cognitive overload and improves long-term retention.</p>
                <p style="margin-top: 1rem; color: var(--light-gray);">
                    Come back tomorrow for more new cards, or wait for reviews to become due.
                </p>
            </div>
        `;
    }

    // ==================== STROKE ORDER (Hanzi Writer) ====================

    updateStrokeOrder() {
        if (!this.currentCard) return;

        this.cleanupHanziWriters();

        const container = document.getElementById('hanzi-writer-container');
        container.innerHTML = '';
        container.classList.remove('quiz-active');

        this.isQuizMode = false;
        document.getElementById('quiz-mode-btn').textContent = 'Quiz Mode';

        const characters = this.currentCard.chinese.split('');

        characters.forEach((char, index) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'hanzi-char-wrapper';
            wrapper.id = `hanzi-wrapper-${index}`;

            const target = document.createElement('div');
            target.id = `hanzi-target-${index}`;
            wrapper.appendChild(target);

            const label = document.createElement('div');
            label.className = 'hanzi-char-label';
            label.textContent = `${index + 1}/${characters.length}`;
            wrapper.appendChild(label);

            container.appendChild(wrapper);

            try {
                const writer = HanziWriter.create(`hanzi-target-${index}`, char, {
                    width: 150,
                    height: 150,
                    padding: 5,
                    showOutline: true,
                    showCharacter: true,
                    strokeColor: '#dc2626',
                    outlineColor: '#ddd',
                    drawingColor: '#333',
                    radicalColor: '#dc2626',
                    highlightColor: '#dc2626',
                    strokeAnimationSpeed: 1,
                    delayBetweenStrokes: 300,
                    charDataLoader: (char, onComplete) => {
                        fetch(`https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0/${char}.json`)
                            .then(response => response.ok ? response.json() : Promise.reject())
                            .then(data => onComplete(data))
                            .catch(() => {
                                target.innerHTML = `<div style="width:150px;height:150px;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:8px;font-size:4rem;">${char}</div>`;
                            });
                    }
                });

                this.hanziWriters.push({ writer, char, index });

                target.addEventListener('click', () => {
                    if (!this.isQuizMode) {
                        writer.animateCharacter();
                    }
                });

            } catch (err) {
                target.innerHTML = `<div style="width:150px;height:150px;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:8px;font-size:4rem;">${char}</div>`;
            }
        });
    }

    cleanupHanziWriters() {
        this.hanziWriters.forEach(({ writer }) => {
            try {
                writer.cancelQuiz();
                writer.hideCharacter();
            } catch (e) {}
        });
        this.hanziWriters = [];
    }

    animateAllCharacters() {
        if (this.hanziWriters.length === 0) return;

        let delay = 0;
        this.hanziWriters.forEach(({ writer }) => {
            setTimeout(() => {
                try { writer.animateCharacter(); } catch (e) {}
            }, delay);
            delay += 1500;
        });
    }

    toggleQuizMode() {
        if (this.hanziWriters.length === 0) return;

        this.isQuizMode = !this.isQuizMode;
        const container = document.getElementById('hanzi-writer-container');
        const btn = document.getElementById('quiz-mode-btn');

        if (this.isQuizMode) {
            container.classList.add('quiz-active');
            btn.textContent = 'Exit Quiz';
            this.startQuiz();
        } else {
            container.classList.remove('quiz-active');
            btn.textContent = 'Quiz Mode';
            this.hanziWriters.forEach(({ writer }) => {
                try {
                    writer.cancelQuiz();
                    writer.showCharacter();
                    writer.showOutline();
                } catch (e) {}
            });
        }
    }

    startQuiz() {
        this.runQuizForCharacter(0);
    }

    runQuizForCharacter(index) {
        if (index >= this.hanziWriters.length || !this.isQuizMode) return;

        const { writer } = this.hanziWriters[index];

        document.querySelectorAll('.hanzi-char-label').forEach((label, i) => {
            label.classList.toggle('active', i === index);
        });

        try {
            writer.quiz({
                showHintAfterMisses: 3,
                highlightOnComplete: true,
                onComplete: () => {
                    setTimeout(() => this.runQuizForCharacter(index + 1), 500);
                }
            });
        } catch (e) {
            this.runQuizForCharacter(index + 1);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ║                    CLAUDE API INTEGRATION                              ║
    // ║                                                                        ║
    // ║  API Key is stored at: localStorage.getItem('claude_api_key')          ║
    // ║  API Key is used in the fetch() call below (line ~780)                 ║
    // ║                                                                        ║
    // ║  To set API key: localStorage.setItem('claude_api_key', 'your-key')    ║
    // ║  Or use the modal that appears when clicking "Generate Sentences"      ║
    // ══════════════════════════════════════════════════════════════════════════

    async generateSentences() {
        if (!this.currentCard) return;

        // ════════════════════════════════════════════════════════════════
        // API KEY CHECK - Retrieved from localStorage
        // ════════════════════════════════════════════════════════════════
        if (!this.apiKey) {
            this.showApiKeyModal();
            return;
        }

        const btn = document.getElementById('generate-sentences-btn');
        const container = document.getElementById('sentences-container');
        const content = document.getElementById('sentences-content');

        btn.disabled = true;
        btn.innerHTML = '<span class="loading"></span> Generating...';

        try {
            // ════════════════════════════════════════════════════════════════
            // API REQUEST - Using the stored API key
            // Model: claude-3-haiku-20240307 (fast and cost-effective)
            // ════════════════════════════════════════════════════════════════
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,  // ← API KEY USED HERE
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
                },
                body: JSON.stringify({
                    model: 'claude-3-haiku-20240307',
                    max_tokens: 1024,
                    messages: [{
                        role: 'user',
                        content: `Generate 3 simple example sentences using the Chinese word "${this.currentCard.chinese}" (${this.currentCard.pinyin}, meaning: ${this.currentCard.english}).

Sentences should be HSK 1 level (beginner). Format exactly as:

1. [Chinese]
[Pinyin]
[English]

2. [Chinese]
[Pinyin]
[English]

3. [Chinese]
[Pinyin]
[English]`
                    }]
                })
            });

            const data = await response.json();

            if (!response.ok) {
                const errorMsg = data.error?.message || `HTTP ${response.status}`;
                throw new Error(errorMsg);
            }

            if (data.content?.[0]?.text) {
                const sentences = this.parseSentences(data.content[0].text);
                this.displaySentences(sentences);
            } else {
                throw new Error('Unexpected response format');
            }

        } catch (error) {
            console.error('API Error:', error);

            content.innerHTML = `
                <div class="api-error">
                    <div class="api-error-title">Error generating sentences</div>
                    <div class="api-error-details">
                        <p>${error.message}</p>
                        <p style="margin-top: 0.5rem; font-size: 0.8rem;">
                            Make sure your API key has browser access enabled at
                            <a href="https://console.anthropic.com/settings/keys" target="_blank" style="color: var(--red);">console.anthropic.com</a>
                        </p>
                    </div>
                </div>
            `;
            container.classList.remove('hidden');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Generate Sample Sentences';
        }
    }

    parseSentences(text) {
        const sentences = [];
        const lines = text.trim().split('\n').filter(line => line.trim());
        let currentSentence = {};

        for (const line of lines) {
            const cleanLine = line.trim().replace(/^\d+\.\s*/, '');
            if (!cleanLine) continue;

            const hasChinese = /[\u4e00-\u9fff]/.test(cleanLine);
            const hasPinyin = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(cleanLine);

            if (hasChinese && !currentSentence.chinese) {
                currentSentence.chinese = cleanLine;
            } else if (hasPinyin && !currentSentence.pinyin) {
                currentSentence.pinyin = cleanLine;
            } else if (!hasChinese && !hasPinyin && currentSentence.chinese) {
                currentSentence.english = cleanLine;
                sentences.push({...currentSentence});
                currentSentence = {};
            }
        }

        if (currentSentence.chinese && currentSentence.english) {
            sentences.push(currentSentence);
        }

        return sentences;
    }

    displaySentences(sentences) {
        const container = document.getElementById('sentences-container');
        const content = document.getElementById('sentences-content');

        if (sentences.length === 0) {
            content.innerHTML = '<p>Could not parse sentences. Please try again.</p>';
        } else {
            content.innerHTML = sentences.map(s => `
                <div class="sentence-item">
                    <div class="sentence-chinese">${s.chinese || ''}</div>
                    <div class="sentence-pinyin">${s.pinyin || ''}</div>
                    <div class="sentence-english">${s.english || ''}</div>
                </div>
            `).join('');
        }

        container.classList.remove('hidden');
    }

    showApiKeyModal() {
        document.getElementById('api-key-modal').classList.remove('hidden');
        document.getElementById('api-key-input').value = this.apiKey;
        document.getElementById('api-key-input').focus();
    }

    hideApiKeyModal() {
        document.getElementById('api-key-modal').classList.add('hidden');
    }

    saveApiKey() {
        const key = document.getElementById('api-key-input').value.trim();
        this.apiKey = key;
        // ════════════════════════════════════════════════════════════════
        // API KEY STORAGE - Saved to localStorage
        // ════════════════════════════════════════════════════════════════
        localStorage.setItem('claude_api_key', key);
        this.hideApiKeyModal();

        if (key) {
            this.generateSentences();
        }
    }

    // ==================== STATISTICS ====================

    updateStats() {
        if (!this.currentProfile) return;

        const learned = Array.from(this.wordProgressCache.values()).filter(p => p.level >= 3).length;
        const due = this.getDueCards().length;
        const total = this.vocabulary.length;

        document.getElementById('learned-count').textContent = learned;
        document.getElementById('due-count').textContent = due;
        document.getElementById('total-count').textContent = total;

        const progress = (learned / total) * 100;
        document.getElementById('progress-fill').style.width = `${progress}%`;
        document.getElementById('progress-text').textContent = `${progress.toFixed(1)}% Complete`;
    }

    // ==================== SCREEN MANAGEMENT ====================

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
        document.getElementById(screenId).classList.add('active');
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.hskTrainer = new HSKTrainer();
});
