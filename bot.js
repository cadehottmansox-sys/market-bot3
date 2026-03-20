require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const { sendDashboard, handleInteraction, getSession, buildDashboard, buildButtons } = require('./dashboard');
const { scrapeEbay, scrapeDepop, getPriceStats } = require('./scraper');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Register slash command on startup ───────────────────────────────────────

async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('marketdashboard')
      .setDescription('Open the ResellBot market analysis dashboard'),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('Registering /marketdashboard slash command...');
    // Register globally (takes up to 1 hour to propagate) OR per-guild (instant)
    // Using guild-based for instant registration during dev
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log('✅ Slash command registered to guild (instant)');
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log('✅ Slash command registered globally (up to 1hr to appear)');
    }
  } catch (err) {
    console.error('Failed to register slash command:', err.message);
    console.log('⚠️  Add CLIENT_ID and GUILD_ID to .env for slash commands');
  }
}

// ─── Bot Ready ────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, () => {
  console.log(`✅ ResellBot online as ${client.user.tag}`);
  if (process.env.CLIENT_ID) {
    // Run non-blocking — don't await so bot starts instantly
    registerSlashCommands().catch(err => console.error('Slash command error:', err.message));
  } else {
    console.log('⚠️  CLIENT_ID not set — slash command not registered. Add to .env');
    console.log('   Bot ID is:', client.user.id);
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();
  const userId = message.author.id;
  const session = getSession(userId);

  // Photo upload intercept
  if (session.awaitingPhoto && message.attachments.size > 0) {
    const att = message.attachments.find((a) => a.contentType?.startsWith('image/'));
    if (att) {
      session.imageUrl = att.url;
      session.imageAttachment = att.url;
      session.awaitingPhoto = false;
      await message.react('✅');
      if (session.dashboardMessageId && session.dashboardChannelId) {
        try {
          const chan = await client.channels.fetch(session.dashboardChannelId);
          const msg = await chan.messages.fetch(session.dashboardMessageId);
          await msg.edit({ embeds: [buildDashboard(session)], components: buildButtons(session) });
        } catch (e) { console.warn('Dashboard refresh failed:', e.message); }
      }
      return;
    }
  }

  if (content === '!help') {
    const embed = new EmbedBuilder()
      .setTitle('🏷️ ResellBot — Help')
      .setColor(0x5865f2)
      .setDescription('Find recent sold prices from **eBay & Depop**, then get an AI listing recommendation.')
      .addFields(
        { name: '🚀 Open Dashboard', value: '`/marketdashboard` — Interactive panel' },
        { name: '⚡ Quick Comps', value: '`!price Nike Dunk Low sz10` — Instant sold comps' },
        { name: '📝 Full Listing', value: '`!list Nike Dunk Low sz10` — Full copy-paste listing' },
      )
      .setFooter({ text: 'ResellBot • Scrapes eBay & Depop directly' });
    return message.reply({ embeds: [embed] });
  }

  if (content.startsWith('!list ')) {
    return runSearch(message, content.slice(6).trim(), null, true);
  }
  if (content.startsWith('!price ')) {
    const args = content.slice(7).trim();
    const img = message.attachments.find((a) => a.contentType?.startsWith('image/'));
    return runSearch(message, args || null, img?.url || null, false);
  }
});

// ─── Interaction handler ──────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  // Slash command: /marketdashboard
  if (interaction.isChatInputCommand() && interaction.commandName === 'marketdashboard') {
    await interaction.deferReply();
    const userId = interaction.user.id;
    const session = getSession(userId);
    const embed = buildDashboard(session);
    const components = buildButtons(session);
    const msg = await interaction.editReply({ embeds: [embed], components });
    session.dashboardMessageId = msg.id;
    session.dashboardChannelId = interaction.channelId;
    return;
  }

  // Button/modal interactions
  await handleInteraction(interaction, {
    anthropic,
    scrapeEbay,
    scrapeDepop,
    generateRecommendation,
    sendResults,
  });
});

// ─── Quick command search runner ──────────────────────────────────────────────

async function runSearch(message, query, imageUrl, isFullListing) {
  const thinking = await message.reply('⏳ Searching eBay & Depop for recent sold listings...');
  try {
    let resolvedQuery = query;
    if (imageUrl && !query) {
      resolvedQuery = await identifyFromImage(anthropic, imageUrl);
      await thinking.edit(`⏳ Identified **${resolvedQuery}** — fetching comps...`);
    }
    const [ebayRes, depopRes] = await Promise.allSettled([scrapeEbay(resolvedQuery), scrapeDepop(resolvedQuery)]);
    const ebay = ebayRes.status === 'fulfilled' ? ebayRes.value : [];
    const depop = depopRes.status === 'fulfilled' ? depopRes.value : [];
    const rec = await generateRecommendation(anthropic, resolvedQuery, ebay, depop, imageUrl, isFullListing);
    await thinking.delete().catch(() => {});
    await sendResults(message.channel, rec, ebay, depop, resolvedQuery, imageUrl);
  } catch (err) {
    console.error(err);
    await thinking.edit(`❌ Error: ${err.message}`);
  }
}

