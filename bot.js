require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Events, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const { scrapeEbay, scrapeDepop, getPriceStats } = require('./scraper');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const sessions = new Map();
const resultOwners = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { itemName: null, status: 'idle', msgId: null, channelId: null });
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
      session.status === 'done' ? '✅ Analysis complete — check your results below!' :
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

function dismissButton(userId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rb_delete_' + userId).setLabel('🗑️ Dismiss').setStyle(ButtonStyle.Secondary),
  )];
}

client.on(Events.InteractionCreate, async (interaction) => {
  const userId = interaction.user.id;
  const session = getSession(userId);

  // Dismiss button — only works for whoever ran the search
  if (interaction.isButton() && interaction.customId.startsWith('rb_delete_')) {
    const ownerId = interaction.customId.replace('rb_delete_', '');
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: '❌ Only the person who ran this search can dismiss it.', flags: MessageFlags.Ephemeral });
    }
    await interaction.message.delete().catch(() => {});
    await interaction.deferUpdate().catch(() => {});
    return;
  }

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

  if (interaction.isButton() && (interaction.customId === 'rb_comps' || interaction.customId === 'rb_listing')) {
    const isFullListing = interaction.customId === 'rb_listing';
    const query = session.itemName;
    const channelId = interaction.channelId;
    session.status = 'searching';
    session.channelId = channelId;
    await interaction.update({ embeds: [buildEmbed(session)], components: buildButtons(session) });
    runSearch(userId, query, channelId, isFullListing).catch(async err => {
      console.error('Search error:', err.message);
      session.status = 'idle';
      const chan = await client.channels.fetch(channelId).catch(() => null);
      if (chan) chan.send({ content: '❌ Error: ' + err.message, components: dismissButton(userId) }).catch(() => {});
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

  // Pick best listing photos using Claude Vision
  const bestPhotos = await pickBestPhotos(ebay, query);
  console.log('Best photos selected: ' + bestPhotos.length);

  const rec = await generateRec(query, ebay, depop, isFullListing);
  session.status = 'done';

  if (session.msgId) {
    const msg = await chan.messages.fetch(session.msgId).catch(() => null);
    if (msg) msg.edit({ embeds: [buildEmbed(session)], components: buildButtons(session) }).catch(() => {});
  }

  await postResults(chan, rec, ebay, depop, query, userId, bestPhotos);
}

// Use Claude Vision to pick 4-5 clean photos (plain background, item only, no packaging)
async function pickBestPhotos(ebayListings, query) {
  const candidates = ebayListings.filter(l => l.imageUrl).slice(0, 12);
  if (candidates.length === 0) return [];

  try {
    // Build multi-image prompt for Claude to score all at once
    const imageContent = candidates.slice(0, 8).map((l, i) => ([
      { type: 'image', source: { type: 'url', url: l.imageUrl } },
      { type: 'text', text: 'Photo ' + (i+1) + ' (sold $' + l.price + ')' },
    ])).flat();

    imageContent.push({ type: 'text', text: 'You are helping a reseller pick the best listing photos for ' + query + '. Rate each photo 1-10 based on: clean plain background (white/grey preferred), item clearly visible, no packaging boxes or bags, no mannequins, good lighting, professional look. Return ONLY a JSON array of objects: [{"index":1,"score":8,"reason":"clean white bg"},{"index":2,"score":3,"reason":"has packaging box"},...] for all ' + candidates.slice(0,8).length + ' photos.' });

    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: imageContent }],
    });

    const raw = r.content[0].text.trim().replace(/```json|```/g, '').trim();
    const scores = JSON.parse(raw);

    // Sort by score descending, take top 4-5 with score >= 5
    const good = scores
      .filter(s => s.score >= 5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(s => ({ ...candidates[s.index - 1], score: s.score, reason: s.reason }));

    return good.length > 0 ? good : candidates.slice(0, 4).map(c => ({ ...c, score: 5, reason: 'auto-selected' }));
  } catch (e) {
    console.error('Photo scoring error:', e.message);
    // Fallback: just return first 4
    return candidates.slice(0, 4).map(c => ({ ...c, score: 5, reason: 'auto-selected' }));
  }
}

async function generateRec(query, ebay, depop, isFullListing) {
  const es = getPriceStats(ebay);
  const ds = getPriceStats(depop);
  const stats = [
    es ? 'eBay: avg $' + es.avg + ', median $' + es.median + ', range $' + es.min + '-$' + es.max + ' (' + es.count + ' sales)' : 'eBay: no data',
    ds ? 'Depop: avg $' + ds.avg + ', median $' + ds.median : 'Depop: no data',
  ].join('\n');
  const comps = ebay.slice(0,6).map((l,i) => (i+1)+'. "'+l.title+'" - $'+l.price+' ('+l.condition+')').join('\n') || 'No comps found';

  const prompt = isFullListing
    ? 'You are an expert eBay reseller using 2025 best practices. Create a complete optimized listing.\n\nItem: ' + query + '\nSold price data:\n' + stats + '\neBay sold comps:\n' + comps + '\n\nReturn ONLY raw JSON (no markdown):\n{"suggestedPrice":49.99,"priceRangeMin":40.00,"priceRangeMax":60.00,"title":"SEO title under 80 chars with brand model color size","condition":"Pre-Owned","description":"3-4 natural paragraphs like a real reseller. Include: what the item is, condition details, what is included, shipping policy, Buy It Now with Best Offer. Do NOT sound like AI.","hashtags":["#brand","#model","#resell"],"tips":["Promote at 3.5% minimum","Enable Best Offer","Free shipping built into price","Relist with tweaks if no views after 48hrs"],"platform":"Specific platform recommendation with reason"}'
    : 'You are an expert eBay reseller. Give quick pricing advice.\n\nItem: ' + query + '\nSold price data:\n' + stats + '\neBay sold comps:\n' + comps + '\n\nReturn ONLY raw JSON (no markdown):\n{"suggestedPrice":49.99,"priceRangeMin":40.00,"priceRangeMax":60.00,"title":"SEO title under 80 chars","condition":"Pre-Owned","tips":["tip1","tip2","tip3"],"platform":"recommendation with reason","marketNote":"one sentence on demand/trend"}';

  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: isFullListing ? 1200 : 600,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = r.content[0].text.trim().replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); }
  catch { return { suggestedPrice: '?', priceRangeMin: '?', priceRangeMax: '?', title: query, condition: 'Pre-Owned', tips: [], platform: 'eBay' }; }
}

