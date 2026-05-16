require('dotenv').config();
const express = require('express');
const https = require('https');
const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    EmbedBuilder,
} = require('discord.js');

const app = express();
app.use(express.json());

const { BOT_TOKEN, CLIENT_ID, GUILD_ID, SHARED_SECRET, PORT = 3000 } = process.env;

// ── Storage ───────────────────────────────────────────────────────────────────
// activeServers: Map<jobId, { placeId, serverType, maxPlayers, startTime, players: Map<userId, PlayerData>, chatLog: [] }>
// recentSessions: Map<userId, { username, displayName, chatLog, friendsInServer, jobId, leaveTime }>
const activeServers = new Map();
const recentSessions = new Map();
const usernameToId = new Map();  // username (lowercase) -> userId
const playerIndex = new Map();   // userId -> { username, displayName, currentJobId }
const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

// ── Roblox API ────────────────────────────────────────────────────────────────
function robloxGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { Accept: 'application/json' } }, res => {
            let raw = '';
            res.on('data', c => (raw += c));
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch { reject(new Error('JSON parse failed')); }
            });
        }).on('error', reject);
    });
}

async function getFriendIds(userId) {
    try {
        const data = await robloxGet(`https://friends.roblox.com/v1/users/${userId}/friends`);
        return new Set((data.data || []).map(f => f.id));
    } catch {
        return new Set();
    }
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
    if (req.headers['x-secret'] !== SHARED_SECRET) return res.status(401).end();
    next();
}

