const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);


/**
 * @typedef {{name: string, visuals: string, canUnbox: boolean, unboxWeight?: number}} Skin
 */

/**
 * `canUnbox === true`
 * 
 * `unboxWeight !== undefined`
 * @typedef {{name: string, visuals: string, canUnbox: boolean, unboxWeight: number}} AvailableToUnboxSkin
 */


const CONFIG = {
    PORT: process.env.PORT || 3000,
    PATHS: {
        DATA: path.join(__dirname, 'data'),
        LEADERBOARD: path.join(__dirname, 'data', 'leaderboard.json'),
        SKINS_DATA: path.join(__dirname, 'data', 'skins.json'),
        PUBLIC: path.join(__dirname, 'public'),
        SKINS_CONFIG: path.join(__dirname, 'public', 'skins', 'config.json'),
    },
    CACHE_DURATION: 5000,
};

// Since "/Data" isn't being shipped to the Github the program wil crash if data isn't there so here i'm ensuring theres a /data folder.
async function ensureDataFolder() {
    const folderPath = path.dirname(CONFIG.PATHS.LEADERBOARD);
    try {
        await fs.mkdir(folderPath, { recursive: true });
    } catch (error) {
        console.error(`Error ensuring data folder:`, error);
    }
}


ensureDataFolder();

const errorHandler = (err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
};

app.use(express.static(CONFIG.PATHS.PUBLIC));
app.use(errorHandler);

app.get('/', (req, res) => {
    res.sendFile(path.join(CONFIG.PATHS.PUBLIC, 'index.html'));
});

app.get('/leaderboard', (req, res) => {
    res.sendFile(path.join(CONFIG.PATHS.PUBLIC, 'leaderboard.html'));
});

app.get('/api/cones/add', (req, res) => {
    const name = req.query.name?.toLowerCase().trim() || '';
    if (!name) return res.status(400).send('Name cannot be blank or invalid.');
    io.emit('addCone', name);
    res.sendStatus(200);
});

app.get('/api/leaderboard', async (req, res, next) => {
    try {
        if (req.query.show === 'true') {
            io.emit('showLb');
            return res.sendStatus(200);
        }
        const data = await LeaderboardManager.getLeaderboard();
        res.json(data);
    } catch (err) {
        next(err);
    }
});

app.get('/api/leaderboard/:name', async (req, res, next) => {
    try {
        const name = req.params.name?.toLowerCase().trim() || '';
        const data = await LeaderboardManager.getLeaderboard();
        const index = data.findIndex((r) => r.name === name);

        if (index === -1) return res.send('did no coneflips.');

        const player = data[index];
        res.send(`coneflip rank: ${index + 1}/${data.length} (Ws: ${player.wins} / Ls: ${player.fails} / WR%: ${player.winrate})`);
    } catch (err) {
        next(err);
    }
});

app.get('/api/skins/available', async (req, res) => {
    const availableSkins = {};
    Object.values(SkinsManager.availableSkins).forEach((skin) => {
        availableSkins[skin.name] = `/skins/${skin.visuals}`;
    })

    res.send(availableSkins)
})

app.get('/api/skins/set', async (req, res, next) => {
    const name = req.query.name?.toLowerCase().trim() || '';
    const skin = req.query.skin?.toLowerCase().trim() || '';
    const random = req.query.random === 'true';

    if (!name) return res.status(400).json('Name must be provided.');

    try {
        let result;

        if (random) {
            result = await SkinsManager.setRandomSkin(name);
        } else {
            if (!skin) {
                return res.status(400).json({ error: 'Skin must be provided when random is false.' });
            }
            result = await SkinsManager.setSkin(name, skin);
        }

        res.send(result);
        io.emit('skinRefresh');
    } catch (err) {
        err.status = err.message.includes('Invalid skin') ? 400 : 500;
        next(err);
    }
});

app.get('/api/skins/users', async (req, res, next) => {
    try {
        const data = await SkinsManager.getUserSkins();
        res.json(data);
    } catch (err) {
        next(err);
    }
});

app.get('/api/skins/odds', (req, res) => {
    res.send(SkinsManager.calculateSkinOdds());
});

class LeaderboardManager {
    static cache = {
        data: null,
        lastUpdate: 0
    };

    static async initialize() {
        try {
            await fs.access(CONFIG.PATHS.LEADERBOARD);
        } catch {
            await fs.mkdir(path.dirname(CONFIG.PATHS.LEADERBOARD), { recursive: true });
            await fs.writeFile(CONFIG.PATHS.LEADERBOARD, JSON.stringify([]), 'utf8');
        }
    }

    static async getLeaderboard() {
        const now = Date.now();
        if (this.cache.data && (now - this.cache.lastUpdate < CONFIG.CACHE_DURATION)) {
            return this.cache.data;
        }

        try {
            const data = await fs.readFile(CONFIG.PATHS.LEADERBOARD, 'utf8');
            this.cache.data = JSON.parse(data);
            this.cache.lastUpdate = now;
            return this.cache.data;
        } catch (err) {
            throw new Error('Failed to read leaderboard data');
        }
    }

    static async updateLeaderboard(data) {
        const sortedData = this.sortLeaderboard(data);
        await fs.writeFile(CONFIG.PATHS.LEADERBOARD, JSON.stringify(sortedData, null, 2), 'utf8');
        this.cache.data = sortedData;
        this.cache.lastUpdate = Date.now();
        return this.cache.data;
    }

