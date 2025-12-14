// HSK 3.0 Level 1 Vocabulary Trainer - Main Application
// Implements user profiles, 2357 spaced repetition, and Claude API integration

class HSKTrainer {
    constructor() {
        this.vocabulary = HSK_VOCABULARY;
        this.currentProfile = null;
        this.currentCard = null;
        this.isCardFlipped = false;
        this.isInputMode = false;
        this.apiKey = localStorage.getItem('claude_api_key') || '';

        // Hanzi Writer instances for stroke order visualization
        this.hanziWriters = [];
        this.isQuizMode = false;

        this.initializeApp();
    }

    // ==================== INITIALIZATION ====================

    initializeApp() {
        this.loadProfiles();
        this.renderProfileList();
        this.attachEventListeners();
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

    loadProfiles() {
        const profiles = localStorage.getItem('hsk_profiles');
        this.profiles = profiles ? JSON.parse(profiles) : {};
    }

    saveProfiles() {
        localStorage.setItem('hsk_profiles', JSON.stringify(this.profiles));
    }

    createProfile() {
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

        this.profiles[name] = {
            name: name,
            createdAt: Date.now(),
            wordProgress: {}, // { wordId: { level: 0-5, nextReview: timestamp, correctCount, incorrectCount } }
            totalCorrect: 0,
            totalIncorrect: 0,
            lastStudied: null
        };

        this.saveProfiles();
        this.renderProfileList();
        nameInput.value = '';
    }

    deleteProfile(name) {
        if (confirm(`Are you sure you want to delete profile "${name}"?`)) {
            delete this.profiles[name];
            this.saveProfiles();
            this.renderProfileList();
        }
    }

    selectProfile(name) {
        this.currentProfile = this.profiles[name];
        this.showScreen('learning-screen');
        document.getElementById('current-user').textContent = name;
        this.updateStats();
        this.loadNextCard();
    }

    logout() {
        this.currentProfile = null;
        this.currentCard = null;
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
            const learnedCount = Object.values(profile.wordProgress).filter(p => p.level >= 3).length;

            const profileItem = document.createElement('div');
            profileItem.className = 'profile-item';
            profileItem.innerHTML = `
                <div>
                    <span class="profile-name">${name}</span>
                    <span class="profile-stats">${learnedCount} / ${this.vocabulary.length} words learned</span>
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

    // ==================== 2357 SPACED REPETITION ALGORITHM ====================
    // Based on Kwik Learning principles and 2357 method
    // Review intervals: 2 hours, 3 hours, 5 hours, 7 hours, then 2 days, 3 days, 5 days, 7 days

    getReviewInterval(level) {
        // Level 0: New word - immediate review
        // Level 1: 2 hours
        // Level 2: 3 hours
        // Level 3: 5 hours
        // Level 4: 7 hours
        // Level 5: 2 days
        // Level 6: 3 days
        // Level 7: 5 days
        // Level 8: 7 days
        // Level 9+: 14 days (mastered)

        const intervals = [
            0,                    // Level 0: immediate
            2 * 60 * 60 * 1000,   // Level 1: 2 hours
            3 * 60 * 60 * 1000,   // Level 2: 3 hours
            5 * 60 * 60 * 1000,   // Level 3: 5 hours
            7 * 60 * 60 * 1000,   // Level 4: 7 hours
            2 * 24 * 60 * 60 * 1000, // Level 5: 2 days
            3 * 24 * 60 * 60 * 1000, // Level 6: 3 days
            5 * 24 * 60 * 60 * 1000, // Level 7: 5 days
            7 * 24 * 60 * 60 * 1000, // Level 8: 7 days
            14 * 24 * 60 * 60 * 1000 // Level 9+: 14 days
        ];

        return intervals[Math.min(level, intervals.length - 1)];
    }

    getWordProgress(wordId) {
        if (!this.currentProfile.wordProgress[wordId]) {
            this.currentProfile.wordProgress[wordId] = {
                level: 0,
                nextReview: Date.now(),
                correctCount: 0,
                incorrectCount: 0,
                lastReviewed: null
            };
        }
        return this.currentProfile.wordProgress[wordId];
    }

    updateWordProgress(wordId, correct) {
        const progress = this.getWordProgress(wordId);
        const now = Date.now();

        if (correct) {
            progress.level = Math.min(progress.level + 1, 10);
            progress.correctCount++;
            this.currentProfile.totalCorrect++;
        } else {
            // On incorrect, drop back 2 levels (but not below 0)
            progress.level = Math.max(0, progress.level - 2);
            progress.incorrectCount++;
            this.currentProfile.totalIncorrect++;
        }

        progress.nextReview = now + this.getReviewInterval(progress.level);
        progress.lastReviewed = now;
        this.currentProfile.lastStudied = now;

        this.saveProfiles();
    }

    getDueCards() {
        const now = Date.now();
        const dueCards = [];

        // First, add cards that are due for review
        this.vocabulary.forEach(word => {
            const progress = this.currentProfile.wordProgress[word.id];
            if (progress && progress.nextReview <= now) {
                dueCards.push({
                    ...word,
                    progress: progress,
                    priority: progress.level // Lower level = higher priority
                });
            }
        });

        // Sort by priority (lower level first, then by next review time)
        dueCards.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.progress.nextReview - b.progress.nextReview;
        });

        return dueCards;
    }

    getNewCards(limit = 5) {
        const newCards = [];

        this.vocabulary.forEach(word => {
            if (!this.currentProfile.wordProgress[word.id]) {
                newCards.push(word);
            }
        });

        // Shuffle and return limited number
        return this.shuffle(newCards).slice(0, limit);
    }

    shuffle(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    // ==================== CARD DISPLAY & INTERACTION ====================

    loadNextCard() {
        // First try to get due cards
        let dueCards = this.getDueCards();

        if (dueCards.length > 0) {
            this.currentCard = dueCards[0];
        } else {
            // No due cards, introduce new cards
            const newCards = this.getNewCards(1);
            if (newCards.length > 0) {
                this.currentCard = newCards[0];
                // Initialize progress for new card
                this.getWordProgress(this.currentCard.id);
            } else {
                // All cards learned and none due!
                this.showCompletionMessage();
                return;
            }
        }

        this.displayCard();
        this.updateStats();
    }

    displayCard() {
        if (!this.currentCard) return;

        this.isCardFlipped = false;
        const flashcard = document.getElementById('flashcard');
        flashcard.classList.remove('flipped');

        // Randomly decide if showing Chinese or English first
        // 70% chance to show Chinese (more practice recognizing characters)
        this.isInputMode = Math.random() < 0.3;

        const inputContainer = document.getElementById('input-container');
        const cardContainer = document.querySelector('.card-container');

        if (this.isInputMode) {
            // English to Mandarin mode - user must type
            flashcard.style.display = 'none';
            inputContainer.classList.remove('hidden');
            document.getElementById('english-prompt').textContent = this.currentCard.english;
            document.getElementById('mandarin-input').value = '';
            document.getElementById('answer-feedback').classList.add('hidden');
            document.getElementById('mandarin-input').focus();
        } else {
            // Chinese to English mode - user clicks to flip
            flashcard.style.display = 'block';
            inputContainer.classList.add('hidden');

            // Front side - Chinese character
            document.getElementById('card-character').textContent = this.currentCard.chinese;
            document.getElementById('card-pinyin').textContent = this.currentCard.pinyin;
            document.getElementById('card-pinyin').classList.add('hidden');

            // Back side - English and details
            document.getElementById('card-english').textContent = this.currentCard.english;
            document.getElementById('card-pinyin-back').textContent = this.currentCard.pinyin;
            document.getElementById('card-chinese-back').textContent = this.currentCard.chinese;
        }

        // Update stroke order iframe
        this.updateStrokeOrder();

        // Hide sentences from previous card
        document.getElementById('sentences-container').classList.add('hidden');
        document.getElementById('sentences-content').innerHTML = '';
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

        // Check if input matches (allow for some flexibility)
        const correct = input === this.currentCard.chinese;

        feedback.classList.remove('hidden');
        if (correct) {
            feedback.className = 'answer-feedback correct';
            feedback.innerHTML = `✓ Correct! <br><strong>${this.currentCard.chinese}</strong> (${this.currentCard.pinyin})`;
        } else {
            feedback.className = 'answer-feedback incorrect';
            feedback.innerHTML = `✗ The answer is: <br><strong>${this.currentCard.chinese}</strong> (${this.currentCard.pinyin})`;
        }

        // Auto-mark based on input correctness
        // User can still override with Yes/No buttons
    }

    markAnswer(correct) {
        if (!this.currentCard) return;

        this.updateWordProgress(this.currentCard.id, correct);
        this.loadNextCard();
    }

    showCompletionMessage() {
        const cardContainer = document.querySelector('.card-container');
        document.getElementById('flashcard').style.display = 'none';
        document.getElementById('input-container').classList.add('hidden');

        cardContainer.innerHTML = `
            <div class="no-cards-message">
                <h3>Congratulations!</h3>
                <p>You've reviewed all due cards and learned all available vocabulary.</p>
                <p>Come back later for more review sessions!</p>
                <p style="margin-top: 1rem; color: var(--red);">
                    Total learned: ${Object.values(this.currentProfile.wordProgress).filter(p => p.level >= 3).length} / ${this.vocabulary.length}
                </p>
            </div>
        `;
    }

    // ==================== STROKE ORDER (Hanzi Writer) ====================

    updateStrokeOrder() {
        if (!this.currentCard) return;

        // Clean up previous Hanzi Writer instances
        this.cleanupHanziWriters();

        const container = document.getElementById('hanzi-writer-container');
        container.innerHTML = '';
        container.classList.remove('quiz-active');

        // Reset quiz mode
        this.isQuizMode = false;
        document.getElementById('quiz-mode-btn').textContent = 'Quiz Mode';

        const characters = this.currentCard.chinese.split('');

        // Create a Hanzi Writer instance for each character
        characters.forEach((char, index) => {
            // Create wrapper element
            const wrapper = document.createElement('div');
            wrapper.className = 'hanzi-char-wrapper';
            wrapper.id = `hanzi-wrapper-${index}`;

            // Create the target div for Hanzi Writer
            const target = document.createElement('div');
            target.id = `hanzi-target-${index}`;
            wrapper.appendChild(target);

            // Create label
            const label = document.createElement('div');
            label.className = 'hanzi-char-label';
            label.textContent = `${index + 1}/${characters.length}`;
            wrapper.appendChild(label);

            container.appendChild(wrapper);

            // Create Hanzi Writer instance
            try {
                const writer = HanziWriter.create(`hanzi-target-${index}`, char, {
                    width: 150,
                    height: 150,
                    padding: 5,
                    showOutline: true,
                    showCharacter: true,
                    strokeColor: '#dc2626', // Red stroke color
                    outlineColor: '#ddd',
                    drawingColor: '#333',
                    radicalColor: '#dc2626',
                    highlightColor: '#dc2626',
                    strokeAnimationSpeed: 1,
                    delayBetweenStrokes: 300,
                    charDataLoader: (char, onComplete) => {
                        fetch(`https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0/${char}.json`)
                            .then(response => {
                                if (!response.ok) {
                                    throw new Error('Character not found');
                                }
                                return response.json();
                            })
                            .then(data => onComplete(data))
                            .catch(err => {
                                console.warn(`Could not load character data for: ${char}`, err);
                                // Show fallback
                                target.innerHTML = `<div style="width:150px;height:150px;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:8px;font-size:4rem;">${char}</div>`;
                            });
                    }
                });

                // Store reference
                this.hanziWriters.push({ writer, char, index });

                // Click to animate individual character
                target.addEventListener('click', () => {
                    if (!this.isQuizMode) {
                        writer.animateCharacter();
                    }
                });

            } catch (err) {
                console.warn(`Could not create HanziWriter for: ${char}`, err);
                target.innerHTML = `<div style="width:150px;height:150px;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:8px;font-size:4rem;">${char}</div>`;
            }
        });
    }

    cleanupHanziWriters() {
        // Clean up previous instances
        this.hanziWriters.forEach(({ writer }) => {
            try {
                writer.cancelQuiz();
                writer.hideCharacter();
            } catch (e) {
                // Ignore cleanup errors
            }
        });
        this.hanziWriters = [];
    }

    animateAllCharacters() {
        if (this.hanziWriters.length === 0) return;

        // Animate characters sequentially
        let delay = 0;
        this.hanziWriters.forEach(({ writer }, index) => {
            setTimeout(() => {
                try {
                    writer.animateCharacter();
                } catch (e) {
                    console.warn('Could not animate character', e);
                }
            }, delay);
            delay += 1500; // 1.5 second delay between characters
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
                } catch (e) {
                    // Ignore errors
                }
            });
        }
    }

    startQuiz() {
        // Start quiz for the first character, then chain to next
        this.runQuizForCharacter(0);
    }

    runQuizForCharacter(index) {
        if (index >= this.hanziWriters.length || !this.isQuizMode) return;

        const { writer, char } = this.hanziWriters[index];

        // Highlight current character label
        document.querySelectorAll('.hanzi-char-label').forEach((label, i) => {
            label.classList.toggle('active', i === index);
        });

        try {
            writer.quiz({
                showHintAfterMisses: 3,
                highlightOnComplete: true,
                onComplete: (summaryData) => {
                    // Move to next character after a short delay
                    setTimeout(() => {
                        this.runQuizForCharacter(index + 1);
                    }, 500);
                }
            });
        } catch (e) {
            console.warn('Could not start quiz for character', e);
            // Try next character
            this.runQuizForCharacter(index + 1);
        }
    }

    // ==================== CLAUDE API INTEGRATION ====================

    async generateSentences() {
        if (!this.currentCard) return;

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
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
                },
                body: JSON.stringify({
                    model: 'claude-3-5-sonnet-20241022',
                    max_tokens: 1024,
                    messages: [{
                        role: 'user',
                        content: `Generate exactly 3 simple example sentences using the Chinese word "${this.currentCard.chinese}" (${this.currentCard.pinyin}, meaning: ${this.currentCard.english}).

The sentences should be appropriate for HSK 3.0 Level 1 learners (beginner level). Keep vocabulary simple.

Format your response EXACTLY like this (use this exact structure):
1. [Chinese sentence]
[Pinyin with tone marks]
[English translation]

2. [Chinese sentence]
[Pinyin with tone marks]
[English translation]

3. [Chinese sentence]
[Pinyin with tone marks]
[English translation]

Do not add any other text, explanations, or formatting.`
                    }]
                })
            });

            // Get response text for error details
            const responseText = await response.text();
            let data;

            try {
                data = JSON.parse(responseText);
            } catch (e) {
                throw new Error(`Invalid JSON response: ${responseText.substring(0, 200)}`);
            }

            if (!response.ok) {
                const errorMsg = data.error?.message || data.message || `HTTP ${response.status}`;
                throw new Error(errorMsg);
            }

            if (!data.content || !data.content[0] || !data.content[0].text) {
                throw new Error('Unexpected API response format');
            }

            const text = data.content[0].text;

            // Parse and display sentences
            const sentences = this.parseSentences(text);
            this.displaySentences(sentences);

        } catch (error) {
            console.error('Error generating sentences:', error);

            let errorHtml = `<div class="api-error">
                <div class="api-error-title">Error generating sentences</div>
                <div class="api-error-details">`;

            if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
                errorHtml += `<p><strong>CORS Error:</strong> Browser security is blocking the API request.</p>
                <p>To use this feature, you need to:</p>
                <ol style="margin-left: 1.5rem; margin-top: 0.5rem;">
                    <li>Enable browser access on your API key at <a href="https://console.anthropic.com/" target="_blank" style="color: var(--red);">console.anthropic.com</a></li>
                    <li>Or run this app through a local server with a backend proxy</li>
                </ol>`;
            } else if (error.message.includes('401') || error.message.includes('authentication')) {
                errorHtml += `<p><strong>Authentication Error:</strong> Your API key appears to be invalid.</p>
                <p>Please check that you've entered the correct API key.</p>`;
            } else if (error.message.includes('403')) {
                errorHtml += `<p><strong>Access Denied:</strong> Your API key doesn't have browser access enabled.</p>
                <p>Go to <a href="https://console.anthropic.com/" target="_blank" style="color: var(--red);">console.anthropic.com</a> and enable "Allow browser access" for your API key.</p>`;
            } else if (error.message.includes('429')) {
                errorHtml += `<p><strong>Rate Limited:</strong> Too many requests. Please wait a moment and try again.</p>`;
            } else {
                errorHtml += `<p>${error.message}</p>`;
            }

            errorHtml += `</div></div>`;

            content.innerHTML = errorHtml;
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
        let lineIndex = 0;

        for (const line of lines) {
            const trimmedLine = line.trim();

            // Skip numbered prefixes
            const cleanLine = trimmedLine.replace(/^\d+\.\s*/, '');

            if (!cleanLine) continue;

            // Detect if line contains Chinese characters
            const hasChinese = /[\u4e00-\u9fff]/.test(cleanLine);
            // Detect if line contains pinyin tone marks
            const hasPinyin = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(cleanLine.toLowerCase());

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

        // Handle last sentence if not pushed
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
        localStorage.setItem('claude_api_key', key);
        this.hideApiKeyModal();

        if (key) {
            this.generateSentences();
        }
    }

    // ==================== STATISTICS ====================

    updateStats() {
        if (!this.currentProfile) return;

        const learned = Object.values(this.currentProfile.wordProgress).filter(p => p.level >= 3).length;
        const due = this.getDueCards().length;
        const total = this.vocabulary.length;

        document.getElementById('learned-count').textContent = learned;
        document.getElementById('due-count').textContent = due;
        document.getElementById('total-count').textContent = total;

        // Update progress bar
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
