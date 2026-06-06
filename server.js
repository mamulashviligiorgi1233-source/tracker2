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

const activeServers      = new Map();
const recentSessions     = new Map();
const usernameToId       = new Map();
const playerIndex        = new Map();
const allKnownPlayers    = new Map();
const persistentChatlogs = new Map();
const adminLogs          = [];
const pendingBans        = [];
const banLogs            = [];
let   banIdCounter       = 0;

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

function robloxPost(url, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const u = new URL(url);
        const req = https.request({
            hostname: u.hostname, path: u.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, res => {
            let raw = '';
            res.on('data', c => (raw += c));
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch { reject(new Error('JSON parse failed')); }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
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

async function getUserByUsername(username) {
    try {
        const data = await robloxPost('https://users.roblox.com/v1/usernames/users', {
            usernames: [username],
            excludeBannedUsers: false,
        });
        return data.data?.[0] || null;
    } catch { return null; }
}

function auth(req, res, next) {
    if (req.headers['x-secret'] !== SHARED_SECRET) return res.status(401).end();
    next();
}

app.post('/event', auth, async (req, res) => {
    const { type, jobId, ...data } = req.body;
    res.json({ ok: true });

    if (type === 'server_start') {
        activeServers.set(jobId, {
            placeId: data.placeId, serverType: data.serverType,
            maxPlayers: data.maxPlayers, startTime: Date.now(),
            players: new Map(), chatLog: [],
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
        if (!persistentChatlogs.has(userId)) persistentChatlogs.set(userId, { username, displayName, entries: [] });
        const pcl = persistentChatlogs.get(userId);
        pcl.username = username;
        pcl.displayName = displayName;
        pcl.entries.push({ jobId, serverType: server.serverType, message, timestamp: Date.now() });
        return;
    }

    if (type === 'admin_command') {
        const serverType = server ? server.serverType : 'Unknown';
        adminLogs.push({
            userId: data.userId, username: data.username, displayName: data.displayName,
            command: data.command, executed: data.executed,
            denialReason: data.denialReason || null, errorMessage: data.errorMessage || null,
            rankName: data.rankName || 'Unknown', adminLevel: data.adminLevel || 0,
            target: data.target || null, serverType, jobId, timestamp: Date.now(),
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

app.get('/pending-bans', auth, (req, res) => {
    res.json({ bans: pendingBans.filter(b => !b.executed) });
});

app.post('/ban-acknowledged', auth, (req, res) => {
    const { banId } = req.body;
    const ban = pendingBans.find(b => b.id === banId);
    if (ban) { ban.executed = true; ban.executedAt = Date.now(); }
    res.json({ ok: true });
});

function uptimeStr(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
}

function tsStr(ms) { return `<t:${Math.floor(ms / 1000)}:T>`; }

function joinUrl(placeId, jobId) {
    return `https://www.roblox.com/games/start?placeId=${placeId}&gameInstanceId=${jobId}`;
}

function buildChatPages(entries, perPage = 12) {
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
        .setTitle('Server Info').setColor(0x3447db)
        .addFields(
            { name: 'Server Type', value: server.serverType, inline: true },
            { name: 'Players', value: `${server.players.size}/${server.maxPlayers}`, inline: true },
            { name: 'Uptime', value: uptimeStr(Date.now() - server.startTime), inline: true },
            { name: 'Place ID', value: String(server.placeId), inline: true },
            { name: 'Messages Logged', value: String(server.chatLog.length), inline: true },
            { name: 'Full Job ID', value: `\`${jobId}\``, inline: false },
            { name: 'Players Online', value: playerList.substring(0, 1024), inline: false },
        ).setTimestamp();
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
        content: '', embeds: [buildSCEmbed(currentPage)],
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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('players')
        .setDescription('List all players currently online across all tracked servers'),

    new SlashCommandBuilder()
        .setName('playerlogs')
        .setDescription('View combined chat and admin command history for a player or server')
        .addStringOption(o => o.setName('username').setDescription('Roblox username to look up').setRequired(false))
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
        .setName('ban')
        .setDescription('Ban a player from the game via Adonis — requires confirmation before executing')
        .addStringOption(o => o.setName('username').setDescription('Exact Roblox username (no display names)').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the ban').setRequired(true)),
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

    if (interaction.isChatInputCommand()) {
        const hasRole = interaction.member?.roles.cache.some(r => ALLOWED_ROLES.includes(r.id));
        if (!hasRole) return interaction.reply({ content: 'You do not have permission to use this bot.', ephemeral: true });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'players') {
        await interaction.deferReply();
        if (activeServers.size === 0) return interaction.editReply('No active servers are being tracked right now.');
        const allServers = [...activeServers.entries()];
        const serverTypes = ['All', 'Public Server', 'Private Server', 'Reserved Server'];
        let currentFilter = 'All';
        let currentPage = 0;
        const perPage = 4;
        function getFiltered(filter) { return allServers.filter(([_, s]) => filter === 'All' || s.serverType === filter); }
        function buildPlayersEmbed(filter, page) {
            const filtered = getFiltered(filter);
            const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
            const pageSlice = filtered.slice(page * perPage, (page + 1) * perPage);
            const embed = new EmbedBuilder().setTitle(`Players Online — ${filter}`).setColor(0x3498db).setTimestamp()
                .setFooter({ text: `Page ${page + 1}/${totalPages} · ${filtered.length} server(s)` });
            if (pageSlice.length === 0) { embed.setDescription('No servers match this filter.'); }
            else {
                for (const [jobId, server] of pageSlice) {
                    const list = server.players.size > 0
                        ? [...server.players.values()].map(p => `${p.displayName} (@${p.username})`).join('\n') : 'Empty';
                    embed.addFields({ name: `${server.serverType} · ${server.players.size}/${server.maxPlayers} · ⏱ ${uptimeStr(Date.now() - server.startTime)}`, value: `\`${jobId}\`\n${list}`.substring(0, 1024) });
                }
            }
            return { embed, totalPages };
        }
        function buildPlayersComponents(filter, page, totalPages) {
            const filtered = getFiltered(filter);
            const pageSlice = filtered.slice(page * perPage, (page + 1) * perPage);
            const filterRow = new ActionRowBuilder().addComponents(serverTypes.map(type =>
                new ButtonBuilder().setCustomId(`pf_${type}`).setLabel(type).setStyle(type === filter ? ButtonStyle.Primary : ButtonStyle.Secondary)
            ));
            const navRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('pp_prev').setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                new ButtonBuilder().setCustomId('pp_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
            );
            const rows = [filterRow, navRow];
            if (pageSlice.length > 0) {
                rows.push(new ActionRowBuilder().addComponents(
                    pageSlice.slice(0, 5).map(([jobId, server], i) =>
                        new ButtonBuilder().setLabel(`Join Server ${page * perPage + i + 1}`).setStyle(ButtonStyle.Link).setURL(joinUrl(server.placeId, jobId))
                    )
                ));
            }
            return rows;
        }
        const { embed, totalPages } = buildPlayersEmbed(currentFilter, currentPage);
        const reply = await interaction.editReply({ embeds: [embed], components: buildPlayersComponents(currentFilter, currentPage, totalPages) });
        const collector = reply.createMessageComponentCollector({ time: 120_000 });
        collector.on('collect', async btn => {
            if (!btn.isButton()) return;
            if (btn.user.id !== interaction.user.id) return btn.reply({ content: 'Not for you.', ephemeral: true });
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

    if (interaction.isChatInputCommand() && interaction.commandName === 'playerlogs') {
        await interaction.deferReply();
        const username = interaction.options.getString('username');
        const filterJobId = interaction.options.getString('jobid');

        if (!username && !filterJobId) {
            if (activeServers.size === 0) return interaction.editReply('No active servers being tracked right now.');
            const row = buildServerSelectMenu('pl_select', 'Select a server to view its logs...');
            const reply = await interaction.editReply({ content: '**Player Logs** — pick a server, or re-run with `/playerlogs username:` to look up a specific player.', components: [row] });
            const collector = reply.createMessageComponentCollector({ time: 60_000 });
            collector.on('collect', async sel => {
                if (sel.user.id !== interaction.user.id) return sel.reply({ content: 'Not for you.', ephemeral: true });
                await sel.deferUpdate();
                const jobId = sel.values[0];
                const server = activeServers.get(jobId);
                if (!server) return interaction.editReply({ content: 'That server is no longer active.', components: [] });
                const chatEntries = [...server.chatLog];
                const adminEntries = adminLogs.filter(l => l.jobId === jobId);
                const chatPages = buildChatPages(chatEntries, 12);
                const adminPages = buildChatPages(adminEntries, 10);
                let view = 'chat';
                let chatPage = 0;
                let adminPage = 0;
                function buildServerLogsEmbed() {
                    if (view === 'chat') {
                        const lines = chatPages[chatPage].map(e => `${tsStr(e.timestamp)} **${e.displayName}** (@${e.username}): ${e.message}`);
                        return new EmbedBuilder().setTitle(`Server Logs — Chat`).setDescription(lines.join('\n').substring(0, 4000) || 'No messages.').setColor(0x3447db)
                            .addFields({ name: 'Full Job ID', value: `\`${jobId}\``, inline: false })
                            .setFooter({ text: `${chatEntries.length} messages · Page ${chatPage + 1}/${chatPages.length}` }).setTimestamp();
                    }
                    const lines = adminPages[adminPage].map(l => `${tsStr(l.timestamp)} ${l.executed ? '✅' : '❌'} **${l.displayName}** (@${l.username}) [${l.rankName}]\n↳ \`${l.command}\`${l.target ? ` → ${l.target}` : ''}${l.denialReason ? `\n↳ ${l.denialReason}` : ''}`);
                    return new EmbedBuilder().setTitle(`Server Logs — Admin Commands`).setDescription(lines.join('\n\n').substring(0, 4000) || 'No commands.').setColor(0xe67e22)
                        .addFields({ name: 'Full Job ID', value: `\`${jobId}\``, inline: false })
                        .setFooter({ text: `${adminEntries.length} commands · Page ${adminPage + 1}/${adminPages.length}` }).setTimestamp();
                }
                function buildServerLogsComponents() {
                    const tabRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('sl_chat').setLabel('📝 Chat Logs').setStyle(view === 'chat' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId('sl_admin').setLabel('🔨 Admin Commands').setStyle(view === 'admin' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                    );
                    const pages = view === 'chat' ? chatPages : adminPages;
                    const page = view === 'chat' ? chatPage : adminPage;
                    const navRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('sl_prev').setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                        new ButtonBuilder().setCustomId('sl_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages.length - 1),
                    );
                    return [tabRow, navRow];
                }
                const msg = await interaction.editReply({ content: '', embeds: [buildServerLogsEmbed()], components: buildServerLogsComponents() });
                collector.stop();
                const c2 = msg.createMessageComponentCollector({ time: 120_000 });
                c2.on('collect', async btn => {
                    if (btn.user.id !== interaction.user.id) return btn.reply({ content: 'Not for you.', ephemeral: true });
                    await btn.deferUpdate();
                    if (btn.customId === 'sl_chat') view = 'chat';
                    else if (btn.customId === 'sl_admin') view = 'admin';
                    else if (btn.customId === 'sl_prev') { if (view === 'chat') chatPage = Math.max(0, chatPage - 1); else adminPage = Math.max(0, adminPage - 1); }
                    else if (btn.customId === 'sl_next') { if (view === 'chat') chatPage = Math.min(chatPages.length - 1, chatPage + 1); else adminPage = Math.min(adminPages.length - 1, adminPage + 1); }
                    await interaction.editReply({ embeds: [buildServerLogsEmbed()], components: buildServerLogsComponents() });
                });
                c2.on('end', async () => { await interaction.editReply({ components: [] }).catch(() => {}); });
            });
            collector.on('end', async (_, reason) => {
                if (reason === 'time') await interaction.editReply({ content: 'Timed out.', components: [] }).catch(() => {});
            });
            return;
        }

        const uid = username ? usernameToId.get(username.toLowerCase()) : null;
        const pcl = uid ? persistentChatlogs.get(uid) : null;
        const activeInfo = uid ? playerIndex.get(uid) : null;
        const activeServer = activeInfo ? activeServers.get(activeInfo.currentJobId) : null;
        const activePlayer = activeServer?.players.get(uid);

        if (username && !pcl && !activePlayer) {
            return interaction.editReply(`No data found for **${username}**. They haven't connected to a tracked server since the bot started.`);
        }

        let chatEntries = pcl ? [...pcl.entries] : [];
        if (activePlayer) {
            for (const e of activePlayer.chatLog) {
                if (!chatEntries.some(pe => pe.timestamp === e.timestamp)) {
                    chatEntries.push({ ...e, jobId: activeInfo.currentJobId, serverType: activeServer.serverType });
                }
            }
        }
        if (filterJobId) chatEntries = chatEntries.filter(e => e.jobId === filterJobId);
        chatEntries.sort((a, b) => a.timestamp - b.timestamp);

        let adminEntries = uid ? adminLogs.filter(l => l.userId === uid) : adminLogs;
        if (filterJobId) adminEntries = adminEntries.filter(l => l.jobId === filterJobId);
        adminEntries = [...adminEntries].sort((a, b) => b.timestamp - a.timestamp);

        const isOnline = !!activePlayer;
        const status = isOnline ? '🟢 Currently online' : '🔴 Offline';
        const chatPages = buildChatPages(chatEntries, 12);
        const adminPages = buildChatPages(adminEntries, 10);
        let view = 'chat';
        let chatPage = 0;
        let adminPage = 0;

        function buildPlayerLogsEmbed() {
            if (view === 'chat') {
                const lines = chatPages[chatPage].map(e =>
                    `${tsStr(e.timestamp)} [${e.serverType || 'Server'} \`${(e.jobId || '').substring(0, 8)}...\`] **${e.displayName}** (@${e.username}): ${e.message}`
                );
                return new EmbedBuilder()
                    .setTitle(`Player Logs — ${username || 'All'} · Chat`)
                    .setDescription(`${username ? status : ''}${filterJobId ? ` · filtered to \`${filterJobId.substring(0, 8)}...\`` : ''}\n\n${lines.join('\n') || 'No messages.'}`.trim().substring(0, 4000))
                    .setColor(isOnline ? 0x2ecc71 : 0x3447db)
                    .setFooter({ text: `${chatEntries.length} messages · Page ${chatPage + 1}/${chatPages.length}` })
                    .setTimestamp();
            }
            const lines = adminPages[adminPage].map(l =>
                `${tsStr(l.timestamp)} ${l.executed ? '✅' : '❌'} **${l.displayName}** (@${l.username}) [${l.rankName}]\n↳ \`${l.command}\`${l.target ? ` → ${l.target}` : ''}${l.denialReason ? `\n↳ ${l.denialReason}` : ''}\n↳ ${l.serverType} \`${l.jobId.substring(0, 8)}...\``
            );
            return new EmbedBuilder()
                .setTitle(`Player Logs — ${username || 'All'} · Admin Commands`)
                .setDescription(lines.join('\n\n').substring(0, 4000) || 'No admin commands on record.')
                .setColor(0xe67e22)
                .setFooter({ text: `${adminEntries.length} commands · Page ${adminPage + 1}/${adminPages.length}` })
                .setTimestamp();
        }

        function buildPlayerLogsComponents() {
            const tabRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('pl_chat').setLabel('📝 Chat Logs').setStyle(view === 'chat' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('pl_admin').setLabel('🔨 Admin Commands').setStyle(view === 'admin' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            );
            const pages = view === 'chat' ? chatPages : adminPages;
            const page = view === 'chat' ? chatPage : adminPage;
            const navRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('pl_prev').setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                new ButtonBuilder().setCustomId('pl_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages.length - 1),
            );
            return [tabRow, navRow];
        }

        const reply = await interaction.editReply({ embeds: [buildPlayerLogsEmbed()], components: buildPlayerLogsComponents() });
        const collector = reply.createMessageComponentCollector({ time: 120_000 });
        collector.on('collect', async btn => {
            if (btn.user.id !== interaction.user.id) return btn.reply({ content: 'Not for you.', ephemeral: true });
            await btn.deferUpdate();
            if (btn.customId === 'pl_chat') view = 'chat';
            else if (btn.customId === 'pl_admin') view = 'admin';
            else if (btn.customId === 'pl_prev') { if (view === 'chat') chatPage = Math.max(0, chatPage - 1); else adminPage = Math.max(0, adminPage - 1); }
            else if (btn.customId === 'pl_next') { if (view === 'chat') chatPage = Math.min(chatPages.length - 1, chatPage + 1); else adminPage = Math.min(adminPages.length - 1, adminPage + 1); }
            await interaction.editReply({ embeds: [buildPlayerLogsEmbed()], components: buildPlayerLogsComponents() });
        });
        collector.on('end', async () => { await interaction.editReply({ components: [] }).catch(() => {}); });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'serverchat') {
        await interaction.deferReply();
        const inputJobId = interaction.options.getString('jobid');
        if (inputJobId) {
            const server = activeServers.get(inputJobId);
            if (!server) return interaction.editReply('No active server found with that Job ID.');
            return showServerchat(interaction, inputJobId, server);
        }
        if (activeServers.size === 0) return interaction.editReply('No active servers being tracked right now.');
        const row = buildServerSelectMenu('sc_select', 'Select a server...');
        const reply = await interaction.editReply({ content: '**Server Chat** — pick a server below, or use `/serverchat jobid:` to enter a Job ID directly.', components: [row] });
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
        const reply = await interaction.editReply({ content: '**Server Info** — pick a server below, or use `/serverinfo jobid:` to enter a Job ID directly.', components: [row] });
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

    if (interaction.isChatInputCommand() && interaction.commandName === 'friends') {
        await interaction.deferReply();
        const username = interaction.options.getString('username');
        const uid = usernameToId.get(username.toLowerCase());
        if (!uid) return interaction.editReply(`**${username}** hasn't connected to a tracked server since the bot started.`);
        const friends = await getFriends(uid);
        if (friends.length === 0) return interaction.editReply(`Could not retrieve friends for **${username}** — their friend list may be private.`);
        const online = [], offline = [];
        for (const friend of friends) {
            const fid = friend.id;
            const known = allKnownPlayers.get(fid);
            const inGroup = await isInGroup(fid);
            const isOnline = playerIndex.has(fid);
            if (isOnline || known || inGroup) {
                const entry = { username: friend.name, displayName: friend.displayName, inGroup, lastSeen: known?.lastSeen, currentJobId: playerIndex.get(fid)?.currentJobId };
                if (isOnline) online.push(entry);
                else offline.push(entry);
            }
        }
        const embed = new EmbedBuilder().setTitle(`Friends — ${username}`).setColor(0x9b59b6).setTimestamp()
            .setFooter({ text: '👥 = in group · Only shows friends who have played or are in the group' });
        embed.addFields(
            { name: `🟢 Online in game (${online.length})`, value: (online.length > 0 ? online.map(f => `🟢 **${f.displayName}** (@${f.username})${f.inGroup ? ' 👥' : ''}${f.currentJobId ? `\n↳ \`${f.currentJobId.substring(0, 8)}...\`` : ''}`).join('\n') : 'None').substring(0, 1024), inline: false },
            { name: `⚫ Seen before / in group (${offline.length})`, value: (offline.length > 0 ? offline.map(f => `⚫ **${f.displayName}** (@${f.username})${f.inGroup ? ' 👥' : ''}${f.lastSeen ? ` · last seen ${tsStr(f.lastSeen)}` : ''}`).join('\n') : 'None').substring(0, 1024), inline: false },
        );
        return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'ban') {
        await interaction.deferReply({ ephemeral: false });

        const username = interaction.options.getString('username');
        const reason   = interaction.options.getString('reason');
        const executor = interaction.user;

        const robloxUser = await getUserByUsername(username);
        if (!robloxUser) {
            return interaction.editReply(`No Roblox account found with username **${username}**. Check the spelling — display names are not accepted.`);
        }

        const alreadyBanned = pendingBans.some(b => b.userId === robloxUser.id && !b.executed);
        if (alreadyBanned) {
            return interaction.editReply(`A ban for **${robloxUser.name}** is already pending execution in-game.`);
        }

        const confirmEmbed = new EmbedBuilder()
            .setTitle('⚠️ Confirm Ban')
            .setColor(0xff0000)
            .setDescription('Review the details below carefully. This action will be **permanently logged** regardless of whether you confirm or cancel.')
            .addFields(
                { name: 'Username',     value: robloxUser.name,           inline: true },
                { name: 'User ID',      value: String(robloxUser.id),     inline: true },
                { name: 'Reason',       value: reason,                    inline: false },
                { name: 'Issued by',    value: `${executor.tag} (${executor.id})`, inline: false },
                { name: 'Time',         value: tsStr(Date.now()),          inline: true },
            )
            .setFooter({ text: 'This confirmation expires in 30 seconds.' })
            .setTimestamp();

        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ban_confirm').setLabel('✅ Confirm Ban').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('ban_cancel').setLabel('❌ Cancel').setStyle(ButtonStyle.Secondary),
        );

        const reply = await interaction.editReply({ embeds: [confirmEmbed], components: [confirmRow] });

        banLogs.push({
            userId:         robloxUser.id,
            username:       robloxUser.name,
            reason,
            issuedBy:       executor.tag,
            issuedById:     executor.id,
            timestamp:      Date.now(),
            confirmed:      false,
            cancelled:      false,
        });

        const collector = reply.createMessageComponentCollector({ time: 30_000, max: 1 });

        collector.on('collect', async btn => {
            if (btn.user.id !== interaction.user.id) {
                return btn.reply({ content: 'Only the person who issued this command can confirm it.', ephemeral: true });
            }

            await btn.deferUpdate();

            const logEntry = banLogs[banLogs.length - 1];

            if (btn.customId === 'ban_cancel') {
                logEntry.cancelled = true;
                return interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle('Ban Cancelled')
                        .setColor(0x95a5a6)
                        .setDescription(`Ban for **${robloxUser.name}** was cancelled by ${executor.tag}.`)
                        .addFields({ name: 'Reason that was given', value: reason, inline: false })
                        .setTimestamp()
                    ],
                    components: [],
                });
            }

            if (btn.customId === 'ban_confirm') {
                logEntry.confirmed = true;
                const banId = ++banIdCounter;
                pendingBans.push({
                    id:         banId,
                    userId:     robloxUser.id,
                    username:   robloxUser.name,
                    reason,
                    bannedBy:   executor.tag,
                    bannedById: executor.id,
                    timestamp:  Date.now(),
                    executed:   false,
                    executedAt: null,
                });

                adminLogs.push({
                    userId:      robloxUser.id,
                    username:    robloxUser.name,
                    displayName: robloxUser.displayName || robloxUser.name,
                    command:     `[Discord Ban] ${robloxUser.name} — Reason: ${reason}`,
                    executed:    true,
                    denialReason: null,
                    errorMessage: null,
                    rankName:    'Discord Staff',
                    adminLevel:  0,
                    target:      robloxUser.name,
                    serverType:  'N/A',
                    jobId:       'discord',
                    issuedBy:    executor.tag,
                    issuedById:  executor.id,
                    timestamp:   Date.now(),
                });

                return interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle('Ban Queued')
                        .setColor(0xe74c3c)
                        .setDescription(`**${robloxUser.name}** will be banned the next time any active game server checks for pending actions (within 30 seconds).`)
                        .addFields(
                            { name: 'Username',  value: robloxUser.name,          inline: true },
                            { name: 'User ID',   value: String(robloxUser.id),    inline: true },
                            { name: 'Reason',    value: reason,                   inline: false },
                            { name: 'Issued by', value: `${executor.tag} (${executor.id})`, inline: false },
                        )
                        .setFooter({ text: 'This action has been permanently logged.' })
                        .setTimestamp()
                    ],
                    components: [],
                });
            }
        });

        collector.on('end', async (collected) => {
            if (collected.size === 0) {
                const logEntry = banLogs[banLogs.length - 1];
                if (!logEntry.confirmed && !logEntry.cancelled) {
                    logEntry.cancelled = true;
                    logEntry.cancelReason = 'timed out';
                }
                await interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle('Ban Timed Out')
                        .setColor(0x95a5a6)
                        .setDescription(`Confirmation for banning **${robloxUser.name}** expired. No action was taken.`)
                        .setTimestamp()
                    ],
                    components: [],
                }).catch(() => {});
            }
        });
    }
});

client.login(BOT_TOKEN);
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));