// ─── AI Recommendation ────────────────────────────────────────────────────────

async function generateRecommendation(anthropic, query, ebayListings, depopListings, imageUrl, isFullListing) {
  const ebayStats = getPriceStats(ebayListings);
  const depopStats = getPriceStats(depopListings);

  const statsBlock = [
    ebayStats ? `eBay: avg $${ebayStats.avg}, median $${ebayStats.median}, range $${ebayStats.min}–$${ebayStats.max} (${ebayStats.count} sales)` : 'eBay: no data',
    depopStats ? `Depop: avg $${depopStats.avg}, median $${depopStats.median}, range $${depopStats.min}–$${depopStats.max} (${depopStats.count} sales)` : 'Depop: no data',
  ].join('\n');

  const ebaySummary = ebayListings.length > 0
    ? ebayListings.slice(0, 8).map((l, i) => `${i + 1}. "${l.title}" — $${l.price} (${l.condition}) ${l.date}`).join('\n')
    : 'No eBay sold listings found.';

  const depopSummary = depopListings.length > 0
    ? depopListings.slice(0, 6).map((l, i) => `${i + 1}. "${l.title}" — $${l.price}`).join('\n')
    : 'No Depop sold listings found.';

  const prompt = isFullListing
    ? `You are an expert reseller. Generate a complete ready-to-post listing.

Item: ${query}
Price stats:\n${statsBlock}
eBay comps:\n${ebaySummary}
Depop comps:\n${depopSummary}

Return ONLY raw JSON (no markdown fences):
{"suggestedPrice":49.99,"priceRangeMin":40.00,"priceRangeMax":60.00,"suggestedTitle":"title under 80 chars","condition":"Used - Good","description":"full 3-4 paragraph listing covering condition, details, shipping","hashtags":["#tag1","#tag2"],"tips":["tip1","tip2","tip3"],"platformRecommendation":"which platform and why","bestPlatform":"eBay","marketNote":"one sentence on demand","photoTips":["tip on what photos to take","tip on lighting","tip on background/angle"]}`
    : `You are an expert reseller. Analyze sold comps and give pricing advice.

Item: ${query}
Price stats:\n${statsBlock}
eBay comps:\n${ebaySummary}
Depop comps:\n${depopSummary}

Return ONLY raw JSON (no markdown fences):
{"suggestedPrice":49.99,"priceRangeMin":40.00,"priceRangeMax":60.00,"suggestedTitle":"title under 80 chars","condition":"Used - Good","quickTips":["tip1","tip2","tip3"],"platformRecommendation":"which platform and why","bestPlatform":"eBay","marketNote":"one sentence on demand","photoTips":["tip on what photos to take","tip on lighting","tip on background/angle"]}`;

  const msgContent = imageUrl
    ? [{ type: 'image', source: { type: 'url', url: imageUrl } }, { type: 'text', text: prompt }]
    : prompt;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: isFullListing ? 1200 : 700,
    messages: [{ role: 'user', content: msgContent }],
  });

  const raw = response.content[0].text.trim().replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); }
  catch { return { _raw: raw, suggestedPrice: 0, suggestedTitle: query, condition: 'Unknown' }; }
}

// ─── Results embeds ───────────────────────────────────────────────────────────

