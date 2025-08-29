import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  PermissionsBitField,
  REST,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// ========= CONFIG =========
const DOMAINS = ["Cryptography","Reverse engineering","Web","Forensics","OSINT","PWN","MISC"];

const CONFIG = {
  TOKEN: process.env.BOT_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID,

  BRAND_NAME: process.env.BRAND_NAME || '4hats',
  THEME_COLOR: parseInt((process.env.THEME_COLOR || '0x111827').replace(/^0x/i,''), 16),
  LOGO_URL: process.env.LOGO_URL || '',

  HELP_CHANNEL_NAME: (process.env.HELP_CHANNEL_NAME || 'ticketes').toLowerCase(),

  TICKET_CATEGORY_ID: process.env.TICKET_CATEGORY_ID || null,
  ARCHIVE_MODE: (process.env.ARCHIVE_MODE || 'false').toLowerCase() === 'true',
  ARCHIVE_CATEGORY_ID: process.env.ARCHIVE_CATEGORY_ID || null,

  // ROLE_<DOMAIN>_ID بعد تحويل الدومين لأحرف كبيرة واستبدال المسافات بـ _
  ROLE_MAP: Object.fromEntries(
    DOMAINS.map(d => [d, process.env[`ROLE_${d.toUpperCase().replace(/\s+/g,'_')}_ID`] || ''])
  ),

  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || '',
  ALLOW_MULTIPLE_PER_DOMAIN: (process.env.ALLOW_MULTIPLE_PER_DOMAIN || 'false').toLowerCase() === 'true',
  PERSIST_FILE: process.env.PERSIST_FILE || 'tickets.json',
};

if (!CONFIG.TOKEN || !CONFIG.CLIENT_ID || !CONFIG.GUILD_ID) {
  throw new Error('Missing required env: BOT_TOKEN, CLIENT_ID, GUILD_ID');
}

// ========= CLIENT =========
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

// ========= SLASH COMMANDS =========
const commands = [
  {
    name: 'setup_tickets',
    description: 'Post the ticket panel to the #ticketes channel',
  }
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID),
    { body: commands }
  );
  console.log('✅ Slash commands registered.');
}

// ========= UI BUILDERS =========
function buildTicketPanel() {
  const openButton = new ButtonBuilder()
    .setCustomId('open_ticket')
    .setLabel('Open ticket')
    .setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(openButton);

  const embed = new EmbedBuilder()
    .setTitle(`${CONFIG.BRAND_NAME} — Ticket system`)
    .setDescription('Click the button below to open the ticket, then choose the field and provide a brief description.')
    .setColor(CONFIG.THEME_COLOR);

  if (CONFIG.LOGO_URL) embed.setThumbnail(CONFIG.LOGO_URL);

  return { embeds: [embed], components: [row] };
}

function buildDomainSelectRow() {
  const select = new StringSelectMenuBuilder()
    .setCustomId('select_domain')
    .setPlaceholder('Select the category')
    .addOptions(DOMAINS.map((d) => ({ label: d, value: d })));
  return new ActionRowBuilder().addComponents(select);
}

function buildDescriptionModal(selectedDomain) {
  const modal = new ModalBuilder()
    .setCustomId(`ticket_modal:${selectedDomain}`)
    .setTitle(`Ticket ${selectedDomain}`);

  const desc = new TextInputBuilder()
    .setCustomId('desc')
    .setLabel('Write a brief description of the problem.')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(true);

  return modal.addComponents(new ActionRowBuilder().addComponents(desc));
}

function buildCloseRow() {
  const closeBtn = new ButtonBuilder()
    .setCustomId('close_ticket')
    .setLabel('إغلاق التيكيت')
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(closeBtn);
}

// ========= HELPERS =========
async function readStore() {
  try {
    const p = path.resolve(CONFIG.PERSIST_FILE);
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { guilds: {} };
  }
}
async function writeStore(store) {
  const p = path.resolve(CONFIG.PERSIST_FILE);
  await fs.writeFile(p, JSON.stringify(store, null, 2), 'utf8');
}
async function nextTicketId(guildId) {
  const store = await readStore();
  const g = (store.guilds[guildId] ||= { lastId: 0 });
  g.lastId = (g.lastId || 0) + 1;
  await writeStore(store);
  return g.lastId;
}
function pad(n, w = 4) { return String(n).padStart(w, '0'); }

