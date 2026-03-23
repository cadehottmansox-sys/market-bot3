require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Events, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const sessions = new Map();
function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { itemName: null, status: 'idle', msgId: null, channelId: null });
  return sessions.get(userId);
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const cmds = [new SlashCommandBuilder().setName('marketdashboard').setDescription('Open ResellBot dashboard')].map(c => c.toJSON());
  try {
    if (process.env.GUILD_ID) await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: cmds });
    else await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: cmds });
    console.log('Slash command registered');
  } catch (e) { console.error('Slash error:', e.message); }
}

client.once(Events.ClientReady, () => {
  console.log('ResellBot online as ' + client.user.tag);
  if (process.env.CLIENT_ID) registerCommands().catch(console.error);
});

function buildEmbed(session) {
  const hasItem = !!session.itemName;
  return new EmbedBuilder()
    .setTitle('🏷️ ResellBot Dashboard')
    .setDescription([
      hasItem ? '**Item:** ' + session.itemName : '**Item:** Nothing entered yet',
      '',
      session.status === 'generating' ? '⏳ Generating listing...' :
      session.status === 'done' ? '✅ Done! Listing posted below.' :
      hasItem ? 'Hit **Generate Listing** below.' : 'Click Enter Item to get started.',
    ].join('\n'))
    .setColor(session.status === 'done' ? 0x00c851 : session.status === 'generating' ? 0xffaa00 : 0x5865f2)
    .setFooter({ text: 'ResellBot - AI Powered Listings' });
}

function buildButtons(session) {
  const hasItem = !!session.itemName;
  const busy = session.status === 'generating';
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rb_enter').setLabel(hasItem ? 'Edit Item' : 'Enter Item').setStyle(hasItem ? ButtonStyle.Secondary : ButtonStyle.Success).setDisabled(busy),
    new ButtonBuilder().setCustomId('rb_listing').setLabel('Generate Listing').setStyle(ButtonStyle.Success).setDisabled(!hasItem || busy),
    new ButtonBuilder().setCustomId('rb_quick').setLabel('Quick Price').setStyle(ButtonStyle.Danger).setDisabled(!hasItem || busy),
    new ButtonBuilder().setCustomId('rb_clear').setLabel('Clear').setStyle(ButtonStyle.Secondary).setDisabled(busy),
  )];
}

client.on(Events.InteractionCreate, async (interaction) => {
  const userId = interaction.user.id;
  const session = getSession(userId);

  if (interaction.isChatInputCommand() && interaction.commandName === 'marketdashboard') {
    const msg = await interaction.reply({ embeds: [buildEmbed(session)], components: buildButtons(session), fetchReply: true });
    session.msgId = msg.id;
    session.channelId = interaction.channelId;
    return;
  }

  if (interaction.isButton() && interaction.customId === 'rb_enter') {
    const modal = new ModalBuilder().setCustomId('rb_modal').setTitle('Enter Item');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('item').setLabel('Item name, brand, model, size, condition').setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Nike Dunk Low Panda Size 10 Like New').setRequired(true).setValue(session.itemName || '')
    ));
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'rb_modal') {
    session.itemName = interaction.fields.fields.get('item')?.value?.trim() || '';
    session.status = 'idle';
    session.channelId = interaction.channelId;
    const msg = await interaction.reply({ embeds: [buildEmbed(session)], components: buildButtons(session), fetchReply: true });
    session.msgId = msg.id;
    return;
  }

  if (interaction.isButton() && interaction.customId === 'rb_clear') {
    session.itemName = null; session.status = 'idle';
    await interaction.update({ embeds: [buildEmbed(session)], components: buildButtons(session) });
    return;
  }

  if (interaction.isButton() && (interaction.customId === 'rb_listing' || interaction.customId === 'rb_quick')) {
    const isFullListing = interaction.customId === 'rb_listing';
    const query = session.itemName;
    const channelId = interaction.channelId;
    session.status = 'generating';
    session.channelId = channelId;
    await interaction.update({ embeds: [buildEmbed(session)], components: buildButtons(session) });
    // Run fully async - no scraping, just AI
    generateAndPost(userId, query, channelId, isFullListing).catch(async err => {
      console.error('Gen error:', err.message);
      session.status = 'idle';
      const chan = await client.channels.fetch(channelId).catch(() => null);
      if (chan) chan.send('Error: ' + err.message).catch(() => {});
    });
  }
});

