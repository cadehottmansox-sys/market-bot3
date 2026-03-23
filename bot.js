require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Events, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const { scrapeEbay, scrapeDepop, getPriceStats, fetchListingPhotos } = require('./scraper');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { itemName: null, status: 'idle', msgId: null, channelId: null, photoListingIndex: 0, ebayListings: [] });
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
      session.status === 'searching' ? '⏳ Searching eBay & Depop for recent sales...' :
      session.status === 'done' ? '✅ Analysis complete — results sent to you!' :
      hasItem ? '🚀 Ready! Hit **🔍 Find Comps** or **📝 Full Listing**.' : '👆 Click **✏️ Enter Item** to get started.',
    ].join('\n'))
    .setColor(session.status === 'done' ? 0x00c851 : session.status === 'searching' ? 0xffaa00 : 0x5865f2)
    .setFooter({ text: '💰 ResellBot • eBay & Depop Comp Finder' });
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

client.on(Events.InteractionCreate, async (interaction) => {
  const userId = interaction.user.id;
  const session = getSession(userId);

  // /marketdashboard — persistent dashboard visible to everyone
  if (interaction.isChatInputCommand() && interaction.commandName === 'marketdashboard') {
    const msg = await interaction.reply({ embeds: [buildEmbed(session)], components: buildButtons(session), fetchReply: true });
    session.msgId = msg.id;
    session.channelId = interaction.channelId;
    return;
  }

  // Enter item button
  if (interaction.isButton() && interaction.customId === 'rb_enter') {
    const modal = new ModalBuilder().setCustomId('rb_modal').setTitle('✏️ Enter Item Details');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('item').setLabel('Item name, brand, model, size, condition')
        .setStyle(TextInputStyle.Short).setPlaceholder('e.g. Nike Dunk Low Panda Size 10 Like New')
        .setRequired(true).setValue(session.itemName || '')
    ));
    return interaction.showModal(modal);
  }

  // Modal submit
  if (interaction.isModalSubmit() && interaction.customId === 'rb_modal') {
    session.itemName = interaction.fields.fields.get('item')?.value?.trim() || '';
    session.status = 'idle';
    session.channelId = interaction.channelId;
    session.photoListingIndex = 0;
    session.ebayListings = [];
    const msg = await interaction.reply({ embeds: [buildEmbed(session)], components: buildButtons(session), fetchReply: true });
    session.msgId = msg.id;
    return;
  }

  // Clear
  if (interaction.isButton() && interaction.customId === 'rb_clear') {
    session.itemName = null; session.status = 'idle'; session.ebayListings = []; session.photoListingIndex = 0;
    await interaction.update({ embeds: [buildEmbed(session)], components: buildButtons(session) });
    return;
  }

  // Find new photos — cycle to next listing with photos
  if (interaction.isButton() && interaction.customId === 'rb_newphotos') {
    await interaction.deferUpdate();
    session.photoListingIndex = (session.photoListingIndex || 0) + 1;
    const chan = await client.channels.fetch(interaction.channelId);
    await sendPhotos(chan, session, userId, true);
    return;
  }

  // Find Comps or Full Listing
  if (interaction.isButton() && (interaction.customId === 'rb_comps' || interaction.customId === 'rb_listing')) {
    const isFullListing = interaction.customId === 'rb_listing';
    const query = session.itemName;
    const channelId = interaction.channelId;
    session.status = 'searching';
    session.channelId = channelId;
    session.photoListingIndex = 0;
    await interaction.update({ embeds: [buildEmbed(session)], components: buildButtons(session) });
    runSearch(userId, query, channelId, isFullListing).catch(async err => {
      console.error('Search error:', err.message);
      session.status = 'idle';
      const chan = await client.channels.fetch(channelId).catch(() => null);
      // Error only visible to user
      if (chan) chan.send({ content: '❌ Error: ' + err.message, flags: MessageFlags.Ephemeral }).catch(() => {});
    });
  }
});

