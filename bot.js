require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Events, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const { scrapeEbay, getPriceStats, fetchListingPhotos } = require('./scraper');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { itemName: null, status: 'idle', msgId: null, channelId: null, photoIdx: 0, listings: [], interaction: null });
  return sessions.get(userId);
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const cmds = [new SlashCommandBuilder().setName('marketdashboard').setDescription('Open the ResellBot market dashboard')].map(c => c.toJSON());
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
    .setTitle('🏷️ ResellBot — Market Analysis')
    .setDescription([
      hasItem ? '🏷️ **Slot 1 — Item**\n✅ ' + session.itemName : '🏷️ **Slot 1 — Item Name**\n⬜ Nothing entered yet',
      '',
      session.status === 'searching' ? '⏳ Searching eBay for recent sales...' :
      session.status === 'done' ? '✅ Done! Results sent privately.' :
      hasItem ? '🚀 Ready! Hit 🔍 Find Comps or 📝 Full Listing.' : '👆 Click ✏️ Enter Item to get started.',
    ].join('\n'))
    .setColor(session.status === 'done' ? 0x00c851 : session.status === 'searching' ? 0xffaa00 : 0x5865f2)
    .setFooter({ text: '💰 ResellBot • eBay Comp Finder' });
}

function buildButtons(session) {
  const hasItem = !!session.itemName;
  const busy = session.status === 'searching';
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rb_enter').setLabel(hasItem ? '✏️ Edit Item' : '✏️ Enter Item').setStyle(hasItem ? ButtonStyle.Secondary : ButtonStyle.Success).setDisabled(busy),
    new ButtonBuilder().setCustomId('rb_comps').setLabel('🔍 Find Comps').setStyle(ButtonStyle.Danger).setDisabled(!hasItem || busy),
    new ButtonBuilder().setCustomId('rb_listing').setLabel('📝 Full Listing').setStyle(ButtonStyle.Success).setDisabled(!hasItem || busy),
    new ButtonBuilder().setCustomId('rb_clear').setLabel('🗑️ Clear').setStyle(ButtonStyle.Secondary).setDisabled(busy),
  )];
}

function newPhotosBtn() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rb_newphotos').setLabel('🔄 New Photos').setStyle(ButtonStyle.Secondary),
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
    const modal = new ModalBuilder().setCustomId('rb_modal').setTitle('✏️ Enter Item Details');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('item').setLabel('Item name, brand, model, size, condition')
        .setStyle(TextInputStyle.Short).setPlaceholder('e.g. Nike Dunk Low Panda Size 10 Like New')
        .setRequired(true).setValue(session.itemName || '')
    ));
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'rb_modal') {
    session.itemName = interaction.fields.fields.get('item')?.value?.trim() || '';
    session.status = 'idle'; session.photoIdx = 0; session.listings = [];
    session.channelId = interaction.channelId;
    const msg = await interaction.reply({ embeds: [buildEmbed(session)], components: buildButtons(session), fetchReply: true });
    session.msgId = msg.id;
    return;
  }

  if (interaction.isButton() && interaction.customId === 'rb_clear') {
    session.itemName = null; session.status = 'idle'; session.listings = []; session.photoIdx = 0;
    await interaction.update({ embeds: [buildEmbed(session)], components: buildButtons(session) });
    return;
  }

  if (interaction.isButton() && interaction.customId === 'rb_newphotos') {
    session.photoIdx = (session.photoIdx || 0) + 1;
    await interaction.deferUpdate();
    await sendPhotos(session).catch(console.error);
    return;
  }

  if (interaction.isButton() && (interaction.customId === 'rb_comps' || interaction.customId === 'rb_listing')) {
    const isFullListing = interaction.customId === 'rb_listing';
    session.status = 'searching';
    session.photoIdx = 0;
    session.listings = [];
    session.interaction = interaction;
    session.channelId = interaction.channelId;
    await interaction.update({ embeds: [buildEmbed(session)], components: buildButtons(session) });
    runSearch(userId, isFullListing).catch(async err => {
      console.error('Search error:', err.message);
      session.status = 'idle';
      await session.interaction.followUp({ content: '❌ Error: ' + err.message, ephemeral: true }).catch(() => {});
    });
  }
});

async function runSearch(userId, isFullListing) {
  const session = getSession(userId);
  const query = session.itemName;

  const ebay = await scrapeEbay(query).catch(() => []);
  console.log('eBay listings: ' + ebay.length);

  session.listings = ebay.filter(l => l.itemUrl);
  const rec = await generateRec(query, ebay, isFullListing);
  session.status = 'done';

  // Update the public dashboard
  const chan = await client.channels.fetch(session.channelId);
  if (session.msgId) {
    const msg = await chan.messages.fetch(session.msgId).catch(() => null);
    if (msg) msg.edit({ embeds: [buildEmbed(session)], components: buildButtons(session) }).catch(() => {});
  }

  // Send results + photos as ephemeral via followUp — ONLY visible to requester
  await sendResults(session, rec, ebay, query);
  await sendPhotos(session);
}