async function sendResults(channel, rec, ebayListings, depopListings, query, imageUrl) {
  const embeds = [];

  // 1. Pricing overview
  const priceEmbed = new EmbedBuilder()
    .setTitle(`💰 Pricing Analysis — ${query.slice(0, 50)}`)
    .setColor(0x00c851)
    .addFields(
      { name: '🏷️ Suggested Price', value: `**$${rec.suggestedPrice}**`, inline: true },
      { name: '📊 Safe Range', value: `$${rec.priceRangeMin} – $${rec.priceRangeMax}`, inline: true },
      { name: '📦 Condition', value: rec.condition || 'Used', inline: true },
      { name: '📝 Optimized Title', value: `\`${rec.suggestedTitle || query}\`` },
      { name: '🛒 Platform', value: rec.platformRecommendation || 'eBay / Depop' },
    )
    .setTimestamp()
    .setFooter({ text: `${ebayListings.length} eBay + ${depopListings.length} Depop sold comps` });

  if (imageUrl) priceEmbed.setThumbnail(imageUrl);
  if (rec.marketNote) priceEmbed.addFields({ name: '📈 Market', value: rec.marketNote });

  const tips = rec.tips || rec.quickTips || [];
  if (tips.length) priceEmbed.addFields({ name: '💡 Tips', value: tips.map((t) => `• ${t}`).join('\n') });
  embeds.push(priceEmbed);

  // 2. eBay comps
  const ebayStats = getPriceStats(ebayListings);
  embeds.push(
    new EmbedBuilder()
      .setTitle('📦 eBay — Recent Sold')
      .setColor(0xe53238)
      .setDescription(
        ebayListings.length > 0
          ? ebayListings.slice(0, 8).map((l, i) => `**${i + 1}.** $${l.price} — ${l.title.slice(0, 55)} *(${l.condition})*`).join('\n')
          : '_No eBay results — try a shorter search term_'
      )
      .setFooter({ text: ebayStats ? `Avg $${ebayStats.avg} • Median $${ebayStats.median} • ${ebayStats.count} sales` : 'No eBay data' })
  );

  // 3. Depop comps
  const depopStats = getPriceStats(depopListings);
  embeds.push(
    new EmbedBuilder()
      .setTitle('🌸 Depop — Recent Sold')
      .setColor(0xff2d55)
      .setDescription(
        depopListings.length > 0
          ? depopListings.slice(0, 6).map((l, i) => `**${i + 1}.** $${l.price} — ${l.title.slice(0, 55)}`).join('\n')
          : '_No Depop results found_'
      )
      .setFooter({ text: depopStats ? `Avg $${depopStats.avg} • Median $${depopStats.median} • ${depopStats.count} sales` : 'No Depop data' })
  );

  // 4. Full description
  if (rec.description) {
    const descEmbed = new EmbedBuilder()
      .setTitle('📋 Copy-Paste Listing')
      .setColor(0x5865f2)
      .setDescription(`\`\`\`\n${rec.description.slice(0, 3900)}\n\`\`\``);
    if (rec.hashtags?.length) descEmbed.addFields({ name: '#️⃣ Hashtags', value: rec.hashtags.join(' ') });
    embeds.push(descEmbed);
  }

  await channel.send({ embeds });

  // 5. Send listing photo examples — eBay sold photos first, then photo tips
  await sendListingPhotos(channel, ebayListings, depopListings, query, rec);
}

// ─── Listing photo embed ──────────────────────────────────────────────────────

async function sendListingPhotos(channel, ebayListings, depopListings, query, rec) {
  // Collect images from sold listings (these are real sold photos = great references)
  const allImages = [
    ...ebayListings.filter(l => l.imageUrl).map(l => ({ url: l.imageUrl, source: 'eBay', title: l.title, price: l.price })),
    ...depopListings.filter(l => l.imageUrl).map(l => ({ url: l.imageUrl, source: 'Depop', title: l.title, price: l.price })),
  ].slice(0, 4); // Max 4 photos

  if (allImages.length === 0) return; // No images found, skip silently

  // Build photo tips from AI recommendation
  const photoTips = rec.photoTips || [
    'Shoot on a clean white or neutral background',
    'Natural light from a window gives the best results',
    'Show all angles: front, back, sides, any flaws',
  ];

  // Send each image as a separate embed with the photo reference label
  const photoEmbeds = allImages.map((img, i) =>
    new EmbedBuilder()
      .setTitle(i === 0 ? '📸 Listing Photo References' : '\u200b')
      .setDescription(i === 0 ? `Real sold listings for **${query.slice(0, 40)}** — use these as photo style references` : null)
      .setImage(img.url)
      .setColor(0x2b2d31)
      .setFooter({ text: `${img.source} sold • $${img.price} — "${img.title.slice(0, 60)}"` })
  );

  // Add photo tips embed at the end
  const tipsEmbed = new EmbedBuilder()
    .setTitle('📷 Photo Tips for Your Listing')
    .setColor(0xf5a623)
    .setDescription(photoTips.map((t, i) => `**${i + 1}.** ${t}`).join('\n'));

  await channel.send({ embeds: [...photoEmbeds, tipsEmbed] });
}

async function identifyFromImage(anthropic, imageUrl) {
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 100,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'url', url: imageUrl } },
      { type: 'text', text: 'Identify this for resale. Return ONLY a short eBay search query (brand + model + key details, max 8 words).' },
    ]}],
  });
  return r.content[0].text.trim();
}

client.login(process.env.DISCORD_TOKEN);