async function generateAndPost(userId, query, channelId, isFullListing) {
  const session = getSession(userId);
  const chan = await client.channels.fetch(channelId);

  const prompt = isFullListing
    ? `You are an expert eBay reseller. Using the 2025 eBay algorithm best practices, create a complete optimized listing for this item.

Item: ${query}

Return ONLY raw JSON, no markdown:
{
  "suggestedPrice": 49.99,
  "priceRangeMin": 40.00,
  "priceRangeMax": 60.00,
  "title": "eBay SEO title under 80 chars - brand model color size condition",
  "condition": "Pre-Owned",
  "description": "Write 3-4 natural paragraphs like a real reseller. Include: what the item is, condition details (be specific), what is included, dimensions/measurements if relevant, shipping policy, Buy It Now with Best Offer accepted. Do NOT sound like AI. Be concise and real.",
  "hashtags": ["#brand", "#model", "#resell"],
  "tips": [
    "Promote at 3.5% minimum on eBay for visibility",
    "Enable Best Offer - captures buyers who lowball",
    "List as Pre-Owned, mention Like New in description",
    "Free shipping - build $5-8 into the price",
    "Relist with minor tweaks if no views after 48hrs"
  ],
  "platform": "eBay recommendation with specific reason based on item category"
}`
    : `You are an expert eBay reseller. Give quick pricing advice for this item.

Item: ${query}

Return ONLY raw JSON, no markdown:
{
  "suggestedPrice": 49.99,
  "priceRangeMin": 40.00,
  "priceRangeMax": 60.00,
  "title": "eBay SEO title under 80 chars",
  "condition": "Pre-Owned",
  "tips": ["tip1", "tip2", "tip3"],
  "platform": "eBay or Depop with reason",
  "marketNote": "one sentence on demand or trend for this item"
}`;

  console.log('Generating for:', query);
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: isFullListing ? 1200 : 500,
    messages: [{ role: 'user', content: prompt }],
  });
  console.log('AI done');

  const raw = r.content[0].text.trim().replace(/```json|```/g, '').trim();
  let rec;
  try { rec = JSON.parse(raw); }
  catch { rec = { suggestedPrice: '?', priceRangeMin: '?', priceRangeMax: '?', title: query, condition: 'Pre-Owned', tips: [], platform: 'eBay' }; }

  session.status = 'done';

  // Update dashboard
  if (session.msgId) {
    const msg = await chan.messages.fetch(session.msgId).catch(() => null);
    if (msg) msg.edit({ embeds: [buildEmbed(session)], components: buildButtons(session) }).catch(() => {});
  }

  // Post pricing embed
  const e1 = new EmbedBuilder()
    .setTitle('💰 ' + query.slice(0, 50))
    .setColor(0x00c851)
    .addFields(
      { name: '🏷️ Suggested Price', value: '$' + rec.suggestedPrice, inline: true },
      { name: '📊 Range', value: '$' + rec.priceRangeMin + ' - $' + rec.priceRangeMax, inline: true },
      { name: '📦 Condition', value: rec.condition || 'Pre-Owned', inline: true },
      { name: '📝 eBay Title', value: '`' + (rec.title || query) + '`' },
      { name: '🛒 Platform', value: rec.platform || 'eBay' },
    ).setTimestamp();
  if (rec.marketNote) e1.addFields({ name: '📈 Market Note', value: rec.marketNote });
  if (rec.tips?.length) e1.addFields({ name: '💡 Tips', value: rec.tips.map(t => '• ' + t).join('\n') });
  await chan.send({ embeds: [e1] });

  // Post full description if generated
  if (rec.description) {
    const e2 = new EmbedBuilder()
      .setTitle('📋 Copy-Paste Listing Description')
      .setColor(0x5865f2)
      .setDescription('```\n' + rec.description.slice(0, 3900) + '\n```');
    if (rec.hashtags?.length) e2.addFields({ name: '#️⃣ Hashtags', value: rec.hashtags.join(' ') });
    await chan.send({ embeds: [e2] });
  }
}

// Also works as a quick command
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const c = message.content.trim();
  if (!c.startsWith('!list ') && !c.startsWith('!price ')) return;
  const isFull = c.startsWith('!list ');
  const query = c.slice(isFull ? 6 : 7).trim();
  if (!query) return message.reply('Usage: `!list Nike Dunk Low sz10`');
  const m = await message.reply('⏳ Generating listing...');
  try {
    const channelId = message.channelId;
    await generateAndPost(message.author.id + '_msg', query, channelId, isFull);
    await m.delete().catch(() => {});
  } catch (err) { await m.edit('Error: ' + err.message); }
});

client.login(process.env.DISCORD_TOKEN);