    static async updatePlayer(playerName, isWin) {
        const data = await this.getLeaderboard();
        const player = data.find(entry => entry.name === playerName);

        if (player) {
            if (isWin) player.wins++;
            else player.fails++;
            player.winrate = ((player.wins / (player.wins + player.fails)) * 100).toFixed(2);
        } else {
            data.push({
                name: playerName,
                wins: isWin ? 1 : 0,
                fails: isWin ? 0 : 1,
                winrate: isWin ? '100.00' : '0.00'
            });
        }

        return this.updateLeaderboard(data);
    }

    static sortLeaderboard(data) {
        return [...data].sort((a, b) => {
            if (b.wins !== a.wins) return b.wins - a.wins; // We sort by descending wins
            if (a.wins > 0) return b.winrate - a.winrate; // Then by winrate
            if (a.fails !== b.fails) return a.fails - b.fails; // After we sort by ascending fails
            return a.name.localeCompare(b.name); // Finally we do alphabetical
        });
    }
}

class SkinsManager {
    /**
     *  @type {Object.<string, Skin>}
     */ 
    static availableSkins = {};

    static async initialize() {
        try {
            await fs.access(CONFIG.PATHS.SKINS_DATA);
        } catch {
            await fs.mkdir(path.dirname(CONFIG.PATHS.SKINS_DATA), { recursive: true });
            await fs.writeFile(CONFIG.PATHS.SKINS_DATA, JSON.stringify([]), 'utf8');
        }
        this.availableSkins = await this.loadConfiguredSkins();
    }

    static async loadConfiguredSkins() {
        const data = await fs.readFile(CONFIG.PATHS.SKINS_CONFIG);
        const skinsConfig = JSON.parse(data);
        
        const skins = {};
        skinsConfig.forEach((skin) => {
            skins[skin.name] = skin;
        });
        return skins;
    }

    static async getUserSkins() {
        const data = await fs.readFile(CONFIG.PATHS.SKINS_DATA, 'utf8');
        return JSON.parse(data);
    }

    static async setSkin(name, skin) {
        if (!this.isValidSkin(skin)) {
            throw new Error('Invalid skin.');
        }

        const data = await this.getUserSkins();
        const playerIndex = data.findIndex(user => user.name === name);

        if (playerIndex === -1) {
            data.push({ name, skin });
        } else {
            data[playerIndex].skin = skin;
        }

        await fs.writeFile(CONFIG.PATHS.SKINS_DATA, JSON.stringify(data, null, 2), 'utf8');
        return `Skin for ${name} updated to ${skin}`;
    }

    static async setRandomSkin(name) {
        const skinsAvailableToUnbox = this.getSkinsAvailableToUnbox();
        const totalWeight = skinsAvailableToUnbox.reduce((sum, skin) => sum + skin.unboxWeight, 0);
        let currentWeight = 0;
        const random = Math.random() * totalWeight;

        for (const skin of skinsAvailableToUnbox) {
            currentWeight += skin.unboxWeight;
            if (random <= currentWeight) {
                await this.setSkin(name, skin.name);
                const odds = (skin.unboxWeight / totalWeight * 100).toFixed(1);
                return `you received ${skin.name} (${odds}%)`;
            }
        }
    }

    static calculateSkinOdds() {
        const skinsAvailableToUnbox = this.getSkinsAvailableToUnbox();
        const totalWeight = skinsAvailableToUnbox.reduce((sum, skin) => sum + skin.unboxWeight, 0);
        return skinsAvailableToUnbox
            .map((skin) => `${skin.name} (${(skin.unboxWeight / totalWeight * 100).toFixed(1)}%)`)
            .join(', ');
    }

    /**
     * @return {[AvailableToUnboxSkin]}
     */
    static getSkinsAvailableToUnbox() {
        return Object.values(this.availableSkins).filter((skin) => skin.canUnbox);
    }

    static isValidSkin(name) {
        return name in this.availableSkins;
    }
}

io.on('connection', async (socket) => {
    let topPlayer = null;

    try {
        const data = await LeaderboardManager.getLeaderboard();
        topPlayer = data[0]?.name || null;
        socket.emit('refreshLb', data);
        socket.emit('goldSkin', topPlayer);

        const updateStateHandler = async (playerName, isWin) => {
            try {
                const result = await LeaderboardManager.updatePlayer(playerName, isWin);
                const newTopPlayer = result[0]?.name;

                if (newTopPlayer !== topPlayer) {
                    topPlayer = newTopPlayer;
                    socket.emit('goldSkin', topPlayer);
                    socket.emit('newGoldCelebration', topPlayer);
                }

                io.emit('refreshLb', result);
            } catch (err) {
                console.error(`Error updating player state: ${err.message}`);
            }
        };

        socket.on('win', (playerName) => updateStateHandler(playerName, true));
        socket.on('fail', (playerName) => updateStateHandler(playerName, false));
    } catch (err) {
        console.error('Socket connection error:', err);
    }
});

async function startServer() {
    try {
        await Promise.all([
            LeaderboardManager.initialize(),
            SkinsManager.initialize()
        ]);

        http.listen(CONFIG.PORT, () => {
            console.log(`Server is running on port ${CONFIG.PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

startServer();