// ── Event endpoint ────────────────────────────────────────────────────────────
app.post('/event', auth, async (req, res) => {
    const { type, jobId, ...data } = req.body;
    res.json({ ok: true }); // respond immediately so Roblox doesn't time out

    if (type === 'server_start') {
        activeServers.set(jobId, {
            placeId: data.placeId,
            serverType: data.serverType,
            maxPlayers: data.maxPlayers,
            startTime: Date.now(),
            players: new Map(),
            chatLog: [],
        });
        return;
    }

    const server = activeServers.get(jobId);
    if (!server) return;

    if (type === 'player_join') {
        const { userId, username, displayName, accountAge } = data;

        const friendIds = await getFriendIds(userId);
        const friendsInServer = [];
        for (const [pid, p] of server.players) {
            if (friendIds.has(pid)) friendsInServer.push(p.username);
        }

        const playerData = {
            userId, username, displayName, accountAge,
            joinTime: Date.now(),
            friendsInServer,
            chatLog: [],
        };

        server.players.set(userId, playerData);
        usernameToId.set(username.toLowerCase(), userId);
        playerIndex.set(userId, { username, displayName, currentJobId: jobId });
        return;
    }

    if (type === 'player_leave') {
        const { userId } = data;
        const player = server.players.get(userId);
        if (!player) return;

        recentSessions.set(userId, {
            username: player.username,
            displayName: player.displayName,
            jobId,
            chatLog: [...player.chatLog],
            friendsInServer: [...player.friendsInServer],
            leaveTime: Date.now(),
        });

        server.players.delete(userId);
        playerIndex.delete(userId);
        return;
    }

    if (type === 'chat') {
        const { userId, username, displayName, message } = data;
        const entry = { userId, username, displayName, message, timestamp: Date.now() };
        server.chatLog.push(entry);
        const player = server.players.get(userId);
        if (player) player.chatLog.push(entry);
        return;
    }

    if (type === 'server_shutdown') {
        for (const [userId, player] of server.players) {
            recentSessions.set(userId, {
                username: player.username,
                displayName: player.displayName,
                jobId,
                chatLog: [...player.chatLog],
                friendsInServer: [...player.friendsInServer],
                leaveTime: Date.now(),
            });
            playerIndex.delete(userId);
        }
        activeServers.delete(jobId);
    }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function uptimeStr(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
}

function tsStr(ms) {
    return `<t:${Math.floor(ms / 1000)}:T>`;
}

function lookupActive(username) {
    const uid = usernameToId.get(username.toLowerCase());
    if (!uid) return null;
    const info = playerIndex.get(uid);
    if (!info) return null;
    const server = activeServers.get(info.currentJobId);
    const player = server?.players.get(uid);
    return player ? { player, server, jobId: info.currentJobId } : null;
}

function lookupRecent(username) {
    const uid = usernameToId.get(username.toLowerCase());
    if (!uid) return null;
    return recentSessions.get(uid) || null;
}

function buildChatEmbed(title, chatLog, color) {
    if (chatLog.length === 0) return null;
    const lines = chatLog.map(e =>
        `${tsStr(e.timestamp)} **${e.displayName}** (@${e.username}): ${e.message}`
    );
    let desc = lines.join('\n');
    if (desc.length > 4000) {
        // Show most recent messages that fit
        const trimmed = [];
        let len = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (len + lines[i].length + 1 > 3900) break;
            trimmed.unshift(lines[i]);
            len += lines[i].length + 1;
        }
        desc = '*(showing most recent messages)*\n' + trimmed.join('\n');
    }
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(desc)
        .setColor(color)
        .setFooter({ text: `${chatLog.length} total messages` })
        .setTimestamp();
}

// ── Discord bot ───────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('players')
        .setDescription('List all players currently online across all tracked servers'),

    new SlashCommandBuilder()
        .setName('chatlogs')
        .setDescription("Get a player's chat history from their current or most recent session")
        .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),

    new SlashCommandBuilder()
        .setName('serverchat')
        .setDescription('Get the full chat log for a server by Job ID')
        .addStringOption(o => o.setName('jobid').setDescription('Server Job ID').setRequired(true)),

    new SlashCommandBuilder()
        .setName('friends')
        .setDescription('Show which friends a player has in their current server')
        .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),

    new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription('Get details and stats about a specific server')
        .addStringOption(o => o.setName('jobid').setDescription('Server Job ID').setRequired(true)),
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Bot online: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log('Slash commands registered');
    } catch (e) {
        console.error('Failed to register commands:', e);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply();

    const { commandName } = interaction;

    // /players
    // /players
    // /players
        if (commandName === 'players') {
        if (activeServers.size === 0) {
            return interaction.editReply('No active servers are being tracked right now.');
        }

        const allServers = [...activeServers.entries()];
        const serverTypes = ['All', 'Public Server', 'Private Server', 'Reserved Server'];
        let currentFilter = 'All';
        let currentPage = 0;
        const perPage = 5;

        function buildEmbed(filter, page) {
            const filtered = allServers.filter(([_, s]) =>
                filter === 'All' || s.serverType === filter
            );

            const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
            const pageSlice = filtered.slice(page * perPage, (page + 1) * perPage);

            let totalPlayers = 0;
            const embed = new EmbedBuilder()
                .setTitle(`Players Online — ${filter}`)
                .setColor(0x3498db)
                .setTimestamp()
                .setFooter({ text: `Page ${page + 1}/${totalPages} · ${filtered.length} server(s)` });

            if (pageSlice.length === 0) {
                embed.setDescription('No servers match this filter.');
            } else {
                for (const [jobId, server] of pageSlice) {
                    const count = server.players.size;
                    totalPlayers += count;
                    const list = count > 0
                        ? [...server.players.values()].map(p => `${p.displayName} (@${p.username})`).join('\n')
                        : 'Empty';
                    embed.addFields({
                        name: `${server.serverType} · ${count}/${server.maxPlayers} · \`${jobId.substring(0, 8)}...\``,
                        value: list.substring(0, 1024),
                    });
                }
            }

            return { embed, totalPages };
        }

        function buildRows(filter, page, totalPages) {
            const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

            const filterRow = new ActionRowBuilder().addComponents(
                serverTypes.map(type =>
                    new ButtonBuilder()
                        .setCustomId(`filter_${type}`)
                        .setLabel(type)
                        .setStyle(type === filter ? ButtonStyle.Primary : ButtonStyle.Secondary)
                )
            );

            const navRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('prev')
                    .setLabel('◀ Prev')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('next')
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page >= totalPages - 1),
            );

            return [filterRow, navRow];
        }

        const { embed, totalPages } = buildEmbed(currentFilter, currentPage);
        const rows = buildRows(currentFilter, currentPage, totalPages);

        const reply = await interaction.editReply({
            embeds: [embed],
            components: rows,
        });

        const collector = reply.createMessageComponentCollector({ time: 120_000 });

        collector.on('collect', async btn => {
            if (btn.user.id !== interaction.user.id) {
                return btn.reply({ content: 'These buttons are not for you.', ephemeral: true });
            }

            await btn.deferUpdate();

            if (btn.customId.startsWith('filter_')) {
                currentFilter = btn.customId.replace('filter_', '');
                currentPage = 0;
            } else if (btn.customId === 'prev') {
                currentPage = Math.max(0, currentPage - 1);
            } else if (btn.customId === 'next') {
                currentPage++;
            }

            const { embed: newEmbed, totalPages: newTotal } = buildEmbed(currentFilter, currentPage);
            const newRows = buildRows(currentFilter, currentPage, newTotal);

            await interaction.editReply({ embeds: [newEmbed], components: newRows });
        });

        collector.on('end', async () => {
            const { embed: finalEmbed } = buildEmbed(currentFilter, currentPage);
            await interaction.editReply({ embeds: [finalEmbed], components: [] }).catch(() => {});
        });
    }

    // /chatlogs
    if (commandName === 'chatlogs') {
        const username = interaction.options.getString('username');
        const active = lookupActive(username);
        const recent = !active ? lookupRecent(username) : null;

        if (!active && !recent) {
            return interaction.editReply(`No data found for **${username}**. They haven't connected to a tracked server since the bot started.`);
        }

        const chatLog = active ? active.player.chatLog : recent.chatLog;
        const status = active
            ? '🟢 Currently online'
            : `🔴 Last seen ${tsStr(recent.leaveTime)}`;

        const embed = buildChatEmbed(`Chat Logs — ${username}`, chatLog, active ? 0x2ecc71 : 0xe74c3c);
        if (!embed) {
            return interaction.editReply(`**${username}** has no chat messages on record. (${status})`);
        }

        embed.setDescription(`${status}\n\n${embed.data.description}`);
        return interaction.editReply({ embeds: [embed] });
    }

    // /serverchat
    if (commandName === 'serverchat') {
        const jobId = interaction.options.getString('jobid');
        const server = activeServers.get(jobId);

        if (!server) {
            return interaction.editReply('Server not found. It may have shut down or the Job ID is wrong.');
        }

        const embed = buildChatEmbed(`Server Chat — \`${jobId.substring(0, 8)}...\``, server.chatLog, 0x3447db);
        if (!embed) {
            return interaction.editReply('No chat messages recorded for this server yet.');
        }

        return interaction.editReply({ embeds: [embed] });
    }

    // /friends
    if (commandName === 'friends') {
        const username = interaction.options.getString('username');
        const active = lookupActive(username);

        if (!active) {
            return interaction.editReply(`**${username}** is not currently online in any tracked server.`);
        }

        const { player } = active;
        const embed = new EmbedBuilder()
            .setTitle(`Friends in Server — ${username}`)
            .setColor(0x9b59b6)
            .setTimestamp();

        if (player.friendsInServer.length === 0) {
            embed.setDescription('No friends were detected in this server when they joined.\n*(Note: players with private friend lists will always show empty)*');
        } else {
            embed.setDescription(player.friendsInServer.map(u => `@${u}`).join('\n'));
            embed.setFooter({ text: `${player.friendsInServer.length} friend(s)` });
        }

        return interaction.editReply({ embeds: [embed] });
    }

    // /serverinfo
    if (commandName === 'serverinfo') {
        const jobId = interaction.options.getString('jobid');
        const server = activeServers.get(jobId);

        if (!server) {
            return interaction.editReply('Server not found.');
        }

        const playerList = server.players.size > 0
            ? [...server.players.values()].map(p => `${p.displayName} (@${p.username})`).join('\n')
            : 'None';

        const embed = new EmbedBuilder()
            .setTitle('Server Info')
            .setColor(0x3447db)
            .addFields(
                { name: 'Server Type', value: server.serverType, inline: true },
                { name: 'Players', value: `${server.players.size}/${server.maxPlayers}`, inline: true },
                { name: 'Uptime', value: uptimeStr(Date.now() - server.startTime), inline: true },
                { name: 'Place ID', value: String(server.placeId), inline: true },
                { name: 'Messages Logged', value: String(server.chatLog.length), inline: true },
                { name: 'Job ID', value: `\`${jobId}\``, inline: false },
                { name: 'Players Online', value: playerList.substring(0, 1024), inline: false },
            )
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }
});

client.login(BOT_TOKEN);
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));