async function postResults(chan, rec, ebay, depop, query, userId, bestPhotos) {
  const es = getPriceStats(ebay);
  const ds = getPriceStats(depop);
  const btn = dismissButton(userId);

  // 1. Pricing
  const e1 = new EmbedBuilder()
    .setTitle('💰 Pricing Analysis — ' + query.slice(0,50))
    .setColor(0x00c851)
    .addFields(
      { name: '🏷️ Suggested Price', value: '**$' + rec.suggestedPrice + '**', inline: true },
      { name: '📊 Safe Range', value: '$' + rec.priceRangeMin + ' – $' + rec.priceRangeMax, inline: true },
      { name: '📦 Condition', value: rec.condition || 'Pre-Owned', inline: true },
      { name: '📝 Optimized Title', value: '`' + (rec.title || query) + '`' },
      { name: '🛒 Platform', value: rec.platform || 'eBay' },
    ).setTimestamp().setFooter({ text: ebay.length + ' eBay + ' + depop.length + ' Depop comps • Hit Dismiss to hide results' });
  if (rec.marketNote) e1.addFields({ name: '📈 Market Note', value: rec.marketNote });
  if (rec.tips?.length) e1.addFields({ name: '💡 Tips', value: rec.tips.map(t => '• ' + t).join('\n') });
  await chan.send({ embeds: [e1], components: btn });

  // 2. Comps
  await chan.send({ embeds: [
    new EmbedBuilder().setTitle('📦 eBay — Recent Sold').setColor(0xe53238)
      .setDescription(ebay.length ? ebay.slice(0,8).map((l,i) => '**'+(i+1)+'.** $'+l.price+' — '+l.title.slice(0,55)+' *('+l.condition+')*').join('\n') : '_No eBay results_')
      .setFooter({ text: es ? 'Avg $'+es.avg+' • Median $'+es.median+' • '+es.count+' sales' : 'No data' }),
    new EmbedBuilder().setTitle('🌸 Depop — Recent Sold').setColor(0xff2d55)
      .setDescription(depop.length ? depop.slice(0,6).map((l,i) => '**'+(i+1)+'.** $'+l.price+' — '+l.title.slice(0,55)).join('\n') : '_No Depop results_')
      .setFooter({ text: ds ? 'Avg $'+ds.avg+' • Median $'+ds.median : 'No data' }),
  ], components: btn });

  // 3. Full listing description
  if (rec.description) {
    const e3 = new EmbedBuilder().setTitle('📋 Copy-Paste Listing Description').setColor(0x5865f2)
      .setDescription('```\n' + rec.description.slice(0,3900) + '\n```');
    if (rec.hashtags?.length) e3.addFields({ name: '#️⃣ Hashtags', value: rec.hashtags.join(' ') });
    await chan.send({ embeds: [e3], components: btn });
  }

  // 4. Best listing photos — Claude-selected, clean background, no packaging
  if (bestPhotos.length > 0) {
    // Send up to 4 photos in one embed message (Discord allows up to 4 images per message via multiple embeds)
    const photoEmbeds = bestPhotos.slice(0, 4).map((p, i) =>
      new EmbedBuilder()
        .setTitle(i === 0 ? '📸 Best Listing Photos (' + bestPhotos.length + ' selected from real sold listings)' : '\u200b')
        .setDescription(i === 0 ? '✅ AI-filtered: clean backgrounds, no packaging, ready to use as listing photo inspiration.' : null)
        .setImage(p.imageUrl)
        .setColor(0x2b2d31)
        .setFooter({ text: '⭐ Score: ' + p.score + '/10 — Sold $' + p.price + ' — ' + p.title.slice(0,50) })
    );
    await chan.send({ embeds: photoEmbeds, components: btn });
  } else {
    // No photos found — give tips instead
    await chan.send({ embeds: [
      new EmbedBuilder().setTitle('📷 No Matching Photos Found').setColor(0xffaa00)
        .setDescription('No clean listing photos were found in the sold results. Here are tips for shooting your own:')
        .addFields(
          { name: '📱 Setup', value: 'Plain white/grey background, natural window light' },
          { name: '📐 Angles', value: 'Front, back, both sides, close-up of tags/labels, any flaws' },
          { name: '🚫 Avoid', value: 'Flash, clutter, packaging, stock photos' },
        )
    ], components: btn });
  }
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
    const bestPhotos = await pickBestPhotos(ebay, query);
    const rec = await generateRec(query, ebay, depop, isFull);
    await m.delete().catch(() => {});
    await postResults(message.channel, rec, ebay, depop, query, message.author.id, bestPhotos);
  } catch (err) { await m.edit('Error: ' + err.message); }
});

client.login(process.env.DISCORD_TOKEN);
