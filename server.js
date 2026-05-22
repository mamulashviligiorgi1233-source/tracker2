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

const GROUP_ID = 7717947;

// ── Storage ───────────────────────────────────────────────────────────────────
const activeServers      = new Map(); // jobId -> server data
const recentSessions     = new Map(); // userId -> last session
const usernameToId       = new Map(); // username (lower) -> userId
const playerIndex        = new Map(); // userId -> { username, displayName, currentJobId }
const allKnownPlayers    = new Map(); // userId -> { username, displayName, lastSeen, currentJobId? }
const persistentChatlogs = new Map(); // userId -> { username, displayName, entries: [] }
const adminLogs          = [];        // all admin command logs

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

async function getFriends(userId) {
    try {
        const data = await robloxGet(`https://friends.roblox.com/v1/users/${userId}/friends`);
        return data.data || [];
    } catch { return []; }
}

async function isInGroup(userId) {
    try {
        const data = await robloxGet(`https://groups.roblox.com/v1/users/${userId}/groups/roles`);
        return (data.data || []).some(g => g.group && g.group.id === GROUP_ID);
    } catch { return false; }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
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

    if (type === 'player_join') {
        if (!server) return;
        const { userId, username, displayName, accountAge } = data;
        const friends = await getFriends(userId);
        const friendsInServer = [];
        for (const [pid, p] of server.players) {
            if (friends.some(f => f.id === pid)) friendsInServer.push(p.username);
        }
        server.players.set(userId, { userId, username, displayName, accountAge, joinTime: Date.now(), friendsInServer, chatLog: [] });
        usernameToId.set(username.toLowerCase(), userId);
        playerIndex.set(userId, { username, displayName, currentJobId: jobId });
        allKnownPlayers.set(userId, { username, displayName, lastSeen: Date.now(), currentJobId: jobId });
        return;
    }

    if (type === 'player_leave') {
        if (!server) return;
        const { userId } = data;
        const player = server.players.get(userId);
        if (!player) return;
        recentSessions.set(userId, {
            username: player.username, displayName: player.displayName, jobId,
            chatLog: [...player.chatLog], friendsInServer: [...player.friendsInServer], leaveTime: Date.now(),
        });
        const known = allKnownPlayers.get(userId);
        if (known) { known.lastSeen = Date.now(); delete known.currentJobId; }
        server.players.delete(userId);
        playerIndex.delete(userId);
        return;
    }

    if (type === 'chat') {
        if (!server) return;
        const { userId, username, displayName, message } = data;
        const entry = { userId, username, displayName, message, jobId, serverType: server.serverType, timestamp: Date.now() };
        server.chatLog.push(entry);
        const player = server.players.get(userId);
        if (player) player.chatLog.push(entry);

        if (!persistentChatlogs.has(userId)) {
            persistentChatlogs.set(userId, { username, displayName, entries: [] });
        }
        const pcl = persistentChatlogs.get(userId);
        pcl.username = username;
        pcl.displayName = displayName;
        pcl.entries.push({ jobId, serverType: server.serverType, message, timestamp: Date.now() });
        return;
    }

    if (type === 'admin_command') {
        const serverType = server ? server.serverType : 'Unknown';
        adminLogs.push({
            userId: data.userId,
            username: data.username,
            displayName: data.displayName,
            command: data.command,
            executed: data.executed,
            denialReason: data.denialReason || null,
            errorMessage: data.errorMessage || null,
            rankName: data.rankName || 'Unknown',
            adminLevel: data.adminLevel || 0,
            target: data.target || null,
            serverType,
            jobId,
            timestamp: Date.now(),
        });
        return;
    }

    if (type === 'server_shutdown') {
        if (!server) return;
        for (const [userId, player] of server.players) {
            recentSessions.set(userId, {
                username: player.username, displayName: player.displayName, jobId,
                chatLog: [...player.chatLog], friendsInServer: [...player.friendsInServer], leaveTime: Date.now(),
            });
            const known = allKnownPlayers.get(userId);
            if (known) { known.lastSeen = Date.now(); delete known.currentJobId; }
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

function tsStr(ms) { return `<t:${Math.floor(ms / 1000)}:T>`; }

function joinUrl(placeId, jobId) {
    return `https://www.roblox.com/games/start?placeId=${placeId}&gameInstanceId=${jobId}`;
}

function buildChatPages(entries, perPage = 15) {
    const pages = [];
    for (let i = 0; i < entries.length; i += perPage) pages.push(entries.slice(i, i + perPage));
    return pages.length > 0 ? pages : [[]];
}

function buildNavRow(page, totalPages, prefix) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${prefix}_prev`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`${prefix}_next`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    );
}

function buildServerSelectMenu(customId, placeholder) {
    const entries = [...activeServers.entries()].slice(0, 25);
    if (entries.length === 0) return null;
    const options = entries.map(([jobId, server]) =>
        new StringSelectMenuOptionBuilder()
            .setLabel(`${server.serverType} · ${server.players.size}/${server.maxPlayers} · up ${uptimeStr(Date.now() - server.startTime)}`)
            .setDescription(jobId)
            .setValue(jobId)
    );
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(options)
    );
}

async function showServerinfo(interaction, jobId, server) {
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

    const joinRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Join Server').setStyle(ButtonStyle.Link).setURL(joinUrl(server.placeId, jobId))
    );

    await interaction.editReply({ content: '', embeds: [embed], components: [joinRow] });
}

async function showServerchat(interaction, jobId, server) {
    const allEntries = [...server.chatLog];
    if (allEntries.length === 0) {
        return interaction.editReply({ content: 'No chat messages recorded for this server yet.', components: [] });
    }

    const pages = buildChatPages(allEntries, 15);
    let currentPage = 0;

    function buildSCEmbed(page) {
        const lines = pages[page].map(e => `${tsStr(e.timestamp)} **${e.displayName}** (@${e.username}): ${e.message}`);
        return new EmbedBuilder()
            .setTitle(`Server Chat — ${server.serverType}`)
            .setDescription(lines.join('\n').substring(0, 4000))
            .setColor(0x3447db)
            .addFields(
                { name: 'Uptime', value: uptimeStr(Date.now() - server.startTime), inline: true },
                { name: 'Players', value: `${server.players.size}/${server.maxPlayers}`, inline: true },
                { name: 'Full Job ID', value: `\`${jobId}\``, inline: false },
            )
            .setFooter({ text: `${allEntries.length} total messages · Page ${page + 1}/${pages.length}` })
            .setTimestamp();
    }

    const reply = await interaction.editReply({
        content: '',
        embeds: [buildSCEmbed(currentPage)],
        components: pages.length > 1 ? [buildNavRow(currentPage, pages.length, 'sc')] : [],
    });

    if (pages.length <= 1) return;

    const collector = reply.createMessageComponentCollector({ time: 120_000 });
    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) return btn.reply({ content: 'Not for you.', ephemeral: true });
        await btn.deferUpdate();
        if (btn.customId === 'sc_prev') currentPage = Math.max(0, currentPage - 1);
        else if (btn.customId === 'sc_next') currentPage = Math.min(pages.length - 1, currentPage + 1);
        await interaction.editReply({ embeds: [buildSCEmbed(currentPage)], components: [buildNavRow(currentPage, pages.length, 'sc')] });
    });
    collector.on('end', async () => { await interaction.editReply({ components: [] }).catch(() => {}); });
}

