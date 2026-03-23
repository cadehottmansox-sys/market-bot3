require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, Events, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const { scrapeEbay, scrapeDepop, getPriceStats } = require('./scraper');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const sessions = new Map();
function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { itemName: null, status: 'idle', msgId: null, channelId: null });
  return sessions.get(userId);
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commands = [new SlashCommandBuilder().setName('marketdashboard').setDescription('Open the ResellBot dashboard')].map(c => c.toJSON());
  try {
    if (process.env.GUILD_ID) await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    else await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('Slash command registered');
  } catch (e) { console.error('Slash error:', e.message); }
}

client.once(Events.ClientReady, () => {
  console.log('ResellBot online as ' + client.user.tag);
  if (process.env.CLIENT_ID) registerCommands().catch(console.error);
});

function buildEmbed(session) {
  const hasItem = !!session.itemName;
  const lines = [
    hasItem ? ('**Item:** ' + session.itemName) : '**Item:** Nothing entered yet',
    '',
    session.status === 'searching' ? 'Searching eBay & Depop...' :
    session.status === 'done' ? 'Done! Results posted below.' :
    hasItem ? 'Hit Find Comps or Full Listing.' : 'Enter an item to get started.',
  ];
  return new EmbedBuilder().setTitle('ResellBot Dashboard').setDescription(lines.join('\n'))
    .setColor(session.status === 'done' ? 0x00c851 : session.status === 'searching' ? 0xffaa00 : 0x5865f2)
    .setFooter({ text: 'ResellBot - eBay & Depop' });
}

function buildButtons(session) {
  const hasItem = !!session.itemName;
  const busy = session.status === 'searching';
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rb_enter').setLabel(hasItem ? 'Edit Item' : 'Enter Item').setStyle(hasItem ? ButtonStyle.Secondary : ButtonStyle.Success).setDisabled(busy),
    new ButtonBuilder().setCustomId('rb_comps').setLabel('Find Comps').setStyle(ButtonStyle.Danger).setDisabled(!hasItem || busy),
    new ButtonBuilder().setCustomId('rb_listing').setLabel('Full Listing').setStyle(ButtonStyle.Success).setDisabled(!hasItem || busy),
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
      new TextInputBuilder().setCustomId('item').setLabel('Item name or search query').setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Nike Dunk Low Panda sz10').setRequired(true).setValue(session.itemName || '')
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
      if (chan) await chan.send('Error: ' + err.message).catch(() => {});
    });
  }
});

async function runSearch(userId, query, channelId, isFullListing) {
  const session = getSession(userId);
  const chan = await client.channels.fetch(channelId);
  const [ebayRes, depopRes] = await Promise.allSettled([scrapeEbay(query), scrapeDepop(query)]);
  const ebay = ebayRes.status === 'fulfilled' ? ebayRes.value : [];
  const depop = depopRes.status === 'fulfilled' ? depopRes.value : [];
  console.log('Search results - eBay: ' + ebay.length + ' Depop: ' + depop.length);
  const rec = await generateRec(query, ebay, depop, isFullListing);
  session.status = 'done';
  if (session.msgId) {
    const msg = await chan.messages.fetch(session.msgId).catch(() => null);
    if (msg) await msg.edit({ embeds: [buildEmbed(session)], components: buildButtons(session) }).catch(() => {});
  }
  await postResults(chan, rec, ebay, depop, query);
}