async function sendResults(session, rec, ebay, query) {
  const es = getPriceStats(ebay);

  const e1 = new EmbedBuilder()
    .setTitle('💰 ' + query.slice(0, 50))
    .setColor(0x00c851)
    .addFields(
      { name: '🏷️ Suggested Price', value: '**$' + rec.suggestedPrice + '**', inline: true },
      { name: '📊 Safe Range', value: '$' + rec.priceRangeMin + ' – $' + rec.priceRangeMax, inline: true },
      { name: '📦 Condition', value: rec.condition || 'Pre-Owned', inline: true },
      { name: '📝 Optimized Title', value: '`' + (rec.title || query) + '`' },
      { name: '🛒 Platform', value: rec.platform || 'eBay' },
    ).setTimestamp().setFooter({ text: ebay.length + ' eBay comps • Only you can see this' });
  if (rec.marketNote) e1.addFields({ name: '📈 Market Note', value: rec.marketNote });
  if (rec.tips?.length) e1.addFields({ name: '💡 Tips', value: rec.tips.map(t => '• ' + t).join('\n') });

  const e2 = new EmbedBuilder().setTitle('📦 eBay — Recent Sold').setColor(0xe53238)
    .setDescription(ebay.length
      ? ebay.slice(0, 8).map((l, i) => '**' + (i+1) + '.** $' + l.price + ' — ' + l.title.slice(0, 55) + ' *(' + l.condition + ')*').join('\n')
      : '_No eBay results_')
    .setFooter({ text: es ? 'Avg $' + es.avg + ' • Median $' + es.median + ' • ' + es.count + ' sales' : 'No data' });

  await session.interaction.followUp({ embeds: [e1, e2], ephemeral: true });

  if (rec.description) {
    const e3 = new EmbedBuilder().setTitle('📋 Copy-Paste Listing').setColor(0x5865f2)
      .setDescription('```\n' + rec.description.slice(0, 3900) + '\n```');
    if (rec.hashtags?.length) e3.addFields({ name: '#️⃣ Hashtags', value: rec.hashtags.join(' ') });
    await session.interaction.followUp({ embeds: [e3], ephemeral: true });
  }
}

async function sendPhotos(session) {
  const listings = (session.listings || []).filter(l => l.itemUrl);
  if (listings.length === 0) return;

  const idx = session.photoIdx || 0;
  if (idx >= listings.length) {
    await session.interaction.followUp({ content: '📷 No more listings to try!', ephemeral: true }).catch(() => {});
    return;
  }

  const listing = listings[idx];
  console.log('Fetching photos from listing ' + (idx + 1) + ': ' + listing.itemUrl);
  const photos = await fetchListingPhotos(listing.itemUrl).catch(() => []);

  if (photos.length === 0) {
    session.photoIdx = idx + 1;
    return sendPhotos(session);
  }

  const photoEmbeds = photos.slice(0, 4).map((url, i) =>
    new EmbedBuilder()
      .setTitle(i === 0 ? '📸 ' + listing.title.slice(0, 45) + ' — Sold $' + listing.price : '\u200b')
      .setDescription(i === 0 ? 'All photos from one sold listing. Hit 🔄 for different listing photos.' : null)
      .setImage(url)
      .setColor(0x2b2d31)
      .setFooter({ text: 'Photo ' + (i + 1) + ' of ' + Math.min(photos.length, 4) + ' • Only you can see this' })
  );

  await session.interaction.followUp({ embeds: photoEmbeds, components: newPhotosBtn(), ephemeral: true });
}

async function generateRec(query, ebay, isFullListing) {
  const es = getPriceStats(ebay);
  const stats = es ? 'eBay: avg $' + es.avg + ', median $' + es.median + ', range $' + es.min + '-$' + es.max + ' (' + es.count + ' sales)' : 'eBay: no data';
  const comps = ebay.slice(0, 6).map((l, i) => (i+1) + '. "' + l.title + '" - $' + l.price + ' (' + l.condition + ')').join('\n') || 'No comps';

  const prompt = isFullListing
    ? 'Expert eBay reseller, 2025 best practices. Full listing for: ' + query + '\nData: ' + stats + '\nComps:\n' + comps + '\nReturn ONLY raw JSON:\n{"suggestedPrice":49.99,"priceRangeMin":40.00,"priceRangeMax":60.00,"title":"SEO title under 80 chars","condition":"Pre-Owned","description":"3-4 natural paragraphs. Condition details, whats included, shipping, Buy It Now + Best Offer. Real seller tone.","hashtags":["#tag"],"tips":["Promote 3.5%","Best Offer on","Free shipping built in","Relist after 48hrs no views"],"platform":"recommendation with reason"}'
    : 'Expert eBay reseller. Quick pricing for: ' + query + '\nData: ' + stats + '\nComps:\n' + comps + '\nReturn ONLY raw JSON:\n{"suggestedPrice":49.99,"priceRangeMin":40.00,"priceRangeMax":60.00,"title":"SEO title under 80 chars","condition":"Pre-Owned","tips":["tip1","tip2","tip3"],"platform":"recommendation","marketNote":"one sentence on demand"}';

  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: isFullListing ? 1200 : 600,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = r.content[0].text.trim().replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); }
  catch { return { suggestedPrice: '?', priceRangeMin: '?', priceRangeMax: '?', title: query, condition: 'Pre-Owned', tips: [], platform: 'eBay' }; }
}

client.login(process.env.DISCORD_TOKEN);