async function resolveDomainRoleId(guild, domain) {
  const byId = CONFIG.ROLE_MAP[domain];
  if (byId) return byId;
  const roleByName = guild.roles.cache.find(r => r.name === domain);
  return roleByName?.id || null;
}

function makeChannelName(username, domain, ticketId) {
  const cleanUser = username.toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 16) || 'user';
  return `ticket-${pad(ticketId)}-${cleanUser}-${domain.toLowerCase()}`.slice(0, 100);
}

function channelTopicPayload({ openerId, domain, roleId, description, ticketId }) {
  return `meta::{"openerId":"${openerId}","domain":"${domain}","roleId":"${roleId}","ticketId":${ticketId},"desc":"${(description||'').replace(/"/g,'\\"').slice(0,180)}"}`;
}

function parseChannelTopic(topic) {
  if (!topic) return null;
  const m = topic.match(/meta::(\{.*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function hasOpenTicketInDomain(guild, userId, domain) {
  if (CONFIG.ALLOW_MULTIPLE_PER_DOMAIN) return false;
  const channels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText && c.name.startsWith('ticket-'));
  for (const c of channels.values()) {
    const meta = parseChannelTopic(c.topic || '');
    if (meta && meta.openerId === userId && meta.domain === domain) return true;
  }
  return false;
}

async function logToChannel(guild, embed) {
  if (!CONFIG.LOG_CHANNEL_ID) return;
  const ch = guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
  if (ch && ch.isTextBased()) await ch.send({ embeds: [embed] }).catch(() => {});
}

// ========= EVENTS =========
client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 Logged in as ${c.user.tag}`);
  await registerCommands();
  await c.user.setPresence({
    activities: [{ name: `${CONFIG.BRAND_NAME} Tickets`, type: 0 }],
    status: 'online'
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // /setup_tickets → ينشر اللوحة في #help فقط
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup_tickets') {
      const guild = interaction.guild;
      const help = guild.channels.cache.find(
        ch => ch.type === ChannelType.GuildText && ch.name.toLowerCase() === CONFIG.HELP_CHANNEL_NAME
      );
      if (!help || !help.isTextBased()) {
        await interaction.reply({ content: `❌ I did not find a channel named#${CONFIG.HELP_CHANNEL_NAME}. Create it and try again.`, ephemeral: true });
        return;
      }
      const panel = buildTicketPanel();
      await help.send(panel);
      await interaction.reply({ content: `✅The ticket board was posted in#${CONFIG.HELP_CHANNEL_NAME}`, ephemeral: true });
      return;
    }

    // فتح تيكيت مسموح فقط من #help  (تمت إزالة القوس الزايد هنا)
    if (interaction.isButton() && interaction.customId === 'open_ticket') {
      const ch = interaction.channel;
      if (!ch || ch.type !== ChannelType.GuildText || ch.name.toLowerCase() !== CONFIG.HELP_CHANNEL_NAME) {
        await interaction.reply({ content: `❌ Open the request from the channel#${CONFIG.HELP_CHANNEL_NAME} only.`, ephemeral: true });
        return;
      }
      const row = buildDomainSelectRow();
      await interaction.reply({ content: 'Select the category:', components: [row], ephemeral: true });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_domain') {
      const picked = interaction.values?.[0];
      if (!picked || !DOMAINS.includes(picked)) {
        await interaction.reply({ content: 'Invalid selection.', ephemeral: true });
        return;
      }
      const modal = buildDescriptionModal(picked);
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_modal:')) {
      const domain = interaction.customId.split(':')[1];
      if (!DOMAINS.includes(domain)) {
        await interaction.reply({ content: 'Unknown category.', ephemeral: true });
        return;
      }

      const guild = await client.guilds.fetch(CONFIG.GUILD_ID);

      if (await hasOpenTicketInDomain(guild, interaction.user.id, domain)) {
        await interaction.reply({ content: `I have already been in the category already.${domain}.`, ephemeral: true });
        return;
      }

      const roleId = await resolveDomainRoleId(guild, domain);
      if (!roleId) {
        await interaction.reply({ content: `There is no roll matching the category.${domain}.`, ephemeral: true });
        return;
      }

      const everyoneId = guild.roles.everyone.id;
      const botId = client.user.id;
      const description = interaction.fields.getTextInputValue('desc');
      const ticketId = await nextTicketId(guild.id);
      const channelName = makeChannelName(interaction.user.username, domain, ticketId);

      const overwrites = [
        { id: everyoneId, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
        { id: roleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
        { id: botId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] },
      ];

      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: CONFIG.TICKET_CATEGORY_ID || undefined,
        topic: channelTopicPayload({ openerId: interaction.user.id, domain, roleId, description, ticketId }),
        permissionOverwrites: overwrites
      });

      const welcome = new EmbedBuilder()
        .setColor(CONFIG.THEME_COLOR)
        .setTitle(`${CONFIG.BRAND_NAME} | ${domain} | #${pad(ticketId)}`)
        .setDescription(`👋 **Welcome!**\nA ticket has been opened regarding the category**${domain}**.\nPlease wait for a response from a specialist.`)
        .addFields({ name: 'Description', value: description?.slice(0, 1000) || '—' });

      if (CONFIG.LOGO_URL) welcome.setThumbnail(CONFIG.LOGO_URL);

      const closeRow = buildCloseRow();
      await channel.send({ content: `<@${interaction.user.id}> <@&${roleId}>`, embeds: [welcome], components: [closeRow] });

      await interaction.reply({ content: `✅ Channel created: ${channel}`, ephemeral: true });

      const openLog = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle(`Opened #${pad(ticketId)} — ${domain}`)
        .addFields(
          { name: 'user', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'category', value: domain, inline: true },
          { name: 'The channel', value: `${channel}`, inline: true },
        )
        .setTimestamp(new Date());
      await logToChannel(guild, openLog);
      return;
    }

    if (interaction.isButton() && interaction.customId === 'close_ticket') {
      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        await interaction.reply({ content: 'Cannot close here.', ephemeral: true });
        return;
      }

      const meta = parseChannelTopic(channel.topic || '');
      if (!meta) {
        await interaction.reply({ content: 'No ticket data found.', ephemeral: true });
        return;
      }

      const guild = channel.guild;
      const member = await guild.members.fetch(interaction.user.id);
      const canClose = member.roles.cache.has(meta.roleId) || interaction.user.id === client.user.id;

      if (!canClose) {
        await interaction.reply({ content: '❌ You do not have the authority to close this ticket.', ephemeral: true });
        return;
      }

      try {
        const opener = await guild.members.fetch(meta.openerId);
        await opener.send(`Thank you! Ticket number has been closed.#${pad(meta.ticketId)} For the category ${meta.domain}.`);
      } catch {}

      if (CONFIG.ARCHIVE_MODE) {
        if (CONFIG.ARCHIVE_CATEGORY_ID) await channel.setParent(CONFIG.ARCHIVE_CATEGORY_ID).catch(()=>{});
        await channel.permissionOverwrites.edit(meta.roleId, { SendMessages: false }).catch(()=>{});
        await channel.permissionOverwrites.edit(meta.openerId, { SendMessages: false }).catch(()=>{});
        await channel.setName(channel.name.replace(/^ticket-/, 'archived-'));
        await interaction.reply({ content: 'The ticket has been archived.✅', ephemeral: true });
      } else {
        await interaction.reply({ content: 'The channel will be deleted in a few moments... ✅', ephemeral: true });
        await channel.delete('Ticket closed');
      }

      const closeLog = new EmbedBuilder()
        .setColor(0xef4444)
        .setTitle(`Closed #${pad(meta.ticketId)} — ${meta.domain}`)
        .addFields(
          { name: 'Close it', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'user', value: `<@${meta.openerId}>`, inline: true },
        )
        .setTimestamp(new Date());
      await logToChannel(guild, closeLog);
      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: 'An unexpected error occurred. Try again later.', ephemeral: true }); } catch {}
    }
  }
});

client.login(CONFIG.TOKEN);
