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
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} = require('discord.js');

const app = express();
app.use(express.json());

const { BOT_TOKEN, CLIENT_ID, GUILD_ID, SHARED_SECRET, PORT = 3000 } = process.env;

const ALLOWED_ROLES = [
    '1352536754531336222',
    '1352531721954000896',
    '1452870606050693152',
    '1393964675900772473',
    '1402589926264016956',
    '1393964997406621716',
    '1352532155879919728',
    '1352532883306319902',
    '1354801120391987311',
    '1352533075128750090',
];

// ── Storage ───────────────────────────────────────────────────────────────────
const activeServers  = new Map();
const recentSessions = new Map();
const usernameToId   = new Map();
const playerIndex    = new Map();

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
    res.json({ ok: true });

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
        const playerData = { userId, username, displayName, accountAge, joinTime: Date.now(), friendsInServer, chatLog: [] };
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

function buildServerSelectMenu(customId, placeholder) {
    const entries = [...activeServers.entries()].slice(0, 25);
    const options = entries.map(([jobId, server]) =>
        new StringSelectMenuOptionBuilder()
            .setLabel(`${server.serverType} · ${server.players.size}/${server.maxPlayers}`)
            .setDescription(`Job: ${jobId.substring(0, 50)}`)
            .setValue(jobId)
    );
    const select = new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .addOptions(options);
    return new ActionRowBuilder().addComponents(select);
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
        .setDescription('View the chat log for a server'),

    new SlashCommandBuilder()
        .setName('friends')
        .setDescription('Show which friends a player has in their current server')
        .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),

    new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription('Get details and stats about a server'),
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
    if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu()) return;

    // ── Role check ────────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
        const member = interaction.member;
        const hasRole = member && member.roles.cache.some(r => ALLOWED_ROLES.includes(r.id));
        if (!hasRole) {
            return interaction.reply({ content: 'You do not have permission to use this bot.', ephemeral: true });
        }
    }

    // ── /players ──────────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'players') {
        await interaction.deferReply();

        if (activeServers.size === 0) {
            return interaction.editReply('No active servers are being tracked right now.');
        }

        const allServers = [...activeServers.entries()];
        const serverTypes = ['All', 'Public Server', 'Private Server', 'Reserved Server'];
        let currentFilter = 'All';
        let currentPage = 0;
        const perPage = 5;

        function buildPlayersEmbed(filter, page) {
            const filtered = allServers.filter(([_, s]) => filter === 'All' || s.serverType === filter);
            const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
            const pageSlice = filtered.slice(page * perPage, (page + 1) * perPage);
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

        function buildPlayersRows(filter, page, totalPages) {
            const filterRow = new ActionRowBuilder().addComponents(
                serverTypes.map(type =>
                    new ButtonBuilder()
                        .setCustomId(`filter_${type}`)
                        .setLabel(type)
                        .setStyle(type === filter ? ButtonStyle.Primary : ButtonStyle.Secondary)
                )
            );
            const navRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('prev').setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                new ButtonBuilder().setCustomId('next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
            );
            return [filterRow, navRow];
        }

        const { embed, totalPages } = buildPlayersEmbed(currentFilter, currentPage);
        const rows = buildPlayersRows(currentFilter, currentPage, totalPages);
        const reply = await interaction.editReply({ embeds: [embed], components: rows });
        const collector = reply.createMessageComponentCollector({ time: 120_000 });

        collector.on('collect', async btn => {
            if (btn.user.id !== interaction.user.id) return btn.reply({ content: 'These buttons are not for you.', ephemeral: true });
            await btn.deferUpdate();
            if (btn.customId.startsWith('filter_')) { currentFilter = btn.customId.replace('filter_', ''); currentPage = 0; }
            else if (btn.customId === 'prev') currentPage = Math.max(0, currentPage - 1);
            else if (btn.customId === 'next') currentPage++;
            const { embed: newEmbed, totalPages: newTotal } = buildPlayersEmbed(currentFilter, currentPage);
            await interaction.editReply({ embeds: [newEmbed], components: buildPlayersRows(currentFilter, currentPage, newTotal) });
        });

        collector.on('end', async () => {
            const { embed: finalEmbed } = buildPlayersEmbed(currentFilter, currentPage);
            await interaction.editReply({ embeds: [finalEmbed], components: [] }).catch(() => {});
        });
    }

    // ── /chatlogs ─────────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'chatlogs') {
        await interaction.deferReply();
        const username = interaction.options.getString('username');
        const active = lookupActive(username);
        const recent = !active ? lookupRecent(username) : null;

        if (!active && !recent) {
            return interaction.editReply(`No data found for **${username}**.`);
        }

        const chatLog = active ? active.player.chatLog : recent.chatLog;
        const status = active ? '🟢 Currently online' : `🔴 Last seen ${tsStr(recent.leaveTime)}`;
        const embed = buildChatEmbed(`Chat Logs — ${username}`, chatLog, active ? 0x2ecc71 : 0xe74c3c);

        if (!embed) return interaction.editReply(`**${username}** has no chat messages on record. (${status})`);
        embed.setDescription(`${status}\n\n${embed.data.description}`);
        return interaction.editReply({ embeds: [embed] });
    }

    // ── /serverchat ───────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'serverchat') {
        await interaction.deferReply();

        if (activeServers.size === 0) return interaction.editReply('No active servers being tracked right now.');

        const row = buildServerSelectMenu('serverchat_select', 'Select a server to view chat...');
        const reply = await interaction.editReply({ content: 'Select a server:', components: [row] });
        const collector = reply.createMessageComponentCollector({ time: 60_000 });

        collector.on('collect', async sel => {
            if (sel.user.id !== interaction.user.id) return sel.reply({ content: 'This menu is not for you.', ephemeral: true });
            await sel.deferUpdate();
            const jobId = sel.values[0];
            const server = activeServers.get(jobId);
            if (!server) return interaction.editReply({ content: 'That server is no longer active.', components: [] });

            const embed = buildChatEmbed(`Server Chat — ${server.serverType}`, server.chatLog, 0x3447db);
            if (!embed) return interaction.editReply({ content: 'No chat messages recorded for this server yet.', components: [] });

            embed.addFields({ name: 'Full Job ID', value: `\`${jobId}\``, inline: false });
            await interaction.editReply({ content: '', embeds: [embed], components: [] });
            collector.stop();
        });

        collector.on('end', async (_, reason) => {
            if (reason === 'time') await interaction.editReply({ content: 'Timed out.', components: [] }).catch(() => {});
        });
    }

    // ── /serverinfo ───────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'serverinfo') {
        await interaction.deferReply();

        if (activeServers.size === 0) return interaction.editReply('No active servers being tracked right now.');

        const row = buildServerSelectMenu('serverinfo_select', 'Select a server to view info...');
        const reply = await interaction.editReply({ content: 'Select a server:', components: [row] });
        const collector = reply.createMessageComponentCollector({ time: 60_000 });

        collector.on('collect', async sel => {
            if (sel.user.id !== interaction.user.id) return sel.reply({ content: 'This menu is not for you.', ephemeral: true });
            await sel.deferUpdate();
            const jobId = sel.values[0];
            const server = activeServers.get(jobId);
            if (!server) return interaction.editReply({ content: 'That server is no longer active.', components: [] });

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
                    { name: 'Full Job ID', value: `\`${jobId}\``, inline: false },
                    { name: 'Players Online', value: playerList.substring(0, 1024), inline: false },
                )
                .setTimestamp();

            await interaction.editReply({ content: '', embeds: [embed], components: [] });
            collector.stop();
        });

        collector.on('end', async (_, reason) => {
            if (reason === 'time') await interaction.editReply({ content: 'Timed out.', components: [] }).catch(() => {});
        });
    }

    // ── /friends ──────────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'friends') {
        await interaction.deferReply();
        const username = interaction.options.getString('username');
        const active = lookupActive(username);

        if (!active) return interaction.editReply(`**${username}** is not currently online in any tracked server.`);

        const { player } = active;
        const embed = new EmbedBuilder().setTitle(`Friends in Server — ${username}`).setColor(0x9b59b6).setTimestamp();

        if (player.friendsInServer.length === 0) {
            embed.setDescription('No friends detected in this server.\n*(Players with private friend lists will always show empty)*');
        } else {
            embed.setDescription(player.friendsInServer.map(u => `@${u}`).join('\n'));
            embed.setFooter({ text: `${player.friendsInServer.length} friend(s)` });
        }

        return interaction.editReply({ embeds: [embed] });
    }
});

client.login(BOT_TOKEN);
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));