async function generateRec(query, ebay, depop, isFullListing) {
  const es = getPriceStats(ebay);
  const ds = getPriceStats(depop);
  const stats = [(es ? 'eBay: avg $' + es.avg + ', median $' + es.median + ', range $' + es.min + '-$' + es.max + ' (' + es.count + ' sales)' : 'eBay: no data'), (ds ? 'Depop: avg $' + ds.avg + ', median $' + ds.median : 'Depop: no data')].join('\n');
  const comps = ebay.slice(0,6).map((l,i) => (i+1)+'. "'+l.title+'" - $'+l.price+' ('+l.condition+')').join('\n') || 'No comps';
  const prompt = isFullListing
    ? 'You are an expert eBay reseller using the eBay Algorithm 2025 best practices. Create a complete optimized listing.\n\nItem: ' + query + '\nSold price data:\n' + stats + '\neBay sold comps:\n' + comps + '\n\nReturn ONLY raw JSON (no markdown):\n{"suggestedPrice":49.99,"priceRangeMin":40.00,"priceRangeMax":60.00,"title":"SEO optimized title under 80 chars","condition":"Pre-Owned","description":"Write 3-4 natural paragraphs like a real seller. Cover: what the item is, condition details, what is included, shipping info, mention Buy It Now with Best Offer accepted. Do NOT sound like AI.","hashtags":["#brand","#model","#category"],"tips":["Promote at 3.5% minimum","Set Best Offer enabled","Relist if no views after 48hrs"],"platform":"Specific recommendation with reasoning"}'
    : 'You are an expert eBay reseller. Analyze these comps.\n\nItem: ' + query + '\nSold price data:\n' + stats + '\neBay sold comps:\n' + comps + '\n\nReturn ONLY raw JSON (no markdown):\n{"suggestedPrice":49.99,"priceRangeMin":40.00,"priceRangeMax":60.00,"title":"SEO title under 80 chars","condition":"Pre-Owned","tips":["tip1","tip2","tip3"],"platform":"recommendation","marketNote":"one sentence on demand"}';
  const r = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: isFullListing ? 1200 : 600, messages: [{ role: 'user', content: prompt }] });
  const raw = r.content[0].text.trim().replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); } catch { return { suggestedPrice: 0, title: query, condition: 'Pre-Owned', tips: [], platform: 'eBay' }; }
}

async function postResults(chan, rec, ebay, depop, query) {
  const es = getPriceStats(ebay);
  const ds = getPriceStats(depop);
  const e1 = new EmbedBuilder().setTitle('Pricing: ' + query.slice(0,50)).setColor(0x00c851)
    .addFields(
      { name: 'Suggested Price', value: '$' + rec.suggestedPrice, inline: true },
      { name: 'Safe Range', value: '$' + rec.priceRangeMin + ' - $' + rec.priceRangeMax, inline: true },
      { name: 'Condition', value: rec.condition || 'Pre-Owned', inline: true },
      { name: 'Optimized Title', value: rec.title || query },
      { name: 'Platform', value: rec.platform || 'eBay' },
    ).setTimestamp().setFooter({ text: ebay.length + ' eBay + ' + depop.length + ' Depop comps' });
  if (rec.marketNote) e1.addFields({ name: 'Market Note', value: rec.marketNote });
  if (rec.tips?.length) e1.addFields({ name: 'Tips', value: rec.tips.map(t => '• ' + t).join('\n') });

  const e2 = new EmbedBuilder().setTitle('eBay Recent Sold').setColor(0xe53238)
    .setDescription(ebay.length ? ebay.slice(0,8).map((l,i) => '**'+(i+1)+'.** $'+l.price+' — '+l.title.slice(0,55)+' *('+l.condition+')*').join('\n') : 'No eBay results')
    .setFooter({ text: es ? 'Avg $'+es.avg+' Median $'+es.median+' ('+es.count+' sales)' : 'No data' });

  const e3 = new EmbedBuilder().setTitle('Depop Recent Sold').setColor(0xff2d55)
    .setDescription(depop.length ? depop.slice(0,6).map((l,i) => '**'+(i+1)+'.** $'+l.price+' — '+l.title.slice(0,55)).join('\n') : 'No Depop results')
    .setFooter({ text: ds ? 'Avg $'+ds.avg+' Median $'+ds.median : 'No data' });

  await chan.send({ embeds: [e1, e2, e3] });

  if (rec.description) {
    const e4 = new EmbedBuilder().setTitle('Copy-Paste Listing Description').setColor(0x5865f2)
      .setDescription('```\n' + rec.description.slice(0,3900) + '\n```');
    if (rec.hashtags?.length) e4.addFields({ name: 'Hashtags', value: rec.hashtags.join(' ') });
    await chan.send({ embeds: [e4] });
  }
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const c = message.content.trim();
  if (!c.startsWith('!price ') && !c.startsWith('!list ')) return;
  const isFull = c.startsWith('!list ');
  const query = c.slice(isFull ? 6 : 7).trim();
  if (!query) return message.reply('Usage: `!price Nike Dunk Low sz10`');
  const m = await message.reply('Searching eBay & Depop...');
  try {
    const [er, dr] = await Promise.allSettled([scrapeEbay(query), scrapeDepop(query)]);
    const ebay = er.status === 'fulfilled' ? er.value : [];
    const depop = dr.status === 'fulfilled' ? dr.value : [];
    const rec = await generateRec(query, ebay, depop, isFull);
    await m.delete().catch(() => {});
    await postResults(message.channel, rec, ebay, depop, query);
  } catch (err) { await m.edit('Error: ' + err.message); }
});

client.login(process.env.DISCORD_TOKEN);