async function runSearch(userId, query, channelId, isFullListing) {
  const session = getSession(userId);
  const chan = await client.channels.fetch(channelId);

  const [ebayRes, depopRes] = await Promise.allSettled([scrapeEbay(query), scrapeDepop(query)]);
  const ebay = ebayRes.status === 'fulfilled' ? ebayRes.value : [];
  const depop = depopRes.status === 'fulfilled' ? depopRes.value : [];
  console.log('eBay: ' + ebay.length + ' Depop: ' + depop.length);

  // Store listings for photo cycling
  session.ebayListings = ebay.filter(l => l.itemUrl);

  const rec = await generateRec(query, ebay, depop, isFullListing);
  session.status = 'done';

  // Update dashboard (stays visible to everyone)
  if (session.msgId) {
    const msg = await chan.messages.fetch(session.msgId).catch(() => null);
    if (msg) msg.edit({ embeds: [buildEmbed(session)], components: buildButtons(session) }).catch(() => {});
  }

  // Send ALL results as ephemeral — only visible to the user who requested
  await sendResultsEphemeral(chan, rec, ebay, depop, query, userId);
  await sendPhotos(chan, session, userId, false);
}

// Send results — ephemeral so only the requester sees them
async function sendResultsEphemeral(chan, rec, ebay, depop, query, userId) {
  const es = getPriceStats(ebay);
  const ds = getPriceStats(depop);

  // Pricing embed
  const e1 = new EmbedBuilder()
    .setTitle('💰 Pricing Analysis — ' + query.slice(0,50))
    .setColor(0x00c851)
    .addFields(
      { name: '🏷️ Suggested Price', value: '**$' + rec.suggestedPrice + '**', inline: true },
      { name: '📊 Safe Range', value: '$' + rec.priceRangeMin + ' – $' + rec.priceRangeMax, inline: true },
      { name: '📦 Condition', value: rec.condition || 'Pre-Owned', inline: true },
      { name: '📝 Optimized Title', value: '`' + (rec.title || query) + '`' },
      { name: '🛒 Platform', value: rec.platform || 'eBay' },
    ).setTimestamp().setFooter({ text: ebay.length + ' eBay + ' + depop.length + ' Depop comps' });
  if (rec.marketNote) e1.addFields({ name: '📈 Market Note', value: rec.marketNote });
  if (rec.tips?.length) e1.addFields({ name: '💡 Tips', value: rec.tips.map(t => '• ' + t).join('\n') });

  // Comps
  const e2 = new EmbedBuilder().setTitle('📦 eBay — Recent Sold').setColor(0xe53238)
    .setDescription(ebay.length ? ebay.slice(0,8).map((l,i) => '**'+(i+1)+'.** $'+l.price+' — '+l.title.slice(0,55)+' *('+l.condition+')*').join('\n') : '_No eBay results_')
    .setFooter({ text: es ? 'Avg $'+es.avg+' • Median $'+es.median+' • '+es.count+' sales' : 'No data' });
  const e3 = new EmbedBuilder().setTitle('🌸 Depop — Recent Sold').setColor(0xff2d55)
    .setDescription(depop.length ? depop.slice(0,6).map((l,i) => '**'+(i+1)+'.** $'+l.price+' — '+l.title.slice(0,55)).join('\n') : '_No Depop results_')
    .setFooter({ text: ds ? 'Avg $'+ds.avg+' • Median $'+ds.median : 'No data' });

  // Send pricing + comps as ephemeral (flags: MessageFlags.Ephemeral)
  await chan.send({ embeds: [e1, e2, e3], flags: MessageFlags.Ephemeral });

  // Full listing description
  if (rec.description) {
    const e4 = new EmbedBuilder().setTitle('📋 Copy-Paste Listing Description').setColor(0x5865f2)
      .setDescription('```\n' + rec.description.slice(0,3900) + '\n```');
    if (rec.hashtags?.length) e4.addFields({ name: '#️⃣ Hashtags', value: rec.hashtags.join(' ') });
    await chan.send({ embeds: [e4], flags: MessageFlags.Ephemeral });
  }
}