// ── Discord bot ───────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('players')
        .setDescription('List all players currently online across all tracked servers'),

    new SlashCommandBuilder()
        .setName('chatlogs')
        .setDescription('Get chat history for a player — shows which server each message was sent in')
        .addStringOption(o => o.setName('username').setDescription('Roblox username to look up').setRequired(true))
        .addStringOption(o => o.setName('jobid').setDescription('Optional: filter to a specific server Job ID').setRequired(false)),

    new SlashCommandBuilder()
        .setName('serverchat')
        .setDescription('View the full chat log for a server — pick from dropdown or enter a Job ID directly')
        .addStringOption(o => o.setName('jobid').setDescription('Optional: enter a Job ID directly to skip the dropdown').setRequired(false)),

    new SlashCommandBuilder()
        .setName('friends')
        .setDescription('Show a player\'s friends who have played or are in the group (online & offline)')
        .addStringOption(o => o.setName('username').setDescription('Roblox username').setRequired(true)),

    new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription('Get details and stats for a server — pick from dropdown or enter a Job ID directly')
        .addStringOption(o => o.setName('jobid').setDescription('Optional: enter a Job ID directly to skip the dropdown').setRequired(false)),

    new SlashCommandBuilder()
        .setName('adminlogs')
        .setDescription('View logged Adonis admin commands — optionally filter by player or server')
        .addStringOption(o => o.setName('username').setDescription('Optional: filter by username').setRequired(false))
        .addStringOption(o => o.setName('jobid').setDescription('Optional: filter by server Job ID').setRequired(false)),
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Bot online: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log('Slash commands registered');
    } catch (e) { console.error('Failed to register commands:', e); }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu()) return;

    // ── Role check ────────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
        const hasRole = interaction.member?.roles.cache.some(r => ALLOWED_ROLES.includes(r.id));
        if (!hasRole) return interaction.reply({ content: 'You do not have permission to use this bot.', ephemeral: true });
    }

    // ── /players ──────────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'players') {
        await interaction.deferReply();
        if (activeServers.size === 0) return interaction.editReply('No active servers are being tracked right now.');

        const allServers = [...activeServers.entries()];
        const serverTypes = ['All', 'Public Server', 'Private Server', 'Reserved Server'];
        let currentFilter = 'All';
        let currentPage = 0;
        const perPage = 4;

        function getFiltered(filter) {
            return allServers.filter(([_, s]) => filter === 'All' || s.serverType === filter);
        }

        function buildPlayersEmbed(filter, page) {
            const filtered = getFiltered(filter);
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
                    const list = server.players.size > 0
                        ? [...server.players.values()].map(p => `${p.displayName} (@${p.username})`).join('\n')
                        : 'Empty';
                    embed.addFields({
                        name: `${server.serverType} · ${server.players.size}/${server.maxPlayers} · ⏱ ${uptimeStr(Date.now() - server.startTime)}`,
                        value: `\`${jobId}\`\n${list}`.substring(0, 1024),
                    });
                }
            }
            return { embed, totalPages };
        }

        function buildPlayersComponents(filter, page, totalPages) {
            const filtered = getFiltered(filter);
            const pageSlice = filtered.slice(page * perPage, (page + 1) * perPage);

            const filterRow = new ActionRowBuilder().addComponents(
                serverTypes.map(type =>
                    new ButtonBuilder()
                        .setCustomId(`pf_${type}`)
                        .setLabel(type)
                        .setStyle(type === filter ? ButtonStyle.Primary : ButtonStyle.Secondary)
                )
            );

            const navRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('pp_prev').setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                new ButtonBuilder().setCustomId('pp_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
            );

            const rows = [filterRow, navRow];

            if (pageSlice.length > 0) {
                const joinRow = new ActionRowBuilder().addComponents(
                    pageSlice.slice(0, 5).map(([jobId, server], i) =>
                        new ButtonBuilder()
                            .setLabel(`Join Server ${page * perPage + i + 1}`)
                            .setStyle(ButtonStyle.Link)
                            .setURL(joinUrl(server.placeId, jobId))
                    )
                );
                rows.push(joinRow);
            }

            return rows;
        }

        const { embed, totalPages } = buildPlayersEmbed(currentFilter, currentPage);
        const reply = await interaction.editReply({ embeds: [embed], components: buildPlayersComponents(currentFilter, currentPage, totalPages) });
        const collector = reply.createMessageComponentCollector({ time: 120_000 });

        collector.on('collect', async btn => {
            if (!btn.isButton()) return;
            if (btn.user.id !== interaction.user.id) return btn.reply({ content: 'These buttons are not for you.', ephemeral: true });
            await btn.deferUpdate();
            if (btn.customId.startsWith('pf_')) { currentFilter = btn.customId.slice(3); currentPage = 0; }
            else if (btn.customId === 'pp_prev') currentPage = Math.max(0, currentPage - 1);
            else if (btn.customId === 'pp_next') currentPage++;
            const { embed: e, totalPages: tp } = buildPlayersEmbed(currentFilter, currentPage);
            await interaction.editReply({ embeds: [e], components: buildPlayersComponents(currentFilter, currentPage, tp) });
        });

        collector.on('end', async () => {
            const { embed: e } = buildPlayersEmbed(currentFilter, currentPage);
            await interaction.editReply({ embeds: [e], components: [] }).catch(() => {});
        });
    }

    // ── /chatlogs ─────────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'chatlogs') {
        await interaction.deferReply();
        const username = interaction.options.getString('username');
        const filterJobId = interaction.options.getString('jobid');
        const uid = usernameToId.get(username.toLowerCase());
        const pcl = uid ? persistentChatlogs.get(uid) : null;
        const activeInfo = uid ? playerIndex.get(uid) : null;
        const activeServer = activeInfo ? activeServers.get(activeInfo.currentJobId) : null;
        const activePlayer = activeServer?.players.get(uid);

        if (!pcl && !activePlayer) {
            return interaction.editReply(`No data found for **${username}**. They haven't connected to a tracked server since the bot started.`);
        }

        let entries = pcl ? [...pcl.entries] : [];
        if (activePlayer) {
            for (const e of activePlayer.chatLog) {
                if (!entries.some(pe => pe.timestamp === e.timestamp)) {
                    entries.push({ ...e, jobId: activeInfo.currentJobId, serverType: activeServer.serverType });
                }
            }
        }

        if (filterJobId) entries = entries.filter(e => e.jobId === filterJobId);
        entries.sort((a, b) => a.timestamp - b.timestamp);

        if (entries.length === 0) {
            return interaction.editReply(`**${username}** has no chat messages on record${filterJobId ? ' for that server' : ''}.`);
        }

        const isOnline = !!activePlayer;
        const status = isOnline ? '🟢 Currently online' : '🔴 Offline';
        const pages = buildChatPages(entries, 15);
        let currentPage = 0;

        function buildCLEmbed(page) {
            const lines = pages[page].map(e =>
                `${tsStr(e.timestamp)} [${e.serverType || 'Server'} \`${(e.jobId || '').substring(0, 8)}...\`] **${e.displayName}** (@${e.username}): ${e.message}`
            );
            return new EmbedBuilder()
                .setTitle(`Chat Logs — ${username}`)
                .setDescription(`${status}${filterJobId ? ` · filtered to \`${filterJobId.substring(0, 8)}...\`` : ''}\n\n${lines.join('\n')}`.substring(0, 4000))
                .setColor(isOnline ? 0x2ecc71 : 0xe74c3c)
                .setFooter({ text: `${entries.length} total messages · Page ${page + 1}/${pages.length}` })
                .setTimestamp();
        }

        const reply = await interaction.editReply({
            embeds: [buildCLEmbed(currentPage)],
            components: pages.length > 1 ? [buildNavRow(currentPage, pages.length, 'cl')] : [],
        });

        if (pages.length <= 1) return;

        const collector = reply.createMessageComponentCollector({ time: 120_000 });
        collector.on('collect', async btn => {
            if (btn.user.id !== interaction.user.id) return btn.reply({ content: 'Not for you.', ephemeral: true });
            await btn.deferUpdate();
            if (btn.customId === 'cl_prev') currentPage = Math.max(0, currentPage - 1);
            else if (btn.customId === 'cl_next') currentPage = Math.min(pages.length - 1, currentPage + 1);
            await interaction.editReply({ embeds: [buildCLEmbed(currentPage)], components: [buildNavRow(currentPage, pages.length, 'cl')] });
        });
        collector.on('end', async () => { await interaction.editReply({ components: [] }).catch(() => {}); });
    }

    // ── /serverchat ───────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'serverchat') {
        await interaction.deferReply();
        const inputJobId = interaction.options.getString('jobid');

        if (inputJobId) {
            const server = activeServers.get(inputJobId);
            if (!server) return interaction.editReply('No active server found with that Job ID. It may have shut down.');
            return showServerchat(interaction, inputJobId, server);
        }

        if (activeServers.size === 0) return interaction.editReply('No active servers being tracked right now.');
        const row = buildServerSelectMenu('sc_select', 'Select a server...');
        const reply = await interaction.editReply({
            content: '**Server Chat** — pick a server below, or use `/serverchat jobid:` to enter a Job ID directly.',
            components: [row],
        });
        const collector = reply.createMessageComponentCollector({ time: 60_000 });
        collector.on('collect', async sel => {
            if (sel.user.id !== interaction.user.id) return sel.reply({ content: 'Not for you.', ephemeral: true });
            await sel.deferUpdate();
            const jobId = sel.values[0];
            const server = activeServers.get(jobId);
            if (!server) return interaction.editReply({ content: 'That server is no longer active.', components: [] });
            await showServerchat(interaction, jobId, server);
            collector.stop();
        });
        collector.on('end', async (_, reason) => {
            if (reason === 'time') await interaction.editReply({ content: 'Timed out.', components: [] }).catch(() => {});
        });
    }

    // ── /serverinfo ───────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'serverinfo') {
        await interaction.deferReply();
        const inputJobId = interaction.options.getString('jobid');

        if (inputJobId) {
            const server = activeServers.get(inputJobId);
            if (!server) return interaction.editReply('No active server found with that Job ID.');
            return showServerinfo(interaction, inputJobId, server);
        }

        if (activeServers.size === 0) return interaction.editReply('No active servers being tracked right now.');
        const row = buildServerSelectMenu('si_select', 'Select a server...');
        const reply = await interaction.editReply({
            content: '**Server Info** — pick a server below, or use `/serverinfo jobid:` to enter a Job ID directly.',
            components: [row],
        });
        const collector = reply.createMessageComponentCollector({ time: 60_000 });
        collector.on('collect', async sel => {
            if (sel.user.id !== interaction.user.id) return sel.reply({ content: 'Not for you.', ephemeral: true });
            await sel.deferUpdate();
            const jobId = sel.values[0];
            const server = activeServers.get(jobId);
            if (!server) return interaction.editReply({ content: 'That server is no longer active.', components: [] });
            await showServerinfo(interaction, jobId, server);
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
        const uid = usernameToId.get(username.toLowerCase());

        if (!uid) return interaction.editReply(`**${username}** hasn't connected to a tracked server since the bot started.`);

        const friends = await getFriends(uid);
        if (friends.length === 0) {
            return interaction.editReply(`Could not retrieve friends for **${username}** — their friend list may be private.`);
        }

        const online = [], offline = [];

        for (const friend of friends) {
            const fid = friend.id;
            const known = allKnownPlayers.get(fid);
            const inGroup = await isInGroup(fid);
            const isOnline = playerIndex.has(fid);

            if (isOnline || known || inGroup) {
                const entry = {
                    username: friend.name,
                    displayName: friend.displayName,
                    inGroup,
                    lastSeen: known?.lastSeen,
                    currentJobId: playerIndex.get(fid)?.currentJobId,
                };
                if (isOnline) online.push(entry);
                else offline.push(entry);
            }
        }

        const embed = new EmbedBuilder()
            .setTitle(`Friends — ${username}`)
            .setColor(0x9b59b6)
            .setTimestamp()
            .setFooter({ text: '👥 = in group · Only shows friends who have played or are in the group' });

        const onlineStr = online.length > 0
            ? online.map(f => `🟢 **${f.displayName}** (@${f.username})${f.inGroup ? ' 👥' : ''}${f.currentJobId ? `\n↳ \`${f.currentJobId.substring(0, 8)}...\`` : ''}`).join('\n')
            : 'None currently online';

        const offlineStr = offline.length > 0
            ? offline.map(f => `⚫ **${f.displayName}** (@${f.username})${f.inGroup ? ' 👥' : ''}${f.lastSeen ? ` · last seen ${tsStr(f.lastSeen)}` : ''}`).join('\n')
            : 'None';

        embed.addFields(
            { name: `🟢 Online in game (${online.length})`, value: onlineStr.substring(0, 1024), inline: false },
            { name: `⚫ Seen before / in group (${offline.length})`, value: offlineStr.substring(0, 1024), inline: false },
        );

        return interaction.editReply({ embeds: [embed] });
    }

    // ── /adminlogs ────────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'adminlogs') {
        await interaction.deferReply();
        const filterUsername = interaction.options.getString('username');
        const filterJobId = interaction.options.getString('jobid');

        let logs = [...adminLogs];
        if (filterUsername) logs = logs.filter(l => l.username.toLowerCase() === filterUsername.toLowerCase());
        if (filterJobId) logs = logs.filter(l => l.jobId === filterJobId);

        if (logs.length === 0) {
            return interaction.editReply('No admin commands logged' + (filterUsername || filterJobId ? ' matching those filters.' : ' yet.'));
        }

        const pages = buildChatPages(logs, 10);
        let currentPage = 0;

        function buildAdminEmbed(page) {
            const lines = pages[page].map(l => {
                const status = l.executed ? '✅' : '❌';
                const denial = l.denialReason ? `\n↳ Reason: ${l.denialReason}` : '';
                const target = l.target ? `\n↳ Target: ${l.target}` : '';
                return `${tsStr(l.timestamp)} ${status} **${l.displayName}** (@${l.username}) [${l.rankName}]\n↳ \`${l.command}\`${target}${denial}\n↳ ${l.serverType} \`${l.jobId.substring(0, 8)}...\``;
            });
            return new EmbedBuilder()
                .setTitle(`Admin Logs${filterUsername ? ` — ${filterUsername}` : ''}`)
                .setDescription(lines.join('\n\n').substring(0, 4000))
                .setColor(0xe67e22)
                .setFooter({ text: `${logs.length} total commands · Page ${page + 1}/${pages.length}` })
                .setTimestamp();
        }

        const reply = await interaction.editReply({
            embeds: [buildAdminEmbed(currentPage)],
            components: pages.length > 1 ? [buildNavRow(currentPage, pages.length, 'al')] : [],
        });

        if (pages.length <= 1) return;

        const collector = reply.createMessageComponentCollector({ time: 120_000 });
        collector.on('collect', async btn => {
            if (btn.user.id !== interaction.user.id) return btn.reply({ content: 'Not for you.', ephemeral: true });
            await btn.deferUpdate();
            if (btn.customId === 'al_prev') currentPage = Math.max(0, currentPage - 1);
            else if (btn.customId === 'al_next') currentPage = Math.min(pages.length - 1, currentPage + 1);
            await interaction.editReply({ embeds: [buildAdminEmbed(currentPage)], components: [buildNavRow(currentPage, pages.length, 'al')] });
        });
        collector.on('end', async () => { await interaction.editReply({ components: [] }).catch(() => {}); });
    }
});

client.login(BOT_TOKEN);
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));