// Send photos from ONE listing — all photos from that single listing
async function sendPhotos(chan, session, userId, isNewPhotoRequest) {
  const listings = (session.ebayListings || []).filter(l => l.itemUrl);
  if (listings.length === 0) return;

  const idx = session.photoListingIndex || 0;
  if (idx >= listings.length) {
    await chan.send({ content: '📷 No more listings with photos to try!', flags: MessageFlags.Ephemeral });
    return;
  }

  const listing = listings[idx];
  console.log('Fetching photos from listing ' + (idx+1) + ': ' + listing.itemUrl);

  const photos = await fetchListingPhotos(listing.itemUrl);
  if (photos.length === 0) {
    // Try next listing automatically
    session.photoListingIndex = idx + 1;
    return sendPhotos(chan, session, userId, isNewPhotoRequest);
  }

  // Build one embed per photo (max 4), all from the same listing
  const photoEmbeds = photos.slice(0, 4).map((url, i) =>
    new EmbedBuilder()
      .setTitle(i === 0 ? '📸 Listing Photos — ' + listing.title.slice(0, 45) + ' ($' + listing.price + ')' : '\u200b')
      .setDescription(i === 0 ? 'All photos from one real sold listing. Hit **🔄 New Photos** for a different listing.' : null)
      .setImage(url)
      .setColor(0x2b2d31)
      .setFooter({ text: 'Photo ' + (i+1) + ' of ' + Math.min(photos.length, 4) + ' • Sold $' + listing.price })
  );

  const newPhotosBtn = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rb_newphotos').setLabel('🔄 New Photos').setStyle(ButtonStyle.Secondary),
  );

  await chan.send({ embeds: photoEmbeds, components: [newPhotosBtn], flags: MessageFlags.Ephemeral });
}

async function generateRec(query, ebay, depop, isFullListing) {
  const es = getPriceStats(ebay);
  const ds = getPriceStats(depop);
  const stats = [
    es ? 'eBay: avg $'+es.avg+', median $'+es.median+', range $'+es.min+'-$'+es.max+' ('+es.count+' sales)' : 'eBay: no data',
    ds ? 'Depop: avg $'+ds.avg+', median $'+ds.median : 'Depop: no data',
  ].join('\n');
  const comps = ebay.slice(0,6).map((l,i) => (i+1)+'. "'+l.title+'" - $'+l.price+' ('+l.condition+')').join('\n') || 'No comps found';

  const prompt = isFullListing
    ? 'You are an expert eBay reseller using 2025 best practices. Create a complete optimized listing.\n\nItem: '+query+'\nSold price data:\n'+stats+'\neBay sold comps:\n'+comps+'\n\nReturn ONLY raw JSON:\n{"suggestedPrice":49.99,"priceRangeMin":40.00,"priceRangeMax":60.00,"title":"SEO title under 80 chars","condition":"Pre-Owned","description":"3-4 natural paragraphs like a real reseller. Condition details, whats included, shipping, Buy It Now + Best Offer. No AI tone.","hashtags":["#brand","#model"],"tips":["Promote at 3.5%","Enable Best Offer","Free shipping built in","Relist after 48hrs no views"],"platform":"recommendation with reason"}'
    : 'You are an expert eBay reseller. Quick pricing advice.\n\nItem: '+query+'\nSold price data:\n'+stats+'\neBay sold comps:\n'+comps+'\n\nReturn ONLY raw JSON:\n{"suggestedPrice":49.99,"priceRangeMin":40.00,"priceRangeMax":60.00,"title":"SEO title under 80 chars","condition":"Pre-Owned","tips":["tip1","tip2","tip3"],"platform":"recommendation","marketNote":"one sentence on demand"}';

  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: isFullListing ? 1200 : 600,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = r.content[0].text.trim().replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); }
  catch { return { suggestedPrice: '?', priceRangeMin: '?', priceRangeMax: '?', title: query, condition: 'Pre-Owned', tips: [], platform: 'eBay' }; }
}

// Quick text commands
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const c = message.content.trim();
  if (!c.startsWith('!price ') && !c.startsWith('!list ')) return;
  const isFull = c.startsWith('!list ');
  const query = c.slice(isFull ? 6 : 7).trim();
  if (!query) return message.reply('Usage: `!list Nike Dunk Low sz10`');
  const m = await message.reply('⏳ Searching eBay & Depop...');
  try {
    const [er, dr] = await Promise.allSettled([scrapeEbay(query), scrapeDepop(query)]);
    const ebay = er.status === 'fulfilled' ? er.value : [];
    const depop = dr.status === 'fulfilled' ? dr.value : [];
    const session = getSession(message.author.id);
    session.ebayListings = ebay.filter(l => l.itemUrl);
    session.photoListingIndex = 0;
    const rec = await generateRec(query, ebay, depop, isFull);
    await m.delete().catch(() => {});
    await sendResultsEphemeral(message.channel, rec, ebay, depop, query, message.author.id);
    await sendPhotos(message.channel, session, message.author.id, false);
  } catch (err) { await m.edit('Error: ' + err.message); }
});

client.login(process.env.DISCORD_TOKEN);
